/**
 * 扑克核心规则回归测试（纯单元，无需服务器）：
 * 1. 洗牌：52 张严格唯一、合法牌集合、密码学随机可重复发牌
 * 2. 牌力：牌型类别、A-5 轮子、7 选 5 的 best5 精确性、平分牌
 * 3. 边池：多人全押阶梯（含弃牌者投入）分层与资格
 * 4. 下注权：不足额全押不重开加注权，足额全押正常重开
 * 运行：node test/rules.test.js
 */
const assert = require('assert');
const {
  evaluate7, computePots, score5, newDeck, normalizeNickname, newToken,
  applyAction, canRaise, oddChipWinnerOrder, awardPot,
} = require('../server.js');

const C = (r, s) => ({ r, s });
let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { console.error(`✗ ${name}: ${e.message}`); process.exitCode = 1; }
}

// ---------------- 洗牌 ----------------
ok('洗牌：52 张且无重复', () => {
  const d = newDeck();
  assert.strictEqual(d.length, 52);
  const keys = new Set(d.map((c) => c.r + c.s));
  assert.strictEqual(keys.size, 52);
});

ok('洗牌：牌集合合法（每花色 13 张、点数 2~14）', () => {
  const d = newDeck();
  const bySuit = {};
  d.forEach((c) => {
    assert.ok(c.r >= 2 && c.r <= 14, 'rank 越界');
    bySuit[c.s] = (bySuit[c.s] || 0) + 1;
  });
  assert.deepStrictEqual(bySuit, { s: 13, h: 13, d: 13, c: 13 });
});

ok('洗牌：连续多副牌顺序不重复（随机性 sanity）', () => {
  const sig = (d) => d.map((c) => c.r + c.s).join(',');
  const seen = new Set();
  for (let i = 0; i < 20; i++) seen.add(sig(newDeck()));
  assert.strictEqual(seen.size, 20, '20 次洗牌出现完全相同顺序');
});

// ---------------- 输入与身份安全 ----------------
ok('昵称：中文保留、首尾空格裁剪，8 个可见字符为合法上限', () => {
  assert.deepStrictEqual(normalizeNickname('  张三  '), { name: '张三' });
  assert.deepStrictEqual(normalizeNickname('甲乙丙丁戊己庚辛'), { name: '甲乙丙丁戊己庚辛' });
  assert.deepStrictEqual(normalizeNickname('😀😀😀😀😀😀😀😀'), { name: '😀😀😀😀😀😀😀😀' });
});

ok('昵称：Unicode 等价写法归一，按用户可见字符而非 UTF-16 长度计数', () => {
  assert.deepStrictEqual(normalizeNickname('Ａ'), { name: 'A' });
  assert.deepStrictEqual(normalizeNickname('e\u0301'), { name: 'é' });
});

ok('昵称：拒绝空白、非字符串、控制/零宽字符和 9 个可见字符', () => {
  for (const value of ['   ', null, '甲\n乙', '甲\u200B乙', '甲乙丙丁戊己庚辛壬']) {
    assert.ok(normalizeNickname(value).err, `应拒绝昵称 ${JSON.stringify(value)}`);
  }
});

ok('身份 token：使用固定强度的 URL 安全随机值且批量不重复', () => {
  const tokens = Array.from({ length: 100 }, () => newToken());
  assert.strictEqual(new Set(tokens).size, tokens.length);
  tokens.forEach((token) => assert.match(token, /^[A-Za-z0-9_-]{32}$/));
});

// ---------------- 牌力 ----------------
ok('牌力：皇家同花顺为最高类别', () => {
  const e = evaluate7([C(14, 's'), C(13, 's'), C(12, 's'), C(11, 's'), C(10, 's'), C(2, 'h'), C(3, 'd')]);
  assert.strictEqual(e.score[0], 8);
});

ok('牌力：葫芦 > 同花 > 顺子', () => {
  const boat = evaluate7([C(9, 'h'), C(9, 'd'), C(9, 's'), C(5, 'c'), C(5, 'h'), C(2, 'd'), C(3, 'c')]);
  const flush = evaluate7([C(14, 'h'), C(12, 'h'), C(9, 'h'), C(6, 'h'), C(2, 'h'), C(13, 'd'), C(13, 'c')]);
  const straight = evaluate7([C(9, 'h'), C(8, 'd'), C(7, 's'), C(6, 'c'), C(5, 'h'), C(2, 'd'), C(13, 'c')]);
  assert.ok(boat.score[0] === 6 && flush.score[0] === 5 && straight.score[0] === 4);
  assert.ok(boat.score[0] > flush.score[0] && flush.score[0] > straight.score[0]);
});

