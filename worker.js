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
    pot: room.pot,
    currentBet: room.currentBet,
    minRaise: room.minRaise,
    youSeat,
    gameOver: room.gameOver,
    economyTotal: room.economyTotal,
    session: room.session.map((entry) => ({
      ...entry,
      chips: room.players.find((player) => player.name === entry.name)?.chips ?? 0,
      pl: (room.players.find((player) => player.name === entry.name)?.chips ?? 0) - entry.buyIn,
    })),
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
      left: false,
      inHand: player.inHand,
      sittingOut: player.sittingOut,
      isDealer: seat === room.dealerSeat,
      hole: null,
      holeCount: 0,
    })),
  };
}

export class PokerHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.rooms = new Map();
    this.clients = new Map();
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get('rooms');
      for (const room of stored || []) {
        room.players.forEach((player) => {
          player.connected = false;
          player.clientId = '';
        });
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
    const serializable = [...this.rooms.values()].map((room) => ({
      ...room,
      players: room.players.map((player) => ({ ...player, connected: false, clientId: '' })),
    }));
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
      if (existing.connected) return this.ack(clientId, id, { ok: false, err: '该昵称已在线，请换一个昵称' });
      if (existing.token !== payload.token) return this.ack(clientId, id, { ok: false, err: '该昵称已被其他玩家使用，请换一个昵称' });
      existing.connected = true;
      existing.clientId = clientId;
      this.clients.get(clientId).roomCode = code;
      addLog(room, `${existing.name} 重新连接`);
      await this.persist();
      this.broadcast(room);
      return this.ack(clientId, id, { ok: true, code, token: existing.token });
    }
    if (room.settings.locked) return this.ack(clientId, id, { ok: false, err: '房主已锁定房间，暂不接受新玩家' });
    if (room.players.length >= 6) return this.ack(clientId, id, { ok: false, err: '房间已满（最多 6 人）' });
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
    });
    room.economyTotal += room.settings.startChips;
    room.session.push({ name, buyIn: room.settings.startChips, hands: 0, wins: 0 });
    this.clients.get(clientId).roomCode = room.code;
    addLog(room, `${name} 加入房间`);
    return { token };
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

  async leaveRoom(clientId, id) {
    const { client, room, player } = this.playerFor(clientId);
    if (!room || !player) return this.ack(clientId, id, { ok: true });
    room.players = room.players.filter((entry) => entry !== player);
    room.economyTotal -= player.chips;
    room.session = room.session.filter((entry) => entry.name !== player.name);
    if (player.name === room.hostName) room.hostName = room.players[0]?.name || null;
    if (client) client.roomCode = '';
    if (!room.players.length) this.rooms.delete(room.code);
    else addLog(room, `${player.name} 离开房间`);
    await this.persist();
    if (this.rooms.has(room.code)) this.broadcast(room);
    this.ack(clientId, id, { ok: true });
  }

  async onClose(clientId) {
    const { room, player } = this.playerFor(clientId);
    this.clients.delete(clientId);
    if (!room || !player) return;
    player.connected = false;
    player.clientId = '';
    addLog(room, `${player.name} 离线`);
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
