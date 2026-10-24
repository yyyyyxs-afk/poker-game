// 仅限隔离本机浏览器：保留真实聊天处理，只控制回执与测试连接。
const readline = require('node:readline');
const {server, io, rooms} = require('../server');
let mode = 'normal', offline = false, current;
const held = [];
io.engine.use((req, res, next) => {
  if (offline && !req._query.sid) return next(new Error('isolated fixture offline'));
  next();
});
io.on('connection', socket => {
  current = socket;
  const handler = socket.listeners('chat_message')[0];
  socket.removeListener('chat_message', handler);
  socket.on('chat_message', (payload, ack) => {
    console.log('CHAT_REQUEST=' + JSON.stringify({mode,text:payload?.text}));
    if (mode === 'blackhole') return;
    handler(payload, result => {
      if (mode === 'release-previous') { held.shift()?.(); held.push(() => ack(result)); console.log('OLD_ACK_RELEASED_NEW_HELD'); }
      else if (mode === 'delay') setTimeout(()=>ack(result),1500);
      else if (mode === 'hold') { held.push(() => ack(result)); console.log('HELD=' + held.length); }
      else if (mode !== 'lost') ack(result);
    });
  });
});
server.listen(0,'127.0.0.1',()=>console.log('CHAT_UI_PORT='+server.address().port));
readline.createInterface({input:process.stdin}).on('line', line => {
  if (['normal','hold','lost','blackhole','delay','release-previous'].includes(line)) mode = line;
  else if (line === 'release') held.shift()?.();
  else if (line === 'offline') { offline = true; current?.conn.close(); }
  else if (line === 'online') offline = false;
  else if (line === 'status') console.log('CHAT_STATUS='+JSON.stringify([...rooms.values()].map(r=>({code:r.code,messages:r.chatMessages}))));
  console.log('FIXTURE='+JSON.stringify({mode,offline,held:held.length}));
});
async function stop() {
  for (const room of rooms.values()) for (const key of ['timer','nextHandTimer','waitingCleanupTimer']) clearTimeout(room[key]);
  io.close(()=>process.exit());
}
process.on('SIGINT',stop); process.on('SIGTERM',stop);
