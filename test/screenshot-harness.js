/**
 * 截图驱动工具（A1 Phase 2 · 给总负责人实测 PC 牌桌用）
 *
 * 使用方法（两步，顺序固定）：
 *   1. 启动服务器（保持运行）：      PORT=3456 node server.js
 *      （Windows CMD：set PORT=3456 && node server.js）
 *   2. 另开一个终端运行本脚本：      node test/screenshot-harness.js
 *
 * 脚本行为：
 *   - 自动创建房间，并让 5 个机器人入座：小帆 / 阿飞 / 可乐 / 兔子 / Lemon（共 6 人局）；
 *   - 第 6 个座位留给浏览器玩家（你）：脚本打印房间号与加入说明；
 *   - 浏览器玩家加入后自动开局；机器人只出 check / call，保持牌局推进；
 *   - 轮到浏览器玩家时机器人全部暂停，等待你在页面上手动操作；
 *   - 服务端 45 秒行动超时会自动过牌/弃牌（服务端默认行为，脚本不干预）。
 *
 * 注意：本脚本不启动服务器、不修改 server.js；按 Ctrl+C 结束。
 */
const { io } = require('socket.io-client');

const URL = process.env.HARNESS_URL || 'http://localhost:3456';
const ROBOT_NAMES = ['小帆', '阿飞', '可乐', '兔子', 'Lemon'];
const SUGGESTED_HERO_NAME = '你';

const states = new Array(ROBOT_NAMES.length).fill(null);
const clients = [];
const acting = new Array(ROBOT_NAMES.length).fill(false);
const heroTurnKey = { value: '' };
let gameStarted = false;
let heroSeatSeen = false;
let roomCode = '';

const log = (...args) => console.log(...args);

function attachRobot(idx, client) {
  client.on('state', (s) => {
    states[idx] = s;
    if (!heroSeatSeen) {
      const hero = s.players.find((p) => !ROBOT_NAMES.includes(p.name));
      if (hero) {
        heroSeatSeen = true;
        log(`✓ 检测到浏览器玩家已入座：「${hero.name}」（座位 ${hero.seat}），即将开局…`);
        startGame();
      }
    }
    drive(idx);
  });
}

/** 房主（小帆）开局：等浏览器玩家入座后再开，保证 6 人局 */
function startGame() {
  if (gameStarted) return;
  gameStarted = true;
  clients[0].emit('start_game', null, (r) => {
    if (r && r.ok) log('✓ 6 人局已开始，机器人自动行动中（只 check/call）');
    else log('✗ 开局失败：' + (r && r.err));
  });
}

/** 机器人驱动器：轮到自己时延迟片刻行动；轮到浏览器玩家时不行动并提示 */
function drive(idx) {
  const s = states[idx];
  if (!s || acting[idx]) return;
  if (!['preflop', 'flop', 'turn', 'river'].includes(s.stage)) {
    if (s.stage === 'handover' && s.results) {
      const key = 'handover_' + s.handNumber;
      if (heroTurnKey.value !== key) {
        heroTurnKey.value = key;
        log(`— 第 ${s.handNumber} 局结束，${(s.settings && s.settings.nextHandDelay) || 20} 秒后自动开下一局 —`);
      }
    }
    return;
  }

  // 找到浏览器玩家的座位（名字不在机器人列表中）；
  // 轮到浏览器玩家：不代打，等手动操作，超时由服务端兜底推进
  const hero = s.players.find((p) => !ROBOT_NAMES.includes(p.name));
  if (hero && s.turnSeat === hero.seat) {
    const key = `hero_${s.handNumber}_${s.stage}_${s.turnSeat}`;
    if (heroTurnKey.value !== key) {
      heroTurnKey.value = key;
      const cur = s.players[hero.seat];
      const toCall = s.currentBet - cur.roundBet;
      log('');
      log('⏸ 轮到浏览器玩家（%s）行动，机器人已暂停，请在页面上操作。', hero.name);
      if (toCall > 0) log('   当前需跟注 %d，剩余思考时间 %d 秒（超时服务端会自动过牌/弃牌）。',
        toCall, (s.settings && s.settings.actionTime) || 45);
      log('');
    }
    return;
  }

  const me = s.players[s.youSeat];
  if (!me || s.turnSeat !== s.youSeat) return;

  acting[idx] = true;
  const seat = s.youSeat;
  setTimeout(() => {
    acting[idx] = false;
    try {
      const cur = states[idx]; // 延迟期间对手可能已行动，用最新状态复核
      if (!cur || cur.turnSeat !== seat || cur.youSeat !== seat) return;
      const p = cur.players[seat];
      if (!p || p.folded || p.allIn) return;
      const toCall = cur.currentBet - p.roundBet;
      const act = toCall <= 0 ? 'check' : 'call';
      clients[idx].emit('action', { type: act }, (r) => {
        if (r && !r.ok && r.err !== '还没轮到你行动') {
          log(`✗ ${p.name} 行动被拒: ${r.err}`);
        }
      });
    } catch (e) {
      log('✗ 驱动器异常:', e && e.message);
    }
  }, 700 + Math.floor(Math.random() * 600)); // 0.7~1.3 秒拟人延迟
}

