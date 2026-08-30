/* 德州扑克客户端（A1 Phase 2 视觉结构版）
 * 牌局数据、Socket.IO 协议与操作逻辑保持不变；
 * 本轮重写 DOM 渲染：Header / Play Stage（牌桌 + 席位 + 下注层）/ Hero Dock / Raise Controller。 */
const socket = io();

let mySeat = -1;
let state = null;
let raiseOpen = false;

// ---------------- 音效（Web Audio 合成，无外部资源） ----------------
let audioCtx = null;
let soundOn = localStorage.getItem('poker-sound') !== 'off';
function ac() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
document.addEventListener('pointerdown', () => ac(), { once: true });
function tone(freq, dur, delay = 0, type = 'sine', vol = 0.12) {
  if (!soundOn) return;
  const ctx = ac();
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g);
  g.connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}
const sfx = {
  deal() { tone(920, 0.06, 0, 'triangle', 0.06); },
  bet() { tone(340, 0.05, 0, 'square', 0.05); tone(430, 0.05, 0.06, 'square', 0.05); },
  turn() { tone(700, 0.1); tone(950, 0.12, 0.12); },
  win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, i * 0.11, 'triangle', 0.09)); },
};
const soundBtn = document.getElementById('btn-sound');
function renderSoundBtn() {
  soundBtn.classList.toggle('off', !soundOn);
  soundBtn.setAttribute('aria-label', soundOn ? '关闭音效' : '开启音效');
}
soundBtn.onclick = () => {
  soundOn = !soundOn;
  localStorage.setItem('poker-sound', soundOn ? 'on' : 'off');
  renderSoundBtn();
};
renderSoundBtn();

// ---------------- Header 汉堡菜单（复制房号 / 邀请链接 / 退出） ----------------
const menuBtn = document.getElementById('btn-menu');
const menuDropdown = document.getElementById('menu-dropdown');
function closeMenu() {
  menuDropdown.classList.add('hidden');
  menuBtn.setAttribute('aria-expanded', 'false');
}
menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const willOpen = menuDropdown.classList.contains('hidden');
  menuDropdown.classList.toggle('hidden', !willOpen);
  menuBtn.setAttribute('aria-expanded', String(willOpen));
});
document.addEventListener('click', (e) => {
  if (menuDropdown.classList.contains('hidden')) return;
  if (!menuDropdown.contains(e.target)) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});

// 牌局记录面板：Header 图标与面板标题都可收起；手机端默认收起，减少视觉干扰
const logPanel = document.getElementById('log-panel');
const logToggleBtn = document.getElementById('btn-log-toggle');
function setLogCollapsed(collapsed) {
  logPanel.classList.toggle('collapsed', collapsed);
  logToggleBtn.setAttribute('aria-pressed', String(!collapsed));
  logToggleBtn.setAttribute('aria-label', collapsed ? '展开牌局记录' : '收起牌局记录');
}
logToggleBtn.addEventListener('click', () => {
  setLogCollapsed(!logPanel.classList.contains('collapsed'));
});
logPanel.querySelector('.log-head').addEventListener('click', (e) => {
  if (e.target.closest('#btn-log-collapse')) return;
  setLogCollapsed(!logPanel.classList.contains('collapsed'));
});
document.getElementById('btn-log-collapse').addEventListener('click', () => setLogCollapsed(true));
if (window.matchMedia('(max-width: 900px)').matches) {
  setLogCollapsed(true);
}

// ---------------- 大厅 ----------------
// 记住昵称：进页自动预填；URL 带 ?room=XXXXXX 时自动填邀请码（邀请链接直达）
(function initLobby() {
  const savedName = localStorage.getItem('poker-nickname');
  if (savedName) document.getElementById('nickname').value = savedName;
  const roomParam = new URLSearchParams(location.search).get('room');
  if (roomParam && /^[A-Za-z0-9]{6}$/.test(roomParam)) {
    document.getElementById('room-code').value = roomParam.toUpperCase();
    document.getElementById('nickname').focus();
  }
})();

function storedToken(code, name) {
  try { return JSON.parse(localStorage.getItem('poker-auth') || '{}'); }
  catch { return {}; }
}
function saveAuth(code, name, token) {
  const auth = storedToken();
  auth[`${code}_${name}`] = token;
  localStorage.setItem('poker-auth', JSON.stringify(auth));
}

document.getElementById('btn-create').onclick = () => {
  const name = getName();
  if (!name) return;
  socket.emit('create_room', { name }, (res) => {
    if (res.ok) { saveAuth(res.code, name, res.token); enterRoom(res.code); }
    else showLobbyError(res.err);
  });
};
document.getElementById('btn-join').onclick = () => {
  const name = getName();
  const code = document.getElementById('room-code').value.trim().toUpperCase();
  if (!name) return;
  if (!/^[A-Z0-9]{6}$/.test(code)) return showLobbyError('请输入 6 位邀请码');
  socket.emit('join_room', { code, name, token: storedToken()[`${code}_${name}`] }, (res) => {
    if (res.ok) { saveAuth(res.code, name, res.token); enterRoom(res.code); }
    else showLobbyError(res.err);
  });
};
function getName() {
  const n = document.getElementById('nickname').value.trim();
  if (!n) { showLobbyError('请先填写昵称'); return null; }
  return n;
}
function showLobbyError(msg) { document.getElementById('lobby-error').textContent = msg; }

function enterRoom(code) {
  const name = document.getElementById('nickname').value.trim();
  if (name) localStorage.setItem('poker-nickname', name);
  saveLastRoom(code, name || localStorage.getItem('poker-nickname') || '');
  document.getElementById('lobby').classList.add('hidden');
  document.getElementById('game').classList.remove('hidden');
  document.getElementById('room-code-display').textContent = code;
}

// ---------------- 断线自动重连（token 恢复座位，客户端行为） ----------------
// 服务端断线保护窗口与座位语义不变；这里只做：断线后 socket 重连成功时，
// 用本地保存的房号/昵称/token 自动 join_room 恢复座位，重试数次后给手动入口。
const LAST_ROOM_KEY = 'poker-last-room';
function saveLastRoom(code, name) {
  if (!code || !name) return;
  localStorage.setItem(LAST_ROOM_KEY, JSON.stringify({ code, name }));
}
function getLastRoom() {
  try { return JSON.parse(localStorage.getItem(LAST_ROOM_KEY) || 'null'); }
  catch { return null; }
}
function clearLastRoom() { localStorage.removeItem(LAST_ROOM_KEY); }

