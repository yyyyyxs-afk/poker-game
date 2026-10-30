/**
 * 短牌德州（Six Plus，36 张）规则与联机回归：
 * 1. 牌堆：36 张唯一、点数域 6–14、无 2–5、20 次洗牌顺序不重复
 * 2. 跨类别对拍：同花 > 葫芦、三条 > 顺子；同牌在经典下结论相反（防止类别表写反）
 * 3. 轮子：A-6-7-8-9 成立且按 9 高；经典 A-2-3-4-5 在短牌不成立；A 不能从中间跨段成顺
 * 4. 牌型中文名随模式：短牌的三条仍叫"三条"、同花仍叫"同花"
 * 5. 经典零回归：newDeck/score5/evaluate7/describeScore 不传模式时与历史行为一致
 * 6. 联机：短牌房牌堆点数域、与经典房并行互不污染、摊牌按短牌判胜负、
 *    弃牌结算资金守恒、短牌拒绝鱿鱼与升盲字段
 * 运行：node test/short-deck.test.js
 */
const assert = require('assert');
const { io: connect } = require('socket.io-client');
const {
  server, io, rooms, evaluate7, score5, newDeck, describeScore,
  __test: { showdown },
} = require('../server');
const { parseCreate } = require('../room-config');

const C = (r, s) => ({ r, s });
let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { console.error(`✗ ${name}: ${e.message}`); process.exitCode = 1; }
}

// ---------------- 牌堆 ----------------
ok('短牌牌堆：36 张唯一、点数域 6–14、不含 2–5', () => {
  const d = newDeck('short');
  assert.strictEqual(d.length, 36);
  assert.strictEqual(new Set(d.map((c) => c.r + c.s)).size, 36);
  const bySuit = {};
  d.forEach((c) => {
    assert.ok(c.r >= 6 && c.r <= 14, `点数越界：${c.r}`);
    bySuit[c.s] = (bySuit[c.s] || 0) + 1;
  });
  assert.deepStrictEqual(bySuit, { s: 9, h: 9, d: 9, c: 9 });
});

ok('短牌牌堆：20 次洗牌顺序不重复', () => {
  const sig = (d) => d.map((c) => c.r + c.s).join(',');
  const seen = new Set();
  for (let i = 0; i < 20; i++) seen.add(sig(newDeck('short')));
  assert.strictEqual(seen.size, 20, '20 次洗牌出现完全相同顺序');
});

