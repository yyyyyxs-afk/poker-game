/**
 * 全量测试专用服务夹具。
 *
 * 由操作系统分配空闲端口，并通过 IPC 把真实端口回报给 run-all.js；父进程
 * 正常结束、失败或中断时都会请求关闭 Socket.IO 与 HTTP 服务。
 */
const { server, io } = require('../server');

let closing = false;

function send(message) {
  if (!process.send || !process.connected) return;
  try { process.send(message); } catch (_) {}
}

function finish(code) {
  process.exit(code);
}

function shutdown(code = 0) {
  if (closing) return;
  closing = true;

  const forceExit = setTimeout(() => finish(code || 1), 2000);
  forceExit.unref();

  const done = (err) => {
    clearTimeout(forceExit);
    finish(err ? 1 : code);
  };

  try {
    io.close(() => {
      if (!server.listening) return done();
      server.close(done);
    });
  } catch (err) {
    done(err);
  }
}

function failFast(kind, reason) {
  if (closing) return;
  const detail = reason && reason.stack ? reason.stack : String(reason);
  console.error(`[测试服务:${kind}] ${detail}`);
  send({ type: 'fatal', message: detail });
  shutdown(1);
}

server.once('error', (err) => {
  send({ type: 'error', message: err && err.message ? err.message : String(err) });
  shutdown(1);
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  send({ type: 'ready', port });
});

process.on('message', (message) => {
  if (message && message.type === 'shutdown') shutdown(0);
});
process.on('disconnect', () => shutdown(0));
process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));
process.on('uncaughtException', (err) => failFast('uncaughtException', err));
process.on('unhandledRejection', (reason) => failFast('unhandledRejection', reason));