const connOverlay = document.getElementById('conn-overlay');
const connMsg = document.getElementById('conn-msg');
const connSub = document.getElementById('conn-sub');
const connActions = document.getElementById('conn-actions');
let reconnectAttempts = 0;
function setConnState(msg, sub, showActions) {
  connMsg.textContent = msg;
  connSub.textContent = sub || '';
  connActions.classList.toggle('hidden', !showActions);
}
function tryRejoin() {
  const last = getLastRoom();
  if (!last || !last.code) { connOverlay.classList.add('hidden'); return; }
  setConnState('正在恢复牌局…', `${last.code} · ${last.name}`);
  socket.emit('join_room', {
    code: last.code,
    name: last.name,
    token: storedToken()[`${last.code}_${last.name}`],
  }, (res) => {
    if (res && res.ok) {
      reconnectAttempts = 0;
      enterRoom(last.code);
      connOverlay.classList.add('hidden');
      flashTip('已重新连接，回到牌局');
    } else if (reconnectAttempts < 3) {
      reconnectAttempts++;
      setTimeout(tryRejoin, 1500);
    } else {
      setConnState('重新连接失败', (res && res.err) || '请稍后手动重试', true);
    }
  });
}
document.getElementById('btn-reconnect').addEventListener('click', () => {
  reconnectAttempts = 0;
  setConnState('正在恢复牌局…', '');
  tryRejoin();
});
document.getElementById('btn-conn-lobby').addEventListener('click', () => {
  clearLastRoom();
  location.reload();
});

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(() => true, () => false);
  }
  // 非安全上下文（http 局域网/隧道地址）降级：弹出选择方便手动复制
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return Promise.resolve(ok);
  } catch { return Promise.resolve(false); }
}
function flashCopied(btn, ok) {
  btn.textContent = ok ? '已复制' : '请手动复制';
  setTimeout(() => (btn.textContent = btn.dataset.label || '复制'), 1200);
}
document.getElementById('btn-copy-code').onclick = () => {
  const code = state?.code || '';
  copyText(code).then((ok) => flashCopied(document.getElementById('btn-copy-code'), ok));
};
document.getElementById('btn-copy-link').onclick = () => {
  const code = state?.code || '';
  const url = location.origin + location.pathname + '?room=' + code;
  copyText(url).then((ok) => flashCopied(document.getElementById('btn-copy-link'), ok));
};
document.getElementById('btn-leave').onclick = () => {
  clearLastRoom(); // 主动退出：不留自动重连的恢复信息
  location.reload();
};

// 开始游戏（等待阶段且人数 >= 2 时显示）
document.getElementById('btn-start').onclick = () => {
  socket.emit('start_game', null, (res) => {
    if (!res.ok) flashTip(res.err);
  });
};

// 重买（筹码输光后在两手之间补充）
document.getElementById('btn-rebuy').onclick = () => {
  socket.emit('rebuy', null, (res) => {
    if (!res.ok) flashTip(res.err);
  });
};

// 暂离 / 坐回（暂离入口在 Header 汉堡菜单内，点击后收起菜单）
document.getElementById('btn-sit-out').onclick = () => {
  closeMenu();
  socket.emit('sit_out', null, (res) => {
    if (!res.ok) flashTip(res.err);
  });
};
document.getElementById('btn-sit-back').onclick = () => {
  socket.emit('sit_back', null, (res) => {
    if (!res.ok) flashTip(res.err);
  });
};

// 被踢出
socket.on('kicked', ({ reason }) => {
  alert(reason || '你已被移出房间');
  location.reload();
});

// ---------------- 房管设置 ----------------
const settingsOverlay = document.getElementById('settings-overlay');
document.getElementById('btn-settings').onclick = () => {
  document.getElementById('set-start-chips').value = state.settings.startChips;
  document.getElementById('set-sb').value = state.settings.smallBlind;
  document.getElementById('set-bb').value = state.settings.bigBlind;
  // 兼容旧服务端：新字段缺失时按默认值回显
  document.getElementById('set-action-time').value = String(state.settings.actionTime || 45);
  document.getElementById('set-next-hand').value = String(state.settings.nextHandDelay || 20);
  document.getElementById('set-rebuy').value = String(state.settings.rebuyAllowed !== false);
  document.getElementById('settings-error').textContent = '';
  settingsOverlay.classList.remove('hidden');
};
document.getElementById('btn-settings-close').onclick = () => settingsOverlay.classList.add('hidden');
document.getElementById('btn-settings-save').onclick = saveSettings;
function saveSettings() {
  const payload = {
    startChips: parseInt(document.getElementById('set-start-chips').value, 10),
    smallBlind: parseInt(document.getElementById('set-sb').value, 10),
    bigBlind: parseInt(document.getElementById('set-bb').value, 10),
    actionTime: parseInt(document.getElementById('set-action-time').value, 10),
    nextHandDelay: parseInt(document.getElementById('set-next-hand').value, 10),
    rebuyAllowed: document.getElementById('set-rebuy').value === 'true',
  };
  socket.emit('update_settings', payload, (res) => {
    if (res.ok) {
      settingsOverlay.classList.add('hidden');
    } else {
      document.getElementById('settings-error').textContent = res.err;
    }
  });
}

// ---------------- 状态渲染 ----------------
socket.on('state', (s) => {
  state = s;
  mySeat = s.youSeat;
  document.getElementById('conn-overlay').classList.add('hidden');
  render();
});

// 断线感知：掉线全屏提示；socket 自动重连成功后用 token 恢复座位
let everConnected = false;
socket.on('connect', () => {
  if (!everConnected) { everConnected = true; return; } // 首次连接不算断线恢复
  reconnectAttempts = 0;
  connOverlay.classList.remove('hidden');
  setConnState('连接恢复，正在回到牌局…', '');
  tryRejoin();
});
socket.on('disconnect', () => {
  connOverlay.classList.remove('hidden');
  setConnState('连接断开，正在重连…', '断线期间轮到你时，牌局会保留一段时间');
});

function render() {
  if (!state) return;
  try {
    updateWinnerSeats();
    renderTableInfo();
    renderSeats();
    renderBets();
    renderCommunity();
    renderMyArea();
    renderLogs();
    renderResults();
  } catch (e) {
    // 渲染异常不应白屏：把错误显示在提示区，座位区保留上次内容
    console.error(e);
    const tip = document.getElementById('waiting-tip');
    if (tip) tip.textContent = '显示出错，请刷新页面重试';
  }
}

/** 房间配置：兼容旧服务端（settings 字段缺失时回退到顶层字段/默认值） */
function cfg() {
  if (state.settings) return state.settings;
  return {
    startChips: state.startChips || 2000,
    smallBlind: state.smallBlind || 10,
    bigBlind: state.bigBlind || 20,
  };
}

let lastTurnKey = '';
let lastResultKey = '';
let prevPot = null;
let prevCurrentBet = null;
let turnCountdownTimer = null;

/** 思考倒计时（显示用途）：按房间行动时长从本轮开始递减，剩 10 秒转警示色 */
function startTurnTimer() {
  stopTurnTimer();
  const el = document.getElementById('turn-timer');
  const total = cfg().actionTime || 45;
  let left = total;
  const paint = () => {
    const pct = Math.max(0, Math.min(100, (left / total) * 100));
    el.innerHTML = `<div class="timer-ring${left <= 10 ? ' urgent' : ''}" style="--p:${pct}" role="timer" aria-label="剩余思考时间 ${Math.max(0, left)} 秒"><b>${Math.max(0, left)}</b></div>`;
  };
  paint();
  el.classList.remove('hidden');
  turnCountdownTimer = setInterval(() => {
    left--;
    if (left <= 0) { stopTurnTimer(); return; }
    paint();
  }, 1000);
}
function stopTurnTimer() {
  if (turnCountdownTimer) { clearInterval(turnCountdownTimer); turnCountdownTimer = null; }
  const el = document.getElementById('turn-timer');
  if (el) { el.classList.add('hidden'); el.innerHTML = ''; }
}