ok('牌力：A-5 轮子是最小顺子', () => {
  const e = evaluate7([C(14, 'h'), C(2, 'd'), C(3, 's'), C(4, 'c'), C(5, 'h'), C(9, 'd'), C(10, 'c')]);
  assert.strictEqual(e.score[0], 4);
  assert.strictEqual(e.score[1], 5, '轮子顺以 5 为最高牌');
});

ok('牌力：7 选 5 的 best5 精确（弃用无关底牌）', () => {
  // 公共牌组成 A 高同花顺的一部分：最佳 5 张 = ♠10JQKA，弃掉无关注的 3h/3d
  const cards = [C(14, 's'), C(13, 's'), C(12, 's'), C(11, 's'), C(10, 's'), C(3, 'h'), C(3, 'd')];
  const e = evaluate7(cards);
  assert.strictEqual(e.score[0], 8);
  const key = (c) => c.r + c.s;
  const best = new Set(e.best5.map(key));
  assert.strictEqual(e.best5.length, 5);
  ['14s', '13s', '12s', '11s', '10s'].forEach((k) => assert.ok(best.has(k), `best5 缺少 ${k}`));
});

ok('牌力：公共牌成牌时两家平分（cmpScore 相等）', () => {
  // 公共牌已是皇家同花顺，任何底牌都一样大
  const board = [C(14, 's'), C(13, 's'), C(12, 's'), C(11, 's'), C(10, 's')];
  const a = evaluate7([...board, C(2, 'h'), C(3, 'd')]);
  const b = evaluate7([...board, C(5, 'c'), C(6, 'c')]);
  assert.deepStrictEqual(a.score, b.score, '平分手牌分值应完全一致');
});

ok('牌力：高牌比较逐级进行（kicker 生效）', () => {
  const a = score5([C(14, 's'), C(13, 'h'), C(9, 'd'), C(6, 'c'), C(2, 'h')]);
  const b = score5([C(14, 's'), C(12, 'h'), C(9, 'd'), C(6, 'c'), C(2, 'h')]);
  assert.deepStrictEqual(a, [0, 14, 13, 9, 6, 2]);
  assert.ok(a[2] > b[2], '第一张同为 A 时以第二张 kicker 分出胜负');
});

// ---------------- 边池 ----------------
function fakeRoom(contribs) {
  // contribs: [{ totalBet, folded }]
  return { players: contribs.map((c) => ({ totalBet: c.totalBet, folded: !!c.folded })) };
}

ok('边池：A全押1000 B全押3000 C全押5000 D跟注5000 的三层阶梯', () => {
  const pots = computePots(fakeRoom([
    { totalBet: 1000 }, { totalBet: 3000 }, { totalBet: 5000 }, { totalBet: 5000 },
  ]));
  assert.deepStrictEqual(pots.map((p) => p.amount), [4000, 6000, 4000]);
  assert.deepStrictEqual(pots[0].eligible, [0, 1, 2, 3]);
  assert.deepStrictEqual(pots[1].eligible, [1, 2, 3]);
  assert.deepStrictEqual(pots[2].eligible, [2, 3]);
  // 总额守恒：各池之和 = 总投入
  assert.strictEqual(pots.reduce((t, p) => t + p.amount, 0), 14000);
});

ok('边池：弃牌者的投入仍计入池但不具备资格', () => {
  const pots = computePots(fakeRoom([
    { totalBet: 1000 }, { totalBet: 3000, folded: true }, { totalBet: 5000 }, { totalBet: 5000 },
  ]));
  assert.strictEqual(pots.reduce((t, p) => t + p.amount, 0), 14000, '弃牌投入不丢失');
  pots.forEach((p) => assert.ok(!p.eligible.includes(1), '弃牌者不具备获胜资格'));
});

ok('边池：所有人投入相同 → 单一主池', () => {
  const pots = computePots(fakeRoom([
    { totalBet: 500 }, { totalBet: 500 }, { totalBet: 500 },
  ]));
  assert.strictEqual(pots.length, 1);
  assert.strictEqual(pots[0].amount, 1500);
  assert.deepStrictEqual(pots[0].eligible, [0, 1, 2]);
});

ok('边池：零投入玩家不产生池', () => {
  const pots = computePots(fakeRoom([
    { totalBet: 0 }, { totalBet: 0 }, { totalBet: 800 },
  ]));
  assert.strictEqual(pots.length, 1);
  assert.strictEqual(pots[0].amount, 800);
  assert.deepStrictEqual(pots[0].eligible, [2]);
});