ok('经典零回归：缺省仍为 52 张、点数域含 2–5', () => {
  const d = newDeck();
  assert.strictEqual(d.length, 52);
  const ranks = [...new Set(d.map((c) => c.r))].sort((a, b) => a - b);
  assert.deepStrictEqual(ranks, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.strictEqual(newDeck('classic').length, 52);
});

// ---------------- 跨类别对拍 ----------------
const FLUSH7 = [C(14, 'h'), C(13, 'h'), C(12, 'h'), C(9, 'h'), C(8, 'h'), C(6, 'c'), C(7, 'd')];
const BOAT7 = [C(9, 'h'), C(9, 'd'), C(9, 's'), C(7, 'c'), C(7, 'h'), C(6, 'd'), C(8, 'c')];

ok('短牌：同花 > 葫芦（经典同牌相反）', () => {
  const flushShort = evaluate7(FLUSH7, 'short');
  const boatShort = evaluate7(BOAT7, 'short');
  assert.strictEqual(flushShort.score[0], 6, '短牌同花应为类别 6');
  assert.strictEqual(boatShort.score[0], 5, '短牌葫芦应为类别 5');
  assert.ok(flushShort.score[0] > boatShort.score[0], '短牌同花应大于葫芦');
  // 同两张牌面在经典模式必须得出相反结论，防止把类别表写反还"自洽通过"
  assert.ok(evaluate7(BOAT7).score[0] > evaluate7(FLUSH7).score[0], '经典葫芦应大于同花');
});

const TRIPS7 = [C(10, 'h'), C(10, 'd'), C(10, 's'), C(6, 'c'), C(8, 'd'), C(13, 'c'), C(14, 'h')];
const STRAIGHT7 = [C(9, 'h'), C(10, 'd'), C(11, 's'), C(12, 'c'), C(13, 'h'), C(6, 'd'), C(8, 'c')];

ok('短牌：三条 > 顺子（经典同牌相反）', () => {
  const tripsShort = evaluate7(TRIPS7, 'short');
  const straightShort = evaluate7(STRAIGHT7, 'short');
  assert.strictEqual(tripsShort.score[0], 4, '短牌三条应为类别 4');
  assert.strictEqual(straightShort.score[0], 3, '短牌顺子应为类别 3');
  assert.ok(tripsShort.score[0] > straightShort.score[0], '短牌三条应大于顺子');
  assert.ok(evaluate7(STRAIGHT7).score[0] > evaluate7(TRIPS7).score[0], '经典顺子应大于三条');
});

ok('短牌：同花顺与四条仍为最高两类', () => {
  const sf = evaluate7([C(13, 's'), C(12, 's'), C(11, 's'), C(10, 's'), C(9, 's'), C(6, 'h'), C(7, 'd')], 'short');
  const quads = evaluate7([C(8, 'h'), C(8, 'd'), C(8, 's'), C(8, 'c'), C(14, 'h'), C(6, 'd'), C(7, 'c')], 'short');
  assert.strictEqual(sf.score[0], 8);
  assert.strictEqual(quads.score[0], 7);
  assert.ok(sf.score[0] > quads.score[0] && quads.score[0] > evaluate7(FLUSH7, 'short').score[0]);
});

// ---------------- 轮子 / A 的位置 ----------------
ok('短牌轮子：A-6-7-8-9 成立且按 9 高', () => {
  const s = score5([C(14, 'h'), C(6, 'h'), C(7, 'd'), C(8, 's'), C(9, 'c')], 'short');
  assert.strictEqual(s[0], 3, '短牌轮子属顺子类别 3');
  assert.strictEqual(s[1], 9, '短牌轮子以 9 为最高牌');
  const e = evaluate7([C(14, 'h'), C(6, 'h'), C(7, 'd'), C(8, 's'), C(9, 'c'), C(13, 'd'), C(12, 's')], 'short');
  assert.strictEqual(e.score[1], 9);
  assert.match(e.name, /顺子（9 高）/);
});

ok('短牌：经典 A-2-3-4-5 轮子不生效', () => {
  const cards = [C(14, 's'), C(2, 'h'), C(3, 'd'), C(4, 'c'), C(5, 's')];
  assert.strictEqual(score5(cards, 'classic')[0], 4, '经典下 A-5 是顺子');
  assert.strictEqual(score5(cards, 'classic')[1], 5);
  assert.strictEqual(score5(cards, 'short')[0], 0, '短牌下 A-2-3-4-5 不是顺子');
  assert.deepStrictEqual(score5(cards, 'short'), [0, 14, 5, 4, 3, 2]);
});

ok('短牌：A 不能从中间跨段成顺（Q-K-A-6-7 不成立）', () => {
  const s = score5([C(12, 'h'), C(13, 'd'), C(14, 's'), C(6, 'c'), C(7, 'h')], 'short');
  assert.strictEqual(s[0], 0, 'A 不能把 Q-K 与 6-7 连成顺子');
});

ok('短牌：10-J-Q-K-A 仍是最大顺子（14 高）', () => {
  const s = score5([C(10, 'h'), C(11, 'd'), C(12, 's'), C(13, 'c'), C(14, 'h')], 'short');
  assert.strictEqual(s[0], 3);
  assert.strictEqual(s[1], 14);
});

// ---------------- 牌型文案 ----------------
ok('牌型名随模式：短牌同花/三条不改名，葫芦仍是葫芦', () => {
  assert.match(evaluate7(FLUSH7, 'short').name, /^同花（A 高）/);
  assert.match(evaluate7(BOAT7, 'short').name, /^葫芦（9 带 7）/);
  assert.match(evaluate7(TRIPS7, 'short').name, /^三条 10/);
  assert.match(evaluate7(STRAIGHT7, 'short').name, /^顺子（K 高）/);
  assert.strictEqual(describeScore([6, 14, 11, 9, 8, 7], 'short'), '同花（A 高）');
  assert.strictEqual(describeScore([5, 9, 7, 0, 0, 0], 'short'), '葫芦（9 带 7）');
});

ok('经典零回归：牌型文案与类别编号逐字节不变', () => {
  assert.strictEqual(describeScore([8, 14, 0, 0, 0, 0]), '同花顺（A 高）');
  assert.strictEqual(describeScore([7, 5, 13, 0, 0, 0]), '四条 5');
  assert.strictEqual(describeScore([6, 8, 3, 0, 0, 0]), '葫芦（8 带 3）');
  assert.strictEqual(describeScore([5, 14, 11, 9, 6, 3]), '同花（A 高）');
  assert.strictEqual(describeScore([4, 5, 0, 0, 0, 0]), '顺子（5 高）');
  assert.strictEqual(describeScore([3, 7, 13, 12, 0, 0]), '三条 7');
  assert.strictEqual(describeScore([2, 11, 9, 14, 0, 0]), '两对 J 和 9');
  assert.strictEqual(describeScore([1, 4, 14, 12, 9, 0]), '一对 4');
  assert.strictEqual(describeScore([0, 14, 12, 9, 7, 5]), '高牌 A');
  assert.strictEqual(evaluate7([C(14, 's'), C(2, 'h'), C(3, 'd'), C(4, 'c'), C(5, 's'), C(13, 'd'), C(12, 'h')]).name, '顺子（5 高）');
});

// ---------------- 创建参数 ----------------
ok('创建参数：短牌进入白名单，拒绝鱿鱼支付与升盲字段', () => {
  assert.strictEqual(parseCreate({ name: '甲', mode: 'short' }).mode, 'short');
  assert.ok(parseCreate({ name: '甲', mode: 'short', squidPayment: 50 }).err);
  assert.ok(parseCreate({ name: '甲', mode: 'short', blindIntervalMinutes: 10 }).err);
  assert.strictEqual(parseCreate({ name: '甲' }).mode, 'classic');
});

// ---------------- 摊牌按模式判胜负（服务端接入点） ----------------
function showdownRoom(mode) {
  const player = (name, hole) => ({
    name, totalBet: 100, roundBet: 0, chips: 1900, handStartChips: 2000,
    folded: false, inHand: true, allIn: false, connected: false, left: false,
    sittingOut: false, hole: [...hole],
  });
  return {
    mode,
    code: 'SHRT01', stage: 'river', handNumber: 1, dealerSeat: 0,
    // 公共牌：♥A ♥K ♥8 ♥7 ♣8
    players: [player('甲', [C(12, 'h'), C(6, 'h')]), player('乙', [C(7, 's'), C(7, 'c')])],
    community: [C(14, 'h'), C(13, 'h'), C(8, 'h'), C(7, 'h'), C(8, 'c')],
    pot: 0, currentBet: 0, minRaise: 20, turnSeat: -1, queue: [],
    logs: [], handActions: [], results: null, lastResult: null, revealed: false,
    timer: null, nextHandTimer: null, winMarkedHand: -1, gameOver: false,
    session: new Map([['甲', { wins: 0, hands: 1, buyIn: 2000 }], ['乙', { wins: 0, hands: 1, buyIn: 2000 }]]),
    sessionLeft: [],
    settings: { bigBlind: 20, nextHandDelay: 20, actionTime: 45 },
    economyTotal: 4000,
  };
}

ok('摊牌：同一副牌短牌判同花胜、经典判葫芦胜', () => {
  const shortRoom = showdownRoom('short');
  showdown(shortRoom);
  assert.strictEqual(shortRoom.results.pots[0].winners[0].name, '甲', '短牌同花应赢葫芦');
  assert.strictEqual(shortRoom.results.showdown.find((s) => s.name === '甲').handName.includes('同花'), true);
  assert.strictEqual(shortRoom.players.reduce((s, p) => s + p.chips, 0), 4000, '短牌摊牌后筹码守恒');

  const classicRoom = showdownRoom('classic');
  showdown(classicRoom);
  assert.strictEqual(classicRoom.results.pots[0].winners[0].name, '乙', '经典葫芦应赢同花');
  assert.strictEqual(classicRoom.players.reduce((s, p) => s + p.chips, 0), 4000, '经典摊牌后筹码守恒');
});

// ---------------- 联机：模式隔离与资金守恒 ----------------
const sockets = [];
const req = (s, e, p = null) => new Promise((resolve, reject) => s.timeout(4000).emit(e, p, (err, r) => err ? reject(err) : resolve(r)));
const okReq = async (...a) => { const r = await req(...a); assert.strictEqual(r.ok, true, r.err); return r; };
async function open() {
  const s = connect(`http://127.0.0.1:${server.address().port}`, { transports: ['websocket'] });
  sockets.push(s);
  s.on('state', (v) => { s.latest = v; });
  await new Promise((r) => s.once('connect', r));
  return s;
}
async function table(n, config) {
  const ss = [await open()];
  const cr = await okReq(ss[0], 'create_room', { name: '甲', ...config });
  const names = ['甲', '乙', '丙', '丁'];
  for (let i = 1; i < n; i++) { ss.push(await open()); await okReq(ss[i], 'join_room', { code: cr.code, name: names[i] }); }
  return { ss, r: rooms.get(cr.code), cr };
}
function tableCards(r) {
  return [...r.deck, ...r.players.filter(Boolean).flatMap((p) => p.hole), ...r.community];
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const visitor = await open();
    const short = await table(2, { mode: 'short' });

    // 创建后、开局前查加入说明：字段集沿用现有最小白名单，不新增协议字段
    const info = await okReq(visitor, 'room_info', { code: short.cr.code });
    assert.strictEqual(info.info.mode, 'short');
    assert.deepStrictEqual(Object.keys(info.info).sort(), ['code', 'mode', 'settings', 'squidPayment']);
    assert.strictEqual(short.r.squid.enabled, false, '短牌房不启用鱿鱼');
    assert.strictEqual(short.r.tournament, undefined, '短牌房不创建锦标赛');
    console.log('✓ 创建：短牌房 mode 正确、不启用鱿鱼/锦标赛，加入说明沿用最小字段集');

    // 短牌不与鱿鱼、锦标赛组合
    const squidReject = await req(visitor, 'create_room', { name: '鱿鱼组合', mode: 'short', squidPayment: 50 });
    assert.strictEqual(squidReject.ok, false);
    assert.match(squidReject.err, /短牌/);
    const blindReject = await req(visitor, 'create_room', { name: '升盲组合', mode: 'short', blindIntervalMinutes: 10 });
    assert.strictEqual(blindReject.ok, false);
    assert.match(blindReject.err, /短牌/);
    assert.strictEqual((await req(short.ss[0], 'set_squid_payment', { payment: 50 })).ok, false, '短牌房拒绝鱿鱼支付');
    console.log('✓ 玩法组合：短牌拒绝鱿鱼支付与升盲字段，房内无鱿鱼设置入口');

    // 同进程并行：短牌房与经典房同时开局，牌堆互不污染
    const classic = await table(2, { mode: 'classic' });
    await okReq(short.ss[0], 'start_game');
    await okReq(classic.ss[0], 'start_game');
    const shortCards = tableCards(short.r);
    assert.strictEqual(shortCards.length, 36, '短牌房发牌后总数应为 36');
    assert.ok(shortCards.every((c) => c.r >= 6), '短牌房不得出现 2–5');
    assert.strictEqual(new Set(shortCards.map((c) => c.r + c.s)).size, 36, '短牌房不得重复发牌');
    const classicCards = tableCards(classic.r);
    assert.strictEqual(classicCards.length, 52, '经典房仍为 52 张');
    assert.ok(classicCards.some((c) => c.r <= 5), '经典房仍含 2–5');
    console.log('✓ 并行对局：短牌 36 张（无 2–5）、经典 52 张，同进程互不污染');

    // 短牌房核对到摊牌：公共牌点数域、牌型名、资金守恒与全场零和
    const r = short.r;
    const before = r.players.reduce((s, p) => s + p.chips, 0) + r.players.reduce((s, p) => s + p.totalBet, 0);
    for (let n = 0; r.stage !== 'handover'; n++) {
      assert.ok(n < 40, '短牌牌局未在限定步数内结束');
      const p = r.players[r.turnSeat];
      const s = sockets.find((x) => x.id === p.socketId);
      await okReq(s, 'action', { type: p.roundBet === r.currentBet ? 'check' : 'call' });
    }
    assert.strictEqual(r.stage, 'handover');
    assert.strictEqual(r.community.length, 5, '短牌应正常走到河牌');
    assert.ok(r.community.every((c) => c.r >= 6), '公共牌同样不含 2–5');
    assert.strictEqual(new Set(tableCards(r).map((c) => c.r + c.s)).size, 36, '整手不得出现重复牌');
    r.results.showdown.forEach((p) => assert.match(p.handName,
      /^(同花顺|四条|同花|葫芦|三条|顺子|两对|一对|高牌)/, `牌型名异常：${p.handName}`));
    assert.strictEqual(r.players.reduce((s, p) => s + p.chips, 0), before, '结算后筹码总额守恒');
    assert.strictEqual(r.results.changes.reduce((s, e) => s + e.delta, 0), 0, '全场盈亏零和');
    assert.strictEqual(r.economyTotal, before, 'economyTotal 守恒');
    console.log('✓ 短牌一手到摊牌：公共牌点数域正确、牌型名可用、筹码守恒、全场盈亏零和');

    // 短牌局结束后经典房牌堆不受影响
    assert.strictEqual(tableCards(classic.r).length, 52);
    console.log('✓ 模式隔离：短牌结算后经典房仍为 52 张');
  } finally {
    sockets.forEach((s) => s.disconnect());
    for (const r of rooms.values()) { clearTimeout(r.timer); clearTimeout(r.nextHandTimer); clearTimeout(r.waitingCleanupTimer); }
    await new Promise((r) => io.close(r));
  }
})().then(() => {
  console.log(`\n短牌规则与联机测试完成：${passed} 项纯规则通过${process.exitCode ? '（存在失败）' : ' ✅'}`);
}).catch((e) => {
  console.error(`✗ 联机测试失败：${e && e.message ? e.message : e}`);
  process.exitCode = 1;
});