function renderTableInfo() {
  const stageText = {
    waiting: '等待中', preflop: '翻牌前', flop: '翻牌圈',
    turn: '转牌圈', river: '河牌圈', showdown: '摊牌', handover: '本局结束',
  }[state.stage] || '';
  document.getElementById('hand-info').textContent =
    state.handNumber > 0 ? `第 ${state.handNumber} 局 · ${stageText}` : '';
  const c = cfg();
  const blindsEl = document.getElementById('blinds-info');
  if (blindsEl) blindsEl.textContent = `盲注 ${c.smallBlind}/${c.bigBlind}`;
  // 底池变化：数字轻量跳动提示
  const potEl = document.getElementById('pot-value');
  if (prevPot !== null && state.pot > prevPot) {
    const disp = document.getElementById('pot-display');
    disp.classList.remove('bump');
    void disp.offsetWidth; // 重置动画
    disp.classList.add('bump');
    setTimeout(() => disp.classList.remove('bump'), 400);
  }
  potEl.textContent = state.pot;
  prevPot = state.pot;
  document.getElementById('stage-label').textContent = stageText;
  // 有人加注：桌心短暂 toast（含加注者昵称）
  if (prevCurrentBet !== null && state.currentBet > prevCurrentBet &&
      ['preflop', 'flop', 'turn', 'river'].includes(state.stage)) {
    const raiser = state.players.find((p) => p.roundBet === state.currentBet);
    showToast(raiser ? `${raiser.name} 加注到 ${state.currentBet}` : `当前下注 ${state.currentBet}`);
  }
  prevCurrentBet = state.currentBet;
  // 房管设置入口：仅房主且在等待阶段可见（旧服务端无 isHost，自动隐藏）
  const settingsBtn = document.getElementById('btn-settings');
  if (settingsBtn) {
    settingsBtn.classList.toggle(
      'hidden', !(state.stage === 'waiting' && state.isHost));
  }
}

let toastTimer = null;
function showToast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.getElementById('play-stage').appendChild(t);
  }
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 1800);
}

function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

/** 像素头像：Phase 1 的 3 张真实 PNG 循环复用（同一玩家本局内稳定）。
 *  Phase 6 扩充：待 6 款资产生成后（见 assets/a1/avatars/prompts-phase6.md），
 *  按文件名顺序追加 3 项即可一席一款（数组按座位号取模）。 */
const AVATAR_PNGS = [
  'assets/a1/avatars/avatar-blue-headphones.png',
  'assets/a1/avatars/avatar-magenta-asym.png',
  'assets/a1/avatars/avatar-red-cap.png',
];
function avatarPng(seat) {
  return AVATAR_PNGS[((seat % 3) + 3) % 3];
}

/** 座位围绕椭圆分布，自己固定在底部（Hero Dock），其余席位在桌沿顺时针排布：
 *  1=左下 2=左上 3=顶部 4=右上 5=右下（6 人时与 A1 效果图一致）。
 *  手机（≤900）侧翼席位纵向避开桌心中央区，避免卡片压牌；≤420 桌与 375
 *  统一 1:1，但窗口矮、中央区占比更大，下侧翼再压到 y82（真机 320 校准：
 *  社区带底约 66%，卡片顶需 ≥ 66%+8px 余量）。
 *  注意：本函数参数与 betPosition 的 BET_BAND 保守带耦合，改动必须
 *  连带复跑全断点 × 人数 × 席位的落点穷举（见提交 ff4ae98 说明）。
 *  注意：传入的 index 已是"相对自己的序号"，自己=0 恒在正下方。 */
function seatPosition(index, total) {
  const angleDeg = 90 + (index / total) * 360;
  const rad = (angleDeg * Math.PI) / 180;
  const w = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const h = typeof window !== 'undefined' ? window.innerHeight : 800;
  const narrow = w <= 900;
  const veryNarrow = narrow && w <= 420;
  const landscape = w > h;
  const rx = 44;
  const ry = narrow ? 40 : 42;
  let x = Math.max(narrow ? 14 : 9, Math.min(narrow ? 86 : 91, 50 + Math.cos(rad) * rx));
  let y = Math.max(narrow ? 11 : 9, Math.min(narrow ? 80 : 71, 50 + Math.sin(rad) * ry));
  // 手机侧翼席位：收在中央区同一侧之外（卡片半高约 6%~9%，按桌比例分档）
  if (narrow && index !== 0 && (x <= 30 || x >= 70)) {
    if (landscape) {
      y = y < 50 ? Math.min(y, 24) : Math.max(y, 88);
    } else {
      y = y < 50 ? Math.min(y, 27) : Math.max(y, veryNarrow ? 82 : 78);
    }
  }
  return { x, y };
}

/** 席位状态徽标（互斥，按优先级取一个） */
function seatStateBadge(p) {
  if (p.allIn && ['preflop', 'flop', 'turn', 'river', 'showdown'].includes(state.stage)) return '全押';
  if (p.folded && state.stage !== 'waiting' && state.stage !== 'handover') return '已弃牌';
  if (!p.connected) return '离线';
  if (p.sittingOut) return '暂离';
  return '';
}

function seatCardHtml(p, isMe) {
  const isTurn = p.seat === state.turnSeat && !p.folded &&
    ['preflop', 'flop', 'turn', 'river'].includes(state.stage);
  const stateBadge = seatStateBadge(p);
  const dealer = p.isDealer && state.stage !== 'waiting'
    ? '<span class="dealer-badge" title="庄家">D</span>' : '';
  return `
    ${dealer}
    <img class="avatar-img" src="${avatarPng(p.seat)}" alt="${escapeHtml(p.name)} 的像素头像" />
    <div class="seat-copy">
      <strong>${escapeHtml(p.name)}</strong>
      <span class="seat-chips">${p.chips}</span>
    </div>
    ${stateBadge ? `<span class="state-badge">${stateBadge}</span>` : ''}
    ${isTurn ? '<span class="turn-dot" aria-label="正在行动"></span>' : ''}
  `;
}

/** 摊牌赢家座位集合：牌桌直显的席位高亮（第一层结算） */
let winnerSeats = new Set();
function updateWinnerSeats() {
  winnerSeats = new Set();
  if (state.stage === 'handover' && state.results) {
    state.results.pots.forEach((pot) => pot.winners.forEach((w) => winnerSeats.add(w.seat)));
  }
}

