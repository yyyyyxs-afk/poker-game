/**
 * 冒烟测试（需先启动服务器）：
 * 1. 集成：2 / 3 / 6 个模拟客户端随机对局，校验筹码守恒 + 战绩盈亏零和
 * 2. 场景：对局中主动退出后守恒跨局保持
 * 3. 场景：断线保护窗口（不瞬间弃牌 / 窗口后自动弃牌 / 窗口内重连可继续行动）
 * 4. 场景：房管设置（行动时长 / 局间倒计时 / 禁止重买）校验
 *
 * 运行前先启动服务器：PORT=3456 node server.js
 * 执行：node test/smoke.test.js （或 TEST_URL=http://localhost:3100 npm test）
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
  const deadline = Date.now() + (n >= 6 ? 90000 : 60000);

  while (handsPlayed.length < 2 && !gameEnded && Date.now() < deadline) {
    for (let i = 0; i < n; i++) {
      const s = states[i];
      if (!s) continue;
      const me = s.players[s.youSeat];

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

// ---------- 场景 2：对局中/局间退出，守恒跨局保持 ----------
async function runLeaveMidHand() {
  const fail = (msg) => { throw new Error(msg); };
  const actionErrorRef = { err: null };
  const { clients, states, code, tokens } = await setupTable(3, fail);
  let bingLeft = false;
  let yiLeft = false;
  const drive = makeDriver(states, clients, actionErrorRef, (i) => (i === 2 && bingLeft) || (i === 1 && yiLeft));

  const sumOf = (s, settled) => s.players.reduce((t, p) => t + p.chips + (settled ? 0 : p.totalBet), 0);

  const deadline = Date.now() + 90000;
  let bugPathVerified = false;
  while (!bugPathVerified && Date.now() < deadline) {
    const s = states[0];
    if (s) {
      // 第 1 步：丙在有投入时对局中退出（立即弃牌、座位保留）
      if (!bingLeft && ['preflop', 'flop', 'turn', 'river'].includes(s.stage)) {
        const p3 = s.players[2];
        if (p3 && p3.totalBet > 0 && !p3.folded) {
          bingLeft = true;
          console.log('  ✓ 丙在有投入时对局中退出（立即弃牌、座位保留）');
          clients[2].emit('leave_room');
        }
      }
      // 第 2 步：第 1 局结束进入局间 → 丙带 token 重连恢复可玩，
      // 然后乙带着已结算的残留 totalBet 离场（触发清场扣账路径）
      if (bingLeft && !yiLeft && s.stage === 'handover' && s.results) {
        const sum = sumOf(s, true);
        assert.strictEqual(sum, s.economyTotal, '第 1 局结算筹码不守恒');
        const reBing = io(URL, { transports: ['websocket'] });
        activeClients.push(reBing);
        clients[2] = reBing;
        await emit(reBing, 'join_room', { code, name: NAMES[2], token: tokens[2] });
        yiLeft = true;
        console.log('  ✓ 第 1 局结算守恒；丙重连，乙在局间离场（触发清场）');
        clients[1].emit('leave_room');
        // 跨 socket 无顺序保证：等服务端处理完离场广播（left 座位已建）再开下一局
        await sleep(400);
        await emit(clients[0], 'next_hand');
      }
      // 第 3 步：乙被清场（房间只剩 2 座位，可能在等待或新一局）→ 守恒 + 战绩零和
      if (yiLeft && s.players.length === 2) {
        const settled = s.stage === 'handover' || s.stage === 'showdown';
        const sum = sumOf(s, settled);
        assert.strictEqual(sum, s.economyTotal, '清场后筹码不守恒（经济清退修复失效）');
        if (Array.isArray(s.session)) {
          const plSum = s.session.reduce((t, e) => t + e.pl, 0);
          assert.strictEqual(plSum, 0, '清场后战绩盈亏之和不为零');
        }
        bugPathVerified = true;
      }
    }
    if (actionErrorRef.err) fail(actionErrorRef.err);
    await drive();
    await sleep(60);
  }
  assert.ok(bugPathVerified, '超时未完成退出场景验证');
  console.log('  ✓ 乙离场清场后 economyTotal 守恒 + 战绩零和保持');

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
  const good = await emit(clients[0], 'update_settings', { startChips: 2000, smallBlind: 10, bigBlind: 20, actionTime: 30, nextHandDelay: 5, rebuyAllowed: false });
  assert.strictEqual(good.settings.actionTime, 30);
  assert.strictEqual(good.settings.nextHandDelay, 5);
  assert.strictEqual(good.settings.rebuyAllowed, false);
  assert.ok(await waitUntil(() => states[0] && states[0].settings && states[0].settings.actionTime === 30, 5000), 'state 未同步新设置');
  console.log('  ✓ 新设置项保存并广播（30s 行动 / 5s 局间 / 禁止重买）');

  disconnectAll(clients);
}

(async () => {
  try {
    await runIntegration(2);
    await runIntegration(3);
    await runIntegration(6);
    await runLeaveMidHand();
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
