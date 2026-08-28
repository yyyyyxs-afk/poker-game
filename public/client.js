/* 德州扑克客户端 */
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
  soundBtn.textContent = soundOn ? '音效 开' : '音效 关';
  soundBtn.classList.toggle('off', !soundOn);
}
soundBtn.onclick = () => {
  soundOn = !soundOn;
  localStorage.setItem('poker-sound', soundOn ? 'on' : 'off');
  renderSoundBtn();
};
renderSoundBtn();

// 牌局动态面板：点标题收起/展开；手机端默认收起，减少视觉干扰
const logPanel = document.getElementById('log-panel');
logPanel.querySelector('h3').addEventListener('click', () => {
  logPanel.classList.toggle('collapsed');
});
if (window.matchMedia('(max-width: 900px)').matches) {
  logPanel.classList.add('collapsed');
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
  document.getElementById('lobby').classList.add('hidden');
  document.getElementById('game').classList.remove('hidden');
  document.getElementById('room-code-display').textContent = code;
}

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
document.getElementById('btn-leave').onclick = () => location.reload();

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

// 暂离 / 坐回
document.getElementById('btn-sit-out').onclick = () => {
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

// 断线感知：掉线立即全屏提示，恢复后自动消失
let everConnected = false;
socket.on('connect', () => {
  if (everConnected) document.getElementById('conn-overlay').classList.add('hidden');
  everConnected = true;
});
socket.on('disconnect', () => {
  document.getElementById('conn-overlay').classList.remove('hidden');
});

function render() {
  if (!state) return;
  try {
    renderTableInfo();
    renderSeats();
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
  // 底池变化：数字跳动提示（别人加注/跟注时手机端日志收起也能感知）
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
    document.getElementById('table-wrap').appendChild(t);
  }
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 1800);
}

/** 座位围绕椭圆分布，自己固定在底部；横向钳制防止小屏裁切。
 *  注意：传入的 index 已是"相对自己的序号"（renderSeats 里的 relIdx），
 *  自己=0 恒在正下方；此前在这里又减了一次 mySeat，导致非 0 号座位的玩家
 *  看到的布局错乱、座位叠在牌桌中央。 */
function seatPosition(index, total, isMe) {
  const angleDeg = 90 + (index / total) * 360;
  const rad = (angleDeg * Math.PI) / 180;
  let rx = 46, ry = 42; // 椭圆半轴（百分比）
  if (isMe) { rx = 0; ry = 44; }
  // 窄屏收紧横向钳制：座位宽 110px 时 86% 会把最右座位推出视口（320px 实测裁切 8px）
  const maxX = (window.innerWidth <= 420 && !isMe) ? 83 : 86;
  return {
    x: Math.max(14, Math.min(maxX, 50 + Math.cos(rad) * rx)),
    y: Math.max(12, Math.min(88, 50 + Math.sin(rad) * ry)),
  };
}