function renderSeats() {
  const wrap = document.getElementById('seats');
  wrap.innerHTML = '';
  const players = state.players;
  players.forEach((p) => {
    if (p.seat === mySeat) return; // 自己固定渲染在 Hero Dock
    const relIdx = (p.seat - (mySeat >= 0 ? mySeat : 0) + players.length) % players.length;
    const pos = seatPosition(relIdx, players.length);

    const div = document.createElement('div');
    div.className = 'seat' + (p.folded ? ' folded-seat' : '') +
      (p.seat === state.turnSeat && !p.folded ? ' active-turn' : '') +
      (winnerSeats.has(p.seat) ? ' winner-seat' : '') +
      (p.connected ? '' : ' offline');
    div.dataset.seat = p.seat;

    div.innerHTML = `
      <div class="hole-cards"></div>
      <div class="seat-card">${seatCardHtml(p, false)}</div>
    `;

    // 摊牌后服务端公开手牌：亮出（未摊牌时不显示牌背，保持桌面干净）
    const holeDiv = div.querySelector('.hole-cards');
    if (p.hole && p.hole.length && state.revealed) {
      p.hole.forEach((c) => holeDiv.appendChild(cardEl(c, false)));
    }

    div.style.left = pos.x + '%';
    div.style.top = pos.y + '%';
    wrap.appendChild(div);

    // 房主踢人按钮：在非自己、非已离开的座位上显示
    if (state.isHost && p.seat !== mySeat && !p.left) {
      const kickBtn = document.createElement('button');
      kickBtn.className = 'kick-btn';
      kickBtn.textContent = '踢出';
      kickBtn.onclick = () => {
        if (confirm('确定将 ' + p.name + ' 移出房间？')) {
          socket.emit('kick_player', { seat: p.seat }, (res) => {
            if (!res.ok) flashTip(res.err);
          });
        }
      };
      div.appendChild(kickBtn);
    }
  });

  // 坐回按钮（暂离对手座位上的快捷入口）
  wrap.querySelectorAll('.sit-back-btn').forEach((btn) => {
    btn.onclick = () => {
      socket.emit('sit_back', null, (res) => {
        if (!res.ok) flashTip(res.err);
      });
    };
  });
}

/** Hero 席位：与手牌、操作区同属一个视觉结构锚点 */
function renderHeroSeat(me) {
  const box = document.getElementById('hero-seat');
  if (!me) {
    box.innerHTML = '<div class="seat-card me-seat seat-empty">未入座</div>';
    return;
  }
  const isTurn = me.seat === state.turnSeat && !me.folded &&
    ['preflop', 'flop', 'turn', 'river'].includes(state.stage);
  const stateBadge = seatStateBadge(me);
  box.innerHTML = `
    <div class="seat-card me-seat${isTurn ? ' is-current' : ''}${me.folded ? ' folded-seat' : ''}${winnerSeats.has(me.seat) ? ' winner-seat' : ''}">
      ${me.isDealer && state.stage !== 'waiting' ? '<span class="dealer-badge" title="庄家">D</span>' : ''}
      <img class="avatar-img" src="${avatarPng(me.seat)}" alt="我的像素头像" />
      <div class="seat-copy">
        <strong>${escapeHtml(me.name)}</strong>
        <span class="seat-chips">${me.chips}</span>
      </div>
      ${stateBadge ? `<span class="state-badge">${stateBadge}</span>` : ''}
    </div>
  `;
}

/** 下注筹码定位（归属优先，运行时 DOM 实测，任何断点自适应）：
 *  1. 锚点 = 自家席位卡边缘，沿"席位→桌心"方向短距离伸出（归属第一线索）；
 *  2. 与桌心中央区（stage-label/pot/公共牌）、其他席位卡、自家卡、桌界冲突时，
 *     只沿该轴回退到第一个可行点，绝不横向漂到其他席位的方位区；
 *  3. 轴上无解（卡与中央区之间放不下）则贴卡上/下/左/右沿（仍在自家席位半侧）；
 *  4. 圆片带席位色描边（--a1-seat-N，a1-foundation.css 追加 tokens）作为
 *     与位置无关的第二归属线索。
 *  几何参数的模型级回归见 test/geometry-check.js（校准基准见其头注释）。 */
