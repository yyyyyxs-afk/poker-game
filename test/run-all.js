/**
 * 一键全量回归：纯规则 -> 几何模型 -> 临时服务 -> 多人联机冒烟。
 *
 * 自动选择本机空闲端口，测试结束（成功、失败或 Ctrl+C）后关闭临时服务，
 * 避免要求使用者另开终端，也避免误连正在给真实玩家使用的 3000 端口。
 */
const { fork, spawn } = require('child_process');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let testServer = null;
let activeTest = null;
let shuttingDown = false;
let stopServerPromise = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(hasExited(child)), timeoutMs);
    child.once('exit', onExit);
  });
}

async function terminateChild(child) {
  if (hasExited(child)) return true;
  child.kill();
  if (await waitForChildExit(child, 2000)) return true;
  child.kill('SIGKILL');
  return waitForChildExit(child, 2000);
}

function runNode(relativeFile, extraEnv = {}, options = {}) {
  const absoluteFile = path.join(ROOT, relativeFile);
  return new Promise((resolve, reject) => {
    if (options.guardServer && hasExited(testServer)) {
      const code = testServer ? testServer.exitCode : '未知';
      reject(new Error(`临时测试服务不可用（退出码 ${code}）`));
      return;
    }
    const child = spawn(process.execPath, [absoluteFile], {
      cwd: ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: 'inherit',
    });
    activeTest = child;
    let settled = false;
    let timeout = null;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (options.guardServer && testServer) testServer.removeListener('exit', onServerExit);
      if (activeTest === child) activeTest = null;
      if (err) reject(err);
      else resolve();
    };

    const onServerExit = (code, signal) => {
      if (shuttingDown) return;
      const detail = signal ? `信号 ${signal}` : `退出码 ${code}`;
      const err = new Error(`临时测试服务异常退出（${detail}）`);
      terminateChild(child).finally(() => finish(err));
    };

    if (options.guardServer && testServer) testServer.once('exit', onServerExit);
    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        const err = new Error(`${relativeFile} 超过 ${Math.round(options.timeoutMs / 60000)} 分钟未完成`);
        terminateChild(child).finally(() => finish(err));
      }, options.timeoutMs);
      timeout.unref();
    }

    child.once('error', finish);
    child.once('exit', (code, signal) => {
      if (code === 0) return finish();
      const detail = signal ? `信号 ${signal}` : `退出码 ${code}`;
      finish(new Error(`${relativeFile} 执行失败（${detail}）`));
    });
  });
}

async function waitForServer(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasExited(testServer)) {
      const detail = testServer && testServer.signalCode
        ? `信号 ${testServer.signalCode}` : `退出码 ${testServer && testServer.exitCode}`;
      throw new Error(`临时测试服务提前退出（${detail}）`);
    }
    const ready = await new Promise((resolve) => {
      const request = http.get({ hostname: '127.0.0.1', port, path: '/', timeout: 500 }, (response) => {
        response.resume();
        resolve(response.statusCode >= 200 && response.statusCode < 400);
      });
      request.once('timeout', () => {
        request.destroy();
        resolve(false);
      });
      request.once('error', () => resolve(false));
    });
    if (ready) return;
    await sleep(100);
  }
  throw new Error(`临时测试服务在 ${timeoutMs / 1000} 秒内未就绪`);
}

async function startServer() {
  testServer = fork(path.join(ROOT, 'test', 'server-fixture.js'), [], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  testServer.stdout.on('data', (chunk) => process.stdout.write(`[测试服务] ${chunk}`));
  testServer.stderr.on('data', (chunk) => process.stderr.write(`[测试服务] ${chunk}`));

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('临时测试服务在 10 秒内未报告端口')), 10000);
    timeout.unref();

    const finish = (err, port) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      testServer.removeListener('message', onMessage);
      testServer.removeListener('exit', onEarlyExit);
      if (err) reject(err);
      else resolve(port);
    };
    const onMessage = (message) => {
      if (!message || !message.type) return;
      if (message.type === 'error' || message.type === 'fatal') {
        return finish(new Error(`临时测试服务启动失败：${message.message}`));
      }
      if (message.type === 'ready' && Number.isInteger(message.port) && message.port > 0) {
        finish(null, message.port);
      }
    };
    const onEarlyExit = (code, signal) => {
      const detail = signal ? `信号 ${signal}` : `退出码 ${code}`;
      finish(new Error(`临时测试服务启动前退出（${detail}）`));
    };

    testServer.on('message', onMessage);
    testServer.once('exit', onEarlyExit);
    testServer.once('error', (err) => finish(err));
  });
}

async function stopServer() {
  if (stopServerPromise) return stopServerPromise;
  stopServerPromise = (async () => {
    const child = testServer;
    if (hasExited(child)) return;
    if (child.connected) child.send({ type: 'shutdown' });
    if (await waitForChildExit(child, 3000)) return;
    child.kill();
    if (await waitForChildExit(child, 2000)) return;
    child.kill('SIGKILL');
    if (await waitForChildExit(child, 2000)) return;
    throw new Error('无法在限定时间内关闭临时测试服务');
  })();
  return stopServerPromise;
}

function installSignalHandler(signal, exitCode) {
  process.once(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await terminateChild(activeTest);
    try { await stopServer(); } catch (_) {}
    process.exit(exitCode);
  });
}

installSignalHandler('SIGINT', 130);
installSignalHandler('SIGTERM', 143);

(async () => {
  try {
    await runNode('test/ui-content.test.js', {}, { timeoutMs: 60000 });
    await runNode('test/chat-delivery.test.js', {}, { timeoutMs: 60000 });
    await runNode('test/lobby-requests.test.js', {}, { timeoutMs: 60000 });
    await runNode('test/rules.test.js', {}, { timeoutMs: 60000 });
    await runNode('test/runtime.test.js', {}, { timeoutMs: 60000 });
    await runNode('test/network-guard.test.js', {}, { timeoutMs: 60000 });
    await runNode('test/network.test.js', {}, { timeoutMs: 60000 });
    await runNode('test/geometry-check.js', {}, { timeoutMs: 60000 });
    await runNode('test/show-cards.test.js', {}, { timeoutMs: 60000 });
    await runNode('test/identity.test.js', {}, { timeoutMs: 60000 });
    await runNode('test/friends.test.js', {}, { timeoutMs: 60000 });
    await runNode('test/squid.test.js', {}, { timeoutMs: 60000 });
    await runNode('test/mode-config.test.js', {}, { timeoutMs: 60000 });

    const port = await startServer();
    await waitForServer(port);
    console.log(`[测试服务] 已就绪: http://127.0.0.1:${port}`);
    await runNode(
      'test/smoke.test.js',
      { TEST_URL: `http://127.0.0.1:${port}` },
      { timeoutMs: 10 * 60 * 1000, guardServer: true },
    );

    console.log('\n全量回归完成：规则、几何与多人联机测试全部通过 ✅');
  } catch (err) {
    if (!shuttingDown) {
      console.error(`\n全量回归失败 ❌：${err && err.message ? err.message : err}`);
      process.exitCode = 1;
    }
  } finally {
    try {
      await stopServer();
    } catch (err) {
      if (!shuttingDown) console.error(`\n测试服务清理失败 ❌：${err.message}`);
      process.exitCode = 1;
    }
  }
})();
