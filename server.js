/**
 * 多人在线德州扑克 - 服务端（权威逻辑）
 *
 * 规则：无限注德州扑克 (No-Limit Texas Hold'em)
 * 流程：发牌 -> 翻牌前 -> 翻牌 -> 转牌 -> 河牌 -> 摊牌（含边池分配）
 */
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// 防御性日志（经总负责人授权的最小改动）：只记录未捕获异常/拒绝，防止
// 进程无堆栈静默退出、便于事后定位；不改变任何牌局逻辑与错误处理路径。
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});

// 静态资源禁用强缓存：客户端 js/css/index 更新后，浏览器刷新即可拿到最新版，
// 避免"新 client.js + 旧 index.html"混搭导致渲染崩溃（座位全消失等）
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// ---------------- 常量 ----------------
const START_CHIPS = 2000;   // 初始筹码
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const TURN_TIMEOUT = 45000; // 默认行动超时（毫秒），可在房间设置中调整
const NEXT_HAND_DELAY = 20000; // 默认摊牌后自动开下一局延迟，可在房间设置中调整
// 断线保护窗口：对局中掉线不立即判负，给这么长时间回来
// （重连恢复剩余行动时间，不会因断线获得额外思考时间）
const DISCONNECT_GRACE_MS = 8000;
// 邀请码：6 位大写字母数字，排除易混淆字符（0/O、1/I/L）
const ROOM_CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const ROOM_CODE_LEN = 6;

// ---------------- 牌与牌力评估 ----------------
const SUITS = ['s', 'h', 'd', 'c']; // 黑桃 红心 方块 梅花
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]; // 11=J 12=Q 13=K 14=A

function newDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ r, s });
  // Fisher-Yates + 密码学安全随机：私人局的洗牌公平性不依赖 Math.random
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** 5 张牌评分，返回可按字典序比较的数组 [类别, k1..k5] */
function score5(cards) {
  const rs = cards.map((c) => c.r).sort((a, b) => a - b);
  const flush = cards.every((c) => c.s === cards[0].s);
  const uniq = [...new Set(rs)];
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[4] - uniq[0] === 4) straightHigh = uniq[4];
    else if (uniq.join(',') === '2,3,4,5,14') straightHigh = 5; // A-5 轮子
  }
  const cnt = {};
  rs.forEach((r) => (cnt[r] = (cnt[r] || 0) + 1));
  const groups = Object.entries(cnt)
    .map(([r, c]) => [c, +r])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]); // 先按张数、再按点数降序

  let cat, keys;
  if (flush && straightHigh) { cat = 8; keys = [straightHigh]; }            // 同花顺
  else if (groups[0][0] === 4) { cat = 7; keys = [groups[0][1], groups[1][1]]; } // 四条
  else if (groups[0][0] === 3 && groups[1][0] === 2) { cat = 6; keys = [groups[0][1], groups[1][1]]; } // 葫芦
  else if (flush) { cat = 5; keys = [...rs].reverse(); }                     // 同花
  else if (straightHigh) { cat = 4; keys = [straightHigh]; }                 // 顺子
  else if (groups[0][0] === 3) { cat = 3; keys = [groups[0][1], ...groups.slice(1).map((g) => g[1])]; } // 三条
  else if (groups[0][0] === 2 && groups[1][0] === 2) {                       // 两对
    cat = 2;
    const kicker = groups.find((g) => g[0] === 1);
    keys = [groups[0][1], groups[1][1], kicker ? kicker[1] : 0];
  } else if (groups[0][0] === 2) {                                           // 一对
    cat = 1;
    keys = [groups[0][1], ...groups.slice(1).map((g) => g[1])];
  } else { cat = 0; keys = [...rs].reverse(); }                              // 高牌

  const out = [cat, ...keys];
  while (out.length < 6) out.push(0);
  return out;
}