function renderBets() {
  const wrap = document.getElementById('bets');
  wrap.innerHTML = '';
  if (state.stage === 'waiting') return;
  const tableEl = document.getElementById('table');
  const tableRect = tableEl.getBoundingClientRect();
  if (!tableRect.width) return;

  // 障碍：桌心中央区三件套 + 全部席位卡（含 hero；自家卡单独判定不压数字）
  const obstacles = ['stage-label', 'pot-display', 'community']
    .map((id) => document.getElementById(id))
    .filter((el) => el && !el.classList.contains('hidden'))
    .map((el) => el.getBoundingClientRect());
  const seatRects = new Map();
  document.querySelectorAll('#seats .seat').forEach((el) => {
    const card = el.querySelector('.seat-card');
    if (card && el.dataset.seat) seatRects.set(Number(el.dataset.seat), card.getBoundingClientRect());
  });
  const heroCard = document.querySelector('#hero-seat .seat-card');
  if (heroCard && mySeat >= 0) seatRects.set(mySeat, heroCard.getBoundingClientRect());

  const overlaps = (r, o, m) => r.right > o.left + m && r.left < o.right - m && r.bottom > o.top + m && r.top < o.bottom - m;

  state.players.forEach((p) => {
    if (!(p.roundBet > 0)) return;
    const selfRect = seatRects.get(p.seat);
    if (!selfRect) return;

    const chip = document.createElement('div');
    chip.className = 'bet-chip';
    chip.style.visibility = 'hidden'; // 先挂载测实际尺寸，再定位显示
    chip.style.setProperty('--chip-c', `var(--a1-seat-${((p.seat % 6) + 6) % 6 + 1})`);
    chip.innerHTML = `<i class="chip-dot" aria-hidden="true"></i><b>${p.roundBet}</b>`;
    wrap.appendChild(chip);
    if (!selfRect.width) return;

    const halfW = chip.offsetWidth / 2;
    const halfH = chip.offsetHeight / 2;
    const cx = selfRect.left + selfRect.width / 2;
    const cy = selfRect.top + selfRect.height / 2;
    let vx = tableRect.left + tableRect.width / 2 - cx;
    let vy = tableRect.top + tableRect.height / 2 - cy;
    const vlen = Math.hypot(vx, vy) || 1;
    vx /= vlen; vy /= vlen;

    // 碰撞 margin 语义：正数=更严格（提前判撞），负数=允许轻擦。
    // 中央区不允许任何压盖（+2）；其他席位卡允许轻擦 3px（密集桌的圆片贴边）；
    // 自家卡允许贴沿 4px（圆片底边擦到卡片边框，不遮昵称/筹码数字）。
    const blocked = (px, py) => {
      const r = { left: px - halfW, right: px + halfW, top: py - halfH, bottom: py + halfH };
      if (r.left < tableRect.left + 3 || r.right > tableRect.right - 3 ||
          r.top < tableRect.top + 3 || r.bottom > tableRect.bottom - 3) return true;
      for (const o of obstacles) if (overlaps(r, o, 2)) return true;
      for (const [seat, o] of seatRects) {
        if (seat === p.seat) continue;
        if (overlaps(r, o, -3)) return true; // 不压其他席位卡（避免归属混淆）
      }
      // 不压自家卡文字区（允许 4px 边框轻擦）
      if (r.right > selfRect.left + 4 && r.left < selfRect.right - 4 &&
          r.bottom > selfRect.top + 4 && r.top < selfRect.bottom - 4) return true;
      return false;
    };
    const place = (px, py) => {
      chip.style.left = (px - tableRect.left) + 'px';
      chip.style.top = (py - tableRect.top) + 'px';
      chip.style.visibility = '';
    };

    // 1) 沿"席位→桌心"轴：从贴卡缘向外找第一个可行点（最贴近自家席位）。
    //    起始距离用卡矩形在轴上的投影半径（正上/正下席位远小于对角半径）。
    const dMin = Math.abs(vx) * (selfRect.width / 2) + Math.abs(vy) * (selfRect.height / 2) + 2;
    const dMax = Math.min(tableRect.width, tableRect.height) * 0.26;
    for (let d = dMin; d <= dMax; d += 3) {
      const px = cx + vx * d;
      const py = cy + vy * d;
      if (!blocked(px, py)) { place(px, py); return; }
    }
    // 2) 轴上无解：贴自家卡四沿（仍在本席位半侧），按桌心方向优先排序
    const offY = selfRect.height / 2 + halfH + 4;
    const offX = selfRect.width / 2 + halfW + 4;
    const edges = [
      [cx, cy + Math.sign(vy || 1) * offY],
      [cx, cy - Math.sign(vy || 1) * offY],
      [cx + offX, cy],
      [cx - offX, cy],
    ];
    for (const [px, py] of edges) {
      if (!blocked(px, py)) { place(px, py); return; }
    }
    // 3) 极度拥挤（矮桌/满员，如 320×568 六人顶部席位）：四沿按压盖代价取最小——
    //    community 10 / 他卡 8 / pot 6 / label 3 / 自家卡 2 / 出界禁选；
    //    此类位置的归属由席位色描边兜底。
    let best = null;
    let bestScore = Infinity;
    for (const [px, py] of edges) {
      const r = { left: px - halfW, right: px + halfW, top: py - halfH, bottom: py + halfH };
      if (r.left < 0 || r.right > tableRect.width || r.top < 0 || r.bottom > tableRect.height) continue;
      let s = 2; // 贴自家卡
      obstacles.forEach((o, i) => {
        if (overlaps(r, o, 0)) s += [3, 6, 10][i] || 5; // [label, pot, community]
      });
      for (const [seat, o] of seatRects) {
        if (seat !== p.seat && overlaps(r, o, 0)) s += 8;
      }
      if (s < bestScore) { bestScore = s; best = [px, py]; }
    }
    if (best) place(best[0], best[1]);
    else place(cx, cy);
  });
}

// 视口变化后按新布局重新定位（renderBets 为纯定位，无副作用）
let betResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(betResizeTimer);
  betResizeTimer = setTimeout(() => { if (state) renderBets(); }, 150);
});

const RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const SUIT_CHAR = { s: '♠', h: '♥', d: '♦', c: '♣' };
/** deal=true 时带发牌入场动画（仅新增的公共牌使用，避免全量重绘闪烁） */
function cardEl(c, deal) {
  const el = document.createElement('div');
  el.className = 'card' + (deal ? ' deal' : '') + (c.s === 'h' || c.s === 'd' ? ' red' : '');
  const r = RANK_LABEL[c.r] || c.r;
  const s = SUIT_CHAR[c.s];
  el.innerHTML = `<span class="idx"><b>${r}</b><i>${s}</i></span><span class="pip">${s}</span><span class="idx flip"><b>${r}</b><i>${s}</i></span>`;
  return el;
}

const cardKey = (c) => c.r + '_' + c.s;
const COMMUNITY_SLOTS = 5;
let communityKeys = [];
/** 公共牌固定 5 个槽位：已发的填白底真牌，未发的留暗色空位 */
function renderCommunity() {
  const box = document.getElementById('community');
  const keys = state.community.map(cardKey);
  let prevKeys = communityKeys;
  const isPrefix = keys.length >= prevKeys.length &&
    prevKeys.every((k, i) => keys[i] === k);
  if (!isPrefix) prevKeys = []; // 新一局：全部按新牌处理

  while (box.children.length < COMMUNITY_SLOTS) {
    const slot = document.createElement('div');
    slot.className = 'card-slot';
    box.appendChild(slot);
  }
  while (box.children.length > COMMUNITY_SLOTS) {
    box.removeChild(box.lastChild);
  }

  for (let i = 0; i < COMMUNITY_SLOTS; i++) {
    const slot = box.children[i];
    const want = i < keys.length ? keys[i] : null;
    if ((slot.dataset.key || null) === want) continue;
    if (!want) {
      slot.dataset.key = '';
      slot.className = 'card-slot empty';
      slot.innerHTML = '';
    } else {
      slot.dataset.key = want;
      slot.className = 'card-slot filled';
      slot.innerHTML = '';
      slot.appendChild(cardEl(state.community[i], i >= prevKeys.length));
    }
  }
  if (keys.length > prevKeys.length) sfx.deal();
  communityKeys = keys;
}

