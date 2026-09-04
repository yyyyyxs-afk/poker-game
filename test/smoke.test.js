/**
 * 冒烟测试（需先启动服务器）：
 * 1. 集成：2 / 3 / 6 个模拟客户端随机对局，校验筹码守恒 + 战绩盈亏零和
 * 2. 场景：对局中主动退出后守恒跨局保持
 * 3. 场景：对局中踢出尾号座位后，战绩归档与经济盘跨局守恒
 * 4. 场景：中间庄家离场后，庄家与盲注按原桌序继续轮转
 * 5. 场景：handover 尾座庄家离开/被踢后，经济盘与庄家轮转保持正确
 * 6. 场景：断线保护窗口（不瞬间弃牌 / 窗口后自动弃牌 / 窗口内重连可继续行动）
 * 7. 场景：房管设置（行动时长 / 局间倒计时 / 禁止重买）校验
 * 8. 安全：单连接单房、畸形 payload、Unicode 昵称归一与 token 防冒名
 *
 * 推荐执行：npm test（自动启动隔离服务并包含规则、几何与本文件）
 * 单独调试：先在 3456 端口启动服务，再执行 npm run test:smoke；也可用 TEST_URL 指定地址。
 */
const assert = require('assert');
const { io } = require('socket.io-client');

const URL = process.env.TEST_URL || 'http://localhost:3456';
const START_CHIPS = 2000;
const NAMES = ['甲', '乙', '丙', '丁', '戊', '己'];

let activeClients = [];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitUntil(fn, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(intervalMs);
  }
  return false;
}

function emit(client, event, payload) {
  return new Promise((res, rej) => {
    client.emit(event, payload, (r) => (r && r.ok ? res(r) : rej(new Error((r && r.err) || (event + ' 失败')))));
  });
}

