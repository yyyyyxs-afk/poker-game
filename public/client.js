/* 德州扑克客户端（A1 Phase 2 视觉结构版）
 * 牌局数据、Socket.IO 协议与操作逻辑保持不变；
 * 本轮重写 DOM 渲染：Header / Play Stage（牌桌 + 席位 + 下注层）/ Hero Dock / Raise Controller。 */
const socket = io();

let mySeat = -1;
let state = null;
let raiseOpen = false;
let raiseContext = '';
let activeRoomCode = '';

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
  if (e.target.closest('button')) return;
  setLogCollapsed(!logPanel.classList.contains('collapsed'));
});
document.getElementById('btn-log-collapse').addEventListener('click', () => setLogCollapsed(true));
if (window.matchMedia('(max-width: 900px)').matches) {
  setLogCollapsed(true);
}

// 牌局记录 / 好友聊天共用右侧面板，手机端也沿用同一底部抽屉。
const panelLogTab = document.getElementById('panel-tab-log');
const panelChatTab = document.getElementById('panel-tab-chat');
const chatUnread = document.getElementById('chat-unread');
let panelMode = 'log';
let seenChatId = 0;
function setPanelMode(mode) {
  panelMode = mode === 'chat' ? 'chat' : 'log';
  document.getElementById('log-view').classList.toggle('hidden', panelMode !== 'log');
  document.getElementById('chat-view').classList.toggle('hidden', panelMode !== 'chat');
  panelLogTab.classList.toggle('active', panelMode === 'log');
  panelChatTab.classList.toggle('active', panelMode === 'chat');
  panelLogTab.setAttribute('aria-selected', String(panelMode === 'log'));
  panelChatTab.setAttribute('aria-selected', String(panelMode === 'chat'));
  if (panelMode === 'chat') {
    const chats = (state && state.chatMessages) || [];
    seenChatId = chats.length ? chats[chats.length - 1].id : seenChatId;
    chatUnread.classList.add('hidden');
    logToggleBtn.classList.remove('has-unread');
    renderChats();
  }
}
panelLogTab.addEventListener('click', () => setPanelMode('log'));
panelChatTab.addEventListener('click', () => setPanelMode('chat'));

// ---------------- 新手玩法与牌型速查 ----------------
const rulesOverlay = document.getElementById('rules-overlay');
const rulesCloseBtn = document.getElementById('btn-rules-close');
const rulesTabs = [...document.querySelectorAll('[data-rules-tab]')];
const rulesPanels = [...document.querySelectorAll('[data-rules-panel]')];
let rulesReturnFocus = null;

const MODAL_FOCUSABLE_SELECTOR = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function isVisibleAndEnabled(element) {
  if (!element || !element.isConnected || element.disabled || element.closest('.hidden')) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}

function getModalFocusableElements(overlay) {
  return [...overlay.querySelectorAll(MODAL_FOCUSABLE_SELECTOR)].filter(isVisibleAndEnabled);
}

function getTopOpenModal() {
  const overlays = [settingsOverlay, resultOverlay, rulesOverlay]
    .filter((overlay) => overlay && isVisibleAndEnabled(overlay));
  return overlays.reduce((top, candidate) => {
    if (!top) return candidate;
    const topZ = Number.parseInt(getComputedStyle(top).zIndex, 10) || 0;
    const candidateZ = Number.parseInt(getComputedStyle(candidate).zIndex, 10) || 0;
    if (candidateZ !== topZ) return candidateZ > topZ ? candidate : top;
    return top.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING
      ? candidate : top;
  }, null);
}

function focusFirstModalControl(overlay) {
  const first = getModalFocusableElements(overlay)[0];
  const fallback = overlay.querySelector('[tabindex="-1"]');
  (first || fallback)?.focus();
}

function restoreModalFocus(preferred, fallbacks = []) {
  const activeModal = getTopOpenModal();
  if (activeModal) {
    if (activeModal.contains(preferred) && isVisibleAndEnabled(preferred)) preferred.focus();
    else focusFirstModalControl(activeModal);
    return;
  }
  const candidates = [
    preferred, ...fallbacks,
    document.getElementById('btn-menu'), document.getElementById('btn-rules-lobby'),
    document.getElementById('btn-create'),
  ];
  candidates.find(isVisibleAndEnabled)?.focus();
}

function handleModalKeyboard(event) {
  const activeModal = getTopOpenModal();
  if (!activeModal) return;

  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (activeModal === rulesOverlay) closeRules();
    else if (activeModal === resultOverlay) closeResultDetail();
    else if (activeModal === settingsOverlay) closeSettings();
    return;
  }

  if (event.key !== 'Tab') return;
  const focusable = getModalFocusableElements(activeModal);
  if (!focusable.length) {
    event.preventDefault();
    focusFirstModalControl(activeModal);
    return;
  }

  const currentIndex = focusable.indexOf(document.activeElement);
  if (event.shiftKey && currentIndex <= 0) {
    event.preventDefault();
    focusable[focusable.length - 1].focus();
  } else if (!event.shiftKey && (currentIndex < 0 || currentIndex === focusable.length - 1)) {
    event.preventDefault();
    focusable[0].focus();
  }
}