// ---------------- Hero 区 & 操作 ----------------
function renderMyArea() {
  const me = state.players[mySeat];
  const myCards = document.getElementById('my-cards');
  const bar = document.getElementById('action-bar');
  const hint = document.getElementById('action-hint');
  const tip = document.getElementById('waiting-tip');

  renderHeroSeat(me);

  if (me && me.hole && me.hole.length && state.stage !== 'waiting') {
    myCards.classList.remove('hidden');
    myCards.innerHTML = '';
    me.hole.forEach((c) => myCards.appendChild(cardEl(c)));
  } else {
    myCards.classList.add('hidden');
  }

  const startBtn = document.getElementById('btn-start');
  const rebuyBtn = document.getElementById('btn-rebuy');
  const sitOutBtn = document.getElementById('btn-sit-out');
  const sitBackBtn = document.getElementById('btn-sit-back');
  const showStart = state.stage === 'waiting' && !state.gameOver && state.players.length >= 2;
  startBtn.classList.toggle('hidden', !showStart);
  const showRebuy = !state.gameOver && ['waiting', 'handover'].includes(state.stage)
    && me && me.chips === 0;
  rebuyBtn.classList.toggle('hidden', !showRebuy);
  rebuyBtn.textContent = `重新买入（补充 ${cfg().startChips} 筹码）`;
  // 暂离/坐回按钮：对局中或局间都可以暂离；暂离状态显示坐回按钮
  const showSitOut = me && !me.sittingOut && ['waiting', 'handover', 'preflop', 'flop', 'turn', 'river'].includes(state.stage) && !state.gameOver;
  const showSitBack = me && me.sittingOut;
  sitOutBtn.classList.toggle('hidden', !showSitOut);
  sitBackBtn.classList.toggle('hidden', !showSitBack);
  // 表情栏：开局后显示，等待阶段隐藏；手机端为弹层（#emoji-toggle 是入口）
  const ebar = document.getElementById('emoji-bar');
  const etoggle = document.getElementById('emoji-toggle');
  const emojiVisible = state.stage !== 'waiting' && mySeat >= 0;
  if (ebar) ebar.classList.toggle('hidden', !emojiVisible);
  if (etoggle) etoggle.classList.toggle('hidden', !emojiVisible);
  if (state.stage === 'waiting') {
    // 回到等待阶段时收起表情弹层，避免残留
    if (ebar) ebar.classList.remove('open');
    if (etoggle) etoggle.setAttribute('aria-expanded', 'false');
    tip.textContent = waitingTipText();
  }

  const inHandActive = me && !me.folded && !me.allIn &&
    ['preflop', 'flop', 'turn', 'river'].includes(state.stage);
  if (inHandActive && state.turnSeat === mySeat) {
    bar.classList.remove('hidden');
    hint.classList.remove('hidden');
    tip.textContent = '';
    resetFoldBtn(); // 新一轮行动开始时复位弃牌确认态
    updateActionBar(me);
    // 轮到自己：提示音 + 振动 + 思考倒计时（每次行动只触发一次）
    const turnKey = `${state.handNumber}_${state.stage}_${state.turnSeat}`;
    if (lastTurnKey !== turnKey) {
      lastTurnKey = turnKey;
      sfx.turn();
      if (navigator.vibrate) navigator.vibrate(120);
      startTurnTimer();
    }
  } else {
    bar.classList.add('hidden');
    hint.classList.add('hidden');
    hideRaisePanel();
    stopTurnTimer();
    if (inHandActive) tip.textContent = '等待其他玩家行动…';
    else if (me && (me.folded || me.allIn) && state.stage !== 'handover') {
      tip.textContent = me.folded ? '你已弃牌，观战中' : '你已全押，等待摊牌';
    } else if (state.stage !== 'waiting') tip.textContent = '';
  }
}

function waitingTipText() {
  if (state.gameOver) return '游戏已结束';
  const count = state.players.length;
  if (count < 2) return `把房号 ${state.code} 发给朋友，凑齐 2 人即可开局`;
  return `${count} 名玩家已就绪`;
}

function updateActionBar(me) {
  const toCall = state.currentBet - me.roundBet;
  // "轮到你 · 跟注 335"式提示：金额数据全部来自服务端状态
  const hint = document.getElementById('action-hint');
  hint.innerHTML = toCall <= 0 ? '轮到你 · <b>过牌</b>'
    : toCall >= me.chips ? `轮到你 · <b>跟注全押 ${me.chips}</b>`
      : `轮到你 · <b>跟注 ${toCall}</b>`;
  const callBtn = document.getElementById('btn-check-call');
  callBtn.textContent = toCall <= 0 ? '过牌'
    : toCall >= me.chips ? `跟注全押 (${me.chips})` : `跟注 ${toCall}`;
  callBtn.onclick = () => sendAction(toCall <= 0 ? 'check' : 'call');

  document.getElementById('btn-allin').onclick = () => sendAction('allin');

  // 加注面板范围：最小加注到 ~ 全部筹码。
  // 筹码不足以最小加注时（rawMin > max）合法动作只剩全押：把下限钳到全部筹码，
  // 避免 slider 出现 min>max 的非法区间、确认金额超过"最大"标签。
  const maxRaiseTo = me.roundBet + me.chips;
  const rawMinRaiseTo = Math.max(state.currentBet + state.minRaise,
    Math.min(state.currentBet + 1, maxRaiseTo));
  const minRaiseTo = Math.min(rawMinRaiseTo, maxRaiseTo);
  const allInOnly = rawMinRaiseTo > maxRaiseTo || maxRaiseTo <= state.currentBet;
  const slider = document.getElementById('raise-slider');
  slider.min = minRaiseTo;
  slider.max = maxRaiseTo;
  slider.step = cfg().bigBlind; // 步进跟盲注走，自定义盲注也能整步覆盖
  // 面板打开期间不重置用户已调的金额（state 广播如对手表情/结算不丢失输入）
  if (!raiseOpen) {
    slider.value = minRaiseTo;
  }
  slider.disabled = maxRaiseTo <= minRaiseTo;
  const input = document.getElementById('raise-input');
  if (!raiseOpen) {
    input.value = minRaiseTo;
  }
  input.min = minRaiseTo;
  input.max = maxRaiseTo;
  const currentRaise = Number(slider.value) || minRaiseTo;
  const confirmValue = document.getElementById('raise-confirm-value');
  confirmValue.textContent = currentRaise.toLocaleString('zh-CN');
  // 按钮首个子节点是"确认加注 "文本节点（金额在后面的 span 里），仅在类型正确时改写
  const confirmBtn = document.getElementById('btn-raise-confirm');
  if (confirmBtn.firstChild && confirmBtn.firstChild.nodeType === Node.TEXT_NODE) {
    confirmBtn.firstChild.textContent = allInOnly ? '全押 ' : '确认加注 ';
  }
  document.getElementById('raise-min-label').textContent = allInOnly
    ? '筹码不足以最小加注，仅全押'
    : `最小 ${minRaiseTo.toLocaleString('zh-CN')}`;
  document.getElementById('raise-max-label').textContent = `最大 ${maxRaiseTo.toLocaleString('zh-CN')}`;
  const isBet = state.currentBet === 0 || state.currentBet <= me.roundBet;
  document.getElementById('raise-label').textContent = isBet ? '下注到' : '加注到';

  /** 滑条/步进/快捷共用：同步数字输入与确认按钮金额 */
  const syncRaiseViews = () => {
    input.value = slider.value;
    confirmValue.textContent = Number(slider.value).toLocaleString('zh-CN');
  };
  slider.oninput = syncRaiseViews;
  input.oninput = () => {
    const v = parseInt(input.value, 10);
    if (!Number.isFinite(v)) return; // 输入中（空/负号/非数字）：不抖动，确认时统一钳制
    const clamped = Math.max(+slider.min, Math.min(+slider.max, v));
    slider.value = clamped;
    confirmValue.textContent = clamped.toLocaleString('zh-CN');
  };
  // P2-5：失焦时把显示值回写为钳制后的合法值（输入中不打断，确认金额始终一致）
  input.onblur = () => {
    const v = parseInt(input.value, 10);
    const clamped = Number.isFinite(v)
      ? Math.max(+slider.min, Math.min(+slider.max, v))
      : Number(slider.value);
    input.value = clamped;
    slider.value = clamped;
    confirmValue.textContent = clamped.toLocaleString('zh-CN');
  };
  document.getElementById('raise-dec').onclick = () => {
    slider.value = Number(slider.value) - Number(slider.step);
    syncRaiseViews();
  };
  document.getElementById('raise-inc').onclick = () => {
    slider.value = Number(slider.value) + Number(slider.step);
    syncRaiseViews();
  };

  // 快捷下注：基于服务端权威的 pot / currentBet 计算"跟注后的底池"比例，
  // 低于最小合法加注自动抬到最小值，超出最大金额自动封顶（全押）
  const PRESET_FRAC = { third: 1 / 3, half: 1 / 2, twothird: 2 / 3, pot: 1 };
  document.querySelectorAll('.preset').forEach((btn) => {
    btn.onclick = () => {
      let v;
      if (btn.dataset.preset === 'allin') {
        v = maxRaiseTo;
      } else {
        const frac = PRESET_FRAC[btn.dataset.preset];
        if (!frac) return;
        const potAfterCall = state.pot + toCall;
        const target = state.currentBet + Math.ceil(potAfterCall * frac);
        v = Math.max(minRaiseTo, Math.min(maxRaiseTo, target));
      }
      slider.value = v; input.value = v;
      confirmValue.textContent = Number(slider.value).toLocaleString('zh-CN');
    };
  });

  const raiseBtn = document.getElementById('btn-toggle-raise');
  raiseBtn.textContent = isBet ? '下注' : '加注';
  raiseBtn.disabled = maxRaiseTo <= state.currentBet;
  raiseBtn.onclick = onRaiseToggleClick;
  document.getElementById('btn-raise-confirm').onclick = confirmRaise;
  document.getElementById('btn-raise-cancel').onclick = hideRaisePanel;
}

