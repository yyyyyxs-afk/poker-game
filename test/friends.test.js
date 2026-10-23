const assert = require('assert');
const { io: client } = require('socket.io-client');
const { server, io, rooms } = require('../server');
const { buildSessionCsv } = require('../session-csv');
const sockets = [];
const req = (s, event, payload = null) => new Promise((resolve, reject) => {
  s.timeout(3000).emit(event, payload, (err, res) => err ? reject(err) : resolve(res));
});
const ok = async (...args) => { const r = await req(...args); assert.strictEqual(r.ok, true, r.err); return r; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function open() {
  const s = client(`http://127.0.0.1:${server.address().port}`, { transports: ['websocket'] });
  sockets.push(s); await new Promise(r => s.once('connect', r)); return s;
}
async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const a = await open(), b = await open(), c = await open();
    const created = await ok(a, 'create_room', { name: '=房主' });
    await ok(b, 'join_room', { code: created.code, name: '+玩家乙' });
    await ok(c, 'join_room', { code: created.code, name: '@离场丙' });
    const room = rooms.get(created.code);
    room.settings.nextHandDelay = 5;
    assert.strictEqual((await req(b, 'set_next_hand_paused', { paused: true })).ok, false);
    assert.strictEqual((await req(a, 'set_next_hand_paused', { paused: 'true' })).ok, false);
    await ok(a, 'start_game');
    const deadline = room.turnDeadline, timer = room.timer;
    await ok(a, 'set_next_hand_paused', { paused: true });
    assert.strictEqual(room.timer, timer); assert.strictEqual(room.turnDeadline, deadline);
    assert.strictEqual((await req(a, 'export_session')).ok, false);
    while (room.stage !== 'handover') {
      const actor = room.players[room.turnSeat];
      await ok(sockets.find(s => s.id === actor.socketId), 'action', { type: 'fold' });
    }
    assert.strictEqual(room.nextHandTimer, null);
    assert.strictEqual((await req(a, 'next_hand')).ok, false);
    assert.strictEqual((await req(a, 'start_game')).ok, false);
    await ok(a, 'set_next_hand_paused', { paused: false });
    const nextDeadline = room.nextHandDeadline;
    await ok(a, 'set_next_hand_paused', { paused: false });
    assert.strictEqual(room.nextHandDeadline, nextDeadline);
    await ok(a, 'set_next_hand_paused', { paused: true });
    room.economyTotal -= room.players[1].chips; room.players[1].chips = 0;
    const buyIn = room.session.get('+玩家乙').buyIn;
    await ok(b, 'rebuy');
    assert.strictEqual(room.session.get('+玩家乙').buyIn, buyIn + room.settings.startChips);
    assert.strictEqual(room.nextHandTimer, null); assert.strictEqual(room.nextHandPaused, true);
    await sleep(5200); assert.strictEqual(room.handNumber, 1);
    await ok(a, 'leave_room');
    assert.strictEqual(room.hostName, '+玩家乙'); assert.strictEqual(room.nextHandPaused, true);
    assert.strictEqual((await req(a, 'set_next_hand_paused', { paused: false })).ok, false);
    const exported = await ok(b, 'export_session');
    assert.ok(exported.csv.startsWith('\uFEFF')); assert.ok(exported.csv.includes("'=房主"));
    assert.ok(exported.csv.includes('已离场'));
    for (const p of room.players) assert.ok(!exported.csv.includes(p.token));
    assert.ok(!exported.csv.includes('socketId')); assert.ok(!exported.csv.includes('hole'));
    const edge = buildSessionCsv({code:'ABC123'}, [{name:' \t=SUM(1,2)\n"名字"',buyIn:2000,chips:1900,pl:-100,hands:1,wins:0,left:false}]);
    assert.ok(edge.includes('"\' \t=SUM(1,2)\n""名字"""')); assert.ok(edge.includes('"-100"'));
    assert.ok(exported.csv.includes('房号'));
    assert.ok(exported.csv.includes('2026-'));
    await ok(b, 'set_next_hand_paused', { paused: false });
    await sleep(5200); assert.strictEqual(room.handNumber, 2);
    console.log('朋友局检查通过：房主权限、当前时钟、手动绕过、重复恢复、定时取消、重买、房主转移、自动恢复、结算口径与CSV安全');
  } finally {
    sockets.forEach(s => s.disconnect());
    for (const room of rooms.values()) { clearTimeout(room.timer); clearTimeout(room.nextHandTimer); }
    await new Promise(r => io.close(r));
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
