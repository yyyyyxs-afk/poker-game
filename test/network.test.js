const assert = require('assert');
const path = require('path');
const { fork } = require('child_process');
const { io } = require('socket.io-client');
const { LIMITS } = require('../network-guard');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error('房间状态未按预期更新');
}

function request(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} 未返回回执`)), 3000);
    socket.emit(event, payload, (reply) => { clearTimeout(timer); resolve(reply); });
  });
}

async function success(socket, event, payload) {
  const reply = await request(socket, event, payload);
  assert.ok(reply && reply.ok, `${event}: ${reply && reply.err}`);
  return reply;
}

function limited(reply, pattern = /频繁|太快/) {
  assert.strictEqual(reply.ok, false);
  assert.match(reply.err, pattern);
  assert.ok(reply.retryAfterMs > 0, '限频失败应告知等待时长');
}

async function withServer(env, run) {
  const sockets = [];
  const child = fork(path.join(__dirname, 'server-fixture.js'), [], {
    env: { ...process.env, POKER_TRUSTED_PROXIES: '', POKER_ALLOWED_ORIGINS: '', ...env },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`测试服务启动超时: ${stderr}`)), 5000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`测试服务退出 ${code}: ${stderr}`)); });
      child.on('message', (message) => {
        if (message.type === 'ready') { clearTimeout(timer); resolve(message.port); }
      });
    });
    const open = async (headers = {}, transport = 'websocket', denied = false) => {
      const socket = io(`http://127.0.0.1:${port}`, {
        autoConnect: false, reconnection: false, forceNew: true,
        transports: [transport], extraHeaders: headers, timeout: 2000,
      });
      sockets.push(socket);
      socket.on('state', (state) => { socket.latest = state; });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('连接未返回结果')), 3000);
        socket.once('connect', () => {
          clearTimeout(timer);
          if (denied) reject(new Error('不允许的来源仍建立了连接'));
          else resolve();
        });
        socket.once('connect_error', (error) => {
          clearTimeout(timer);
          if (denied) resolve();
          else reject(error);
        });
        socket.connect();
      });
      return socket;
    };
    await run(open);
  } finally {
    for (const socket of sockets) socket.disconnect();
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => child.kill(), 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        if (child.connected) child.send({ type: 'shutdown' });
        else child.kill();
      });
    }
  }
}

async function createTable(open) {
  const host = await open();
  const room = await success(host, 'create_room', { name: '房主' });
  const players = [{ socket: host, token: room.token, name: '房主' }];
  for (let i = 1; i < 6; i++) {
    const socket = await open();
    const name = `朋友${i}`;
    const joined = await success(socket, 'join_room', { code: room.code, name });
    players.push({ socket, token: joined.token, name });
  }
  await waitFor(() => host.latest && host.latest.players.length === 6);
  return { host, room, players };
}

async function testCreate() {
  await withServer({}, async (open) => {
    for (let i = 0; i < LIMITS.create.limit; i++) {
      // 每次换连接并伪造转发头，仍应共用真实对端的配额。
      const socket = await open({ 'X-Forwarded-For': `198.51.100.${i + 1}` });
      await success(socket, 'create_room', { name: '建房测试' });
      await success(socket, 'leave_room', null);
      socket.disconnect();
    }
    const overflow = await open({ 'X-Forwarded-For': '203.0.113.10' });
    limited(await request(overflow, 'create_room', { name: '换连接' }));
  });
  console.log('  ✓ 建房跨连接限频，伪造转发 IP 或退出换房不能刷新额度');
}