/** 加注按钮：点击展开 Raise Controller 面板，面板内取消或确认。
 *  .raising 同时挂到 action-bar 上：手机端据此收起四个主按钮并显示遮罩
 *  （PC 无对应样式规则）；点遮罩等同取消。 */
function onRaiseToggleClick() {
  raiseOpen = true;
  document.getElementById('raise-panel').classList.remove('hidden');
  document.getElementById('action-bar').classList.add('raising');
  document.getElementById('btn-toggle-raise').classList.add('is-active');
}
function hideRaisePanel() {
  raiseOpen = false;
  document.getElementById('raise-panel').classList.add('hidden');
  document.getElementById('action-bar').classList.remove('raising');
  document.getElementById('raise-panel').style.bottom = ''; // 清键盘兜底偏移
  const toggle = document.getElementById('btn-toggle-raise');
  if (toggle) toggle.classList.remove('is-active');
}
// 手机抽屉遮罩：点击等同取消
document.getElementById('raise-scrim').addEventListener('click', hideRaisePanel);
// 键盘弹起兜底（仅手机）：软键盘把抽屉盖住时，用 visualViewport 实测
// 键盘高度把抽屉抬到键盘上方；键盘收起自动归位。主路径（快捷/滑条/步进）不依赖键盘。
if (window.visualViewport && window.matchMedia('(max-width: 900px)').matches) {
  const raisePanel = document.getElementById('raise-panel');
  visualViewport.addEventListener('resize', () => {
    if (!raiseOpen) return;
    const keyboard = Math.max(0, window.innerHeight - visualViewport.height - visualViewport.offsetTop);
    raisePanel.style.bottom = keyboard > 0 ? keyboard + 'px' : '';
  });
}
document.getElementById('raise-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') confirmRaise();
});
/** 弃牌防误触：第一次点击进入确认态，2.5 秒内再点一次才真正弃牌。
 *  （此前用长按方案：普通单击不足 600ms 被当作取消，按钮看起来"没用"） */
const foldBtn = document.getElementById('btn-fold');
let foldArmed = false;
let foldDisarmTimer = null;
foldBtn.addEventListener('click', () => {
  if (foldBtn.disabled) return;
  if (!foldArmed) {
    foldArmed = true;
    foldBtn.classList.add('holding');
    foldBtn.textContent = '再点一次确认弃牌';
    clearTimeout(foldDisarmTimer);
    foldDisarmTimer = setTimeout(resetFoldBtn, 2500);
    return;
  }
  resetFoldBtn();
  sendAction('fold');
});
function resetFoldBtn() {
  foldArmed = false;
  clearTimeout(foldDisarmTimer);
  foldDisarmTimer = null;
  foldBtn.classList.remove('holding');
  foldBtn.textContent = '弃牌';
}

function confirmRaise() {
  const slider = document.getElementById('raise-slider');
  let v = parseInt(document.getElementById('raise-input').value, 10);
  if (!v || v <= 0) return;
  // 发送前钳制到合法范围，避免超限才被服务端打回
  v = Math.max(+slider.min, Math.min(+slider.max, v));
  sendAction('raise', v);
  hideRaisePanel();
}

function sendAction(type, amount) {
  const buttons = document.getElementById('action-buttons');
  buttons.classList.add('is-waiting');
  buttons.setAttribute('aria-busy', 'true');
  const clearWaiting = () => {
    buttons.classList.remove('is-waiting');
    buttons.removeAttribute('aria-busy');
  };
  // 兜底：网络异常收不到回执时 3 秒后自动解除等待态
  setTimeout(clearWaiting, 3000);
  socket.emit('action', { type, amount }, (res) => {
    clearWaiting();
    if (res.ok) sfx.bet();
    else flashTip(res.err);
  });
}
function flashTip(msg) {
  const tip = document.getElementById('waiting-tip');
  tip.textContent = msg;
  setTimeout(renderMyArea, 1500);
}

// ---------------- 日志 ----------------
function renderLogs() {
  const ul = document.getElementById('log-list');
  ul.innerHTML = '';
  state.logs.forEach((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    ul.appendChild(li);
  });
  ul.scrollTop = ul.scrollHeight;
}

// ---------------- 结算（两层，§17） ----------------
// 第一层：牌桌直显——winner 横幅 + 席位高亮 + 摊牌亮牌（renderSeats 的 revealed 逻辑）；
// 第二层：查看本局详情——主池边池/每人结果/最佳五张/战绩（result-overlay，手动打开）。
// 大 Modal 不再自动弹出作为唯一结算方式。
let resultDetailOpen = false;
const resultOverlay = document.getElementById('result-overlay');
const winnerBanner = document.getElementById('winner-banner');
const resultDetailBtn = document.getElementById('btn-result-detail');
resultDetailBtn.addEventListener('click', () => {
  resultDetailOpen = true;
  renderResults();
});
document.getElementById('btn-result-close').addEventListener('click', () => {
  resultDetailOpen = false;
  renderResults();
});