function request(client, event, payload, timeoutMs = 3000) {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${event} 未返回回执（服务端可能异常）`)), timeoutMs);
    client.emit(event, payload, (reply) => {
      clearTimeout(timer);
      res(reply);
    });
  });
}

async function openClient() {
  const client = io(URL, { transports: ['websocket'] });
  activeClients.push(client);
  if (client.connected) return client;
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('Socket 连接超时')), 5000);
    client.once('connect', () => { clearTimeout(timer); res(); });
    client.once('connect_error', (err) => { clearTimeout(timer); rej(err); });
  });
  return client;
}

/**
 * 创建一个模拟客户端：记录最新状态，持续校验
 * - 筹码守恒：Σ(chips + 未结算 totalBet) === economyTotal
 * - 战绩零和：Σ session.pl === 0（含离场存档）
 */
function makeClient(states, idx, expectedPlayers, onFail) {
  const c = io(URL, { transports: ['websocket'] });
  c.on('state', (s) => {
    states[idx] = s;
    if (s.players.length < expectedPlayers) return;
    const settled = s.stage === 'handover' || s.stage === 'showdown';
    const sum = s.players.reduce((t, p) => t + p.chips + (settled ? 0 : p.totalBet), 0);
    const expectTotal = typeof s.economyTotal === 'number' ? s.economyTotal : expectedPlayers * START_CHIPS;
    if (sum !== expectTotal) {
      onFail(`筹码不守恒: ${sum} != ${expectTotal} (stage=${s.stage}, hand=${s.handNumber})`);
    }
    if (Array.isArray(s.session)) {
      const plSum = s.session.reduce((t, e) => t + e.pl, 0);
      if (plSum !== 0) {
        onFail(`战绩盈亏之和 ${plSum} != 0 (stage=${s.stage}, hand=${s.handNumber})`);
      }
    }
  });
  activeClients.push(c);
  return c;
}

/** 创建房间 + n 名玩家加入 + 开局。返回 { clients, states, code, tokens } */
async function setupTable(n, onFail) {
  const states = new Array(n).fill(null);
  const clients = [];
  const tokens = [];
  for (let i = 0; i < n; i++) clients.push(makeClient(states, i, n, onFail));
  await sleep(300);
  const room = await emit(clients[0], 'create_room', { name: NAMES[0] });
  tokens[0] = room.token;
  for (let i = 1; i < n; i++) {
    const r = await emit(clients[i], 'join_room', { code: room.code, name: NAMES[i] });
    tokens[i] = r.token;
  }
  await emit(clients[0], 'start_game', null);
  return { clients, states, code: room.code, tokens };
}

/** 随机行动驱动器（N 人通用）。isSkipped(i) 为 true 的客户端不再行动 */
function makeDriver(states, clients, actionErrorRef, isSkipped) {
  const acting = states.map(() => false);
  return async function driveOnce() {
    for (let i = 0; i < states.length; i++) {
      const s = states[i];
      if (!s || acting[i]) continue;
      if (isSkipped && isSkipped(i)) continue;
      if (!['preflop', 'flop', 'turn', 'river'].includes(s.stage)) continue;
      if (s.turnSeat !== s.youSeat) continue;
      acting[i] = true;
      const me = i;
      setTimeout(() => {
        try {
          const cur = states[me]; // 用最新状态复核，延迟期间对手可能已行动
          if (!cur || cur.turnSeat !== cur.youSeat) return;
          const p = cur.players[cur.youSeat];
          const toCall = cur.currentBet - p.roundBet;
          const maxTo = p.roundBet + p.chips;
          const minTo = Math.max(cur.currentBet + cur.minRaise, Math.min(cur.currentBet + 1, maxTo));
          const roll = Math.random();
          let act;
          if (toCall <= 0) {
            act = roll < 0.55 ? ['check'] : roll < 0.85 ? ['raise', minTo] : ['allin'];
          } else {
            act = roll < 0.15 ? ['fold'] : roll < 0.75 ? ['call'] : roll < 0.9 ? ['raise', minTo] : ['allin'];
          }
          if (act[0] === 'raise' && act[1] > maxTo) act = ['allin'];
          clients[me].emit('action', { type: act[0], amount: act[1] }, (r) => {
            if (!r.ok && r.err !== '还没轮到你行动') actionErrorRef.err = `客户端${me} 行动被拒: ${r.err}`;
          });
        } finally {
          acting[me] = false;
        }
      }, 30);
    }
  };
}

function disconnectAll(clients) {
  clients.forEach((c) => { try { c.disconnect(); } catch (_) {} });
  activeClients = activeClients.filter((c) => !clients.includes(c));
}

// ---------- 安全场景：payload / 单连接单房 / Unicode 同名 / token 防冒名 ----------
async function runSocketHardeningScenario() {
  const first = await openClient();
  let firstState = null;
  first.on('state', (state) => { firstState = state; });

  // 所有需要对象 payload 的事件都必须对 null、非对象、缺字段给出失败回执。
  const objectEvents = ['create_room', 'join_room', 'update_settings', 'action', 'emoji', 'kick_player'];
  for (const event of objectEvents) {
    for (const payload of [null, 'bad-payload', {}]) {
      const reply = await request(first, event, payload);
      assert.ok(reply && reply.ok === false && reply.err, `${event} 未拒绝畸形 payload`);
    }
  }
  // 无参数事件只接受 null / 无参数 / 空对象，不能让任意外部结构静默进入处理逻辑。
  for (const event of ['start_game', 'next_hand', 'rebuy', 'sit_out', 'sit_back', 'leave_room']) {
    const reply = await request(first, event, 'bad-payload');
    assert.ok(reply && reply.ok === false && reply.err, `${event} 未拒绝额外 payload`);
  }
  console.log('  ✓ 全部 Socket 入口对畸形 payload 返回失败回执，服务仍可继续使用');

  // NFKC 将全角 A 统一为 A；中文原样保留，首尾空格被裁剪。
  const firstRoom = await emit(first, 'create_room', { name: '  Ａ张三  ' });
  assert.ok(await waitUntil(() => firstState && firstState.players[0]
    && firstState.players[0].name === 'A张三', 3000), '昵称未按预期归一/裁剪');

  const duplicateCreate = await request(first, 'create_room', { name: '另一个房主' });
  assert.strictEqual(duplicateCreate.ok, false, '同一连接重复建房应被拒绝');
  assert.strictEqual(duplicateCreate.code, firstRoom.code, '重复建房回执应指出当前房间');

  const second = await openClient();
  const secondRoom = await emit(second, 'create_room', { name: '第二房主' });
  const crossJoin = await request(first, 'join_room', { code: secondRoom.code, name: '跨房者' });
  assert.strictEqual(crossJoin.ok, false, '同一连接加入第二个房间应被拒绝');
  assert.strictEqual(crossJoin.code, firstRoom.code, '跨房回执应保留原房间归属');
  console.log('  ✓ 同一连接重复 create / join 均被拒绝且返回当前房间');

  const contender = await openClient();
  const impersonation = await request(contender, 'join_room', { code: firstRoom.code, name: 'A张三' });
  assert.strictEqual(impersonation.ok, false, 'Unicode 等价昵称不应绕过在线同名保护');
  assert.match(impersonation.err, /昵称|在线|使用/);
  await emit(contender, 'join_room', { code: firstRoom.code, name: '李四' });
  console.log('  ✓ Unicode 等价昵称无法绕过现有在线冒名保护');

  disconnectAll([first, second, contender]);
}

async function runTokenHijackScenario() {
  const host = await openClient();
  const victim = await openClient();
  const attacker = await openClient();
  let hostState = null;
  host.on('state', (state) => { hostState = state; });

  const room = await emit(host, 'create_room', { name: '房主甲' });
  const victimJoin = await emit(victim, 'join_room', { code: room.code, name: '离线乙' });
  await emit(host, 'start_game', null);
  assert.ok(await waitUntil(() => hostState && ['preflop', 'flop', 'turn', 'river'].includes(hostState.stage), 3000),
    '防冒名场景未正常开局');

  victim.disconnect();
  assert.ok(await waitUntil(() => hostState && hostState.players.some((p) => p.name === '离线乙' && !p.connected), 3000),
    '服务端未记录玩家离线');

  const hijack = await request(attacker, 'join_room', {
    code: room.code, name: '离线乙', token: 'wrong-token',
  });
  assert.strictEqual(hijack.ok, false, '错误 token 不应接管离线座位');
  assert.match(hijack.err, /昵称|使用/);

  const restored = await emit(attacker, 'join_room', {
    code: room.code, name: '离线乙', token: victimJoin.token,
  });
  assert.strictEqual(restored.token, victimJoin.token, '合法重连应沿用原 token');
  console.log('  ✓ 离线座位拒绝错误 token，合法 token 可恢复且不轮换身份');

  disconnectAll([host, victim, attacker]);
}

async function runFoldedHolePrivacyScenario() {
  const fail = (msg) => { throw new Error(msg); };
  const { clients, states } = await setupTable(3, fail);
  let foldedSeat = -1;
  let finalState = null;
  const deadline = Date.now() + 20000;

  while (!finalState && Date.now() < deadline) {
    const table = states[0];
    if (!table) { await sleep(30); continue; }
    if (table.stage === 'handover' && table.revealed) {
      const observer = states.find((state) => state && state.youSeat !== foldedSeat
        && state.players[state.youSeat] && !state.players[state.youSeat].folded);
      finalState = observer || null;
      break;
    }
    if (!['preflop', 'flop', 'turn', 'river'].includes(table.stage) || table.turnSeat < 0) {
      await sleep(30);
      continue;
    }

    const actorIdx = states.findIndex((state) => state && state.youSeat === table.turnSeat);
    if (actorIdx < 0) { await sleep(30); continue; }
    const actor = table.players[table.turnSeat];
    const type = foldedSeat < 0
      ? 'fold'
      : (table.currentBet - actor.roundBet <= 0 ? 'check' : 'call');
    const reply = await request(clients[actorIdx], 'action', { type });
    assert.ok(reply && reply.ok, `隐私专项行动失败: ${reply && reply.err}`);
    if (foldedSeat < 0) foldedSeat = table.turnSeat;
    await sleep(30);
  }

  assert.ok(finalState, '三人一人先弃牌场景未在时限内进入摊牌');
  const folded = finalState.players[foldedSeat];
  assert.ok(folded && folded.folded, '专项场景未保留先弃牌者');
  assert.strictEqual(folded.hole, null, '已弃牌者底牌被公开给其他玩家');
  const shownEligible = finalState.players.filter((p) => p.inHand && !p.folded && Array.isArray(p.hole) && p.hole.length === 2);
  assert.strictEqual(shownEligible.length, 2, '有摊牌资格的两名玩家应正常亮牌');
  console.log('  ✓ 三人局一人先弃牌：弃牌者底牌不公开，剩余两家正常亮牌');

  disconnectAll(clients);
}

async function runDuplicateBusinessRequestScenario() {
  const fail = (msg) => { throw new Error(msg); };
  const states = new Array(2).fill(null);
  const clients = [makeClient(states, 0, 2, fail), makeClient(states, 1, 2, fail)];
  await sleep(300);
  const room = await emit(clients[0], 'create_room', { name: '幂等甲' });
  await emit(clients[1], 'join_room', { code: room.code, name: '幂等乙' });
  await emit(clients[0], 'update_settings', {
    startChips: 100, smallBlind: 1, bigBlind: 2,
    actionTime: 20, nextHandDelay: 20, rebuyAllowed: true,
  });

  const startReplies = await Promise.all([
    request(clients[0], 'start_game', null),
    request(clients[0], 'start_game', null),
  ]);
  assert.strictEqual(startReplies.filter((reply) => reply && reply.ok).length, 1, '双 start_game 应仅一次成功');
  assert.ok(await waitUntil(() => states[0] && states[0].handNumber === 1
    && ['preflop', 'flop', 'turn', 'river'].includes(states[0].stage), 3000), '双 start_game 后手数异常');

  let duplicateActionChecked = false;
  let handover = null;
  const allInDeadline = Date.now() + 30000;
  for (let attempt = 0; attempt < 10 && !handover && Date.now() < allInDeadline; attempt++) {
    const hand = states[0].handNumber;
    while (Date.now() < allInDeadline) {
      const table = states[0];
      if (table && table.handNumber === hand && table.stage === 'handover') {
        const zero = table.players.find((p) => p.chips === 0);
        if (zero) handover = table;
        else await emit(clients[0], 'next_hand', null); // 极少数平局，继续下一手
        break;
      }
      if (table && table.handNumber === hand
        && ['preflop', 'flop', 'turn', 'river'].includes(table.stage) && table.turnSeat >= 0) {
        const actorIdx = states.findIndex((state) => state && state.youSeat === table.turnSeat);
        if (actorIdx >= 0) {
          if (!duplicateActionChecked) {
            const replies = await Promise.all([
              request(clients[actorIdx], 'action', { type: 'allin' }),
              request(clients[actorIdx], 'action', { type: 'allin' }),
            ]);
            assert.strictEqual(replies.filter((reply) => reply && reply.ok).length, 1, '双 action 应仅一次成功');
            duplicateActionChecked = true;
          } else {
            const reply = await request(clients[actorIdx], 'action', { type: 'allin' });
            assert.ok(reply && reply.ok, `全押推进失败: ${reply && reply.err}`);
          }
        }
      }
      await sleep(30);
    }
  }

  assert.ok(handover, '连续全押后未产生可重买玩家');
  const zeroSeat = handover.players.find((p) => p.chips === 0).seat;
  const zeroClientIdx = states.findIndex((state) => state && state.youSeat === zeroSeat);
  const economyBefore = handover.economyTotal;
  const rebuyReplies = await Promise.all([
    request(clients[zeroClientIdx], 'rebuy', null),
    request(clients[zeroClientIdx], 'rebuy', null),
  ]);
  assert.strictEqual(rebuyReplies.filter((reply) => reply && reply.ok).length, 1, '双 rebuy 应仅一次成功');
  assert.ok(await waitUntil(() => states[0] && states[0].players[zeroSeat].chips === 100, 3000), '重买筹码未到账');
  assert.strictEqual(states[0].economyTotal, economyBefore + 100, '双 rebuy 重复增加经济总盘');

  const beforeNext = states[0].handNumber;
  const nextReplies = await Promise.all([
    request(clients[0], 'next_hand', null),
    request(clients[0], 'next_hand', null),
  ]);
  assert.strictEqual(nextReplies.filter((reply) => reply && reply.ok).length, 1, '双 next_hand 应仅一次成功');
  assert.ok(await waitUntil(() => states[0] && states[0].handNumber === beforeNext + 1, 3000), '双 next_hand 重复或未推进手数');
  console.log('  ✓ 双 start / action / rebuy / next 请求均最多一次成功，手数与筹码只变更一次');

  disconnectAll(clients);
}

// ---------- 场景 1：N 人随机对局（N = 2 / 3 / 6），守恒 + 零和 + 流程推进 ----------
async function runIntegration(n) {
  const fail = (msg) => { throw new Error(msg); };
  const actionErrorRef = { err: null };
  const { clients, states } = await setupTable(n, fail);
  const drive = makeDriver(states, clients, actionErrorRef);

  console.log(`✓ ${n} 人房间开局`);

  const handsPlayed = [];
  let gameEnded = false;
  let lastResult = null;
  let previousResultSeenDuringPlay = false;
  const deadline = Date.now() + (n >= 6 ? 90000 : 60000);

  while (handsPlayed.length < 2 && !gameEnded && Date.now() < deadline) {
    for (let i = 0; i < n; i++) {
      const s = states[i];
      if (!s) continue;
      const me = s.players[s.youSeat];
      if (s.handNumber > 1 && ['preflop', 'flop', 'turn', 'river'].includes(s.stage)
        && s.lastResult && s.lastResult.handNumber === s.handNumber - 1) {
        previousResultSeenDuringPlay = true;
      }

      // 输光玩家自动重买；凑齐后由房主重新开局
      if ((s.stage === 'handover' || s.stage === 'waiting') && !s.gameOver && me && me.chips === 0) {
        clients[i].emit('rebuy', null, () => {});
      }
      if (i === 0 && s.stage === 'waiting' && handsPlayed.length >= 1 && !s.gameOver && me && me.chips > 0
        && s.players.every((q) => q.chips > 0)) {
        clients[0].emit('start_game', null, () => {});
      }

      if (s.stage === 'handover' && s.results && !handsPlayed.includes(s.handNumber)) {
        handsPlayed.push(s.handNumber);
        lastResult = s;
        console.log(`  ✓ 第 ${s.handNumber} 局结束 → ${s.players.map((p) => `${p.name}:${p.chips}`).join(' ')}`);
        if (s.gameOver) { gameEnded = true; break; }
        clients[0].emit('next_hand');
      }
    }
    if (actionErrorRef.err) fail(actionErrorRef.err);
    await drive();
    await sleep(60);
  }

  assert.ok(handsPlayed.length >= 1, `${n} 人局超时未完成任何一局`);
  if (!gameEnded) assert.strictEqual(handsPlayed.length, 2, `${n} 人局未完成两手`);
  assert.ok(lastResult && lastResult.results, '缺少摊牌结果');
  assert.ok(Array.isArray(lastResult.results.changes), '缺少本局筹码变化');
  const participants = lastResult.players.filter((p) => p.inHand).length;
  assert.ok(Array.isArray(lastResult.results.actions) && lastResult.results.actions.length >= participants + 1,
    '缺少完整本局行动时间线');
  assert.strictEqual(lastResult.results.changes.length, participants, `${n} 人桌实际参局人数记录错误`);
  assert.strictEqual(
    lastResult.results.changes.reduce((sum, entry) => sum + entry.delta, 0),
    0,
    `${n} 人局单局盈亏不守恒`,
  );
  if (handsPlayed.length >= 2) assert.ok(previousResultSeenDuringPlay, `${n} 人局开下一手后无法回看上一局`);
  // 战绩：参与手数合计 ≥ n（每名参与玩家至少打了一手）
  if (Array.isArray(lastResult.session)) {
    assert.ok(lastResult.session.reduce((t, e) => t + e.hands, 0) >= n, '战绩参与手数异常');
  }
  // 结束时守恒终检（用留存快照，结算阶段只看 chips）
  if (typeof lastResult.economyTotal === 'number') {
    const sum = lastResult.players.reduce((t, p) => t + p.chips, 0);
    assert.strictEqual(sum, lastResult.economyTotal, `${n} 人局结算筹码不守恒`);
  }
  disconnectAll(clients);
}

// ---------- 场景 2：对局中明确退出，结算后清退且守恒跨局保持 ----------
async function runLeaveMidHand() {
  const fail = (msg) => { throw new Error(msg); };
  const actionErrorRef = { err: null };
  const { clients, states } = await setupTable(3, fail);
  let bingLeft = false;
  let leaveHand = 0;
  let nextRequested = false;
  const drive = makeDriver(states, clients, actionErrorRef, (i) => i === 2 && bingLeft);

  const sumOf = (s, settled) => s.players.reduce((t, p) => t + p.chips + (settled ? 0 : p.totalBet), 0);

  const deadline = Date.now() + 90000;
  let bugPathVerified = false;
  while (!bugPathVerified && Date.now() < deadline) {
    const s = states[0];
    if (s) {
      // 第 1 步：丙在有投入时明确退出；本手暂留 seat 索引，但立即标记 left 且不可行动。
      if (!bingLeft && ['preflop', 'flop', 'turn', 'river'].includes(s.stage)) {
        const p3 = s.players[2];
        if (p3 && p3.totalBet > 0 && !p3.folded) {
          bingLeft = true;
          leaveHand = s.handNumber;
          const reply = await request(clients[2], 'leave_room', null);
          assert.ok(reply && reply.ok, 'leave_room 未返回明确成功回执');
          assert.ok(await waitUntil(() => {
            const cur = states[0];
            const left = cur && cur.players.find((p) => p.name === NAMES[2]);
            return left && left.left && !left.connected && left.folded;
          }, 3000), '主动退出未与普通断线区分（left/folded 状态缺失）');
          console.log('  ✓ 丙对局中 leave_room：成功回执、立即弃牌并标记明确离场');
        }
      }
      // 第 2 步：本手结算仍守恒，开下一手时清退 left 占位，不留下幽灵座位。
      if (bingLeft && !nextRequested && s.handNumber === leaveHand && s.stage === 'handover' && s.results) {
        const sum = sumOf(s, true);
        assert.strictEqual(sum, s.economyTotal, '主动退出后的本手结算筹码不守恒');
        assert.strictEqual(s.session.reduce((t, e) => t + e.pl, 0), 0, '主动退出后的战绩盈亏不为零');
        nextRequested = true;
        await emit(clients[0], 'next_hand');
      }
      if (nextRequested && s.players.length === 2) {
        assert.ok(!s.players.some((p) => p.name === NAMES[2]), '主动退出玩家在下一手仍占幽灵座位');
        const settled = s.stage === 'handover' || s.stage === 'showdown';
        const sum = sumOf(s, settled);
        assert.strictEqual(sum, s.economyTotal, '清退主动退出玩家后筹码不守恒');
        assert.strictEqual(s.session.reduce((t, e) => t + e.pl, 0), 0, '清退后战绩盈亏之和不为零');
        bugPathVerified = true;
      }
    }
    if (actionErrorRef.err) fail(actionErrorRef.err);
    await drive();
    await sleep(60);
  }
  assert.ok(bugPathVerified, '超时未完成退出场景验证');
  console.log('  ✓ 下一手已清退主动退出座位，economyTotal 守恒且战绩零和');

  disconnectAll(clients);
}

// ---------- 场景 2b：对局中踢出尾号座位，结算归档与经济盘保持一致 ----------
async function runKickTailMidHand() {
  const fail = (msg) => { throw new Error(msg); };
  const actionErrorRef = { err: null };
  const { clients, states } = await setupTable(3, fail);
  const drive = makeDriver(states, clients, actionErrorRef, (i) => i === 2);

  const readyToKick = await waitUntil(() => {
    const s = states[0];
    const tail = s && s.players[2];
    return s && ['preflop', 'flop', 'turn', 'river'].includes(s.stage)
      && tail && tail.name === NAMES[2] && tail.inHand && tail.totalBet > 0;
  }, 5000, 50);
  assert.ok(readyToKick, '未等到尾号玩家带投入进入对局');

  const hand = states[0].handNumber;
  const economyBefore = states[0].economyTotal;
  const reply = await request(clients[0], 'kick_player', { seat: 2 });
  assert.ok(reply && reply.ok, '房主踢出尾号座位失败');

  const retained = await waitUntil(() => {
    const s = states[0];
    const tail = s && s.players.find((p) => p.name === NAMES[2]);
    return tail && tail.left && tail.folded && !tail.connected;
  }, 3000, 50);
  assert.ok(retained, '对局中被踢的尾号座位被过早删除，无法在结算时归档');
  assert.strictEqual(states[0].economyTotal, economyBefore, '对局中踢人不应提前缩减经济总盘');
  assert.strictEqual(states[0].session.reduce((sum, entry) => sum + entry.pl, 0), 0,
    '对局中踢人后战绩盈亏应继续为零');
  console.log('  ✓ 对局中踢出尾号座位：保留 left 占位且经济盘、战绩仍守恒');

  let nextRequested = false;
  let verified = false;
  const deadline = Date.now() + 60000;
  while (!verified && Date.now() < deadline) {
    const s = states[0];
    if (s && s.handNumber === hand && s.stage === 'handover' && s.results && !nextRequested) {
      const archived = s.session.find((entry) => entry.name === NAMES[2]);
      assert.ok(archived && archived.left, '被踢玩家未在结算后进入离场战绩');
      assert.strictEqual(s.session.reduce((sum, entry) => sum + entry.pl, 0), 0,
        '尾号玩家归档后战绩盈亏不为零');
      assert.strictEqual(s.players.reduce((sum, p) => sum + p.chips, 0), s.economyTotal,
        '尾号玩家归档后的结算筹码不守恒');
      nextRequested = true;
      await emit(clients[0], 'next_hand', null);
    }
    if (s && nextRequested && s.players.length === 2) {
      assert.ok(!s.players.some((p) => p.name === NAMES[2]), '下一手仍残留被踢的尾号座位');
      const settled = ['showdown', 'handover'].includes(s.stage);
      const owned = s.players.reduce((sum, p) => sum + p.chips + (settled ? 0 : p.totalBet), 0);
      assert.strictEqual(owned, s.economyTotal, '清退尾号玩家后经济总盘不守恒');
      assert.strictEqual(s.session.reduce((sum, entry) => sum + entry.pl, 0), 0,
        '清退尾号玩家后战绩盈亏不为零');
      verified = true;
    }
    if (actionErrorRef.err) fail(actionErrorRef.err);
    await drive();
    await sleep(60);
  }

  assert.ok(verified, '超时未完成对局中踢出尾号座位的跨局验证');
  console.log('  ✓ 结算后已归档、下一手已清退尾号座位，守恒保持');
  disconnectAll(clients);
}

// ---------- 场景 2c：当前庄家/中间座离场后，下一手庄家继续顺时针轮转 ----------
async function runDealerRemapAfterMiddleKick() {
  const fail = (msg) => { throw new Error(msg); };
  const { clients, states } = await setupTable(3, fail);

  async function foldUntilHandover(hand, skipped = new Set()) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const table = states[0];
      if (table && table.handNumber === hand && table.stage === 'handover') return table;
      if (table && table.handNumber === hand
        && ['preflop', 'flop', 'turn', 'river'].includes(table.stage) && table.turnSeat >= 0) {
        const actorIdx = states.findIndex((view, idx) => !skipped.has(idx)
          && view && view.youSeat === table.turnSeat && clients[idx].connected);
        if (actorIdx >= 0) {
          const actionReply = await request(clients[actorIdx], 'action', { type: 'fold' });
          assert.ok(actionReply && actionReply.ok, `推进第 ${hand} 手失败`);
        }
      }
      await sleep(30);
    }
    throw new Error(`第 ${hand} 手未在时限内结束`);
  }

  assert.ok(await waitUntil(() => states[0] && states[0].handNumber === 1
    && ['preflop', 'flop', 'turn', 'river'].includes(states[0].stage), 3000), '庄家轮转场景未开局');
  assert.strictEqual(states[0].players[states[0].dealerSeat].name, NAMES[0], '第一手庄家应为甲');
  await foldUntilHandover(1);

  await emit(clients[0], 'next_hand', null);
  assert.ok(await waitUntil(() => states[0] && states[0].handNumber === 2
    && ['preflop', 'flop', 'turn', 'river'].includes(states[0].stage), 3000), '第二手未开始');
  const secondDealerSeat = states[0].dealerSeat;
  assert.strictEqual(states[0].players[secondDealerSeat].name, NAMES[1], '第二手庄家应轮到乙');

  const kickReply = await request(clients[0], 'kick_player', { seat: secondDealerSeat });
  assert.ok(kickReply && kickReply.ok, '未能在第二手踢出当前庄家乙');
  assert.ok(await waitUntil(() => {
    const p = states[0] && states[0].players.find((player) => player.name === NAMES[1]);
    return p && p.left && p.folded;
  }, 3000), '被踢的中间庄家未保留到本手结算');

  await foldUntilHandover(2, new Set([1]));
  assert.strictEqual(states[0].session.reduce((sum, entry) => sum + entry.pl, 0), 0,
    '中间庄家离场后战绩盈亏不为零');
  await emit(clients[0], 'next_hand', null);

  assert.ok(await waitUntil(() => states[0] && states[0].handNumber === 3
    && states[0].players.length === 2
    && ['preflop', 'flop', 'turn', 'river'].includes(states[0].stage), 3000), '第三手未按两人桌开始');
  const thirdDealer = states[0].players[states[0].dealerSeat];
  assert.ok(thirdDealer, '第三手庄家索引无效');
  assert.strictEqual(thirdDealer.name, NAMES[2], '中间庄家离场后，下一手应顺时针轮到丙');
  console.log('  ✓ 中间庄家被踢后座位正确压缩，下一手顺时针轮到丙');

  disconnectAll(clients);
}

// ---------- 场景 2d：handover 尾座庄家离开/被踢，延迟清退且庄家顺序不丢 ----------
async function runHandoverDealerTailRemoval(mode) {
  const fail = (msg) => { throw new Error(msg); };
  const { clients, states } = await setupTable(3, fail);

  async function actWhenTurn(hand, clientIdx, type) {
    const ready = await waitUntil(() => {
      const table = states[0];
      const actorView = states[clientIdx];
      return table && actorView && table.handNumber === hand
        && ['preflop', 'flop', 'turn', 'river'].includes(table.stage)
        && table.turnSeat === actorView.youSeat;
    }, 5000, 30);
    assert.ok(ready, `第 ${hand} 手未轮到 ${NAMES[clientIdx]} 执行 ${type}`);
    const actionReply = await request(clients[clientIdx], 'action', { type });
    assert.ok(actionReply && actionReply.ok, `${NAMES[clientIdx]} 的 ${type} 行动失败`);
  }

  async function waitHandover(hand) {
    const done = await waitUntil(() => states[0] && states[0].handNumber === hand
      && states[0].stage === 'handover' && states[0].results, 5000, 30);
    assert.ok(done, `第 ${hand} 手未进入结算`);
  }

  // 第 1 手庄家甲：甲、乙依次弃牌；第 2 手庄家乙：乙、丙依次弃牌。
  await actWhenTurn(1, 0, 'fold');
  await actWhenTurn(1, 1, 'fold');
  await waitHandover(1);
  await emit(clients[0], 'next_hand', null);

  await actWhenTurn(2, 1, 'fold');
  await actWhenTurn(2, 2, 'fold');
  await waitHandover(2);
  await emit(clients[0], 'next_hand', null);

  // 第 3 手庄家丙先跟注 20，确保 handover 时 totalBet 非零，再让甲、乙弃牌。
  await actWhenTurn(3, 2, 'call');
  await actWhenTurn(3, 0, 'fold');
  await actWhenTurn(3, 1, 'fold');
  await waitHandover(3);

  const settled = states[0];
  assert.strictEqual(settled.players[settled.dealerSeat].name, NAMES[2], '第三手庄家应为尾座丙');
  const tailBefore = settled.players[2];
  assert.ok(tailBefore.totalBet > 0, '专项场景未保留尾座庄家的已结算投入');
  const economyBefore = settled.economyTotal;

  const removalReply = mode === 'leave'
    ? await request(clients[2], 'leave_room', null)
    : await request(clients[0], 'kick_player', { seat: 2 });
  assert.ok(removalReply && removalReply.ok, `handover 尾座庄家${mode === 'leave' ? '离开' : '被踢'}失败`);

  const retained = await waitUntil(() => {
    const tail = states[0] && states[0].players.find((p) => p.name === NAMES[2]);
    return tail && tail.left && !tail.connected;
  }, 3000, 30);
  assert.ok(retained, 'handover 尾座庄家被提前删除，旧桌序无法用于下手轮转');
  assert.strictEqual(states[0].economyTotal, economyBefore, 'handover 延迟清退前不应缩减经济总盘');
  assert.strictEqual(states[0].players.reduce((sum, p) => sum + p.chips, 0), economyBefore,
    'handover 尾座移除后结算筹码不守恒（可能重复扣除 totalBet）');
  assert.strictEqual(states[0].session.reduce((sum, entry) => sum + entry.pl, 0), 0,
    'handover 尾座移除后战绩盈亏不为零');

  await emit(clients[0], 'next_hand', null);
  assert.ok(await waitUntil(() => states[0] && states[0].handNumber === 4
    && states[0].players.length === 2
    && ['preflop', 'flop', 'turn', 'river'].includes(states[0].stage), 3000, 30), '第四手未按两人桌开始');
  const nextDealer = states[0].players[states[0].dealerSeat];
  assert.ok(nextDealer, '尾座庄家清退后 dealerSeat 无效');
  assert.strictEqual(nextDealer.name, NAMES[0], '尾座庄家离场后下一手应顺时针轮到甲');
  const owned = states[0].players.reduce((sum, p) => sum + p.chips + p.totalBet, 0);
  assert.strictEqual(owned, states[0].economyTotal, '下一手清退尾座庄家后经济总盘不守恒');
  assert.strictEqual(states[0].session.reduce((sum, entry) => sum + entry.pl, 0), 0,
    '下一手清退尾座庄家后战绩盈亏不为零');
  console.log(`  ✓ handover 尾座庄家${mode === 'leave' ? '主动离开' : '被房主踢出'}：只扣 chips，下一手轮到甲`);

  disconnectAll(clients);
}

// ---------- 场景 3a：断线保护窗口（不瞬间弃牌 → 窗口后自动弃牌 → 重连恢复座位） ----------
async function runGraceScenario() {
  const fail = (msg) => { throw new Error(msg); };
  const actionErrorRef = { err: null };
  const { clients, states, code, tokens } = await setupTable(2, fail);

  // 等 乙 成为行动者后立刻断开（模拟手机切后台/断网）。
  // 期间顺带驱动甲立即过牌/跟注，否则甲要等 45 秒超时才轮到乙
  const midHand = (s) => !!s && ['preflop', 'flop', 'turn', 'river'].includes(s.stage);
  const yiActing = await waitUntil(() => {
    const s0 = states[0];
    if (midHand(s0) && s0.turnSeat === s0.youSeat) {
      const jia = s0.players[s0.youSeat];
      if (jia && !jia.folded) {
        const toCall = s0.currentBet - jia.roundBet;
        clients[0].emit('action', { type: toCall <= 0 ? 'check' : 'call' }, () => {});
      }
    }
    const s1 = states[1];
    return midHand(s1) && s1.turnSeat === s1.youSeat;
  }, 20000, 80);
  assert.ok(yiActing, '20 秒内未等到乙行动');
  const seatOfYi = states[1].youSeat;
  clients[1].disconnect();
  console.log('  ✓ 行动中乙断线（保护窗口开始）');

  // 1.5 秒后：乙不应被瞬间弃牌
  await sleep(1500);
  const yiView = states[0].players.find((p) => p.seat === seatOfYi);
  assert.ok(yiView && !yiView.folded, '断线玩家被瞬间弃牌，保护窗口未生效');
  console.log('  ✓ 保护窗口内未被判负（未瞬间弃牌）');

  // 窗口（8 秒）过后：乙被自动弃牌，牌局继续推进
  const foldedOrEnded = await waitUntil(() => {
    const s = states[0];
    if (!s) return false;
    const p = s.players.find((q) => q.seat === seatOfYi);
    return (p && p.folded) || s.stage === 'handover' || s.stage === 'showdown';
  }, 15000, 200);
  assert.ok(foldedOrEnded, '保护窗口过后未自动弃牌（牌局可能卡死）');
  console.log('  ✓ 保护窗口过后自动弃牌，牌局继续');

  // 重连恢复座位
  const reconnected = io(URL, { transports: ['websocket'] });
  activeClients.push(reconnected);
  const re = await new Promise((res) => {
    reconnected.emit('join_room', { code, name: NAMES[1], token: tokens[1] }, (r) => res(r));
  });
  assert.ok(re.ok, '重连失败: ' + (re.err || ''));
  assert.ok(await waitUntil(() => {
    const s = states[0];
    if (!s) return false;
    const p = s.players.find((q) => q.seat === seatOfYi);
    return p && p.connected;
  }, 5000), '重连后座位未恢复在线');
  console.log('  ✓ 断线玩家重连恢复座位');

  disconnectAll(clients);
  try { reconnected.disconnect(); } catch (_) {}
  activeClients = activeClients.filter((c) => c !== reconnected);
}

// ---------- 场景 3b：窗口内重连，行动权保留且可被服务端接受 ----------
async function runGraceReconnectWithinWindow() {
  const fail = (msg) => { throw new Error(msg); };
  const { clients, states, code, tokens } = await setupTable(2, fail);

  const midHand = (s) => !!s && ['preflop', 'flop', 'turn', 'river'].includes(s.stage);
  const yiActing = await waitUntil(() => {
    // 顺带驱动甲立即过牌/跟注，让行动权尽快轮到乙
    const s0 = states[0];
    if (midHand(s0) && s0.turnSeat === s0.youSeat) {
      const jia = s0.players[s0.youSeat];
      if (jia && !jia.folded) {
        const toCall = s0.currentBet - jia.roundBet;
        clients[0].emit('action', { type: toCall <= 0 ? 'check' : 'call' }, () => {});
      }
    }
    const s1 = states[1];
    return midHand(s1) && s1.turnSeat === s1.youSeat;
  }, 20000, 80);
  assert.ok(yiActing, '20 秒内未等到乙行动');
  const seatOfYi = states[1].youSeat;

  // 断线 → 2 秒后带 token 重连（8 秒窗口内）
  clients[1].disconnect();
  await sleep(2000);
  const re = io(URL, { transports: ['websocket'] });
  activeClients.push(re);
  const r = await new Promise((res) => {
    re.emit('join_room', { code, name: NAMES[1], token: tokens[1] }, (x) => res(x));
  });
  assert.ok(r.ok, '窗口内重连失败: ' + (r.err || ''));

  assert.ok(await waitUntil(() => {
    const s = states[0];
    const p = s && s.players.find((q) => q.seat === seatOfYi);
    return p && p.connected && !p.folded;
  }, 5000), '窗口内重连后座位/手牌状态异常');
  console.log('  ✓ 窗口内重连：座位恢复且手牌保留');

  // 若（再次）轮到乙，用重连后的连接行动一次，服务端应接受（行动权未被作废）
  const acted = await waitUntil(async () => {
    const s = states[0];
    if (!s || s.turnSeat !== seatOfYi || !['preflop', 'flop', 'turn', 'river'].includes(s.stage)) return false;
    const me = s.players[seatOfYi];
    const toCall = s.currentBet - me.roundBet;
    const act = toCall <= 0 ? 'check' : 'call';
    return await new Promise((res) => {
      re.emit('action', { type: act }, (x) => res(!!(x && x.ok)));
    });
  }, 25000, 200);
  assert.ok(acted, '窗口内重连后行动被拒（行动权丢失）');
  console.log('  ✓ 窗口内重连后行动被服务端接受');

  disconnectAll(clients);
  try { re.disconnect(); } catch (_) {}
  activeClients = activeClients.filter((c) => c !== re);
}

// ---------- 场景 4：房管设置（行动时长 / 局间倒计时 / 禁止重买） ----------
async function runSettingsScenario() {
  const fail = (msg) => { throw new Error(msg); };
  const states = new Array(2).fill(null);
  const clients = [];
  for (let i = 0; i < 2; i++) clients.push(makeClient(states, i, 2, fail));
  await sleep(300);
  const room = await emit(clients[0], 'create_room', { name: NAMES[0] });
  await emit(clients[1], 'join_room', { code: room.code, name: NAMES[1] });

  // 非法值被拒
  const bad = await new Promise((res) => {
    clients[0].emit('update_settings', { startChips: 2000, smallBlind: 10, bigBlind: 20, actionTime: 25, nextHandDelay: 5, rebuyAllowed: true }, (r) => res(r));
  });
  assert.strictEqual(bad.ok, false, '非法 actionTime 应被拒绝');

  // 合法值生效
  const good = await emit(clients[0], 'update_settings', { startChips: 2000, smallBlind: 10, bigBlind: 20, actionTime: 30, nextHandDelay: 5, rebuyAllowed: false, locked: true });
  assert.strictEqual(good.settings.actionTime, 30);
  assert.strictEqual(good.settings.nextHandDelay, 5);
  assert.strictEqual(good.settings.rebuyAllowed, false);
  assert.strictEqual(good.settings.locked, true);
  assert.ok(await waitUntil(() => states[0] && states[0].settings && states[0].settings.actionTime === 30, 5000), 'state 未同步新设置');
  const newcomer = await openClient();
  const blocked = await request(newcomer, 'join_room', { code: room.code, name: '新玩家' });
  assert.strictEqual(blocked.ok, false, '锁房后新玩家不应加入');
  assert.match(blocked.err, /锁定/);
  console.log('  ✓ 新设置项保存并广播（30s 行动 / 5s 局间 / 禁止重买 / 锁房）');

  disconnectAll([...clients, newcomer]);
}

(async () => {
  try {
    await runSocketHardeningScenario();
    await runTokenHijackScenario();
    await runFoldedHolePrivacyScenario();
    await runDuplicateBusinessRequestScenario();
    await runIntegration(2);
    await runIntegration(3);
    await runIntegration(6);
    await runLeaveMidHand();
    await runKickTailMidHand();
    await runDealerRemapAfterMiddleKick();
    await runHandoverDealerTailRemoval('leave');
    await runHandoverDealerTailRemoval('kick');
    await runGraceScenario();
    await runGraceReconnectWithinWindow();
    await runSettingsScenario();
    console.log('\n全部测试通过 ✅');
  } catch (e) {
    console.error('\n测试失败 ❌:', e && e.message ? e.message : e);
    process.exitCode = 1;
  } finally {
    for (const c of activeClients) { try { c.disconnect(); } catch (_) {} }
    setTimeout(() => process.exit(process.exitCode || 0), 100);
  }
})();