ok('平分底池：零头筹码从庄家左侧起按顺时针发放', () => {
  const room = {
    dealerSeat: 2,
    players: Array.from({ length: 5 }, () => ({ chips: 0 })),
  };
  const winners = [0, 2, 4];
  assert.deepStrictEqual(oddChipWinnerOrder(room, winners), [4, 0, 2]);
  awardPot(room, 8, winners); // 每人 2，两个零头依次给 4 号与 0 号座位
  assert.deepStrictEqual(room.players.map((p) => p.chips), [3, 0, 2, 0, 3]);
  assert.strictEqual(room.players.reduce((sum, p) => sum + p.chips, 0), 8);
});

// ---------------- 不足额全押与加注权 ----------------
function bettingPlayer(name, chips, acted = false) {
  return {
    name, chips, roundBet: 100, totalBet: 100,
    folded: false, allIn: false, connected: true, inHand: true, sittingOut: false,
    actedBet: acted ? 100 : null, actedMinRaise: acted ? 100 : null,
    socketId: `test-${name}`, avatar: '🙂', hole: [], left: false,
  };
}

function bettingRoom(allInChips) {
  return {
    code: 'TEST01', stage: 'flop', handNumber: 1,
    players: [
      bettingPlayer('先行动者', 900, true),
      bettingPlayer('全押者', allInChips, false),
      bettingPlayer('未行动者', 900, false),
    ],
    turnSeat: 1, queue: [1, 2], currentBet: 100, minRaise: 100,
    community: [], pot: 300, dealerSeat: 0, logs: [], handActions: [],
    results: null, lastResult: null, chatMessages: [], revealed: false,
    gameOver: false, economyTotal: 3000, session: new Map(), sessionLeft: [],
    settings: { startChips: 1000, smallBlind: 5, bigBlind: 10, actionTime: 60, nextHandDelay: 20 },
    hostName: '先行动者', timer: null, turnDeadline: 0,
  };
}

ok('不足额全押：已行动玩家需再次响应，但不能重新加注', () => {
  const room = bettingRoom(30); // 加到 130，只增加 30，未达到完整加注幅度 100
  assert.deepStrictEqual(applyAction(room, 1, 'allin'), { ok: true });
  clearTimeout(room.timer);
  assert.strictEqual(room.currentBet, 130);
  assert.strictEqual(room.minRaise, 100, '不足额全押不应改变完整最小加注幅度');
  assert.deepStrictEqual(room.queue, [2, 0], '未行动者和已行动者都必须响应新的跟注额');
  assert.strictEqual(canRaise(room, room.players[0]), false, '已行动玩家不应恢复加注权');
  assert.strictEqual(canRaise(room, room.players[2]), true, '尚未行动玩家仍保留加注权');

  room.turnSeat = 0;
  room.queue = [0, 2];
  const rejected = applyAction(room, 0, 'raise', 230);
  assert.strictEqual(rejected.ok, false, '已行动玩家不应能在不足额全押后再次加注');
  assert.match(rejected.err, /未重新开放加注权/);
  assert.deepStrictEqual(applyAction(room, 0, 'call'), { ok: true }, '已行动玩家仍应能够跟注');
  clearTimeout(room.timer);
  assert.strictEqual(room.players[0].roundBet, 130);
});

ok('足额全押：正常重新开放已行动玩家的加注权', () => {
  const room = bettingRoom(100); // 加到 200，增加 100，构成完整加注
  assert.deepStrictEqual(applyAction(room, 1, 'allin'), { ok: true });
  clearTimeout(room.timer);
  assert.strictEqual(room.currentBet, 200);
  assert.strictEqual(canRaise(room, room.players[0]), true, '完整加注应重新开放加注权');

  room.turnSeat = 0;
  room.queue = [0, 2];
  assert.deepStrictEqual(applyAction(room, 0, 'raise', 300), { ok: true });
  clearTimeout(room.timer);
  assert.strictEqual(room.currentBet, 300);
});

ok('累计不足额全押：累计达到完整加注幅度后重新开放加注权', () => {
  const room = bettingRoom(30); // 第一次从 100 加到 130
  room.players[2].chips = 100;  // 第二次从 130 加到 200，单次仍不足 100

  assert.deepStrictEqual(applyAction(room, 1, 'allin'), { ok: true });
  clearTimeout(room.timer);
  assert.strictEqual(canRaise(room, room.players[0]), false,
    '第一次不足额全押后不应重开加注权');

  assert.strictEqual(room.turnSeat, 2);
  assert.deepStrictEqual(applyAction(room, 2, 'allin'), { ok: true });
  clearTimeout(room.timer);
  assert.strictEqual(room.currentBet, 200);
  assert.strictEqual(room.minRaise, 100, '两个不足额全押不应改变完整最小加注幅度');
  assert.strictEqual(canRaise(room, room.players[0]), true,
    '累计增加达到玩家上次面对的完整加注幅度后应恢复加注权');
});

console.log(`\n规则回归测试完成：${passed} 项通过${process.exitCode ? '（存在失败）' : ' ✅'}`);