function renderResults() {
  if (state.stage !== 'handover' || !state.results) {
    resultOverlay.classList.add('hidden');
    resultDetailBtn.classList.add('hidden');
    winnerBanner.classList.add('hidden');
    if (state.stage !== 'handover') resultDetailOpen = false;
    return;
  }
  const r = state.results;
  document.getElementById('result-title').textContent =
    r.forfeit ? '其余玩家全部弃牌' : '摊牌结算';

  // 第一层：牌桌直显横幅（主池赢家 + 赢取金额 + 牌型）
  const mainPot = r.pots[0];
  const winnerNames = mainPot.winners.map((w) => escapeHtml(w.name)).join('、');
  winnerBanner.innerHTML = `<b>${winnerNames}</b> 获胜 <em>+${mainPot.amount}</em>` +
    `<span>${mainPot.winners[0].handName ? mainPot.winners[0].handName : '对手全部弃牌'}${r.pots.length > 1 ? ` · 含边池 ${r.pots.length - 1} 个` : ''}</span>`;
  winnerBanner.classList.remove('hidden');
  resultDetailBtn.classList.remove('hidden');
  resultOverlay.classList.toggle('hidden', !resultDetailOpen); // 第二层仅在主动查看时显示

  const potsDiv = document.getElementById('result-pots');
  potsDiv.innerHTML = '';
  r.pots.forEach((pot, i) => {
    const row = document.createElement('div');
    row.className = 'result-pot-row';
    const label = r.pots.length > 1 ? (i === 0 ? '主池' : `边池 ${i}`) : '底池';
    row.innerHTML = `
      <div class="pot-label">${label} · ${pot.amount} 筹码</div>
      ${pot.winners.map((w) => `
        <div class="winners">
          <img class="winner-avatar" src="${avatarPng(w.seat)}" alt="" />
          <div class="winner-info">
            <div class="winner-name"><b>${escapeHtml(w.name)}</b> 赢得 ${pot.amount} 筹码</div>
            ${w.handName ? `<div class="hand-name">牌型: ${w.handName}</div>` : '<div class="hand-name">对手全部弃牌</div>'}
            ${winnerCardsHtml(w)}
          </div>
        </div>`).join('')}
    `;
    potsDiv.appendChild(row);
  });

  renderSession();

  // 我赢钱了：播放胜利音效 + 倒计时只在结算变化时启动一次
  // （否则 handover 阶段每次状态推送都会重置倒计时）
  const resultKey = `${state.handNumber}_${r.pots.map((p) => p.winners.map((w) => w.seat).join(',')).join('|')}`;
  if (lastResultKey !== resultKey) {
    lastResultKey = resultKey;
    clearInterval(countdownTimer);
    countdown = 20;
    countdownTimer = setInterval(() => {
      countdown--;
      if (countdown <= 0) { clearInterval(countdownTimer); nextTip.textContent = '正在开始下一局…'; }
      else nextTip.textContent = `${countdown} 秒后自动开始下一局…`;
    }, 1000);
    const meWon = r.pots.some((p) => p.winners.some((w) => w.seat === mySeat));
    if (meWon) sfx.win();
  }

  const nextTip = document.getElementById('next-tip');
  const nextBtn = document.getElementById('btn-next-hand');
  if (state.gameOver) {
    nextTip.textContent = '游戏结束！刷新页面可开新房间。';
    nextBtn.classList.add('hidden');
  } else {
    nextTip.textContent = `${countdown} 秒后自动开始下一局…`;
    nextBtn.classList.remove('hidden');
  }
}

/** 本场战绩表：买入 / 当前筹码 / 盈亏 / 手数 / 胜场；离场玩家以存档显示 */
function renderSession() {
  const box = document.getElementById('session-box');
  if (!box) return;
  const list = state.session || [];
  if (!list.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const tbody = box.querySelector('tbody');
  tbody.innerHTML = list.map((e) => {
    const chips = e.left ? '已离场' : e.chips;
    const plCls = e.pl > 0 ? 'pl-pos' : e.pl < 0 ? 'pl-neg' : '';
    const plText = (e.pl > 0 ? '+' : '') + e.pl;
    return `<tr>
      <td>${escapeHtml(e.name)}${e.left ? '（离场）' : ''}</td>
      <td>${e.buyIn}</td>
      <td>${chips}</td>
      <td class="${plCls}">${plText}</td>
      <td>${e.hands}</td>
      <td>${e.wins}</td>
    </tr>`;
  }).join('');
}

/** 赢家的 7 张牌（底牌+公共牌），高亮实际获胜的 5 张 */
function winnerCardsHtml(w) {
  if (!w.hole || !w.hole.length || !state.community || !state.community.length || !w.bestCards) return '';
  const bestKeys = new Set(w.bestCards.map((c) => c.r + '_' + c.s));
  const all = [...w.hole, ...state.community];
  return '<div class="win-cards">' + all.map((c) => {
    const el = cardEl(c, false);
    if (bestKeys.has(c.r + '_' + c.s)) el.classList.add('hl');
    el.classList.add('mini');
    return el.outerHTML;
  }).join('') + '</div>';
}
let countdown = 8;
let countdownTimer = null;
document.getElementById('btn-next-hand').onclick = () => {
  socket.emit('next_hand', null, (res) => {
    if (res && !res.ok) flashTip(res.err);
  });
};

// ---------------- 表情快捷互动 ----------------
// 手机端：#emoji-bar 是底部弹层，#emoji-toggle 为入口；PC 端保持一排常驻
const EMOJI_LIST = ['😀', '😂', '😭', '👍', '🎉', '🤔', '😈', '🔥'];
const emojiBar = document.getElementById('emoji-bar');
const emojiToggle = document.getElementById('emoji-toggle');
function setEmojiOpen(open) {
  emojiBar.classList.toggle('open', open);
  emojiToggle.setAttribute('aria-expanded', String(open));
}
emojiToggle.addEventListener('click', () => {
  setEmojiOpen(!emojiBar.classList.contains('open'));
});
EMOJI_LIST.forEach((e) => {
  const b = document.createElement('button');
  b.className = 'emoji-btn';
  b.textContent = e;
  b.onclick = () => {
    socket.emit('emoji', { emoji: e }, () => {});
    setEmojiOpen(false); // 发送后收起弹层（PC 一排形态不受 open 类影响）
    // 本端即时反馈（服务端会广播回来，靠 seat 匹配去重太繁琐，本地直接展示）
    if (mySeat >= 0) showEmojiBubble(mySeat, e);
  };
  emojiBar.appendChild(b);
});
socket.on('emoji', ({ seat, emoji }) => {
  if (seat !== mySeat) showEmojiBubble(seat, emoji); // 自己的已在点击时展示
});
function showEmojiBubble(seat, emoji) {
  const seatEl = seat === mySeat
    ? document.querySelector('#hero-seat .seat-card')
    : document.querySelector(`.seat[data-seat="${seat}"]`);
  if (!seatEl || !state || state.stage === 'waiting') return;
  // 同一座位连发时先清掉上一个，避免堆叠
  const prev = seatEl.querySelector('.emoji-bubble');
  if (prev) prev.remove();
  const b = document.createElement('div');
  b.className = 'emoji-bubble';
  b.textContent = emoji;
  seatEl.appendChild(b);
  setTimeout(() => b.remove(), 1600);
  tone(880, 0.08, 0, 'sine', 0.05);
}
