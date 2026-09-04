import { DurableObject } from 'cloudflare:workers';

const ROOM_CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const AVATARS = ['🦊', '🐼', '🐯', '🦁', '🐸', '🐵', '🐨', '🦉'];
const DEFAULT_SETTINGS = {
  startChips: 2000,
  smallBlind: 10,
  bigBlind: 20,
  actionTime: 45,
  nextHandDelay: 20,
  rebuyAllowed: true,
  locked: false,
};
const SUITS = ['s', 'h', 'd', 'c'];
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const EMOJIS = ['😀', '😂', '😭', '👍', '🎉', '🤔', '😈', '🔥'];

function newDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ r: rank, s: suit });
  for (let i = deck.length - 1; i > 0; i--) {
    const random = crypto.getRandomValues(new Uint32Array(1))[0];
    const j = random % (i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function score5(cards) {
  const ranks = cards.map((card) => card.r).sort((a, b) => a - b);
  const flush = cards.every((card) => card.s === cards[0].s);
  const unique = [...new Set(ranks)];
  let straightHigh = 0;
  if (unique.length === 5) {
    if (unique[4] - unique[0] === 4) straightHigh = unique[4];
    else if (unique.join(',') === '2,3,4,5,14') straightHigh = 5;
  }
  const counts = {};
  ranks.forEach((rank) => { counts[rank] = (counts[rank] || 0) + 1; });
  const groups = Object.entries(counts)
    .map(([rank, count]) => [count, Number(rank)])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  let category;
  let keys;
  if (flush && straightHigh) { category = 8; keys = [straightHigh]; }
  else if (groups[0][0] === 4) { category = 7; keys = [groups[0][1], groups[1][1]]; }
  else if (groups[0][0] === 3 && groups[1][0] === 2) { category = 6; keys = [groups[0][1], groups[1][1]]; }
  else if (flush) { category = 5; keys = [...ranks].reverse(); }
  else if (straightHigh) { category = 4; keys = [straightHigh]; }
  else if (groups[0][0] === 3) { category = 3; keys = [groups[0][1], ...groups.slice(1).map((group) => group[1])]; }
  else if (groups[0][0] === 2 && groups[1][0] === 2) {
    category = 2;
    keys = [groups[0][1], groups[1][1], groups.find((group) => group[0] === 1)?.[1] || 0];
  } else if (groups[0][0] === 2) {
    category = 1;
    keys = [groups[0][1], ...groups.slice(1).map((group) => group[1])];
  } else { category = 0; keys = [...ranks].reverse(); }
  const score = [category, ...keys];
  while (score.length < 6) score.push(0);
  return score;
}

function compareScore(a, b) {
  for (let i = 0; i < 6; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function rankText(rank) {
  return ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' })[rank] || String(rank);
}

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

const COMBOS_7_5 = [];
(function combinations(start, picked) {
  if (picked.length === 5) { COMBOS_7_5.push([...picked]); return; }
  for (let i = start; i < 7; i++) {
    picked.push(i);
    combinations(i + 1, picked);
    picked.pop();
  }
})(0, []);

function evaluate7(cards) {
  let best = null;
  for (const combo of COMBOS_7_5) {
    const selected = combo.map((index) => cards[index]);
    const score = score5(selected);
    if (!best || compareScore(score, best.score) > 0) best = { score, cards: selected };
  }
  return { score: best.score, name: describeScore(best.score), best5: best.cards };
}

function computePots(room) {
  const contributions = room.players
    .map((player, seat) => ({ seat, player, amount: player.totalBet }))
    .filter((entry) => entry.amount > 0);
  const pots = [];
  while (contributions.some((entry) => entry.amount > 0)) {
    const level = Math.min(...contributions.filter((entry) => entry.amount > 0).map((entry) => entry.amount));
    let amount = 0;
    const eligible = [];
    for (const entry of contributions) {
      if (entry.amount >= level) {
        amount += level;
        entry.amount -= level;
        if (!entry.player.folded) eligible.push(entry.seat);
      }
    }
    if (amount > 0) pots.push({ amount, eligible });
  }
  return pots;
}

function randomText(chars, length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((n) => chars[n % chars.length]).join('');
}

function normalizeNickname(input) {
  if (typeof input !== 'string' || input.length > 128 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(input)) {
    return { err: '昵称必须是 1-8 个可见字符' };
  }
  const name = input.normalize('NFKC').trim();
  const count = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name)].length;
  if (!name || count > 8) return { err: '昵称必须是 1-8 个可见字符' };
  return { name };
}

function makeRoom(code, hostName) {
  return {
    code,
    hostName,
    stage: 'waiting',
    handNumber: 0,
    dealerSeat: -1,
    turnSeat: -1,
    community: [],
    pot: 0,
    currentBet: 0,
    minRaise: 20,
    economyTotal: 0,
    gameOver: false,
    results: null,
    revealed: false,
    logs: [],
    players: [],
    settings: { ...DEFAULT_SETTINGS },
    session: [],
    sessionLeft: [],
  };
}

function addLog(room, message) {
  room.logs.push(message);
  if (room.logs.length > 40) room.logs.shift();
}

function stateFor(room, clientId) {
  const youSeat = room.players.findIndex((player) => player.clientId === clientId);
  const viewer = room.players[youSeat];
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
    turnSeat: room.turnSeat,
    community: room.community,
    pot: ['showdown', 'handover'].includes(room.stage) ? 0 : room.pot,
    currentBet: room.currentBet,
    minRaise: room.minRaise,
    youSeat,
    gameOver: room.gameOver,
    economyTotal: room.economyTotal,
    session: room.session.map((entry) => {
      const chips = room.players.find((player) => player.name === entry.name)?.chips ?? entry.cashOut ?? 0;
      return { ...entry, chips, pl: chips - entry.buyIn };
    }),
    results: room.results,
    revealed: room.revealed,
    logs: room.logs.slice(-12),
    players: room.players.map((player, seat) => ({
      seat,
      name: player.name,
      avatar: player.avatar,
      chips: player.chips,
      roundBet: player.roundBet,
      totalBet: player.totalBet,
      folded: player.folded,
      allIn: player.allIn,
      connected: player.connected,
      left: !!player.left,
      inHand: player.inHand,
      sittingOut: player.sittingOut,
      isDealer: seat === room.dealerSeat,
      hole: player.hole && (seat === youSeat || (room.revealed && player.inHand && !player.folded))
        ? player.hole : null,
      holeCount: player.hole?.length || 0,
    })),
  };
}

export class PokerHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.rooms = new Map();
    this.clients = new Map();
    this.emojiLast = new Map();
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get('rooms');
      for (const room of stored || []) {
        room.players.forEach((player) => {
          player.connected = false;
          player.clientId = '';
        });
        if (['preflop', 'flop', 'turn', 'river', 'showdown'].includes(room.stage)) {
          room.players.forEach((player) => {
            player.chips += player.totalBet || 0;
            player.roundBet = 0;
            player.totalBet = 0;
            player.folded = true;
            player.allIn = false;
            player.inHand = false;
            player.hole = [];
          });
          room.stage = 'waiting';
          room.community = [];
          room.pot = 0;
          room.currentBet = 0;
          room.turnSeat = -1;
          room.queue = [];
          room.results = null;
          room.revealed = false;
          addLog(room, '服务恢复：中断的一局已作废，本局投入已返还');
        } else if (room.stage === 'handover') {
          room.stage = 'waiting';
          room.results = null;
          room.revealed = false;
          addLog(room, '服务恢复：可随时开始下一局');
        }
        this.rooms.set(room.code, room);
      }
    });
  }

  async fetch(request) {
    await this.ready;
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const clientId = randomText('abcdefghijklmnopqrstuvwxyz0123456789', 20);
    server.accept();
    this.clients.set(clientId, { ws: server, roomCode: '' });
    server.addEventListener('message', (event) => this.onMessage(clientId, event.data));
    server.addEventListener('close', () => this.onClose(clientId));
    server.addEventListener('error', () => this.onClose(clientId));
    server.send(JSON.stringify({ event: 'welcome', data: { id: clientId } }));
    return new Response(null, { status: 101, webSocket: client });
  }

  send(clientId, event, data) {
    const client = this.clients.get(clientId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) return;
    client.ws.send(JSON.stringify({ event, data }));
  }

  ack(clientId, id, data) {
    if (!id) return;
    const client = this.clients.get(clientId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) return;
    client.ws.send(JSON.stringify({ ack: id, data }));
  }

  broadcast(room) {
    room.players.forEach((player) => {
      if (player.connected && player.clientId) this.send(player.clientId, 'state', stateFor(room, player.clientId));
    });
  }

  async persist() {
    const serializable = [...this.rooms.values()].map((room) => {
      const { turnTimer, nextHandTimer, ...storedRoom } = room;
      void turnTimer;
      void nextHandTimer;
      return {
        ...storedRoom,
        players: room.players.map((player) => ({ ...player, connected: false, clientId: '' })),
      };
    });
    await this.ctx.storage.put('rooms', serializable);
  }

  newRoomCode() {
    let code;
    do { code = randomText(ROOM_CODE_CHARS, 6); } while (this.rooms.has(code));
    return code;
  }

  playerFor(clientId) {
    const client = this.clients.get(clientId);
    const room = client?.roomCode ? this.rooms.get(client.roomCode) : null;
    const player = room?.players.find((entry) => entry.clientId === clientId);
    return { client, room, player };
  }

  async onMessage(clientId, raw) {
    let packet;
    try { packet = JSON.parse(raw); } catch (_) { return; }
    const { id, event, payload } = packet || {};
    try {
      if (event === 'create_room') return await this.createRoom(clientId, id, payload);
      if (event === 'join_room') return await this.joinRoom(clientId, id, payload);
      if (event === 'update_settings') return await this.updateSettings(clientId, id, payload);
      if (event === 'leave_room') return await this.leaveRoom(clientId, id);
      if (event === 'start_game') return await this.startGame(clientId, id);
      if (event === 'next_hand') return await this.nextHand(clientId, id);
      if (event === 'action') return await this.playerAction(clientId, id, payload);
      if (event === 'rebuy') return await this.rebuy(clientId, id);
      if (event === 'sit_out') return await this.sitOut(clientId, id);
      if (event === 'sit_back') return await this.sitBack(clientId, id);
      if (event === 'kick_player') return await this.kickPlayer(clientId, id, payload);
      if (event === 'emoji') return this.emoji(clientId, id, payload);
      this.ack(clientId, id, { ok: false, err: 'Cloudflare 迁移版暂未接入该牌局操作' });
    } catch (error) {
      console.error('PokerHub request failed', error);
      this.ack(clientId, id, { ok: false, err: '服务器处理失败，请稍后重试' });
    }
  }

  async createRoom(clientId, id, payload) {
    if (this.clients.get(clientId)?.roomCode) return this.ack(clientId, id, { ok: false, err: '当前连接已在房间中' });
    const nick = normalizeNickname(payload?.name);
    if (nick.err) return this.ack(clientId, id, { ok: false, err: nick.err });
    const code = this.newRoomCode();
    const room = makeRoom(code, nick.name);
    this.rooms.set(code, room);
    const result = this.addPlayer(room, clientId, nick.name);
    await this.persist();
    this.broadcast(room);
    this.ack(clientId, id, { ok: true, code, token: result.token });
  }

  async joinRoom(clientId, id, payload) {
    if (this.clients.get(clientId)?.roomCode) return this.ack(clientId, id, { ok: false, err: '当前连接已在房间中' });
    const nick = normalizeNickname(payload?.name);
    if (nick.err) return this.ack(clientId, id, { ok: false, err: nick.err });
    const code = typeof payload?.code === 'string' ? payload.code.trim().toUpperCase() : '';
    const room = this.rooms.get(code);
    if (!room) return this.ack(clientId, id, { ok: false, err: '房间不存在，请核对邀请码' });
    const existing = room.players.find((player) => player.name === nick.name);
    if (existing) {
      if (existing.left) return this.ack(clientId, id, { ok: false, err: '该玩家已离开本房间，请换一个昵称' });
      if (existing.connected) return this.ack(clientId, id, { ok: false, err: '该昵称已在线，请换一个昵称' });
      if (existing.token !== payload.token) return this.ack(clientId, id, { ok: false, err: '该昵称已被其他玩家使用，请换一个昵称' });
      existing.connected = true;
      existing.clientId = clientId;
      this.clients.get(clientId).roomCode = code;
      addLog(room, `${existing.name} 重新连接`);
      if (room.turnSeat === room.players.indexOf(existing)) this.setTurn(room, room.turnSeat);
      await this.persist();
      this.broadcast(room);
      return this.ack(clientId, id, { ok: true, code, token: existing.token });
    }
    if (room.session.some((entry) => entry.name === nick.name)) {
      return this.ack(clientId, id, { ok: false, err: '该昵称本场已使用，请换一个昵称' });
    }
    if (room.settings.locked) return this.ack(clientId, id, { ok: false, err: '房主已锁定房间，暂不接受新玩家' });
    if (room.players.filter((player) => !player.left).length >= 6) return this.ack(clientId, id, { ok: false, err: '房间已满（最多 6 人）' });
    if (!['waiting', 'handover'].includes(room.stage)) return this.ack(clientId, id, { ok: false, err: '本局进行中，请稍等局结束后加入' });
    const result = this.addPlayer(room, clientId, nick.name);
    await this.persist();
    this.broadcast(room);
    this.ack(clientId, id, { ok: true, code, token: result.token });
  }

  addPlayer(room, clientId, name) {
    const token = randomText('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_', 32);
    room.players.push({
      clientId,
      name,
      token,
      avatar: AVATARS[room.players.length % AVATARS.length],
      chips: room.settings.startChips,
      roundBet: 0,
      totalBet: 0,
      folded: false,
      allIn: false,
      connected: true,
      inHand: false,
      sittingOut: false,
      left: false,
      hole: [],
    });
    room.economyTotal += room.settings.startChips;
    room.session.push({ name, buyIn: room.settings.startChips, hands: 0, wins: 0 });
    this.clients.get(clientId).roomCode = room.code;
    addLog(room, `${name} 加入房间`);
    return { token };
  }

  compactLeftPlayers(room) {
    if (!room.players.some((player) => player.left)) return;
    let nextDealer = null;
    if (room.handNumber > 0 && room.players.length) {
      const seat = this.nextSeat(room, room.dealerSeat, (player) => player && !player.left);
      if (seat >= 0) nextDealer = room.players[seat];
    }
    room.players = room.players.filter((player) => !player.left);
    if (nextDealer && room.players.length) {
      const desired = room.players.indexOf(nextDealer);
      room.dealerSeat = (desired - 1 + room.players.length) % room.players.length;
    } else if (room.dealerSeat >= room.players.length) room.dealerSeat = -1;
  }

  markPlayerLeft(room, player) {
    if (player.left) return;
    player.left = true;
    player.connected = false;
    player.clientId = '';
    player.sittingOut = true;
    const stat = room.session.find((entry) => entry.name === player.name);
    if (stat) stat.cashOut = player.chips;
    room.economyTotal -= player.chips;
  }

  async updateSettings(clientId, id, payload) {
    const { room, player } = this.playerFor(clientId);
    if (!room || !player) return this.ack(clientId, id, { ok: false, err: '不在房间中' });
    if (player.name !== room.hostName) return this.ack(clientId, id, { ok: false, err: '只有房主可以修改设置' });
    if (room.stage !== 'waiting') return this.ack(clientId, id, { ok: false, err: '只能在对局开始前修改' });
    const settings = {
      startChips: Math.round(Number(payload?.startChips)),
      smallBlind: Math.round(Number(payload?.smallBlind)),
      bigBlind: Math.round(Number(payload?.bigBlind)),
      actionTime: Number(payload?.actionTime),
      nextHandDelay: Number(payload?.nextHandDelay),
      rebuyAllowed: payload?.rebuyAllowed,
      locked: payload?.locked === true,
    };
    if (!Number.isFinite(settings.startChips) || settings.startChips < 100 || settings.startChips > 1000000) {
      return this.ack(clientId, id, { ok: false, err: '起始筹码需在 100 ~ 1,000,000 之间' });
    }
    if (!Number.isFinite(settings.smallBlind) || settings.smallBlind < 1 || settings.bigBlind < settings.smallBlind) {
      return this.ack(clientId, id, { ok: false, err: '盲注无效：大盲需 ≥ 小盲 ≥ 1' });
    }
    if (settings.bigBlind * 20 > settings.startChips) return this.ack(clientId, id, { ok: false, err: '起始筹码至少为大盲注的 20 倍' });
    if (![20, 30, 45, 60].includes(settings.actionTime) || ![5, 10, 20].includes(settings.nextHandDelay)) {
      return this.ack(clientId, id, { ok: false, err: '行动或局间时长设置无效' });
    }
    if (typeof settings.rebuyAllowed !== 'boolean') return this.ack(clientId, id, { ok: false, err: '重买设置格式错误' });
    room.settings = settings;
    room.minRaise = settings.bigBlind;
    if (room.handNumber === 0) {
      room.players.forEach((entry) => { entry.chips = settings.startChips; });
      room.session.forEach((entry) => { entry.buyIn = settings.startChips; });
      room.economyTotal = settings.startChips * room.players.length;
    }
    addLog(room, `房主修改设置${settings.locked ? '，已锁房' : ''}`);
    await this.persist();
    this.broadcast(room);
    this.ack(clientId, id, { ok: true, settings });
  }

  canAct(player, allowOffline = false) {
    return !!player && !player.folded && !player.allIn && player.chips > 0
      && player.inHand && !player.sittingOut && !player.left && (allowOffline || player.connected);
  }

  nextSeat(room, from, predicate) {
    for (let offset = 1; offset <= room.players.length; offset++) {
      const seat = (from + offset) % room.players.length;
      if (predicate(room.players[seat])) return seat;
    }
    return -1;
  }

  pay(player, amount) {
    const paid = Math.min(amount, player.chips);
    player.chips -= paid;
    player.roundBet += paid;
    player.totalBet += paid;
    if (player.chips === 0) player.allIn = true;
    return paid;
  }

  async startGame(clientId, id) {
    const { room } = this.playerFor(clientId);
    if (!room) return this.ack(clientId, id, { ok: false, err: '不在房间中' });
    if (!['waiting', 'handover'].includes(room.stage)) return this.ack(clientId, id, { ok: false, err: '本局正在进行中' });
    if (room.players.filter((player) => player.connected && player.chips > 0 && !player.sittingOut && !player.left).length < 2) {
      return this.ack(clientId, id, { ok: false, err: '至少需要 2 名在线玩家' });
    }
    clearTimeout(room.nextHandTimer);
    room.nextHandTimer = null;
    this.startHand(room);
    await this.persist();
    this.broadcast(room);
    this.ack(clientId, id, { ok: true });
  }

  startHand(room) {
    this.compactLeftPlayers(room);
    const playable = room.players.filter((player) => player.connected && player.chips > 0 && !player.sittingOut && !player.left);
    if (playable.length < 2) { room.stage = 'waiting'; return; }
    room.handNumber += 1;
    room.stage = 'preflop';
    room.community = [];
    room.pot = 0;
    room.currentBet = room.settings.bigBlind;
    room.minRaise = room.settings.bigBlind;
    room.results = null;
    room.revealed = false;
    room.queue = [];
    room.gameOver = false;
    room.players.forEach((player) => {
      player.inHand = playable.includes(player);
      player.folded = !player.inHand;
      player.roundBet = 0;
      player.totalBet = 0;
      player.allIn = false;
      player.hole = [];
      if (player.inHand) {
        const stat = room.session.find((entry) => entry.name === player.name);
        if (stat) stat.hands += 1;
      }
    });
    const eligible = (player) => playable.includes(player);
    room.dealerSeat = room.handNumber === 1
      ? room.players.findIndex(eligible)
      : this.nextSeat(room, room.dealerSeat, eligible);
    let smallBlindSeat;
    let bigBlindSeat;
    if (playable.length === 2) {
      smallBlindSeat = room.dealerSeat;
      bigBlindSeat = this.nextSeat(room, smallBlindSeat, eligible);
    } else {
      smallBlindSeat = this.nextSeat(room, room.dealerSeat, eligible);
      bigBlindSeat = this.nextSeat(room, smallBlindSeat, eligible);
    }
    room.deck = newDeck();
    for (let round = 0; round < 2; round++) {
      for (let offset = 1; offset <= room.players.length; offset++) {
        const seat = (smallBlindSeat + offset) % room.players.length;
        if (room.players[seat].inHand) room.players[seat].hole.push(room.deck.pop());
      }
    }
    const smallBlind = room.players[smallBlindSeat];
    const bigBlind = room.players[bigBlindSeat];
    const smallPaid = this.pay(smallBlind, room.settings.smallBlind);
    const bigPaid = this.pay(bigBlind, room.settings.bigBlind);
    addLog(room, `第 ${room.handNumber} 局开始，盲注 ${room.settings.smallBlind}/${room.settings.bigBlind}`);
    addLog(room, `${smallBlind.name} 小盲 ${smallPaid}，${bigBlind.name} 大盲 ${bigPaid}`);
    this.buildQueue(room, this.nextSeat(room, bigBlindSeat, (player) => this.canAct(player)));
  }

  buildQueue(room, firstSeat) {
    if (firstSeat < 0) { room.queue = []; room.turnSeat = -1; this.nextStreet(room); return; }
    room.queue = [];
    for (let offset = 0; offset < room.players.length; offset++) {
      const seat = (firstSeat + offset) % room.players.length;
      if (this.canAct(room.players[seat])) room.queue.push(seat);
    }
    this.setTurn(room, room.queue[0] ?? -1);
  }

  setTurn(room, seat) {
    clearTimeout(room.turnTimer);
    room.turnSeat = seat;
    if (seat < 0) return;
    const player = room.players[seat];
    const duration = player.connected ? room.settings.actionTime * 1000 : 8000;
    room.turnDeadline = Date.now() + duration;
    room.turnTimer = setTimeout(async () => {
      const current = room.players[room.turnSeat];
      if (!current) return;
      const action = current.roundBet === room.currentBet ? 'check' : 'fold';
      addLog(room, `${current.name} 超时，自动${action === 'check' ? '过牌' : '弃牌'}`);
      this.applyAction(room, room.turnSeat, action, undefined, true);
      await this.persist();
      this.broadcast(room);
    }, duration);
  }

  async playerAction(clientId, id, payload) {
    const { room } = this.playerFor(clientId);
    if (!room) return this.ack(clientId, id, { ok: false, err: '不在房间中' });
    const seat = room.players.findIndex((player) => player.clientId === clientId);
    const result = this.applyAction(room, seat, payload?.type, payload?.amount);
    if (result.ok) {
      await this.persist();
      this.broadcast(room);
    }
    this.ack(clientId, id, result);
  }

  applyAction(room, seat, action, amount, automatic = false) {
    const player = room.players[seat];
    if (room.turnSeat !== seat || !this.canAct(player, automatic)) return { ok: false, err: '还没轮到你行动' };
    if (action === 'fold') {
      player.folded = true;
      addLog(room, `${player.name} 弃牌`);
    } else if (action === 'check') {
      if (player.roundBet !== room.currentBet) return { ok: false, err: '当前有人加注，不能过牌' };
      addLog(room, `${player.name} 过牌`);
    } else if (action === 'call') {
      const needed = room.currentBet - player.roundBet;
      if (needed <= 0) return { ok: false, err: '无需跟注，可以过牌' };
      const paid = this.pay(player, needed);
      addLog(room, `${player.name} 跟注 ${paid}${player.allIn ? '（全押）' : ''}`);
    } else if (action === 'raise' || action === 'allin') {
      let target = action === 'allin' ? player.roundBet + player.chips : Math.min(amount, player.roundBet + player.chips);
      if (!Number.isInteger(target) || target <= player.roundBet) return { ok: false, err: '加注金额无效' };
      const needed = target - player.roundBet;
      const isAllIn = needed >= player.chips;
      if (target > room.currentBet) {
        const raiseSize = target - room.currentBet;
        if (!isAllIn && raiseSize < room.minRaise) return { ok: false, err: `最小加注到 ${room.currentBet + room.minRaise}` };
        this.pay(player, needed);
        room.minRaise = Math.max(room.minRaise, raiseSize);
        room.currentBet = target;
        addLog(room, `${player.name} 加注到 ${target}${isAllIn ? '（全押）' : ''}`);
        room.queue = [];
        for (let offset = 1; offset <= room.players.length; offset++) {
          const other = (seat + offset) % room.players.length;
          if (this.canAct(room.players[other])) room.queue.push(other);
        }
      } else {
        if (!isAllIn) return { ok: false, err: `加注至少到 ${room.currentBet}` };
        this.pay(player, needed);
        addLog(room, `${player.name} 全押跟注 ${needed}`);
      }
    } else return { ok: false, err: '未知操作' };
    this.advanceAfterAction(room, seat);
    return { ok: true };
  }

  advanceAfterAction(room, actedSeat) {
    room.queue = room.queue.filter((seat) => seat !== actedSeat);
    const alive = room.players.filter((player) => player.inHand && !player.folded);
    if (alive.length === 1) {
      const amount = room.players.reduce((sum, player) => sum + player.totalBet, 0);
      const winner = alive[0];
      winner.chips += amount;
      const stat = room.session.find((entry) => entry.name === winner.name);
      if (stat) stat.wins += 1;
      room.results = { pots: [{ amount, winners: [{ seat: room.players.indexOf(winner), name: winner.name, chips: winner.chips, handName: null }] }], forfeit: true };
      addLog(room, `${winner.name} 赢得底池 ${amount}（其余玩家均弃牌）`);
      this.endHand(room);
    } else if (!room.queue.length) {
      this.setTurn(room, -1);
      this.nextStreet(room);
    } else this.setTurn(room, room.queue[0]);
  }

  nextStreet(room) {
    room.players.forEach((player) => { player.roundBet = 0; });
    room.currentBet = 0;
    room.minRaise = room.settings.bigBlind;
    room.pot = room.players.reduce((sum, player) => sum + player.totalBet, 0);
    if (room.stage === 'preflop') {
      room.stage = 'flop';
      room.community.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
    } else if (room.stage === 'flop') {
      room.stage = 'turn';
      room.community.push(room.deck.pop());
    } else if (room.stage === 'turn') {
      room.stage = 'river';
      room.community.push(room.deck.pop());
    } else if (room.stage === 'river') return this.showdown(room);
    addLog(room, `${({ flop: '翻牌', turn: '转牌', river: '河牌' })[room.stage]}：${room.community.map((card) => `${card.s}${rankText(card.r)}`).join(' ')}`);
    if (room.players.filter((player) => this.canAct(player)).length < 2) return this.nextStreet(room);
    this.buildQueue(room, this.nextSeat(room, room.dealerSeat, (player) => this.canAct(player)));
  }

  showdown(room) {
    room.stage = 'showdown';
    room.revealed = true;
    room.pot = room.players.reduce((sum, player) => sum + player.totalBet, 0);
    clearTimeout(room.turnTimer);
    const alive = room.players.map((player, seat) => ({ player, seat })).filter(({ player }) => player.inHand && !player.folded);
    const evaluations = new Map(alive.map(({ player, seat }) => [seat, evaluate7([...player.hole, ...room.community])]));
    const results = [];
    for (const pot of computePots(room)) {
      const eligible = pot.eligible.filter((seat) => evaluations.has(seat));
      let best = null;
      eligible.forEach((seat) => { if (!best || compareScore(evaluations.get(seat).score, best) > 0) best = evaluations.get(seat).score; });
      const winners = eligible.filter((seat) => compareScore(evaluations.get(seat).score, best) === 0);
      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount - share * winners.length;
      winners.forEach((seat) => {
        room.players[seat].chips += share + (remainder-- > 0 ? 1 : 0);
      });
      results.push({ amount: pot.amount, winners: winners.map((seat) => ({
        seat,
        name: room.players[seat].name,
        chips: room.players[seat].chips,
        handName: evaluations.get(seat).name,
        bestCards: evaluations.get(seat).best5,
        hole: room.players[seat].hole,
      })) });
    }
    new Set(results.flatMap((pot) => pot.winners.map((winner) => winner.name))).forEach((name) => {
      const stat = room.session.find((entry) => entry.name === name);
      if (stat) stat.wins += 1;
    });
    room.results = { pots: results, forfeit: false };
    this.endHand(room);
  }

  endHand(room) {
    room.stage = 'handover';
    room.turnSeat = -1;
    clearTimeout(room.turnTimer);
    clearTimeout(room.nextHandTimer);
    room.nextHandTimer = setTimeout(async () => {
      this.startHand(room);
      await this.persist();
      this.broadcast(room);
    }, room.settings.nextHandDelay * 1000);
  }

  async nextHand(clientId, id) {
    const { room } = this.playerFor(clientId);
    if (!room || room.stage !== 'handover') return this.ack(clientId, id, { ok: false, err: '当前不能开局' });
    clearTimeout(room.nextHandTimer);
    this.startHand(room);
    await this.persist();
    this.broadcast(room);
    this.ack(clientId, id, { ok: true });
  }

  async rebuy(clientId, id) {
    const { room, player } = this.playerFor(clientId);
    if (!room || !player) return this.ack(clientId, id, { ok: false, err: '不在房间中' });
    if (!['waiting', 'handover'].includes(room.stage)) return this.ack(clientId, id, { ok: false, err: '只能在本局结束后重买' });
    if (room.settings.rebuyAllowed === false) return this.ack(clientId, id, { ok: false, err: '本房间已禁止重买' });
    if (player.chips > 0) return this.ack(clientId, id, { ok: false, err: '你还有筹码，无需重买' });
    const amount = room.settings.startChips;
    player.chips = amount;
    player.sittingOut = false;
    room.gameOver = false;
    room.economyTotal += amount;
    const stat = room.session.find((entry) => entry.name === player.name);
    if (stat) stat.buyIn += amount;
    addLog(room, `${player.name} 重买 ${amount} 筹码`);
    await this.persist();
    this.ack(clientId, id, { ok: true });
    this.broadcast(room);
  }

  async sitOut(clientId, id) {
    const { room, player } = this.playerFor(clientId);
    if (!room || !player) return this.ack(clientId, id, { ok: false, err: '不在房间中' });
    player.sittingOut = true;
    const seat = room.players.indexOf(player);
    if (player.inHand && !player.folded) {
      player.folded = true;
      addLog(room, `${player.name} 暂离，自动弃牌`);
      this.advanceAfterAction(room, seat);
    } else addLog(room, `${player.name} 暂离（下局不参与）`);
    await this.persist();
    this.broadcast(room);
    this.ack(clientId, id, { ok: true });
  }

  async sitBack(clientId, id) {
    const { room, player } = this.playerFor(clientId);
    if (!room || !player) return this.ack(clientId, id, { ok: false, err: '不在房间中' });
    player.sittingOut = false;
    addLog(room, `${player.name} 坐回`);
    await this.persist();
    this.broadcast(room);
    this.ack(clientId, id, { ok: true });
  }

  emoji(clientId, id, payload) {
    const { room, player } = this.playerFor(clientId);
    if (!room || !player) return this.ack(clientId, id, { ok: false, err: '不在房间中' });
    if (typeof payload?.emoji !== 'string' || !EMOJIS.includes(payload.emoji)) {
      return this.ack(clientId, id, { ok: false, err: '不支持的表情' });
    }
    const now = Date.now();
    if (now - (this.emojiLast.get(clientId) || 0) < 1000) return this.ack(clientId, id, { ok: false, err: '发太快啦' });
    this.emojiLast.set(clientId, now);
    const seat = room.players.indexOf(player);
    room.players.forEach((entry) => {
      if (entry.connected && entry.clientId) this.send(entry.clientId, 'emoji', { seat, emoji: payload.emoji });
    });
    this.ack(clientId, id, { ok: true });
  }

  async kickPlayer(clientId, id, payload) {
    const { room, player } = this.playerFor(clientId);
    if (!room || !player) return this.ack(clientId, id, { ok: false, err: '不在房间中' });
    if (player.name !== room.hostName) return this.ack(clientId, id, { ok: false, err: '只有房主可以踢人' });
    const seat = payload?.seat;
    if (!Number.isInteger(seat) || seat < 0 || seat >= room.players.length) {
      return this.ack(clientId, id, { ok: false, err: '座位参数格式错误' });
    }
    const target = room.players[seat];
    if (!target || target.left) return this.ack(clientId, id, { ok: false, err: '该座位无人' });
    if (target === player) return this.ack(clientId, id, { ok: false, err: '不能踢自己' });
    const targetClientId = target.clientId;
    addLog(room, `${target.name} 被房主移出房间`);
    this.markPlayerLeft(room, target);
    if (target.inHand && !target.folded && ['preflop', 'flop', 'turn', 'river'].includes(room.stage)) {
      target.folded = true;
      this.advanceAfterAction(room, seat);
    }
    if (room.stage === 'waiting') this.compactLeftPlayers(room);
    const targetClient = this.clients.get(targetClientId);
    if (targetClient) targetClient.roomCode = '';
    if (targetClientId) this.send(targetClientId, 'kicked', { reason: '房主将你移出房间' });
    await this.persist();
    this.broadcast(room);
    this.ack(clientId, id, { ok: true });
    if (targetClient?.ws?.readyState === WebSocket.OPEN) targetClient.ws.close(4000, 'kicked');
  }

  async leaveRoom(clientId, id) {
    const { client, room, player } = this.playerFor(clientId);
    if (!room || !player) return this.ack(clientId, id, { ok: true });
    const seat = room.players.indexOf(player);
    this.markPlayerLeft(room, player);
    if (player.inHand && !player.folded && ['preflop', 'flop', 'turn', 'river'].includes(room.stage)) {
      player.folded = true;
      this.advanceAfterAction(room, seat);
    }
    if (player.name === room.hostName) room.hostName = room.players.find((entry) => !entry.left)?.name || null;
    if (client) client.roomCode = '';
    if (room.stage === 'waiting') this.compactLeftPlayers(room);
    if (!room.players.some((entry) => !entry.left)) this.rooms.delete(room.code);
    else addLog(room, `${player.name} 离开房间`);
    await this.persist();
    if (this.rooms.has(room.code)) this.broadcast(room);
    this.ack(clientId, id, { ok: true });
  }

  async onClose(clientId) {
    const { room, player } = this.playerFor(clientId);
    this.clients.delete(clientId);
    this.emojiLast.delete(clientId);
    if (!room || !player) return;
    player.connected = false;
    player.clientId = '';
    addLog(room, `${player.name} 离线`);
    if (room.turnSeat === room.players.indexOf(player)) this.setTurn(room, room.turnSeat);
    await this.persist();
    this.broadcast(room);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      const hub = env.POKER_HUB.getByName('global');
      return hub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