function renderSeats() {
  const wrap = document.getElementById('seats');
  wrap.innerHTML = '';
  const players = state.players;
  players.forEach((p) => {
    const relIdx = (p.seat - (mySeat >= 0 ? mySeat : 0) + players.length) % players.length;
    const pos = seatPosition(relIdx, players.length, p.seat === mySeat);

    const div = document.createElement('div');
    div.className = 'seat' + (p.folded ? ' folded-seat' : '') +
      (p.seat === state.turnSeat && !p.folded ? ' active-turn' : '') +
      (p.seat === mySeat ? ' me' : '');
    div.dataset.seat = p.seat;

    const badges = [];
    if (p.isDealer && state.stage !== 'waiting') badges.push('<span class="dealer-badge">D</span>');

    div.innerHTML = `
      <div class="avatar">${p.avatar}${badges.length ? `<span class="badges">${badges.join('')}</span>` : ''}</div>
      <div class="pname">${p.name}${p.connected ? '' : '<br><span class="offline-mark">离线</span>'}${p.sittingOut ? '<br><span class="sitting-mark">暂离</span>' : ''}</div>
      <div class="pchips">${p.chips}</div>
      ${p.totalBet > 0 && state.stage !== 'waiting' ? `<div class="ptotal">本局已投 ${p.totalBet}</div>` : ''}
      <div class="hole-cards"></div>
      ${p.roundBet > 0 ? `<div class="bet-chip">下注 ${p.roundBet}</div>` : ''}
      ${p.sittingOut ? `<button class="sit-back-btn" data-seat="${p.seat}">坐回</button>` : ''}
    `;

    // 手牌：自己的只在底部"我的区域"展示；对手不渲染背面牌（避免遮挡公共牌，
    // 也更简约），摊牌后服务端会公开真实手牌，届时自然亮出
    const holeDiv = div.querySelector('.hole-cards');
    if (p.seat !== mySeat && p.hole && p.hole.length) {
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

  // 坐回按钮
  wrap.querySelectorAll('.sit-back-btn').forEach((btn) => {
    btn.onclick = () => {
      socket.emit('sit_back', null, (res) => {
        if (!res.ok) flashTip(res.err);
      });
    };
  });
}

const RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const SUIT_CHAR = { s: '♠', h: '♥', d: '♦', c: '♣' };
/** deal=true 时带发牌入场动画（仅新增的公共牌使用，避免全量重绘闪烁） */
function cardEl(c, deal) {
  const el = document.createElement('div');
  el.className = 'card' + (deal ? ' deal' : '') + (c.s === 'h' || c.s === 'd' ? ' red' : '');
  const r = RANK_LABEL[c.r] || c.r;
  el.innerHTML = `<span>${r}<br>${SUIT_CHAR[c.s]}</span>`;
  return el;
}

const cardKey = (c) => c.r + '_' + c.s;
let communityKeys = [];
function renderCommunity() {
  const box = document.getElementById('community');
  const keys = state.community.map(cardKey);
  const grew = keys.length > communityKeys.length;
  const isPrefix = keys.length >= communityKeys.length &&
    communityKeys.every((k, i) => keys[i] === k);

  if (!isPrefix) {
    // 新一局：整体重建
    box.innerHTML = '';
    state.community.forEach((c) => box.appendChild(cardEl(c, true)));
  } else if (grew) {
    const hint = box.querySelector('.waiting-hint');
    if (hint) hint.remove();
    for (let i = communityKeys.length; i < keys.length; i++) {
      box.appendChild(cardEl(state.community[i], true));
    }
  }
  communityKeys = keys;
  if (grew) sfx.deal();
  if (!state.community.length && ['preflop'].includes(state.stage)) {
    box.innerHTML = '<span class="waiting-hint" style="color:var(--muted);font-size:13px;">等待翻牌…</span>';
  }
}

// ---------------- 我的区域 & 操作 ----------------
function renderMyArea() {
  const me = state.players[mySeat];
  const myCards = document.getElementById('my-cards');
  const bar = document.getElementById('action-bar');
  const tip = document.getElementById('waiting-tip');

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
  // 表情栏：开局后显示，等待阶段隐藏
  const ebar = document.getElementById('emoji-bar');
  if (ebar) ebar.classList.toggle('hidden', state.stage === 'waiting' || mySeat < 0);
  if (state.stage === 'waiting') tip.textContent = waitingTipText();

  const inHandActive = me && !me.folded && !me.allIn &&
    ['preflop', 'flop', 'turn', 'river'].includes(state.stage);
  if (inHandActive && state.turnSeat === mySeat) {
    bar.classList.remove('hidden');
    tip.textContent = '';
    resetFoldBtn(); // 新一轮行动开始时复位弃牌确认态
    updateActionBar(me);
    // 轮到自己：提示音 + 振动（每次行动只触发一次）
    const turnKey = `${state.handNumber}_${state.stage}_${state.turnSeat}`;
    if (lastTurnKey !== turnKey) {
      lastTurnKey = turnKey;
      sfx.turn();
      if (navigator.vibrate) navigator.vibrate(120);
    }
  } else {
    bar.classList.add('hidden');
    hideRaisePanel();
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
  const callBtn = document.getElementById('btn-check-call');
  callBtn.textContent = toCall <= 0 ? '过牌'
    : toCall >= me.chips ? `跟注全押 (${me.chips})` : `跟注 ${toCall}`;
  callBtn.onclick = () => sendAction(toCall <= 0 ? 'check' : 'call');

  document.getElementById('btn-allin').onclick = () => sendAction('allin');

  // 加注面板范围：最小加注到 ~ 全部筹码
  const minRaiseTo = Math.max(state.currentBet + state.minRaise,
    Math.min(state.currentBet + 1, me.roundBet + me.chips));
  const maxRaiseTo = me.roundBet + me.chips;
  const slider = document.getElementById('raise-slider');
  slider.min = minRaiseTo;
  slider.max = maxRaiseTo;
  slider.step = cfg().bigBlind; // 步进跟盲注走，自定义盲注也能整步覆盖
  slider.value = minRaiseTo;
  if (maxRaiseTo <= minRaiseTo) slider.disabled = true; else slider.disabled = false;
  const input = document.getElementById('raise-input');
  input.value = minRaiseTo;
  input.min = minRaiseTo;
  input.max = maxRaiseTo;

  slider.oninput = () => { input.value = slider.value; };
  input.oninput = () => { if (+input.value >= +slider.min && +input.value <= +slider.max) slider.value = input.value; };

  // 快捷下注：基于服务端权威的 pot / currentBet 计算"跟注后的底池"比例，
  // 低于最小合法加注自动抬到最小值，超出最大金额自动封顶（全押）
  const PRESET_FRAC = { third: 1 / 3, half: 1 / 2, twothird: 2 / 3, pot: 1 };
  document.querySelectorAll('.preset').forEach((btn) => {
    btn.onclick = () => {
      const frac = PRESET_FRAC[btn.dataset.preset];
      if (!frac) return;
      const potAfterCall = state.pot + toCall;
      const target = state.currentBet + Math.ceil(potAfterCall * frac);
      const v = Math.max(minRaiseTo, Math.min(maxRaiseTo, target));
      slider.value = v; input.value = v;
    };
  });

  document.getElementById('btn-toggle-raise').textContent =
    state.currentBet === 0 || state.currentBet <= me.roundBet ? '下注' : '加注';
  document.getElementById('btn-toggle-raise').disabled = maxRaiseTo <= state.currentBet;
  document.getElementById('btn-toggle-raise').onclick = onRaiseToggleClick;
}

/** 加注按钮：面板关闭时点击展开；展开后变为"确认加注" */
function onRaiseToggleClick() {
  if (!raiseOpen) {
    raiseOpen = true;
    document.getElementById('raise-panel').classList.remove('hidden');
    const toggle = document.getElementById('btn-toggle-raise');
    toggle.textContent = '确认加注 ✓';
  } else {
    confirmRaise();
  }
}
function hideRaisePanel() {
  raiseOpen = false;
  document.getElementById('raise-panel').classList.add('hidden');
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
  socket.emit('action', { type, amount }, (res) => {
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

// ---------------- 结果弹窗 ----------------
function renderResults() {
  const overlay = document.getElementById('result-overlay');
  if (state.stage !== 'handover' || !state.results) {
    overlay.classList.add('hidden');
    return;
  }
  overlay.classList.remove('hidden');
  const r = state.results;
  document.getElementById('result-title').textContent =
    r.forfeit ? '其余玩家全部弃牌' : '摊牌结算';

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
          <span class="winner-avatar">${state.players[w.seat] ? state.players[w.seat].avatar : ''}</span>
          <div class="winner-info">
            <div class="winner-name"><b>${w.name}</b> 赢得 ${pot.amount} 筹码</div>
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
      <td>${e.name}${e.left ? '（离场）' : ''}</td>
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
  return `<div class="win-cards">` + all.map((c) => {
    const hl = bestKeys.has(c.r + '_' + c.s) ? ' hl' : '';
    const red = c.s === 'h' || c.s === 'd' ? ' red' : '';
    return `<div class="card mini${red}${hl}"><span>${RANK_LABEL[c.r] || c.r}<br>${SUIT_CHAR[c.s]}</span></div>`;
  }).join('') + `</div>`;
}
let countdown = 8;
let countdownTimer = null;
document.getElementById('btn-next-hand').onclick = () => {
  socket.emit('next_hand', null, (res) => {
    if (res && !res.ok) flashTip(res.err);
  });
};

// ---------------- 表情快捷互动 ----------------
const EMOJI_LIST = ['😀', '😂', '😭', '👍', '🎉', '🤔', '😈', '🔥'];
const emojiBar = document.getElementById('emoji-bar');
EMOJI_LIST.forEach((e) => {
  const b = document.createElement('button');
  b.className = 'emoji-btn';
  b.textContent = e;
  b.onclick = () => {
    socket.emit('emoji', { emoji: e }, () => {});
    // 本端即时反馈（服务端会广播回来，靠 seat 匹配去重太繁琐，本地直接展示）
    if (mySeat >= 0) showEmojiBubble(mySeat, e);
  };
  emojiBar.appendChild(b);
});
socket.on('emoji', ({ seat, emoji }) => {
  if (seat !== mySeat) showEmojiBubble(seat, emoji); // 自己的已在点击时展示
});
function showEmojiBubble(seat, emoji) {
  const seatEl = document.querySelector(`.seat[data-seat="${seat}"]`);
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