function cmpScore(a, b) {
  for (let i = 0; i < 6; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// 7 选 5 的所有组合下标
const COMBOS_7_5 = [];
(function gen(start, picked) {
  if (picked.length === 5) { COMBOS_7_5.push([...picked]); return; }
  for (let i = start; i < 7; i++) { picked.push(i); gen(i + 1, picked); picked.pop(); }
})(0, []);

function rankText(r) {
  const R = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  return R[r] || String(r);
}

/** 把评分数组转成带关键点数的中文描述，如 "一对 3"、"两对 J 和 9" */
function describeScore(score) {
  switch (score[0]) {
    case 8: return `同花顺（${rankText(score[1])} 高）`;
    case 7: return `四条 ${rankText(score[1])}`;
    case 6: return `葫芦（${rankText(score[1])} 带 ${rankText(score[2])}）`;
    case 5: return `同花（${rankText(score[1])} 高）`;
    case 4: return `顺子（${rankText(score[1])} 高）`;
    case 3: return `三条 ${rankText(score[1])}`;
    case 2: return `两对 ${rankText(score[1])} 和 ${rankText(score[2])}`;
    case 1: return `一对 ${rankText(score[1])}`;
    default: return `高牌 ${rankText(score[1])}`;
  }
}

/** 评估 7 张牌的最佳 5 张，返回 { score, name, best5 } */
function evaluate7(cards7) {
  let best = null;
  for (const combo of COMBOS_7_5) {
    const s = score5(combo.map((i) => cards7[i]));
    if (!best || cmpScore(s, best.score) > 0) best = { score: s, cards: combo.map((i) => cards7[i]) };
  }
  return { score: best.score, name: describeScore(best.score), best5: best.cards };
}

// ---------------- 房间管理 ----------------
/** rooms: Map<code, Room> */
const rooms = new Map();

function genRoomCode() {
  // 6 位字母数字邀请码，密码学随机；碰撞自动重生成
  let code;
  do {
    code = '';
    for (let i = 0; i < ROOM_CODE_LEN; i++) {
      code += ROOM_CODE_CHARS[crypto.randomInt(0, ROOM_CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

const AVATARS = ['🦊', '🐼', '🐯', '🦁', '🐸', '🐵', '🐨', '🦉'];

function createRoom(hostName) {
  const code = genRoomCode();
  const room = {
    code,
    players: [],           // 座位即数组下标；空位为 null
    stage: 'waiting',      // waiting | preflop | flop | turn | river | showdown | handover
    handNumber: 0,
    dealerSeat: -1,
    community: [],
    pot: 0,
    currentBet: 0,
    minRaise: BIG_BLIND,
    turnSeat: -1,
    queue: [],             // 本轮待行动座位队列
    logs: [],
    results: null,         // 摊牌结果
    revealed: false,
    timer: null,
    turnDeadline: 0,       // 当前行动定时器的绝对截止时间（断线保护窗口用于恢复剩余时间）
    preGrace: null,        // 行动者断线前保存的 { seat, deadline }，重连时恢复原剩余时间
    nextHandTimer: null,
    settings: {
      startChips: START_CHIPS,
      smallBlind: SMALL_BLIND,
      bigBlind: BIG_BLIND,
      actionTime: 45,      // 行动时长（秒），可选 20/30/45/60
      nextHandDelay: 20,   // 局间自动开局倒计时（秒），可选 5/10/20
      rebuyAllowed: true,  // 是否允许重买
    },
    hostName: hostName || null, // 房主（可修改房间设置）
    economyTotal: 0,       // 经济总盘子：所有在场筹码之和。加入/重买增加，
                           // 离场玩家清退时扣除；测试用它校验筹码守恒
    session: new Map(),    // 本场战绩：name -> { buyIn, hands, wins }
    sessionLeft: [],       // 已离场玩家的战绩存档：{ name, buyIn, pl, hands, wins }
    winMarkedHand: -1,     // 已统计过胜场的手数（防止结算重复计胜）
  };
  rooms.set(code, room);
  return room;
}

function seatCount(room) {
  return room.players.filter((p) => p && !p.left).length;
}

function addLog(room, msg) {
  room.logs.push(msg);
  if (room.logs.length > 40) room.logs.shift();
}

function canAct(p) {
  return p && !p.folded && !p.allIn && p.connected && p.chips > 0 && p.inHand && !p.sittingOut;
}

function nextSeat(room, from, filterFn) {
  const n = room.players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (from + i) % n;
    const p = room.players[idx];
    if (p && (!filterFn || filterFn(p))) return idx;
  }
  return -1;
}

function pay(p, amount) {
  const amt = Math.min(amount, p.chips);
  p.chips -= amt;
  p.roundBet += amt;
  p.totalBet += amt;
  if (p.chips === 0) p.allIn = true;
  return amt;
}

// ---------------- 一局流程 ----------------
function startHand(room) {
  const seated = room.players.filter((p) => p && !p.left);
  if (seated.length < MIN_PLAYERS) return;

  // 移除已离开的玩家（在两手之间）；0 筹码玩家保留座位（可重买或 sit out）
  // 清退只扣玩家真实持有的 chips：其 totalBet 在本手结算时已并入底池由赢家
  // 获得（仍在经济盘内），若一并扣除会造成 economyTotal 少计、破坏守恒
  room.players.filter((p) => !p || p.left).forEach((p) => {
    if (p) room.economyTotal -= p.chips;
  });
  room.players = room.players.filter((p) => p && !p.left);
  // 可参与本局的玩家：有筹码、未暂离、已连接
  const playable = room.players.filter((p) => p && p.chips > 0 && !p.sittingOut && p.connected);
  if (playable.length < MIN_PLAYERS) {
    // 凑不齐人进入等待时也必须先清掉上一局残留状态：
    // 此时赢家筹码已经发放，若 totalBet 还挂着不清，广播出的 waiting
    // 状态会同时包含"新筹码+旧下注"，底池虚高且筹码守恒被破坏。
    room.players.forEach((p) => {
      if (!p) return;
      p.folded = true;
      p.inHand = false;
      p.roundBet = 0;
      p.totalBet = 0;
      p.allIn = false;
      p.hole = [];
      p.isSB = false;
      p.isBB = false;
    });
    room.pot = 0;
    room.currentBet = 0;
    room.minRaise = room.settings.bigBlind;
    room.community = [];
    room.revealed = false;
    room.results = null;
    room.queue = [];
    setTurn(room, -1);
    room.stage = 'waiting';
    broadcast(room);
    return;
  }
  if (room.players.length > MAX_PLAYERS) room.players = room.players.slice(0, MAX_PLAYERS);

  const sbAmt = room.settings.smallBlind;
  const bbAmt = room.settings.bigBlind;
  room.handNumber++;
  room.stage = 'preflop';
  room.community = [];
  room.pot = 0;
  room.currentBet = bbAmt;
  room.minRaise = bbAmt;
  room.results = null;
  room.revealed = false;
  room.queue = [];
  room.preGrace = null; // 新一手开始，旧的断线保护恢复记录作废

  room.players.forEach((p) => {
    if (!p) return;
    // 暂离或 0 筹码玩家不参与本局
    if (p.sittingOut || p.chips <= 0 || !p.connected) {
      p.inHand = false;
      p.folded = true;
    } else {
      p.folded = false;
      p.inHand = true;
    }
    p.roundBet = 0;
    p.totalBet = 0;
    p.allIn = false;
    p.hole = [];
    p.isSB = false;
    p.isBB = false;
  });

  // 本场战绩：参与本手的玩家计一手
  room.players.forEach((p) => {
    if (p && p.inHand) {
      const st = room.session.get(p.name);
      if (st) st.hands++;
    }
  });

  // 庄家位轮转（跳过暂离/0筹码/未连接的玩家）
  const isPlayable = (p) => p && !p.left && !p.sittingOut && p.chips > 0 && p.connected;
  room.dealerSeat = room.handNumber === 1
    ? room.players.findIndex(isPlayable)
    : nextSeat(room, room.dealerSeat, isPlayable);

  // 盲注位：单挑时庄家是小盲；多人时庄家下一位小盲、再下一位大盲
  const n = room.players.length;
  let sbSeat, bbSeat;
  if (n === 2) {
    sbSeat = room.dealerSeat;
    bbSeat = nextSeat(room, sbSeat, isPlayable);
  } else {
    sbSeat = nextSeat(room, room.dealerSeat, isPlayable);
    bbSeat = nextSeat(room, sbSeat, isPlayable);
  }

  room.deck = newDeck();
  for (let round = 0; round < 2; round++) {
    for (let i = 1; i <= n; i++) {
      const idx = (sbSeat + i) % n; // 从小盲开始顺时针发牌
      const p2 = room.players[idx];
      if (p2 && p2.inHand) p2.hole.push(room.deck.pop());
    }
  }

  addLog(room, `第 ${room.handNumber} 局开始，盲注 ${sbAmt}/${bbAmt}`);

  const sbP = room.players[sbSeat];
  const bbP = room.players[bbSeat];
  const sbPaid = pay(sbP, sbAmt);
  const bbPaid = pay(bbP, bbAmt);
  addLog(room, `${sbP.name} 小盲 ${sbPaid}，${bbP.name} 大盲 ${bbPaid}`);
  sbP.isSB = true; bbP.isBB = true;

  buildQueueFrom(room, nextSeat(room, bbSeat, canAct));

  broadcast(room);
  armTurnTimer(room);
}

function buildQueueFrom(room, firstSeat) {
  const q = [];
  const n = room.players.length;
  let idx = firstSeat;
  if (idx < 0) { room.queue = []; setTurn(room, -1); nextStreet(room); return; }
  for (let i = 0; i < n; i++) {
    const s = (firstSeat + i) % n;
    if (canAct(room.players[s])) q.push(s);
  }
  void idx;
  room.queue = q;
  setTurn(room, q.length ? q[0] : -1);
}

function setTurn(room, seat) {
  room.turnSeat = seat;
  if (seat >= 0) armTurnTimer(room);
  else clearTurnTimer(room);
}

function streetBetsToPot(room) {
  room.pot = room.players.reduce((sum, p) => sum + (p ? p.totalBet : 0), 0);
}

function nextStreet(room) {
  room.players.forEach((p) => { if (p) p.roundBet = 0; });
  room.currentBet = 0;
  room.minRaise = room.settings.bigBlind;
  streetBetsToPot(room);

  const alive = room.players.filter((p) => p && !p.folded && p.inHand);
  if (alive.length <= 1) { showdown(room); return; }

  if (room.stage === 'preflop') {
    room.stage = 'flop';
    room.community.push(newDeckPop3(room));
    room.community = room.community.flat();
  } else if (room.stage === 'flop') {
    room.stage = 'turn';
    room.community.push(room.deck.pop());
  } else if (room.stage === 'turn') {
    room.stage = 'river';
    room.community.push(room.deck.pop());
  } else if (room.stage === 'river') {
    showdown(room);
    return;
  }
  addLog(room, stageLabel(room.stage) +
    (room.stage !== 'preflop' ? `：${room.community.map(cardText).join(' ')}` : ''));

  // 若能行动的玩家不足 2 人（全押局面），自动连续发完到摊牌
  const actors = room.players.filter(canAct).length;
  if (actors < 2) { nextStreet(room); return; }

  buildQueueFrom(room, nextSeat(room, room.dealerSeat, canAct));
}

function newDeckPop3(room) {
  return [room.deck.pop(), room.deck.pop(), room.deck.pop()];
}

function stageLabel(stage) {
  return { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌' }[stage] || stage;
}
function cardText(c) {
  const label = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[c.r] || c.r;
  const suit = { s: '♠', h: '♥', d: '♦', c: '♣' }[c.s];
  return `${suit}${label}`;
}

function applyAction(room, seat, action, amount, opts = {}) {
  const p = room.players[seat];
  // auto=服务端超时/断线保护窗口触发的自动动作：允许对已断线玩家执行，
  // 否则 canAct 的 connected 要求会让"断线超时自动弃牌"永远被拒、牌局卡死
  const actable = p && room.turnSeat === seat &&
    (opts.auto
      ? (!p.folded && !p.allIn && p.inHand && p.chips > 0)
      : canAct(p));
  if (!actable) return { ok: false, err: '还没轮到你行动' };

  switch (action) {
    case 'fold':
      p.folded = true;
      addLog(room, `${p.name} 弃牌`);
      break;
    case 'check': {
      if (p.roundBet !== room.currentBet) return { ok: false, err: '当前有人加注，不能过牌' };
      addLog(room, `${p.name} 过牌`);
      break;
    }
    case 'call': {
      const need = room.currentBet - p.roundBet;
      if (need <= 0) return { ok: false, err: '无需跟注，可以过牌' };
      const paid = pay(p, need);
      addLog(room, `${p.name} 跟注 ${paid}${p.allIn ? '（全押）' : ''}`);
      break;
    }
    case 'raise':
    case 'allin': {
      let target;
      if (action === 'allin') target = p.roundBet + p.chips;
      else {
        if (!Number.isInteger(amount) || amount <= 0) return { ok: false, err: '加注金额无效' };
        target = Math.min(amount, p.roundBet + p.chips); // 超出部分按全押截断
      }
      const need = target - p.roundBet;
      if (need <= 0) return { ok: false, err: '金额需大于已下注额' };
      const isAllIn = need >= p.chips;
      if (target > room.currentBet) {
        const raiseSize = target - room.currentBet;
        if (!isAllIn && raiseSize < room.minRaise) {
          return { ok: false, err: `最小加注到 ${room.currentBet + room.minRaise}` };
        }
        pay(p, need);
        room.minRaise = Math.max(room.minRaise, raiseSize);
        room.currentBet = target;
        addLog(room, `${p.name} 加注到 ${target}${isAllIn ? '（全押）' : ''}`);
        // 有新加注：其余未弃牌未全押玩家重新获得行动权
        const n = room.players.length;
        room.queue = [];
        for (let i = 1; i <= n; i++) {
          const s = (seat + i) % n;
          if (canAct(room.players[s])) room.queue.push(s);
        }
      } else {
        // target <= currentBet：只有全押跟注（押上全部筹码）才允许，
        // 否则属于"少于跟注额的加注"，直接拒绝，防止玩家少付钱留在局中
        if (!isAllIn) {
          return { ok: false, err: `加注至少到 ${room.currentBet}` };
        }
        pay(p, need);
        addLog(room, `${p.name} 全押跟注 ${need}`);
      }
      break;
    }
    default:
      return { ok: false, err: '未知操作' };
  }

  consumeQueueAndAdvance(room, seat);
  broadcast(room);
  return { ok: true };
}

function consumeQueueAndAdvance(room, actedSeat) {
  room.queue = room.queue.filter((s) => s !== actedSeat);
  const alive = room.players.filter((p) => p && !p.folded && p.inHand);

  if (alive.length === 1) {
    // 其余全部弃牌，直接赢池
    streetBetsToPot(room);
    const winner = alive[0];
    winner.chips += room.pot;
    const wst = room.session.get(winner.name);
    if (wst && room.winMarkedHand !== room.handNumber) { wst.wins++; room.winMarkedHand = room.handNumber; }
    addLog(room, `${winner.name} 赢得底池 ${room.pot}（其余玩家均弃牌）`);
    room.results = {
      pots: [{ amount: room.pot, winners: [{ seat: room.players.indexOf(winner), name: winner.name, chips: winner.chips, handName: null }] }],
      forfeit: true,
    };
    endHand(room);
    return;
  }

  if (room.queue.length === 0) {
    setTurn(room, -1);
    nextStreet(room);
  } else {
    setTurn(room, room.queue[0]);
  }
}

// ---------------- 摊牌与边池 ----------------
function computePots(room) {
  // 以每位玩家的总投入分层构建边池
  const contrib = room.players
    .map((p, seat) => ({ seat, p, amt: p.totalBet }))
    .filter((c) => c.amt > 0);
  const pots = [];
  while (contrib.some((c) => c.amt > 0)) {
    const lvl = Math.min(...contrib.filter((c) => c.amt > 0).map((c) => c.amt));
    let amount = 0;
    const eligible = [];
    for (const c of contrib) {
      if (c.amt >= lvl) {
        amount += lvl;
        c.amt -= lvl;
        if (!c.p.folded) eligible.push(c.seat);
      } else if (c.amt > 0) {
        amount += c.amt;
        c.amt = 0;
      }
    }
    if (amount > 0) pots.push({ amount, eligible });
  }
  return pots;
}

function showdown(room) {
  room.stage = 'showdown';
  room.revealed = true;
  streetBetsToPot(room);
  clearTurnTimer(room);

  const aliveSeats = room.players
    .map((p, seat) => ({ p, seat }))
    .filter((x) => x.p && !x.p.folded && x.p.inHand)
    .map((x) => x.seat);

  const evals = {};
  for (const seat of aliveSeats) {
    evals[seat] = evaluate7([...room.players[seat].hole, ...room.community]);
    addLog(room, `${room.players[seat].name} 摊牌 ${evals[seat].name}（${room.players[seat].hole.map(cardText).join('')}）`);
  }

  const pots = computePots(room);
  const potResults = [];
  for (const pot of pots) {
    const eligibleAlive = pot.eligible.filter((s) => aliveSeats.includes(s));
    let winners;
    if (eligibleAlive.length === 0) {
      // 极端情况：该层只有弃牌者投入（理论少见），归给主池赢家
      winners = aliveSeats;
    } else {
      let bestScore = null;
      for (const s of eligibleAlive) {
        if (!bestScore || cmpScore(evals[s].score, bestScore) > 0) bestScore = evals[s].score;
      }
      winners = eligibleAlive.filter((s) => cmpScore(evals[s].score, bestScore) === 0);
    }
    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;
    for (const s of winners) {
      room.players[s].chips += share + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
    }
    potResults.push({
      amount: pot.amount,
      winners: winners.map((s) => ({
        seat: s,
        name: room.players[s].name,
        chips: room.players[s].chips,
        handName: evals[s] ? evals[s].name : null,
        bestCards: evals[s] ? evals[s].best5 : null,
        hole: room.players[s].hole,
      })),
    });
  }

  for (const pr of potResults) {
    const label = potResults.length > 1 ? (potResults.indexOf(pr) === 0 ? '主池' : '边池') : '底池';
    addLog(room, `${label} ${pr.amount} 归 ${pr.winners.map((w) => w.name).join('、')}`);
  }

  // 本场战绩：本手赢过任意底池的玩家计一胜（每手只记一次）
  if (room.winMarkedHand !== room.handNumber) {
    const wonNames = new Set(potResults.flatMap((pr) => pr.winners.map((w) => w.name)));
    for (const n of wonNames) {
      const st = room.session.get(n);
      if (st) st.wins++;
    }
    room.winMarkedHand = room.handNumber;
  }

  room.results = { pots: potResults, forfeit: false };
  endHand(room);
}

function endHand(room) {
  room.stage = 'handover';
  clearTurnTimer(room);
  broadcast(room);
  scheduleNextHandIfReady(room);
}

/**
 * 局间自动开下一局：有足够可参与玩家就排定时器。
 * 0 筹码玩家不阻塞——他们可以选择重买或暂离，定时器照常倒计时。
 * 如果实在凑不齐 2 人可参与（都走了或都 0 筹码），进入 gameOver。
 */
function scheduleNextHandIfReady(room) {
  clearTimeout(room.nextHandTimer);
  room.nextHandTimer = null;
  if (room.stage !== 'handover') return;
  const playable = room.players.filter((p) => p && !p.left && !p.sittingOut && p.chips > 0 && p.connected);
  if (playable.length < MIN_PLAYERS) {
    // 看看有没有可能通过重买凑齐
    const zeroChips = room.players.filter((p) => p && !p.left && p.chips === 0 && p.connected);
    if (zeroChips.length > 0 && playable.length + zeroChips.length >= MIN_PLAYERS) {
      // 有人可以重买，等待
      addLog(room, '等待筹码为 0 的玩家重买后继续');
      broadcast(room);
      return;
    }
    // 真的没人能玩了
    if (!room.gameOver) {
      const champ = playable[0] || room.players.find((p) => p && !p.left && p.chips > 0);
      if (champ) addLog(room, `🏆 ${champ.name} 赢得整场游戏！`);
      room.gameOver = true;
      broadcast(room);
    }
    return;
  }
  room.nextHandTimer = setTimeout(() => {
    room.nextHandTimer = null;
    startHand(room);
  }, ((room.settings && room.settings.nextHandDelay) || 20) * 1000);
}

// ---------------- 回合超时 ----------------
function turnTimeoutMs(room) {
  return ((room.settings && room.settings.actionTime) || 45) * 1000;
}

/** 以指定时长武装行动定时器（唯一入口，避免双重计时） */
function armTurnTimerFor(room, ms) {
  clearTurnTimer(room);
  room.turnDeadline = Date.now() + ms;
  room.timer = setTimeout(() => {
    const p = room.players[room.turnSeat];
    if (!p) return;
    const autoAction = p.roundBet === room.currentBet ? 'check' : 'fold';
    addLog(room, `${p.name}${p.connected ? ' 超时' : ' 断线超时'}，自动${autoAction === 'check' ? '过牌' : '弃牌'}`);
    applyAction(room, room.turnSeat, autoAction, undefined, { auto: true });
  }, ms);
}

function armTurnTimer(room) {
  if (room.turnSeat < 0) return;
  const p = room.players[room.turnSeat];
  // 断线玩家轮到行动时只给保护窗口，不占用完整行动时间；
  // 重连后由 joinPlayer 恢复原截止时间，不会因断线续命
  const ms = p && !p.connected ? DISCONNECT_GRACE_MS : turnTimeoutMs(room);
  armTurnTimerFor(room, ms);
}
function clearTurnTimer(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
}

// ---------------- 状态广播 ----------------
function sanitizeState(room, viewerSocketId) {
  const viewerIdx = room.players.findIndex((p) => p && p.socketId === viewerSocketId);
  const viewer = room.players[viewerIdx];
  return {
    code: room.code,
    stage: room.stage,
    handNumber: room.handNumber,
    smallBlind: room.settings.smallBlind,
    bigBlind: room.settings.bigBlind,
    startChips: room.settings.startChips,
    settings: room.settings,
    isHost: !!viewer && viewer.name === room.hostName,
    hostName: room.hostName,
    dealerSeat: room.dealerSeat,
    community: room.community,
    // 结算阶段筹码已发放，底池归零以免与弹窗结果对不上
    pot: ['showdown', 'handover'].includes(room.stage)
      ? 0
      : room.players.reduce((s, p) => s + (p ? p.totalBet : 0), 0),
    currentBet: room.currentBet,
    minRaise: room.minRaise,
    turnSeat: room.turnSeat,
    youSeat: viewerIdx,
    gameOver: !!room.gameOver,
    economyTotal: room.economyTotal,
    // 本场战绩：在场玩家带实时筹码，离场玩家带存档盈亏；全场 Σ盈亏恒为 0。
    // 对局中已投入底池的 totalBet 尚未结算，实时盈亏需将其计入
    session: [
      ...[...room.session.entries()].map(([n, st]) => {
        const sp = room.players.find((x) => x && !x.left && x.name === n);
        const owned = sp ? sp.chips + (['showdown', 'handover'].includes(room.stage) ? 0 : sp.totalBet) : 0;
        return { name: n, buyIn: st.buyIn, chips: sp ? sp.chips : 0, pl: owned - st.buyIn, hands: st.hands, wins: st.wins, left: false };
      }),
      ...room.sessionLeft.map((e) => ({ ...e, chips: null, left: true })),
    ],
    results: room.results,
    revealed: room.revealed,
    logs: room.logs.slice(-12),
    players: room.players.map((p, seat) => ({
      seat,
      name: p.name,
      avatar: p.avatar,
      chips: p.chips,
      roundBet: p.roundBet,
      totalBet: p.totalBet,
      folded: p.folded,
      allIn: p.allIn,
      connected: p.connected,
      inHand: p.inHand,
      sittingOut: !!p.sittingOut,
      isDealer: seat === room.dealerSeat,
      hole: p.hole && (seat === viewerIdx || room.revealed) ? p.hole : null,
      holeCount: p.hole ? p.hole.length : 0,
    })),
  };
}

function broadcast(room) {
  for (const p of room.players) {
    if (p && p.socketId && p.connected) {
      io.to(p.socketId).emit('state', sanitizeState(room, p.socketId));
    }
  }
}

function publicRoomInfo(room) {
  return {
    code: room.code,
    stage: room.stage,
    playerCount: seatCount(room),
    maxPlayers: MAX_PLAYERS,
  };
}

// ---------------- Socket 处理 ----------------
io.on('connection', (socket) => {
  socket.on('create_room', ({ name }, cb) => {
    const room = createRoom(name || '玩家');
    const res = joinPlayer(room, socket, name || '玩家');
    cb && cb({ ok: true, code: room.code, token: res.token });
  });

  // 加入限频：同一 socket 短时间内大量尝试不存在的房间视为扫房，拒绝
  const joinAttempts = new Map(); // socketId -> { count, resetAt }
  function registerFailedJoin(sid) {
    const now = Date.now();
    let rec = joinAttempts.get(sid);
    if (!rec || now > rec.resetAt) { rec = { count: 0, resetAt: now + 60000 }; joinAttempts.set(sid, rec); }
    rec.count++;
    return rec.count <= 15;
  }

  socket.on('join_room', ({ code, name, token }, cb) => {
    // 统一大写、去空格：邀请码不区分大小写输入
    const normalized = String(code || '').trim().toUpperCase();
    const room = rooms.get(normalized);
    if (!room) {
      if (!registerFailedJoin(socket.id)) {
        return cb && cb({ ok: false, err: '尝试过于频繁，请稍后再试' });
      }
      return cb && cb({ ok: false, err: '房间不存在，请核对邀请码' });
    }
    joinAttempts.delete(socket.id);
    // 断线重连：同名匹配到离线玩家时，任何阶段都允许恢复座位
    const offlineSameName = room.players.find((p) => p && !p.left && p.name === name && !p.connected);
    // 满员判断按有效座位算（排除已离开的占位）；同名断线座位即将被 token 恢复，
    // 不计入满员，否则满员桌任何玩家刷新后都会被"房间已满"锁在门外（经用户授权的最小修复）
    if (room.players.filter((p) => p && !p.left && p !== offlineSameName).length >= MAX_PLAYERS) {
      return cb && cb({ ok: false, err: '房间已满（最多 6 人）' });
    }
    const stageOpen = ['waiting', 'handover'].includes(room.stage);
    if (!offlineSameName && !stageOpen) {
      return cb && cb({ ok: false, err: '本局进行中，请稍等局结束后加入' });
    }
    const res = joinPlayer(room, socket, name || '玩家', token);
    if (res.err) return cb && cb({ ok: false, err: res.err });
    cb && cb({ ok: true, code: room.code, token: res.token });
  });

  socket.on('start_game', (_, cb) => {
    const room = findRoomBySocket(socket.id);
    if (!room) return cb && cb({ ok: false, err: '不在房间中' });
    // 只能在等待/局间开局，防止对局中重复开局重扣盲注
    if (!['waiting', 'handover'].includes(room.stage)) {
      return cb && cb({ ok: false, err: '本局正在进行中' });
    }
    if (seatCount(room) < MIN_PLAYERS) return cb && cb({ ok: false, err: '至少需要 2 名玩家' });
    // 清掉局间自动开局的定时器，避免手动开局后定时器再触发一次摧毁当前局
    clearTimeout(room.nextHandTimer);
    room.nextHandTimer = null;
    room.gameOver = false;
    startHand(room);
    cb && cb({ ok: true });
  });

  socket.on('next_hand', (_, cb) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.stage !== 'handover') return cb && cb({ ok: false, err: '当前不能开局' });
    clearTimeout(room.nextHandTimer);
    room.nextHandTimer = null;
    startHand(room);
    cb && cb({ ok: true });
  });

  // 重买：筹码输光的玩家在两手之间补充筹码
  socket.on('rebuy', (_, cb) => {
    const room = findRoomBySocket(socket.id);
    const p = room && room.players.find((x) => x && x.socketId === socket.id);
    if (!p) return cb && cb({ ok: false, err: '已不在房间中，请刷新页面用邀请码重新加入' });
    if (!['waiting', 'handover'].includes(room.stage)) return cb && cb({ ok: false, err: '只能在本局结束后重买' });
    if (room.settings.rebuyAllowed === false) return cb && cb({ ok: false, err: '本房间已禁止重买' });
    if (p.chips > 0) return cb && cb({ ok: false, err: '你还有筹码，无需重买' });
    const amount = room.settings.startChips;
    p.chips = amount;
    p.sittingOut = false;
    room.gameOver = false;
    room.economyTotal += amount;
    const st = room.session.get(p.name);
    if (st) st.buyIn += amount;
    addLog(room, `${p.name} 重买 ${amount} 筹码`);
    // 先回执再广播：客户端要先确认重买到账再收到含新筹码的状态，
    // 保证"筹码变化"与"到账通知"在订阅端严格有序
    cb && cb({ ok: true });
    broadcast(room);
    // 重买后重新检查是否可以自动开局
    if (room.stage === 'handover') scheduleNextHandIfReady(room);
  });

  // 房管设置：房主在等待阶段修改起始筹码 / 盲注
  socket.on('update_settings', ({ startChips, smallBlind, bigBlind, actionTime, nextHandDelay, rebuyAllowed }, cb) => {
    const room = findRoomBySocket(socket.id);
    const p = room && room.players.find((x) => x && x.socketId === socket.id);
    if (!room || !p) return cb && cb({ ok: false, err: '不在房间中' });
    if (p.name !== room.hostName) return cb && cb({ ok: false, err: '只有房主可以修改设置' });
    if (room.stage !== 'waiting') return cb && cb({ ok: false, err: '只能在对局开始前修改' });

    const sc = Math.round(Number(startChips));
    const sb = Math.round(Number(smallBlind));
    const bb = Math.round(Number(bigBlind));
    if (!Number.isFinite(sc) || sc < 100 || sc > 1000000) {
      return cb && cb({ ok: false, err: '起始筹码需在 100 ~ 1,000,000 之间' });
    }
    if (!Number.isFinite(sb) || sb < 1 || !Number.isFinite(bb) || bb < sb) {
      return cb && cb({ ok: false, err: '盲注无效：大盲需 ≥ 小盲 ≥ 1' });
    }
    if (bb * 20 > sc) return cb && cb({ ok: false, err: '起始筹码至少为大盲注的 20 倍' });

    const at = Number(actionTime);
    if (!Number.isFinite(at) || ![20, 30, 45, 60].includes(at)) {
      return cb && cb({ ok: false, err: '行动时长仅支持 20 / 30 / 45 / 60 秒' });
    }
    const nh = Number(nextHandDelay);
    if (!Number.isFinite(nh) || ![5, 10, 20].includes(nh)) {
      return cb && cb({ ok: false, err: '局间倒计时仅支持 5 / 10 / 20 秒' });
    }
    const rb = rebuyAllowed !== false;

    room.settings = {
      startChips: sc, smallBlind: sb, bigBlind: bb,
      actionTime: at, nextHandDelay: nh, rebuyAllowed: rb,
    };
    // 还没开过局：已就座玩家统一按新起始筹码重置（战绩买入同步重算）
    if (room.handNumber === 0) {
      room.players.forEach((x) => { if (x && !x.left) x.chips = sc; });
      room.economyTotal = sc * room.players.filter((x) => x && !x.left).length;
      room.session.forEach((st) => { st.buyIn = sc; });
      room.sessionLeft = [];
    }
    addLog(room, `房主修改设置：起始筹码 ${sc}，盲注 ${sb}/${bb}，行动 ${at}s，局间 ${nh}s${rb ? '' : '，禁止重买'}`);
    broadcast(room);
    cb && cb({ ok: true, settings: room.settings });
  });

  socket.on('action', ({ type, amount }, cb) => {
    const room = findRoomBySocket(socket.id);
    if (!room) return cb && cb({ ok: false, err: '不在房间中' });
    const seat = room.players.findIndex((p) => p && p.socketId === socket.id);
    const res = applyAction(room, seat, type, amount);
    cb && cb(res);
  });

  // 表情快捷互动：转发给全房间，在自己头像上冒泡展示
  const EMOJIS = ['😀', '😂', '😭', '👍', '🎉', '🤔', '😈', '🔥'];
  const emojiLast = new Map(); // socketId -> 上次发送时间（限频 1 次/秒）
  socket.on('emoji', ({ emoji }, cb) => {
    const room = findRoomBySocket(socket.id);
    if (!room) return cb && cb({ ok: false, err: '不在房间中' });
    if (!EMOJIS.includes(emoji)) return cb && cb({ ok: false, err: '不支持的表情' });
    const now = Date.now();
    if (now - (emojiLast.get(socket.id) || 0) < 1000) {
      return cb && cb({ ok: false, err: '发太快啦' });
    }
    emojiLast.set(socket.id, now);
    const seat = room.players.findIndex((p) => p && p.socketId === socket.id);
    for (const p of room.players) {
      if (p && p.socketId && p.connected) io.to(p.socketId).emit('emoji', { seat, emoji });
    }
    cb && cb({ ok: true });
  });

  // 暂离（不参与下局，保留座位和筹码）
  socket.on('sit_out', (_, cb) => {
    const room = findRoomBySocket(socket.id);
    const p = room && room.players.find((x) => x && x.socketId === socket.id);
    if (!p) return cb && cb({ ok: false, err: '不在房间中' });
    p.sittingOut = true;
    // 如果在对局中，标记为已弃牌
    if (p.inHand && !p.folded) {
      p.folded = true;
      addLog(room, `${p.name} 暂离，自动弃牌`);
      room.queue = room.queue.filter((s) => s !== room.players.indexOf(p));
      consumeQueueAndAdvance(room, room.players.indexOf(p));
    } else {
      addLog(room, `${p.name} 暂离（下局不参与）`);
      broadcast(room);
    }
    cb && cb({ ok: true });
  });

  // 坐回（重新参与）
  socket.on('sit_back', (_, cb) => {
    const room = findRoomBySocket(socket.id);
    const p = room && room.players.find((x) => x && x.socketId === socket.id);
    if (!p) return cb && cb({ ok: false, err: '不在房间中' });
    p.sittingOut = false;
    addLog(room, `${p.name} 坐回`);
    broadcast(room);
    cb && cb({ ok: true });
  });

  // 踢人（仅房主）
  socket.on('kick_player', ({ seat }, cb) => {
    const room = findRoomBySocket(socket.id);
    const p = room && room.players.find((x) => x && x.socketId === socket.id);
    if (!room || !p) return cb && cb({ ok: false, err: '不在房间中' });
    if (p.name !== room.hostName) return cb && cb({ ok: false, err: '只有房主可以踢人' });
    const target = room.players[seat];
    if (!target || target.left) return cb && cb({ ok: false, err: '该座位无人' });
    if (target.name === room.hostName) return cb && cb({ ok: false, err: '不能踢自己' });
    addLog(room, `${target.name} 被房主移出房间`);
    target.left = true;
    target.connected = false;
    if (target.socketId) {
      io.to(target.socketId).emit('kicked', { reason: '房主将你移出房间' });
      const s = io.sockets.sockets.get(target.socketId);
      if (s) s.disconnect(true);
    }
    // 清理尾部已离开的空位（同时把其资产从经济总盘子中清退）。
    // 对局中被踢：其 totalBet 还是底池里的活钱（之后按在场玩家重新汇总），
    // 弹出后需一并扣账；局间清理时 totalBet 已结算并入赢家筹码，只扣 chips。
    const midHandKick = ['preflop', 'flop', 'turn', 'river'].includes(room.stage);
    while (room.players.length && (!room.players[room.players.length - 1] || room.players[room.players.length - 1].left)) {
      const dropped = room.players[room.players.length - 1];
      if (dropped) room.economyTotal -= dropped.chips + (midHandKick ? dropped.totalBet : 0);
      room.players.pop();
    }
    // 对局中被踢：标记弃牌并推进行动队列，防止无手牌玩家参与摊牌分池
    if (midHandKick && target.inHand && !target.folded) {
      target.folded = true;
      room.queue = room.queue.filter((s) => s !== seat);
      consumeQueueAndAdvance(room, seat);
    }
    bankSession(room, target);
    if (room.stage === 'waiting' && room.dealerSeat >= room.players.length) room.dealerSeat = -1;
    clearTimeout(room.nextHandTimer);
    room.nextHandTimer = null;
    scheduleNextHandIfReady(room);
    broadcast(room);
    cb && cb({ ok: true });
  });

  socket.on('leave_room', () => handleLeave(socket));

  socket.on('disconnect', () => {
    joinAttempts.delete(socket.id);
    handleLeave(socket, true);
  });
});

/**
 * 加入/恢复座位。返回 { token } 表示成功，返回 { err } 表示失败。
 * 安全规则：同名玩家在线时拒绝进入（防冒名）；接管离线座位需 token 匹配，
 * 防止他人凭昵称劫持座位看底牌/代打。
 */
function joinPlayer(room, socket, name, token) {
  const existing = room.players.find((p) => p && !p.left && p.name === name);
  if (existing) {
    // "connected" 可能是刷新页面时的幽灵记录（旧 socket 已死但 disconnect 未到）：
    // 只有旧 socket 真实存活时才视为在线冲突，拒绝冒名进入
    const oldSocketAlive = existing.socketId && io.sockets.sockets.has(existing.socketId);
    if (oldSocketAlive && existing.socketId !== socket.id) {
      return { err: '该昵称已在线，请换一个昵称' };
    }
    // 接管（含刷新重连、断线恢复）都必须出示原 token，防止冒名劫持座位
    if (existing.token && token !== existing.token) {
      return { err: '该昵称已被其他玩家使用，请换一个昵称' };
    }
    const wasOffline = !existing.connected;
    existing.socketId = socket.id;
    existing.connected = true;
    if (!existing.token) existing.token = newToken();
    addLog(room, wasOffline ? `${name} 重新连接` : `${name} 重新进入（接管原座位）`);
    // 断线保护窗口：若该玩家断线时正在行动，恢复断线前的剩余行动时间
    // （不重新计满 45 秒，防止靠断线续命；窗口已过或街已推进则不恢复）
    const seatIdx = room.players.indexOf(existing);
    if (room.preGrace && room.preGrace.seat === seatIdx) {
      if (room.turnSeat === seatIdx && room.preGrace.deadline - Date.now() > 1000) {
        armTurnTimerFor(room, room.preGrace.deadline - Date.now());
      }
      room.preGrace = null;
    }
    resumeStuckTurn(room);
    broadcast(room);
    return { token: existing.token };
  }
  const avatar = AVATARS[room.players.filter(Boolean).length % AVATARS.length];
  const t = newToken();
  room.players.push({
    socketId: socket.id,
    name,
    token: t,
    avatar,
    chips: room.settings.startChips,
    hole: [],
    roundBet: 0,
    totalBet: 0,
    folded: false,
    allIn: false,
    inHand: false,
    connected: true,
    sittingOut: false,
  });
  room.economyTotal += room.settings.startChips;
  // 本场战绩登记：买入从当前设置起始筹码算起
  if (!room.session.has(name)) {
    room.session.set(name, { buyIn: room.settings.startChips, hands: 0, wins: 0 });
  }
  addLog(room, `${name} 加入房间`);
  broadcast(room);
  return { token: t };
}

function newToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function findRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.some((p) => p && p.socketId === socketId)) return room;
  }
  return null;
}

/**
 * 恢复卡住的行动轮：修复前的版本里，断线玩家若正轮到行动，turnSeat 会被置 -1
 * 且没有任何定时器/事件再推进牌局（重连也不恢复）。重连时检测到这种冻结态，
 * 就把行动队列继续向前推。正常进行中的牌局 turnSeat >= 0，本函数直接返回。
 */
function resumeStuckTurn(room) {
  if (!['preflop', 'flop', 'turn', 'river'].includes(room.stage)) return;
  if (room.turnSeat >= 0) return;
  addLog(room, '牌局恢复，继续行动');
  consumeQueueAndAdvance(room, -1);
}

/**
 * 离场玩家战绩入账：以当前真实持有筹码计盈亏（pl = chips - buyIn）。
 * 其留在底池的 totalBet 之后会由在场玩家瓜分，盈亏在全场范围内仍然零和。
 */
function bankSession(room, p) {
  const st = room.session.get(p.name);
  if (!st) return;
  room.sessionLeft.push({
    name: p.name, buyIn: st.buyIn, pl: p.chips - st.buyIn, hands: st.hands, wins: st.wins,
  });
  room.session.delete(p.name);
}

function handleLeave(socket, isDisconnect = false) {
  const room = findRoomBySocket(socket.id);
  if (!room) return;
  const idx = room.players.findIndex((p) => p && p.socketId === socket.id);
  if (idx < 0) return;
  const p = room.players[idx];

  const midHand = !['waiting', 'handover'].includes(room.stage);
  if (midHand) {
    // must 在置离线之前判断能否行动：canAct 要求 connected
    const wasActable = canAct(p);
    p.connected = false;
    p.socketId = null;
    addLog(room, `${p.name} 离线`);
    if (!isDisconnect && wasActable) {
      // 主动退出：立即弃牌，不拖慢牌局
      p.folded = true;
      addLog(room, `${p.name} 退出并弃牌`);
      room.queue = room.queue.filter((s) => s !== idx);
      consumeQueueAndAdvance(room, idx);
    } else if (isDisconnect && room.turnSeat === idx) {
      // 断线保护窗口：保留行动权一小段时间，等玩家回来；
      // 记住原截止时间，重连后恢复剩余时间而非重新计满
      room.preGrace = { seat: idx, deadline: room.turnDeadline };
      armTurnTimer(room);
    }
    // 断线且不在行动中：什么都不做，保持手牌；等轮到他时 armTurnTimer 自动给保护窗口
  } else {
    // 不把槽位置为 null：座位索引被 turnSeat/youSeat/客户端按位引用，
    // 置 null 会让 sanitizeState 崩溃。改为打 left 标记，下一局开始时统一清场。
    p.left = true;
    p.connected = false;
    p.socketId = null;
    addLog(room, `${p.name} 离开房间`);
    // 离场玩家战绩入账（以当前真实持有筹码计盈亏）
    bankSession(room, p);
    // 房主离开：转移给剩余玩家中的第一位
    if (p.name === room.hostName) {
      const nextHost = room.players.find((x) => x && !x.left);
      room.hostName = nextHost ? nextHost.name : null;
      if (nextHost) addLog(room, `${nextHost.name} 成为新房主`);
    }
    // 清理尾部已离开的空位（同时把其筹码从经济总盘子中清退）
    while (room.players.length && (!room.players[room.players.length - 1] || room.players[room.players.length - 1].left)) {
      const dropped = room.players[room.players.length - 1];
      if (dropped) room.economyTotal -= dropped.chips + dropped.totalBet;
      room.players.pop();
    }
    if (room.stage === 'waiting' && room.dealerSeat >= room.players.length) room.dealerSeat = -1;
    // 局间有人离开后要重排自动开局的定时器，否则永远卡在本局结束
    clearTimeout(room.nextHandTimer);
    room.nextHandTimer = null;
    scheduleNextHandIfReady(room);
  }
  broadcast(room);

  // 房间空了就销毁
  if (seatCount(room) === 0) {
    clearTurnTimer(room);
    clearTimeout(room.nextHandTimer);
    rooms.delete(room.code);
  }
}

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`德州扑克服务器已启动: http://localhost:${PORT}`);
  });
}

// 供自动化测试使用
module.exports = { rooms, evaluate7, computePots, score5, newDeck };
