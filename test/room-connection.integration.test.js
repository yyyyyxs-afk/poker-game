const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { server, io, rooms } = require('../server');
const squid = require('../squid');
const { createRoomRecovery, createActionDelivery } = require('../public/room-connection');
const clients = [];
const request = (socket, event, payload = null) => new Promise((resolve, reject) => {
  socket.timeout(3000).emit(event, payload, (error, response) => {
    if (error) reject(error);
    else if (!response?.ok) reject(new Error(response?.err || event));
    else resolve(response);
  });
});
async function waitFor(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, '等待测试状态超时');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function open(transport) {
  const socket = connect(`http://127.0.0.1:${server.address().port}`, {
    transports: [transport], reconnection: false, forceNew: true,
  });
  clients.push(socket);
  socket.on('state', state => { socket.latest = state; });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve); socket.once('connect_error', reject);
  });
  return socket;
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const [mode, count, transport] of [['classic', 6, 'polling'], ['squid', 3, 'websocket']]) {
      const seats = [], credentials = new Map();
      const host = await open(transport);
      seats.push(host);
      const created = await request(host, 'create_room', { name: '朋友0', mode,
        ...(mode === 'squid' ? { squidPayment: 20 } : {}) });
      const room = rooms.get(created.code);
      credentials.set('朋友0', created.token);
      for (let i = 1; i < count; i++) {
        const socket = await open(transport); seats.push(socket);
        const joined = await request(socket, 'join_room', { code: room.code, name: `朋友${i}` });
        credentials.set(`朋友${i}`, joined.token);
      }
      await request(host, 'set_next_hand_paused', { paused: true });
      await request(host, 'start_game');
      let recoveries = 0, actions = 0;
      for (let hand = 0; hand < 6; hand++) {
        if (hand) {
          const currentHost = seats.find(socket => socket.id === room.players.find(p => p.name === room.hostName).socketId);
          await request(currentHost, 'set_next_hand_paused', { paused: false });
          await request(currentHost, 'next_hand');
          await request(currentHost, 'set_next_hand_paused', { paused: true });
        }
        const turn = room.turnSeat, player = room.players[turn];
        const before = { chips: player.chips, hole: player.hole.map(card => ({ ...card })), token: player.token };
        seats[turn].disconnect(); await waitFor(() => !player.connected);
        const returning = await open(transport); seats[turn] = returning;
        await new Promise((resolve, reject) => {
          const recovery = createRoomRecovery({ socket: returning,
            getTarget: () => ({ code: room.code, name: player.name, token: credentials.get(player.name) }),
            onChange: (status, detail) => { if (status === 'failed') reject(new Error(detail)); },
            onRestored: () => resolve(), waitMs: 1000, retryMs: 20 });
          returning.on('state', state => recovery.acceptState(state));
          recovery.start();
        });
        recoveries++;
        assert.equal(room.players[turn], player);
        assert.equal(returning.latest.youSeat, turn);
        assert.equal(player.chips, before.chips); assert.equal(player.token, before.token);
        assert.deepEqual(returning.latest.players[turn].hole, before.hole);
        for (const opponent of returning.latest.players.filter(p => p.seat !== turn)) assert.equal(opponent.hole, null);
        assert.equal(returning.latest.turnSeat, turn, '保护窗口内恢复不能跳过本人行动');
        let safety = 0;
        while (room.stage !== 'handover') {
          assert.ok(++safety < 100, '牌局应能推进结束');
          const acting = room.players[room.turnSeat], socket = seats[room.turnSeat];
          await new Promise((resolve, reject) => {
            const delivery = createActionDelivery({ socket, isReady: () => true, onWaiting: () => {},
              onError: error => reject(new Error(error)), onSuccess: resolve });
            delivery.send({ type: hand % 2 === 0 ? 'fold' : acting.roundBet === room.currentBet ? 'check' : 'call' });
          });
          actions++;
        }
        assert.equal(room.players.reduce((sum, p) => sum + squid.estate(p), 0), room.economyTotal);
      }
      console.log(`PASS ${mode} ${count}人 / ${transport}：连续6手、${recoveries}次行动中回座、${actions}次真实行动、底牌隐私和筹码守恒`);
      for (const socket of seats) await request(socket, 'leave_room');
    }
  } finally {
    clients.forEach(socket => socket.disconnect());
    for (const room of rooms.values()) for (const key of ['timer', 'nextHandTimer', 'waitingCleanupTimer']) clearTimeout(room[key]);
    await new Promise(resolve => io.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