(async () => {
  log('');
  log('══════════════════════════════════════════════════════');
  log(' 截图驱动工具启动（目标服务器：%s）', URL);
  log('══════════════════════════════════════════════════════');

  // 1. 创建房间：小帆为房主
  const host = io(URL, { transports: ['websocket'] });
  clients.push(host);
  const created = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('连接服务器超时，请确认已运行 PORT=3456 node server.js')), 5000);
    host.emit('create_room', { name: ROBOT_NAMES[0] }, (r) => {
      clearTimeout(t);
      if (r && r.ok) res(r); else rej(new Error('创建房间失败: ' + (r && r.err)));
    });
  }).catch((e) => {
    log('✗ ' + e.message);
    process.exit(1);
  });
  roomCode = created.code;

  attachRobot(0, host);

  // 2. 其余 4 个机器人加入
  for (let i = 1; i < ROBOT_NAMES.length; i++) {
    const c = io(URL, { transports: ['websocket'] });
    clients.push(c);
    const name = ROBOT_NAMES[i];
    // eslint-disable-next-line no-loop-func
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(name + ' 加入超时')), 5000);
      c.emit('join_room', { code: roomCode, name }, (r) => {
        clearTimeout(t);
        if (r && r.ok) res(r); else rej(new Error(name + ' 加入失败: ' + (r && r.err)));
      });
    });
    attachRobot(i, c);
  }

  log('');
  log('──────────────────────────────────────────────────────');
  log(' 房间号：%s（房主：小帆）', roomCode);
  log(' 6 人局已就座 5 席：' + ROBOT_NAMES.join(' / '));
  log('');
  log(' 请用浏览器完成第 6 人入座（三步）：');
  log('   1. 打开  %s/?room=%s', URL.replace(/\/$/, ''), roomCode);
  log('   2. 昵称填「%s」（不要与机器人昵称重复）', SUGGESTED_HERO_NAME);
  log('   3. 点「加入」入座 —— 检测到你入座后会自动开局');
  log('');
  log(' 建议浏览器窗口：1920×1080 或 1366×768，用于 PC 截图验收。');
  log(' 轮到你时机器人会暂停等你操作；45 秒不操作会自动过牌/弃牌。');
  log('──────────────────────────────────────────────────────');
  log('');

  // 3. 等待浏览器玩家期间给个心跳提示
  let waitSec = 0;
  const waitTimer = setInterval(() => {
    waitSec += 10;
    if (!heroSeatSeen && waitSec % 30 === 0) {
      log('… 等待浏览器玩家入座中（已等 %d 秒）', waitSec);
    }
  }, 10000);
  waitTimer.unref && waitTimer.unref();
})().catch((e) => {
  log('✗ 启动失败: ' + (e && e.message ? e.message : e));
  process.exit(1);
});

// 保持进程存活：机器人 socket 连接期间脚本持续运行；Ctrl+C 退出
process.on('SIGINT', () => {
  log('');
  log('已停止截图驱动工具（服务器不受影响）。');
  clients.forEach((c) => { try { c.disconnect(); } catch (_) {} });
  setTimeout(() => process.exit(0), 100);
});
