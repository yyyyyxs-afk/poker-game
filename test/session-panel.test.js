const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { io: connect } = require('socket.io-client');
const { server, io, rooms } = require('../server');
const squid = require('../squid');
const PokerExplanations = require('../public/poker-explanations');

const source = fs.readFileSync(require.resolve('../public/client.js'), 'utf8');
const render = source.match(/function renderSession\([^]*?\n}/)[0];
const status = source.match(/function renderNextHandStatus\([^]*?\n}/)[0];
const elements = new Map();
function element(id) {
  if (!elements.has(id)) {
    const classes = new Set();
    elements.set(id, { textContent: '', innerHTML: '', disabled: false, attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      classList: { toggle(k, yes) { if (yes) classes.add(k); else classes.delete(k); }, contains(k) { return classes.has(k); } },
      querySelector() { return element('old-session-body'); } });
  }
  return elements.get(id);
}
const ctx = { document: { getElementById: element }, PokerExplanations,
  escapeHtml: v => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  isForfeitIntermission: () => false, state: null };
vm.createContext(ctx); vm.runInContext(`${render}\n${status}`, ctx);
function draw(state) { ctx.state = state; ctx.renderSession(); ctx.renderNextHandStatus(); return element('session-list').innerHTML; }

const sockets = [];
const request = (s, event, payload = null) => new Promise((resolve, reject) => s.timeout(3000).emit(event, payload, (error, result) => error ? reject(error) : resolve(result)));
async function ok(...args) { const r = await request(...args); assert.equal(r.ok, true, r.err); return r; }
async function open() {
  const s = connect(`http://127.0.0.1:${server.address().port}`, { transports: ['websocket'] });
  sockets.push(s); s.on('state', state => { s.latest = state; });
  await new Promise(resolve => s.once('connect', resolve)); return s;
}
async function waitFor(test) {
  const until = Date.now() + 3000;
  while (!test()) { if (Date.now() >= until) throw Error('等待测试状态超时'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function foldTo(room, name) {
  for (let i = 0; room.stage !== 'handover'; i++) {
    assert.ok(i < 30);
    const p = room.players[room.turnSeat];
    const actor = sockets.find(s => s.id === p.socketId);
    await ok(actor, 'action', { type: p.name === name ? (p.roundBet === room.currentBet ? 'check' : 'call') : 'fold' });
  }
}
function csvRow(csv, name, left) {
  return csv.slice(1).split('\r\n').slice(1).filter(Boolean).map(line => line.split(',').map(cell => cell.slice(1, -1)))
    .find(row => row[2] === name && row[10] === (left ? '已离场' : '在场'));
}
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const a = await open(), b = await open(), c = await open();
    const created = await ok(a, 'create_room', { name: '甲', mode: 'squid', squidPayment: 50 });
    await ok(b, 'join_room', { code: created.code, name: '乙' });
    await ok(c, 'join_room', { code: created.code, name: '丙' });
    const room = rooms.get(created.code);
    await ok(a, 'start_game'); await ok(a, 'set_next_hand_paused', { paused: true });
    await waitFor(() => a.latest && a.latest.stage === 'preflop');
    let list = a.latest.session;
    for (const entry of list) {
      const p = room.players.find(p => p.name === entry.name);
      assert.equal(entry.estate, squid.estate(p) + p.totalBet, '进行中包含已投入筹码');
      assert.equal(entry.frozen, 100, '冻结额包含在总资产中');
      assert.equal(entry.pl, entry.estate - entry.buyIn);
      assert.equal(entry.hole, undefined);
    }
    let html = draw(a.latest);
    assert.match(html, /含冻结 100/); assert.match(element('session-status').textContent, /本手尚未结算.*本手已投入/);
    assert.equal(element('btn-session-export').disabled, true);
    assert.equal((await request(a, 'export_session')).ok, false);
    const timer = room.timer, deadline = room.turnDeadline, paused = room.nextHandPaused;
    draw(a.latest); assert.equal(room.timer, timer); assert.equal(room.turnDeadline, deadline); assert.equal(room.nextHandPaused, paused);
    await foldTo(room, '甲');
    await ok(a, 'set_next_hand_paused', { paused: false }); await ok(a, 'next_hand');
    await ok(a, 'set_next_hand_paused', { paused: true }); await foldTo(room, '乙');
    assert.ok(room.results.squidEvents.some(e => e.type === 'payment'), '完成鱿鱼收付');
    await waitFor(() => a.latest.stage === 'handover' && a.latest.handNumber === 2);
    html = draw(a.latest); assert.match(element('session-status').textContent, /已结算/); assert.equal(element('btn-session-export').disabled, false);
    let exported = await ok(a, 'export_session');
    for (const e of a.latest.session) {
      const row = csvRow(exported.csv, e.name, e.left);
      assert.ok(row); assert.equal(Number(row[6]), e.estate); assert.equal(Number(row[7]), e.pl);
      assert.equal(Number(row[8]), e.hands); assert.equal(Number(row[9]), e.wins);
    }
    // 正筹码补买的鱿鱼资金不足场景由既有 mode-config 检查覆盖；这里验证实际重买广播与展示。
    const p = room.players.find(p => p.name === '乙'); room.economyTotal -= p.chips; p.chips = 0;
    const before = room.session.get('乙').buyIn; await ok(b, 'rebuy');
    await waitFor(() => a.latest.session.find(e => e.name === '乙').buyIn === before + room.settings.startChips);
    assert.match(draw(a.latest), /4,000/);
    c.emit('leave_room'); await waitFor(() => room.sessionLeft.some(e => e.name === '丙'));
    const d = await open(); await ok(d, 'join_room', { code: room.code, name: '丙' });
    await waitFor(() => a.latest.session.filter(e => e.name === '丙').length === 2);
    list = a.latest.session.filter(e => e.name === '丙');
    const current = list.find(e => !e.left), archived = list.find(e => e.left);
    assert.equal(current.estate, room.settings.startChips, '同名新座位不得使用旧座位资产');
    assert.notEqual(archived.buyIn + archived.pl, current.estate, '测试需要不同资产');
    html = draw(a.latest); assert.match(html, /同名记录 1/); assert.match(html, /同名记录 2/); assert.match(html, /已离场/);
    assert.ok(html.includes(PokerExplanations.number(archived.buyIn + archived.pl)));
    exported = await ok(a, 'export_session');
    for (const e of list) {
      const row = csvRow(exported.csv, e.name, e.left);
      assert.ok(row); assert.equal(Number(row[6]), e.left ? e.buyIn + e.pl : e.estate); assert.equal(Number(row[7]), e.pl);
    }
    ctx.state = { stage:'preflop', session:[{ name:'<甲>', buyIn:100, chips:80, estate:100, pl:0, hands:1, wins:0, left:false }] };
    ctx.renderSession(); assert.match(element('session-list').innerHTML, /&lt;甲&gt;/);
    console.log('本场战绩检查通过：进行中投入与冻结、禁导出、收付、重买、同名重入、离场资产和 CSV 一致');
  } finally {
    sockets.forEach(s => s.disconnect());
    for (const room of rooms.values()) { clearTimeout(room.timer); clearTimeout(room.nextHandTimer); clearTimeout(room.waitingCleanupTimer); }
    await new Promise(resolve => io.close(resolve));
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