// 只在当前最上层对话框打开时接管 Tab 与 Esc，其余按键继续交给原有交互。
document.addEventListener('keydown', handleModalKeyboard, true);

function selectRulesTab(name) {
  rulesTabs.forEach((tab) => {
    const active = tab.dataset.rulesTab === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  rulesPanels.forEach((panel) => panel.classList.toggle('hidden', panel.dataset.rulesPanel !== name));
}

function openRules(tab = 'quick', trigger = document.activeElement) {
  const activeModal = getTopOpenModal();
  rulesReturnFocus = activeModal && activeModal.contains(document.activeElement)
    ? document.activeElement : trigger;
  selectRulesTab(tab);
  rulesOverlay.classList.remove('hidden');
  document.body.classList.add('modal-open');
  rulesCloseBtn.focus();
}

function closeRules() {
  if (rulesOverlay.classList.contains('hidden')) return;
  rulesOverlay.classList.add('hidden');
  document.body.classList.remove('modal-open');
  const returnFocus = rulesReturnFocus;
  rulesReturnFocus = null;
  restoreModalFocus(returnFocus, [document.getElementById('btn-rules-lobby'), menuBtn]);
}

document.getElementById('btn-rules-lobby').addEventListener('click', (event) => openRules('quick', event.currentTarget));
document.getElementById('btn-rules-game').addEventListener('click', () => {
  closeMenu();
  openRules('quick', menuBtn);
});
rulesTabs.forEach((tab) => tab.addEventListener('click', () => selectRulesTab(tab.dataset.rulesTab)));
rulesCloseBtn.addEventListener('click', closeRules);
rulesOverlay.addEventListener('click', (event) => { if (event.target === rulesOverlay) closeRules(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeRules(); });

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

const createRoomBtn = document.getElementById('btn-create');
const joinRoomBtn = document.getElementById('btn-join');
let lobbySubmission = '';
let lobbyExpectedRoom = '';

/** 大厅请求只允许一个在途：同时锁住创建和加入，避免同一 socket 被快速点进多个房间。 */
function beginLobbySubmission(kind, expectedRoom = '') {
  if (lobbySubmission) return false;
  lobbySubmission = kind;
  lobbyExpectedRoom = expectedRoom;
  createRoomBtn.disabled = true;
  joinRoomBtn.disabled = true;
  createRoomBtn.textContent = kind === 'create' ? '创建中…' : '创建房间';
  joinRoomBtn.textContent = kind === 'join' ? '加入中…' : '加入';
  const busyBtn = kind === 'create' ? createRoomBtn : joinRoomBtn;
  busyBtn.setAttribute('aria-busy', 'true');
  showLobbyError('');
  return true;
}
function endLobbySubmission(kind = lobbySubmission) {
  if (!lobbySubmission || kind !== lobbySubmission) return;
  lobbySubmission = '';
  lobbyExpectedRoom = '';
  createRoomBtn.disabled = false;
  joinRoomBtn.disabled = false;
  createRoomBtn.textContent = '创建房间';
  joinRoomBtn.textContent = '加入';
  createRoomBtn.removeAttribute('aria-busy');
  joinRoomBtn.removeAttribute('aria-busy');
}

createRoomBtn.onclick = () => {
  const name = getName();
  if (!name) return;
  if (!beginLobbySubmission('create')) return;
  socket.emit('create_room', { name }, (res) => {
    if (lobbySubmission !== 'create') return;
    if (res && res.ok) {
      saveAuth(res.code, name, res.token);
      endLobbySubmission('create');
      enterRoom(res.code);
    } else {
      endLobbySubmission('create');
      showLobbyError((res && res.err) || '创建失败，请稍后重试');
    }
  });
};
joinRoomBtn.onclick = () => {
  const name = getName();
  const code = document.getElementById('room-code').value.trim().toUpperCase();
  if (!name) return;
  if (!/^[A-Z0-9]{6}$/.test(code)) return showLobbyError('请输入 6 位邀请码');
  if (!beginLobbySubmission('join', code)) return;
  socket.emit('join_room', { code, name, token: storedToken()[`${code}_${name}`] }, (res) => {
    if (lobbySubmission !== 'join') return;
    if (res && res.ok) {
      saveAuth(res.code, name, res.token);
      endLobbySubmission('join');
      enterRoom(res.code);
    } else {
      endLobbySubmission('join');
      showLobbyError((res && res.err) || '加入失败，请稍后重试');
    }
  });
};
function getName() {
  const n = document.getElementById('nickname').value.trim();
  if (!n) { showLobbyError('请先填写昵称'); return null; }
  return n;
}
function showLobbyError(msg) { document.getElementById('lobby-error').textContent = msg; }

function enterRoom(code) {
  const normalizedCode = String(code || '').trim().toUpperCase();
  if (!normalizedCode) return;
  activeRoomCode = normalizedCode;
  hideRaisePanel();
  const name = document.getElementById('nickname').value.trim();
  if (name) localStorage.setItem('poker-nickname', name);
  saveLastRoom(normalizedCode, name || localStorage.getItem('poker-nickname') || '');
  document.getElementById('lobby').classList.add('hidden');
  document.getElementById('game').classList.remove('hidden');
  document.getElementById('room-code-display').textContent = normalizedCode;
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
document.getElementById('btn-invite').onclick = async () => {
  const code = state?.code || '';
  const url = location.origin + location.pathname + '?room=' + code;
  const share = { title: '德州扑克好友局', text: `加入我的德州扑克房间 ${code}`, url };
  if (navigator.share) {
    try { await navigator.share(share); return; } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  const ok = await copyText(url);
  showToast(ok ? '邀请链接已复制，发给朋友即可' : '复制失败，请从左上角菜单复制');
};
const leaveBtn = document.getElementById('btn-leave');
let leavingRoom = false;
leaveBtn.onclick = () => {
  if (leavingRoom) return;
  leavingRoom = true;
  leaveBtn.disabled = true;
  leaveBtn.textContent = '退出中…';
  closeMenu();
  clearLastRoom(); // 先断开自动恢复资格，退出期间即使 socket 抖动也不会回座
  activeRoomCode = '';
  hideRaisePanel();
  connOverlay.classList.add('hidden');
  socket.emit('leave_room');
  // 现有 leave_room 协议没有 ack；留出发送窗口后回大厅，并以定时跳转兜底。
  setTimeout(() => location.replace(location.pathname), 300);
};

// 开始游戏（仅房主在等待阶段且人数 >= 2 时显示）
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
const settingsBtn = document.getElementById('btn-settings');
const settingsFirstControl = document.getElementById('set-start-chips');
let settingsReturnFocus = null;

settingsBtn.onclick = () => {
  const activeModal = getTopOpenModal();
  settingsReturnFocus = activeModal && activeModal.contains(document.activeElement)
    ? document.activeElement : settingsBtn;
  document.getElementById('set-start-chips').value = state.settings.startChips;
  document.getElementById('set-sb').value = state.settings.smallBlind;
  document.getElementById('set-bb').value = state.settings.bigBlind;
  // 兼容旧服务端：新字段缺失时按默认值回显
  document.getElementById('set-action-time').value = String(state.settings.actionTime || 45);
  document.getElementById('set-next-hand').value = String(state.settings.nextHandDelay || 20);
  document.getElementById('set-rebuy').value = String(state.settings.rebuyAllowed !== false);
  document.getElementById('set-locked').value = String(!!state.settings.locked);
  document.getElementById('settings-error').textContent = '';
  settingsOverlay.classList.remove('hidden');
  settingsFirstControl.focus();
};
function closeSettings() {
  if (settingsOverlay.classList.contains('hidden')) return;
  settingsOverlay.classList.add('hidden');
  const returnFocus = settingsReturnFocus;
  settingsReturnFocus = null;
  restoreModalFocus(returnFocus, [settingsBtn, menuBtn]);
}
document.getElementById('btn-settings-close').onclick = closeSettings;
document.getElementById('btn-settings-save').onclick = saveSettings;
function saveSettings() {
  const payload = {
    startChips: parseInt(document.getElementById('set-start-chips').value, 10),
    smallBlind: parseInt(document.getElementById('set-sb').value, 10),
    bigBlind: parseInt(document.getElementById('set-bb').value, 10),
    actionTime: parseInt(document.getElementById('set-action-time').value, 10),
    nextHandDelay: parseInt(document.getElementById('set-next-hand').value, 10),
    rebuyAllowed: document.getElementById('set-rebuy').value === 'true',
    locked: document.getElementById('set-locked').value === 'true',
  };
  socket.emit('update_settings', payload, (res) => {
    if (res.ok) {
      closeSettings();
    } else {
      document.getElementById('settings-error').textContent = res.err;
    }
  });
}

// ---------------- 状态渲染 ----------------
socket.on('state', (s) => {
  const incomingCode = String((s && s.code) || '').trim().toUpperCase();
  // 一个 socket 若因历史重复请求残留在多个房间，只接收当前明确进入的房间状态。
  if (activeRoomCode && incomingCode && incomingCode !== activeRoomCode) return;
  if (!activeRoomCode && lobbyExpectedRoom && incomingCode && incomingCode !== lobbyExpectedRoom) return;
  // 自动开出下一手时收起上一局弹窗，避免遮挡当前行动；之后仍可主动回看。
  const autoClosedResult = !!(state && state.stage === 'handover' && s.stage !== 'handover' && resultDetailOpen);
  if (state && state.stage === 'handover' && s.stage !== 'handover') resultDetailOpen = false;
  state = s;
  mySeat = s.youSeat;
  document.getElementById('conn-overlay').classList.add('hidden');
  render();
  if (autoClosedResult) {
    const returnFocus = resultReturnFocus;
    resultReturnFocus = null;
    restoreModalFocus(returnFocus, [resultDetailBtn, menuBtn]);
  }
});

// 断线感知：掉线全屏提示；socket 自动重连成功后用 token 恢复座位
let everConnected = false;
socket.on('connect', () => {
  if (!everConnected) { everConnected = true; return; } // 首次连接不算断线恢复
  // 只恢复本页已经进入的牌局；大厅里的旧 last-room 不能因网络抖动自行把页面带走。
  if (!activeRoomCode || document.getElementById('game').classList.contains('hidden')) {
    connOverlay.classList.add('hidden');
    endLobbySubmission();
    return;
  }
  reconnectAttempts = 0;
  connOverlay.classList.remove('hidden');
  setConnState('连接恢复，正在回到牌局…', '');
  tryRejoin();
});
socket.on('disconnect', () => {
  if (!activeRoomCode || document.getElementById('game').classList.contains('hidden')) {
    const wasSubmitting = !!lobbySubmission;
    endLobbySubmission();
    if (wasSubmitting) showLobbyError('连接中断，请重新提交');
    return;
  }
  hideRaisePanel();
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
    renderChats();
    renderIdentityControls();
    renderNextHandStatus();
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
  const inviteBtn = document.getElementById('btn-invite');
  if (inviteBtn) inviteBtn.classList.toggle('hidden', state.stage !== 'waiting');
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

/** 默认仍映射原六款；用户选择的头像编号绑定玩家身份。 */
const AVATAR_PNGS = [
  'assets/a1/avatars/avatar-blue-headphones.png',
  'assets/a1/avatars/avatar-magenta-asym.png',
  'assets/a1/avatars/avatar-red-cap.png',
  'assets/a1/avatars/avatar-teal-ponytail.png',
  'assets/a1/avatars/avatar-amber-beanie.png',
  'assets/a1/avatars/avatar-violet-bangs.png',
  'assets/a1/avatars/hk/gao-jin.png',
  'assets/a1/avatars/hk/chan-siuto.png',
  'assets/a1/avatars/hk/sing.png',
  'assets/a1/avatars/hk/lung-five.png',
  'assets/a1/avatars/hk/lung-nine.png',
  'assets/a1/avatars/hk/hoi-tong.png',
];
const AVATAR_NAMES = ['像素头像1','像素头像2','像素头像3','像素头像4','像素头像5','像素头像6','高进','陈小刀','阿星','龙五','龙九','海棠'];
function avatarPng(seat) {
  const player = state && state.players.find(p => p.seat === seat);
  const id = player && Number.isInteger(player.avatarId) && AVATAR_PNGS[player.avatarId] ? player.avatarId : ((seat % 6) + 6) % 6;
  return AVATAR_PNGS[id];
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
    <img class="avatar-img" src="${avatarPng(p.seat)}" alt="${escapeHtml(p.name)} 的头像" />
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
    const choosing = state.stage === 'waiting' && state.handNumber === 0;
    const total = choosing ? 6 : players.length;
    const mine = players.find(x => x.seat === mySeat);
    const relIdx = choosing ? (p.lobbySeat - (mine ? mine.lobbySeat : 0) + 6) % 6 : (p.seat - (mySeat >= 0 ? mySeat : 0) + total) % total;
    const pos = seatPosition(relIdx, total);

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

    // 仅用服务端公开的 holeCount 画牌背；牌面仍只在 revealed 后读取 p.hole，绝不推测底牌。
    const holeDiv = div.querySelector('.hole-cards');
    if (p.hole && p.hole.length && state.revealed) {
      p.hole.forEach((c) => holeDiv.appendChild(cardEl(c, false)));
    } else if (!state.revealed && p.inHand && !p.folded && p.holeCount > 0 &&
        ['preflop', 'flop', 'turn', 'river', 'showdown'].includes(state.stage)) {
      const count = Math.min(2, Math.max(0, Number(p.holeCount) || 0));
      holeDiv.classList.add('is-facedown');
      holeDiv.setAttribute('aria-label', `${count} 张未公开底牌`);
      for (let i = 0; i < count; i++) {
        const back = document.createElement('img');
        back.className = 'card-back';
        back.src = 'assets/a1/card-back.png';
        back.alt = '';
        back.setAttribute('aria-hidden', 'true');
        holeDiv.appendChild(back);
      }
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
      <img class="avatar-img" src="${avatarPng(me.seat)}" alt="我的头像" />
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

    // 自己的席位在牌桌外的 Hero Dock。不能从 Hero 卡中心做有限距离搜索，
    // 否则在手机竖屏的大间距布局中搜索不到桌内点，最终会回退到手牌附近。
    // 固定优先放在桌面下沿内侧，既表达“来自自己”，也与底牌保持明显间隔。
    if (p.seat === mySeat) {
      const heroX = tableRect.left + tableRect.width / 2;
      for (const ratio of [0.82, 0.78, 0.86, 0.74]) {
        const heroY = tableRect.top + tableRect.height * ratio;
        if (!blocked(heroX, heroY)) { place(heroX, heroY); return; }
      }
      place(heroX, tableRect.top + tableRect.height * 0.82);
      return;
    }

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
  const showStart = state.stage === 'waiting' && state.isHost
    && !state.gameOver && state.players.length >= 2;
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
    const currentContext = raiseContextKey(me);
    if (raiseOpen && raiseContext !== currentContext) hideRaisePanel();
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
  return state.isHost ? `${count} 名玩家已就绪，可以开始游戏`
    : `${count} 名玩家已就绪，等待房主开始`;
}

function updateActionBar(me) {
  const toCall = state.currentBet - me.roundBet;
  const raiseAllowed = me.raiseAllowed !== false; // 兼容旧服务端：字段缺失时仍按可加注处理
  // "轮到你 · 跟注 335"式提示：金额数据全部来自服务端状态
  const hint = document.getElementById('action-hint');
  hint.innerHTML = toCall <= 0 ? '轮到你 · <b>过牌</b>'
    : toCall >= me.chips ? `轮到你 · <b>跟注全押 ${me.chips}</b>`
      : `轮到你 · <b>跟注 ${toCall}</b>`;
  const callBtn = document.getElementById('btn-check-call');
  callBtn.textContent = toCall <= 0 ? '过牌'
    : toCall >= me.chips ? `跟注全押 (${me.chips})` : `跟注 ${toCall}`;
  callBtn.onclick = () => sendAction(toCall <= 0 ? 'check' : 'call');

  const allInBtn = document.getElementById('btn-allin');
  allInBtn.onclick = () => sendAction('allin');

  // 加注面板范围：最小加注到 ~ 全部筹码。
  // 筹码不足以最小加注时（rawMin > max）合法动作只剩全押：把下限钳到全部筹码，
  // 避免 slider 出现 min>max 的非法区间、确认金额超过"最大"标签。
  const maxRaiseTo = me.roundBet + me.chips;
  allInBtn.disabled = !raiseAllowed && maxRaiseTo > state.currentBet;
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
  document.getElementById('raise-min-label').textContent = !raiseAllowed
    ? '不足额全押未重新开放加注权'
    : allInOnly ? '筹码不足以最小加注，仅全押'
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
  raiseBtn.disabled = maxRaiseTo <= state.currentBet || !raiseAllowed;
  raiseBtn.onclick = onRaiseToggleClick;
  document.getElementById('btn-raise-confirm').onclick = confirmRaise;
  document.getElementById('btn-raise-cancel').onclick = hideRaisePanel;
}

/** 加注按钮：点击展开 Raise Controller 面板，面板内取消或确认。
 *  .raising 同时挂到 action-bar 上：手机端据此收起四个主按钮并显示遮罩
 *  （PC 无对应样式规则）；点遮罩等同取消。 */
function onRaiseToggleClick() {
  const me = state && state.players ? state.players[mySeat] : null;
  const currentContext = raiseContextKey(me);
  const raiseBtn = document.getElementById('btn-toggle-raise');
  // 防止旧 DOM 点击、轮次切换或失效状态把抽屉带开；开启必须对应当前可行动轮次。
  if (!currentContext || raiseBtn.disabled || document.getElementById('action-bar').classList.contains('hidden')) {
    hideRaisePanel();
    return;
  }
  raiseOpen = true;
  raiseContext = currentContext;
  document.getElementById('raise-panel').classList.remove('hidden');
  document.getElementById('action-bar').classList.add('raising');
  document.getElementById('btn-toggle-raise').classList.add('is-active');
}
function hideRaisePanel() {
  raiseOpen = false;
  raiseContext = '';
  document.getElementById('raise-panel').classList.add('hidden');
  document.getElementById('action-bar').classList.remove('raising');
  document.getElementById('raise-panel').style.bottom = ''; // 清键盘兜底偏移
  const toggle = document.getElementById('btn-toggle-raise');
  if (toggle) toggle.classList.remove('is-active');
}
function raiseContextKey(me) {
  if (!state || !me || me.folded || me.allIn || state.turnSeat !== mySeat ||
      !['preflop', 'flop', 'turn', 'river'].includes(state.stage)) return '';
  return [state.code, state.handNumber, state.stage, state.turnSeat,
    state.currentBet, me.roundBet, me.chips].join('|');
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

function renderChats() {
  const chats = (state && Array.isArray(state.chatMessages)) ? state.chatMessages : [];
  const ul = document.getElementById('chat-list');
  ul.innerHTML = chats.length ? chats.map((message) => `
    <li class="${message.seat === mySeat ? 'mine' : ''}">
      <span>${escapeHtml(message.name)}</span>
      <p>${escapeHtml(message.text)}</p>
    </li>`).join('') : '<li class="chat-empty">还没有消息，先打个招呼吧</li>';
  ul.scrollTop = ul.scrollHeight;

  const latestId = chats.length ? chats[chats.length - 1].id : 0;
  if (panelMode === 'chat' && !logPanel.classList.contains('collapsed')) {
    seenChatId = latestId;
    chatUnread.classList.add('hidden');
    logToggleBtn.classList.remove('has-unread');
  } else if (latestId > seenChatId) {
    chatUnread.classList.remove('hidden');
    logToggleBtn.classList.add('has-unread');
  }
}

const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('btn-chat-send');
const chatError = document.getElementById('chat-error');
chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text || chatSendBtn.disabled) return;
  chatSendBtn.disabled = true;
  chatError.textContent = '';
  socket.emit('chat_message', { text }, (res) => {
    chatSendBtn.disabled = false;
    if (res && res.ok) {
      chatInput.value = '';
      chatInput.focus();
    } else {
      chatError.textContent = (res && res.err) || '发送失败，请重试';
    }
  });
});

// ---------------- 结算（两层，§17） ----------------
// 第一层：牌桌直显——winner 横幅 + 席位高亮 + 摊牌亮牌（renderSeats 的 revealed 逻辑）；
// 第二层：查看本局详情——主池边池/每人结果/最佳五张/战绩（result-overlay，手动打开）。
// 大 Modal 不再自动弹出作为唯一结算方式。
let resultDetailOpen = false;
const resultOverlay = document.getElementById('result-overlay');
const winnerBanner = document.getElementById('winner-banner');
const resultDetailBtn = document.getElementById('btn-result-detail');
const resultCloseTopBtn = document.getElementById('btn-result-close-top');
let resultReturnFocus = null;
resultDetailBtn.addEventListener('click', (event) => {
  resultReturnFocus = event.currentTarget;
  resultDetailOpen = true;
  renderResults();
  if (!resultOverlay.classList.contains('hidden')) resultCloseTopBtn.focus();
  else restoreModalFocus(resultReturnFocus, [menuBtn]);
});
function closeResultDetail() {
  if (!resultDetailOpen) return;
  resultDetailOpen = false;
  renderResults();
  const returnFocus = resultReturnFocus;
  resultReturnFocus = null;
  restoreModalFocus(returnFocus, [resultDetailBtn, menuBtn]);
}
resultCloseTopBtn.addEventListener('click', closeResultDetail);
document.getElementById('btn-result-close').addEventListener('click', closeResultDetail);

function renderResults() {
  const isCurrentResult = state.stage === 'handover' && !!state.results;
  const r = isCurrentResult ? state.results : state.lastResult;
  if (!r) {
    const wasOpen = resultDetailOpen;
    resultDetailOpen = false;
    resultOverlay.classList.add('hidden');
    resultDetailBtn.classList.add('hidden');
    winnerBanner.classList.add('hidden');
    if (wasOpen) {
      const returnFocus = resultReturnFocus;
      resultReturnFocus = null;
      restoreModalFocus(returnFocus, [resultDetailBtn, menuBtn]);
    }
    return;
  }
  document.getElementById('result-title').textContent =
    `${isCurrentResult ? '' : `第 ${r.handNumber} 局 · `}${r.forfeit ? '其余玩家全部弃牌' : '摊牌结算'}`;

  // 第一层：牌桌直显横幅（主池赢家 + 赢取金额 + 牌型）
  const mainPot = r.pots[0];
  const winnerNames = mainPot.winners.map((w) => escapeHtml(w.name)).join('、');
  const winnerHand = mainPot.winners[0].handName
    ? escapeHtml(mainPot.winners[0].handName) : '对手全部弃牌';
  const mainPotWinnerAmount = Number.isFinite(mainPot.winners[0].amountWon)
    ? mainPot.winners[0].amountWon : mainPot.amount;
  const mainPotAmountLabel = mainPot.winners.length > 1 ? '赢家合计分得' : '分得底池';
  if (isCurrentResult) {
    winnerBanner.innerHTML = `<b>${winnerNames}</b><span class="winner-amount">${mainPotAmountLabel} <em>+${mainPot.winners.length > 1 ? mainPot.amount : mainPotWinnerAmount}</em></span>` +
      `<span class="winner-hand">${winnerHand}${r.pots.length > 1 ? ` · 含边池 ${r.pots.length - 1} 个` : ''}</span>`;
    winnerBanner.classList.remove('hidden');
  } else {
    winnerBanner.classList.add('hidden');
  }
  resultDetailBtn.textContent = isCurrentResult ? '查看本局详情' : `回看第 ${r.handNumber} 局`;
  resultDetailBtn.classList.remove('hidden');
  resultOverlay.classList.toggle('hidden', !resultDetailOpen); // 第二层仅在主动查看时显示

  const changesDiv = document.getElementById('hand-changes');
  const changes = Array.isArray(r.changes)
    ? [...r.changes].sort((a, b) => b.delta - a.delta)
    : [];
  if (changes.length) {
    changesDiv.innerHTML = `
      <div class="hand-change-title">本局净盈亏</div>
      <div class="hand-change-list">
        ${changes.map((entry) => {
          const delta = Number(entry.delta) || 0;
          const tone = delta > 0 ? 'gain' : (delta < 0 ? 'loss' : 'flat');
          const label = delta > 0 ? `+${delta}` : `${delta}`;
          return `<div class="hand-change ${tone}">
            <span>${escapeHtml(entry.name)}</span>
            <b>${label}</b>
          </div>`;
        }).join('')}
      </div>`;
    changesDiv.classList.remove('hidden');
  } else {
    changesDiv.innerHTML = '';
    changesDiv.classList.add('hidden');
  }

  const potsDiv = document.getElementById('result-pots');
  potsDiv.innerHTML = '';
  r.pots.forEach((pot, i) => {
    const row = document.createElement('div');
    row.className = 'result-pot-row';
    const label = r.pots.length > 1 ? (i === 0 ? '主池' : `边池 ${i}`) : '底池';
    const winnerAmountLabel = (winner) => {
      if (Number.isFinite(winner.amountWon)) return `分得 ${winner.amountWon} 筹码`;
      if (pot.winners.length === 1) return `分得底池 ${pot.amount} 筹码`;
      return `与 ${pot.winners.length - 1} 位赢家共享底池（个人分配未记录）`;
    };
    row.innerHTML = `
      <div class="pot-label">${label} · ${pot.amount} 筹码</div>
      ${pot.winners.map((w) => `
        <div class="winners">
          <img class="winner-avatar" src="${avatarPng(w.seat)}" alt="" />
          <div class="winner-info">
            <div class="winner-name"><b>${escapeHtml(w.name)}</b> ${winnerAmountLabel(w)}</div>
            ${w.handName ? `<div class="hand-name">牌型: ${w.handName}</div>` : '<div class="hand-name">对手全部弃牌</div>'}
            ${winnerCardsHtml(w, r.community)}
          </div>
        </div>`).join('')}
    `;
    potsDiv.appendChild(row);
  });

  renderShowdownReview(r);
  renderActionTimeline(r);

  renderSession();

  // 我赢钱了：播放胜利音效 + 倒计时只在结算变化时启动一次
  // （否则 handover 阶段每次状态推送都会重置倒计时）
  const resultKey = `${r.handNumber}_${r.pots.map((p) => p.winners.map((w) => w.seat).join(',')).join('|')}`;
  if (isCurrentResult && lastResultKey !== resultKey) {
    lastResultKey = resultKey;
    clearInterval(countdownTimer);
    countdown = cfg().nextHandDelay || 20;
    countdownTimer = setInterval(() => {
      if (state.nextHandPaused) { nextTip.textContent = '下一局已暂停，等待房主恢复'; return; }
      countdown = state.nextHandDeadline ? Math.max(0, Math.ceil((state.nextHandDeadline - Date.now()) / 1000)) : 0;
      if (countdown <= 0) { nextTip.textContent = state.nextHandDeadline ? '正在开始下一局…' : '等待可参与玩家或重买后继续'; }
      else nextTip.textContent = `${countdown} 秒后自动开始下一局…`;
    }, 1000);
    const meWon = r.pots.some((p) => p.winners.some((w) => w.seat === mySeat));
    if (meWon) sfx.win();
  }

  const nextTip = document.getElementById('next-tip');
  const nextBtn = document.getElementById('btn-next-hand');
  nextTip.classList.toggle('hidden', !isCurrentResult);
  if (!isCurrentResult) {
    nextBtn.classList.add('hidden');
  } else if (state.nextHandPaused) {
    nextTip.textContent = '下一局已暂停，等待房主恢复';
    nextBtn.classList.add('hidden');
  } else if (state.gameOver) {
    nextTip.textContent = '游戏结束！刷新页面可开新房间。';
    nextBtn.classList.add('hidden');
  } else {
    nextTip.textContent = state.nextHandDeadline ? `${Math.max(0, Math.ceil((state.nextHandDeadline - Date.now()) / 1000))} 秒后自动开始下一局…` : '等待可参与玩家或重买后继续';
    nextBtn.classList.toggle('hidden', !state.isHost);
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
function winnerCardsHtml(w, community = state.community) {
  if (!w.hole || !w.hole.length || !community || !community.length || !w.bestCards) return '';
  const bestKeys = new Set(w.bestCards.map((c) => c.r + '_' + c.s));
  const all = [...w.hole, ...community];
  return '<div class="win-cards">' + all.map((c) => {
    const el = cardEl(c, false);
    if (bestKeys.has(c.r + '_' + c.s)) el.classList.add('hl');
    el.classList.add('mini');
    return el.outerHTML;
  }).join('') + '</div>';
}

function miniCardsHtml(cards, highlighted = cards) {
  if (!Array.isArray(cards) || !cards.length) return '';
  const keys = new Set((highlighted || []).map((c) => c.r + '_' + c.s));
  return cards.map((c) => {
    const el = cardEl(c, false);
    el.classList.add('mini');
    if (keys.has(c.r + '_' + c.s)) el.classList.add('hl');
    return el.outerHTML;
  }).join('');
}

function renderShowdownReview(r) {
  const box = document.getElementById('result-showdown');
  const players = Array.isArray(r.showdown) ? r.showdown : [];
  if (!players.length) {
    box.innerHTML = '';
    box.classList.add('hidden');
    return;
  }
  box.innerHTML = `<h3>摊牌结果</h3>${players.map((p) => `
    <div class="showdown-row">
      <div class="showdown-player"><b>${escapeHtml(p.name)}</b><span>${escapeHtml(p.handName)}</span></div>
      <div class="showdown-best" aria-label="最佳五张">${miniCardsHtml(p.bestCards)}</div>
    </div>`).join('')}`;
  box.classList.remove('hidden');
}

function renderActionTimeline(r) {
  const box = document.getElementById('result-timeline');
  const actions = Array.isArray(r.actions) ? r.actions : [];
  if (!actions.length) {
    box.innerHTML = '';
    box.classList.add('hidden');
    return;
  }
  const streetNames = { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌' };
  box.innerHTML = `<h3>本局过程</h3><div class="timeline-list">${actions.map((entry) => {
    if (entry.type === 'street') {
      const cards = miniCardsHtml(entry.cards || []);
      return `<div class="timeline-street"><b>${streetNames[entry.street] || escapeHtml(entry.street)}</b>${cards ? `<span class="timeline-cards">${cards}</span>` : ''}</div>`;
    }
    return `<div class="timeline-action"><span>${escapeHtml(entry.name)}</span><b>${escapeHtml(entry.label)}</b></div>`;
  }).join('')}</div>`;
  box.classList.remove('hidden');
}
let countdown = 8;
let countdownTimer = null;
document.getElementById('btn-next-hand').onclick = () => {
  socket.emit('next_hand', null, (res) => {
    if (res && !res.ok) flashTip(res.err);
  });
};

// ---------------- 表情快捷互动 ----------------
// 手机端是底部弹层，PC 端是同一克制入口旁的轻量浮层，不再常驻一排。
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
document.addEventListener('click', (e) => {
  const wrap = document.getElementById('emoji-wrap');
  if (emojiBar.classList.contains('open') && wrap && !wrap.contains(e.target)) setEmojiOpen(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setEmojiOpen(false);
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

function renderNextHandStatus() {
  const paused = !!state.nextHandPaused;
  const btn = document.getElementById('btn-pause-next');
  btn.classList.toggle('hidden', !state.isHost);
  btn.textContent = paused ? '恢复下一局' : '暂停下一局';
  btn.setAttribute('aria-pressed', String(paused));
  document.getElementById('next-hand-status').textContent = paused
    ? '下一局已暂停，当前手照常进行'
    : '';
  const settled = ['waiting', 'handover'].includes(state.stage);
  document.getElementById('btn-export-session').disabled = !settled;
  document.getElementById('export-session-tip').textContent = settled
    ? '导出已结算战绩，包含已离场记录；离场筹码按离场时记录。'
    : '本手尚未结算，请在局间下载战绩。';
}
document.getElementById('btn-pause-next').onclick = () => {
  socket.emit('set_next_hand_paused', { paused: !state.nextHandPaused }, res => {
    if (!res || !res.ok) alert((res && res.err) || '操作失败');
  });
};
document.getElementById('btn-export-session').onclick = () => {
  socket.emit('export_session', null, res => {
    if (!res || !res.ok) return alert((res && res.err) || '导出失败');
    const url = URL.createObjectURL(new Blob([res.csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = res.filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
};

function renderIdentityControls() {
  const me = state.players.find(p => p.seat === mySeat);
  const panel = document.getElementById('identity-controls');
  panel.classList.toggle('hidden', !me || state.stage !== 'waiting' || state.handNumber !== 0);
  if (!me) return;
  const canMove = state.stage === 'waiting' && state.handNumber === 0;
  const select = document.getElementById('identity-seat');
  select.disabled = !canMove;
  select.innerHTML = Array.from({length:6}, (_,i) => {
    const occupant = state.players.find(p => !p.left && p.lobbySeat === i);
    return `<option value="${i}" ${i === me.lobbySeat ? 'selected' : ''} ${occupant && occupant !== me ? 'disabled' : ''}>${i+1}号座位${occupant ? (occupant === me ? '（我）' : '（有人）') : '（空位）'}</option>`;
  }).join('');
  document.getElementById('identity-seat-tip').textContent = canMove ? '座号按顺时针排列，首次开局后固定。' : '已开局，座位固定。';
  document.querySelectorAll('[data-avatar-id]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.avatarId) === me.avatarId)));
}
const avatarChoices = document.getElementById('identity-avatars');
avatarChoices.innerHTML = [{label:'原像素头像',start:0,end:6},{label:'港片人物',start:6,end:12}].map(group => `<fieldset class="avatar-group"><legend>${group.label}</legend><div class="avatar-options ${group.start ? 'hk-options' : ''}">${AVATAR_PNGS.slice(group.start,group.end).map((src,idx) => {
  const i = idx + group.start;
  return `<button type="button" data-avatar-id="${i}" aria-label="${AVATAR_NAMES[i]}" title="${AVATAR_NAMES[i]}"><img loading="lazy" decoding="async" src="${src}" width="38" height="38" alt="" />${group.start ? `<span>${AVATAR_NAMES[i]}</span>` : ''}</button>`;
}).join('')}</div></fieldset>`).join('');
avatarChoices.onclick = e => {
  const b = e.target.closest('[data-avatar-id]');
  if (b) socket.emit('choose_avatar', {avatarId:Number(b.dataset.avatarId)}, r => { if (!r.ok) alert(r.err); });
};
document.getElementById('identity-seat').onchange = e => socket.emit('choose_seat', {seat:Number(e.target.value)}, r => { if (!r.ok) { alert(r.err); renderIdentityControls(); } });