async function testJoinAndReconnect() {
  await withServer({}, async (open) => {
    const { host, room, players } = await createTable(open);
    let attempts = 5;
    async function attempt(code = '000000') {
      const socket = await open();
      const reply = await request(socket, 'join_room', { code, name: '测试访客' });
      socket.disconnect();
      attempts++;
      return reply;
    }
    for (let i = 0; i < LIMITS.missingRoom.limit; i++) {
      assert.match((await attempt()).err, /房间不存在/);
    }
    assert.match((await attempt(room.code)).err, /房间已满/);
    limited(await attempt()); // 遇到存在的房间也不能清掉先前的扫房记录。
    while (attempts < LIMITS.join.limit) await attempt();

    await success(host, 'update_settings', {
      startChips: 2000, smallBlind: 10, bigBlind: 20,
      actionTime: 60, nextHandDelay: 20, rebuyAllowed: true, locked: true,
    });
    await success(host, 'start_game', null);
    const returning = players[4];
    returning.socket.disconnect();
    await waitFor(() => host.latest.players.some((p) => p.name === returning.name && !p.connected));
    const impostor = await open();
    limited(await request(impostor, 'join_room', { code: room.code, name: returning.name, token: 'wrong-token' }));
    const restored = await open();
    await success(restored, 'join_room', { code: room.code, name: returning.name, token: returning.token });
    await waitFor(() => restored.latest && restored.latest.youSeat === 4);
    assert.strictEqual(restored.latest.players[4].hole.length, 2);
    assert.strictEqual(restored.latest.players[4].inHand, true);
    assert.strictEqual(restored.latest.players.length, 6);
  });
  console.log('  ✓ 入房/扫房跨连接限制；额度耗尽时正确 token 仍能回到已锁满员的进行中牌局');
}

async function testChat() {
  await withServer({}, async (open) => {
    const { host, room, players } = await createTable(open);
    await success(host, 'start_game', null);
    async function sendThree(player) {
      for (let i = 0; i < 3; i++) await success(player.socket, 'chat_message', { text: `测试${i}` });
    }
    const first = players[5];
    await sendThree(first);
    first.socket.disconnect();
    await waitFor(() => host.latest.players.some((p) => p.name === first.name && !p.connected));
    first.socket = await open();
    await success(first.socket, 'join_room', { code: room.code, name: first.name, token: first.token });
    limited(await request(first.socket, 'chat_message', { text: '重连不能重置' }), /太快/);
    for (const player of players.slice(0, 5)) await sendThree(player);
    // 同一网络六位朋友各发三条均可正常发送，总计 18 条。
    for (let round = 0; round < 2; round++) {
      await sleep(2050);
      for (const player of players) await sendThree(player);
    }
    await sleep(2050);
    await sendThree(players[0]);
    await sendThree(players[1]); // 总计 60 条，未到 10 秒窗口边界。
    const replacement = await open({ 'X-Forwarded-For': '192.0.2.200' });
    await success(replacement, 'create_room', { name: '换房换昵称' });
    limited(await request(replacement, 'chat_message', { text: '换身份也受网络配额限制' }), /当前网络/);
    assert.strictEqual(host.latest.chatMessages.length, 50, '聊天历史仍只保留最近 50 条');
  });
  console.log('  ✓ 六人同网络聊天正常；重连保留个人配额，换昵称也不能绕过网络配额');
}

async function testTrustedProxyAndOrigin() {
  await withServer({
    POKER_TRUSTED_PROXIES: '127.0.0.1/32,::1/128',
    POKER_ALLOWED_ORIGINS: 'https://poker.example',
  }, async (open) => {
    for (const transport of ['websocket', 'polling']) {
      (await open({ Origin: 'https://poker.example' }, transport)).disconnect();
      (await open({ Origin: 'https://poker.example.attacker.test' }, transport, true)).disconnect();
    }
    (await open()).disconnect(); // 原生客户端没有 Origin，不将此机制当作账号鉴权。
    for (let i = 0; i < LIMITS.create.limit; i++) {
      const socket = await open({ 'X-Forwarded-For': `192.0.2.${i + 1}, 198.51.100.10` });
      await success(socket, 'create_room', { name: '代理访客' });
      await success(socket, 'leave_room', null);
      socket.disconnect();
    }
    const exhausted = await open({ 'X-Forwarded-For': '192.0.2.200, 198.51.100.10' });
    limited(await request(exhausted, 'create_room', { name: '仍是同IP' }));
    const otherAddress = await open({ 'X-Forwarded-For': '198.51.100.11' });
    await success(otherAddress, 'create_room', { name: '另一网络' });
  });
  console.log('  ✓ 可信代理按不同客户端分别限频，来源白名单同时约束 WebSocket 与长轮询');
}

(async () => {
  await testCreate();
  await testJoinAndReconnect();
  await testChat();
  await testTrustedProxyAndOrigin();
  console.log('网络防滥用联机验证全部通过');
})().catch((error) => { console.error(error); process.exitCode = 1; });
