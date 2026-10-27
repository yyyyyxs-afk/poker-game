/* 德州扑克客户端（A1 Phase 2 视觉结构版）
 * 牌局数据、Socket.IO 协议与操作逻辑保持不变；
 * 本轮重写 DOM 渲染：Header / Play Stage（牌桌 + 席位 + 下注层）/ Hero Dock / Raise Controller。 */
const socket = io();

let mySeat = -1;
let state = null;
let raiseOpen = false;
let raiseContext = '';
let allInIntent = null;
let activeRoomCode = '';
let roomConnectionReady = false;

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
const sessionOverlay = document.getElementById('session-overlay');
const tournamentOverlay = document.getElementById('tournament-overlay');
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
  const overlays = [settingsOverlay, resultOverlay, sessionOverlay, tournamentOverlay, rulesOverlay]
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
    else if (activeModal === sessionOverlay) closeSession();
    else if (activeModal === tournamentOverlay) closeTournament();
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
const lobbyCard = document.querySelector('.lobby-card');
const fieldErrorIds = {nickname:'nickname-error','room-code':'room-code-error','create-chips':'create-chips-error','create-sb':'create-stakes-error','create-bb':'create-stakes-error','create-payment':'create-payment-error'};
function clearFieldError(id) {
  const el=document.getElementById(id);
  el.removeAttribute('aria-invalid');
  document.getElementById(fieldErrorIds[id]).textContent='';
}
function clearLobbyErrors() {
  Object.keys(fieldErrorIds).forEach(clearFieldError);
  for(const id of ['lobby-error','create-form-error','join-form-error'])document.getElementById(id).textContent='';
}
function fieldError(id,message) {
  const el=document.getElementById(id);
  el.setAttribute('aria-invalid','true');
  document.getElementById(fieldErrorIds[id]).textContent=message;
  el.focus();
  el.scrollIntoView({block:'center'});
  return false;
}
function selectedCreateMode(){return document.querySelector('[name="create-mode"]:checked').value;}
function validateCreateFields(){
  const sc=Number(document.getElementById('create-chips').value),sb=Number(document.getElementById('create-sb').value),bb=Number(document.getElementById('create-bb').value);
  if(!Number.isSafeInteger(sc)||sc<100||sc>1000000)return fieldError('create-chips','起始筹码请填100–1,000,000的整数。');
  if(!Number.isSafeInteger(sb)||sb<1)return fieldError('create-sb','小盲注请填正整数。');
  if(!Number.isSafeInteger(bb)||bb<sb)return fieldError('create-bb','大盲注须为整数，且不低于小盲注。');
  if(bb>Math.floor(sc/20))return fieldError('create-bb','起始筹码至少为大盲的20倍，请调整盲注或筹码。');
  const payment=Number(document.getElementById('create-payment').value);
  if(selectedCreateMode()==='squid'&&(!Number.isSafeInteger(payment)||payment<1||payment>1000000))return fieldError('create-payment','每人支付额请填1–1,000,000的整数筹码。');
  return true;
}

const lobbyRequests=createLobbyRequests({socket,onChange:renderLobbyRequestState});
function renderLobbyRequestState(s) {
  lobbySubmission=s.pendingKind;
  lobbyExpectedRoom=s.pendingCode||s.unknown?.code||'';
  const mutationBusy=!!s.pendingKind&&s.pendingKind!=='preview';
  for(const el of document.querySelectorAll('#create-options input,#create-options select,#create-mode button,#create-squid-settings button,#nickname,#room-code'))el.disabled=mutationBusy;
  const createConfirm=document.getElementById('btn-create-confirm'),joinConfirm=document.getElementById('btn-join-confirm');
  createConfirm.disabled=!!s.pendingKind||!!s.unknown;
  joinConfirm.disabled=!!s.pendingKind||!!s.unknown||s.replacement;
  joinRoomBtn.disabled=!!s.pendingKind||!!s.unknown||s.replacement;
  joinRoomBtn.textContent=s.pendingKind==='preview'?'查询中…':s.unknown||s.replacement?'待核对':'加入';
  createConfirm.textContent=s.pendingKind==='create'?'正在创建…':s.unknown?'结果待核对':s.replacement?'创建新房间':'创建房间';
  joinConfirm.textContent=s.pendingKind==='join'?'正在加入…':s.unknown?'结果待核对':'确认加入';
  for(const [button,kind] of [[createConfirm,'create'],[joinConfirm,'join'],[joinRoomBtn,'preview']]){
    if(s.pendingKind===kind)button.setAttribute('aria-busy','true');else button.removeAttribute('aria-busy');
  }
  const connectionText={connecting:'正在连接牌局服务；可先填写资料。',failed:'连接未成功，正在重试；资料已保留。',offline:'连接已断开，正在重连；资料已保留。',ready:'已连接牌局服务。',recovered:'连接已恢复；请主动提交，不会自动执行之前操作。'};
  const connectionLabel=document.getElementById('lobby-connection');
  if(connectionLabel.textContent!==connectionText[s.connection])connectionLabel.textContent=connectionText[s.connection];
  document.getElementById('lobby-request-message').textContent=s.message;
  const details=document.getElementById('lobby-unknown');
  details.classList.toggle('hidden',!s.unknown);
  document.getElementById('btn-lobby-unknown-open').classList.toggle('hidden',!s.unknown);
  if(s.unknown)document.getElementById('lobby-unknown-original').textContent=`原操作：${s.unknown.kind==='create'?'创建房间':'加入房间'} · ${s.unknown.name}${s.unknown.code?' · '+s.unknown.code:''}`;
  else {details.open=false;document.getElementById('lobby-abandon-confirm').checked=false;}
  document.getElementById('btn-lobby-abandon').disabled=!document.getElementById('lobby-abandon-confirm').checked;
}
function moveLobbyFeedback(view) {
  document.getElementById(view==='create'?'create-feedback-slot':view==='join'?'join-feedback-slot':'lobby-feedback-slot').appendChild(document.getElementById('lobby-feedback'));
  document.getElementById(view==='create'?'create-unknown-slot':view==='join'?'join-unknown-slot':'lobby-unknown-slot').appendChild(document.getElementById('lobby-unknown'));
}
document.getElementById('btn-lobby-unknown-open').onclick=()=>{
  const details=document.getElementById('lobby-unknown');details.open=true;details.querySelector('summary').focus();details.scrollIntoView({block:'nearest'});
};
document.getElementById('lobby-abandon-confirm').onchange=()=>lobbyRequests.refresh();
document.getElementById('btn-lobby-abandon').onclick=()=>{
  if(lobbyRequests.abandonForNewRoom(document.getElementById('lobby-abandon-confirm').checked))showCreateOptions(true);
};
lobbyRequests.refresh();
function sendLobbyRequest(kind,payload,callbacks) {
  const sent=lobbyRequests.send(kind,payload,callbacks);
  const feedback=document.getElementById('lobby-feedback');feedback.focus({preventScroll:true});feedback.scrollIntoView({block:'nearest'});
  return sent;
}

document.getElementById('create-options').onsubmit = event => {
  event.preventDefault();
  if(lobbySubmission)return;
  clearLobbyErrors();
  const name = getName();
  if (!name) return;
  if(!validateCreateFields())return;
  const mode=selectedCreateMode();
  const settings={startChips:Number(document.getElementById('create-chips').value),smallBlind:Number(document.getElementById('create-sb').value),bigBlind:Number(document.getElementById('create-bb').value),actionTime:Number(document.getElementById('create-action').value),nextHandDelay:Number(document.getElementById('create-delay').value),rebuyAllowed:mode!=='tournament'&&document.getElementById('create-rebuy').value==='true'};
  sendLobbyRequest('create', { name,mode,settings,...(mode==='squid'?{squidPayment:Number(document.getElementById('create-payment').value)}:{}),...(mode==='tournament'?{blindIntervalMinutes:Number(document.getElementById('create-blind-interval').value)}:{}) }, {success:res=>{
      saveAuth(res.code, name, res.token);
      enterRoom(res.code);
  },rejected:res=>showLobbyError(res.err||'创建被拒绝，请检查资料。')});
};
function submitJoin() {
  const name = getName();
  const code = document.getElementById('room-code').value.trim().toUpperCase();
  if (!name) return;
  if (!/^[A-Z0-9]{6}$/.test(code)) return showLobbyError('请输入 6 位邀请码');
  sendLobbyRequest('join', { code, name, token: storedToken()[`${code}_${name}`] }, {success:res=>{
      saveAuth(res.code, name, res.token);
      enterRoom(res.code);
  },rejected:res=>showLobbyError(res.err||'加入被拒绝，请检查资料。')});
 }
let previewCode='';
joinRoomBtn.onclick=()=>{
  const name=getName(),code=document.getElementById('room-code').value.trim().toUpperCase();
  if(!name)return;
  if(!/^[A-Z0-9]{6}$/.test(code))return showLobbyError('请输入6位邀请码');
  if(storedToken()[`${code}_${name}`])return submitJoin();
  document.getElementById('join-preview').classList.add('hidden');
  sendLobbyRequest('preview',{code},{success:res=>{
    if(document.getElementById('room-code').value.trim().toUpperCase()!==code)return;
    previewCode=code;
    const info=res.info,c=info.settings,isSquid=info.mode==='squid',isTournament=info.mode==='tournament';
    document.getElementById('preview-room-code').textContent=code;
    document.getElementById('join-preview-title').textContent=isSquid?'加入鱿鱼德州':isTournament?'加入单桌锦标赛':'加入经典德州';
    document.getElementById('join-mode-meta').textContent=isSquid?'普通52张德州＋经典鱿鱼 · 3–6人':isTournament?'定时升盲、淘汰争冠 · 2–6人':'普通52张无限注德州 · 2–6人';
    document.getElementById('join-tournament-note').classList.toggle('hidden',!isTournament);
    document.getElementById('join-tournament-note').textContent=isTournament?`每${info.blindIntervalMinutes}分钟升盲；禁止补买，开赛后不接受新入座，服务器重启不保留赛事。`:'';
    document.getElementById('join-start-chips').textContent=c.startChips.toLocaleString('zh-CN');
    document.getElementById('join-blinds').textContent=`${c.smallBlind} / ${c.bigBlind}`;
    document.getElementById('join-tempo').textContent=`${c.actionTime}秒行动 · ${c.nextHandDelay}秒局间 · ${c.rebuyAllowed?'允许':'禁止'}重买`;
    document.getElementById('join-squid-summary').classList.toggle('hidden',!isSquid);
    document.getElementById('join-payment').textContent=isSquid?info.squidPayment.toLocaleString('zh-CN'):'';
    lobbyCard.classList.add('joining');
    for(const id of ['btn-create','join-divider','join-entry'])document.getElementById(id).classList.add('hidden');
    document.getElementById('join-name-slot').appendChild(document.getElementById('nickname-field'));
    document.getElementById('join-preview').classList.remove('hidden');
    moveLobbyFeedback('join');
    document.getElementById('join-preview-title').focus();
  },rejected:res=>showLobbyError(res.err||'查询失败，请核对房号。')});
};
document.getElementById('btn-join-confirm').onclick=()=>{
  if(previewCode!==document.getElementById('room-code').value.trim().toUpperCase())return showLobbyError('邀请码已变化，请重新查询房间说明');
  submitJoin();
};
function closeJoinPreview(){
  lobbyRequests.leaveView();
  lobbyCard.classList.remove('joining');
  document.getElementById('join-preview').classList.add('hidden');
  document.getElementById('nickname-home-slot').appendChild(document.getElementById('nickname-field'));
  for(const id of ['btn-create','join-divider','join-entry'])document.getElementById(id).classList.remove('hidden');
  moveLobbyFeedback('home');
  previewCode='';clearLobbyErrors();document.getElementById('room-code').focus();
}
document.getElementById('btn-join-back').onclick=closeJoinPreview;
document.getElementById('room-code').addEventListener('input',()=>{lobbyRequests.cancelQuery();previewCode='';document.getElementById('join-preview').classList.add('hidden');});
document.getElementById('nickname').addEventListener('input',()=>lobbyRequests.cancelQuery());
function showCreateOptions(open){
  lobbyRequests.leaveView();
  lobbyCard.classList.toggle('creating',open);
  lobbyCard.classList.remove('joining');
  document.getElementById(open?'create-name-slot':'nickname-home-slot').appendChild(document.getElementById('nickname-field'));
  document.getElementById('create-options').classList.toggle('hidden',!open);
  document.getElementById('create-heading').classList.toggle('hidden',!open);
  for(const id of ['btn-create','join-divider','join-entry'])document.getElementById(id).classList.toggle('hidden',open);
  document.querySelector('.lobby-facts').classList.toggle('hidden',open);
  document.getElementById('join-preview').classList.add('hidden');
  moveLobbyFeedback(open?'create':'home');
  clearLobbyErrors();
  if(open){renderCreateOptions();document.querySelector('[name="create-mode"]:checked').focus();}else createRoomBtn.focus();
}
createRoomBtn.onclick=()=>showCreateOptions(true);
document.getElementById('btn-create-back').onclick=()=>showCreateOptions(false);
document.getElementById('btn-create-cancel').onclick=()=>showCreateOptions(false);
let createPaymentTouched=false;
function renderCreateOptions(){
  const mode=selectedCreateMode(),isSquid=mode==='squid',isTournament=mode==='tournament';
  lobbyCard.classList.toggle('classic',!isSquid);
  document.getElementById('create-squid-settings').classList.toggle('hidden',!isSquid);
  document.getElementById('create-tournament-settings').classList.toggle('hidden',!isTournament);
  document.getElementById('create-rebuy-row').classList.toggle('hidden',isTournament);
  document.getElementById('create-mode-tip').textContent='玩法创建后固定，入房后不能切换。';
  const p=Number(document.getElementById('create-payment').value);
  const total=Number.isSafeInteger(p)&&p>=1&&p<=1000000?(3*p).toLocaleString('zh-CN'):'—';
  document.getElementById('preview-total').textContent=total;
  document.getElementById('preview-frozen').textContent=total;
  document.querySelectorAll('[data-payment]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.payment)===p)));
  document.getElementById('advanced-summary').textContent=`${document.getElementById('create-action').value}秒行动 · ${document.getElementById('create-delay').value}秒局间 · ${isTournament?'禁止':document.getElementById('create-rebuy').value==='true'?'允许':'禁止'}重买`;
}
document.getElementById('create-mode').onchange=renderCreateOptions;
document.getElementById('create-bb').oninput=()=>{if(!createPaymentTouched)document.getElementById('create-payment').value=document.getElementById('create-bb').value;renderCreateOptions();};
document.getElementById('create-payment').oninput=()=>{createPaymentTouched=true;renderCreateOptions();};
document.querySelectorAll('[data-payment]').forEach(b=>b.onclick=()=>{createPaymentTouched=true;document.getElementById('create-payment').value=b.dataset.payment;clearFieldError('create-payment');renderCreateOptions();});
for(const id of ['create-action','create-delay','create-rebuy'])document.getElementById(id).onchange=renderCreateOptions;
Object.keys(fieldErrorIds).forEach(id=>document.getElementById(id).addEventListener('input',()=>{clearFieldError(id);document.getElementById('create-form-error').textContent='';document.getElementById('join-form-error').textContent='';}));
renderCreateOptions();
function getName() {
  const n = document.getElementById('nickname').value.trim();
  if (!n) { fieldError('nickname','请先填写昵称。'); return null; }
  const normalized=n.normalize('NFKC'),count=typeof Intl.Segmenter==='function'?[...new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(normalized)].length:Array.from(normalized).length;
  if(count>8||/[\p{Cc}\p{Cf}\p{Cs}]/u.test(normalized)||!/[\p{L}\p{N}\p{P}\p{S}]/u.test(normalized)){fieldError('nickname','昵称须为1–8个可见字符，不能含控制或零宽字符。');return null;}
  return n;
}
function showLobbyError(msg) {
  if(!msg){clearLobbyErrors();return;}
  if(/昵称/.test(msg)){fieldError('nickname',msg);return;}
  if(lobbyCard.classList.contains('creating')){
    const field=/支付/.test(msg)?'create-payment':/盲注/.test(msg)?'create-bb':/起始筹码/.test(msg)?'create-chips':null;
    if(field){fieldError(field,msg);return;}
  }else if(!lobbyCard.classList.contains('joining')){fieldError('room-code',msg);return;}
  const el=document.getElementById(lobbyCard.classList.contains('creating')?'create-form-error':'join-form-error');
  el.textContent=msg;el.focus();
}

function enterRoom(code) {
  const normalizedCode = String(code || '').trim().toUpperCase();
  if (!normalizedCode) return;
  activeRoomCode = normalizedCode;
  roomConnectionReady = socket.connected;
  hideRaisePanel();
  const name = document.getElementById('nickname').value.trim();
  if (name) localStorage.setItem('poker-nickname', name);
  saveLastRoom(normalizedCode, name || localStorage.getItem('poker-nickname') || '');
  document.getElementById('lobby').classList.add('hidden');
  document.getElementById('game').classList.remove('hidden');
  document.getElementById('room-code-display').textContent = normalizedCode;
  chatDelivery.refresh();
  mobileView.refresh();
}

// ---------------- 断线自动重连（token 恢复座位，客户端行为） ----------------
// 服务端断线保护窗口与座位语义不变；这里只做：断线后 socket 重连成功时，
// 用本地保存的房号/昵称/token 恢复座位；等待有时限，拿到本人状态后再允许行动。
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
function setConnState(msg, sub, showActions) {
  connMsg.textContent = msg;
  connSub.textContent = sub || '';
  connActions.classList.toggle('hidden', !showActions);
}
const roomRecovery = createRoomRecovery({
  socket,
  getTarget: () => {
    const last = getLastRoom();
    if (!activeRoomCode || last?.code !== activeRoomCode) return null;
    return { code: last.code, name: last.name, token: storedToken()[`${last.code}_${last.name}`] };
  },
  onChange: (status, detail) => {
    roomConnectionReady = false;
    connOverlay.classList.remove('hidden');
    setConnState(status === 'restoring' ? '正在恢复牌局…' : status === 'offline' ? '连接断开，正在重连…' : '暂时无法恢复牌局', detail, status !== 'restoring');
  },
  onRestored: target => {
    enterRoom(target.code);
    connOverlay.classList.add('hidden');
    flashTip('已重新连接，回到牌局');
  },
});
const actionDelivery = createActionDelivery({
  socket,
  isReady: () => roomConnectionReady && !!state && state.code === activeRoomCode && state.turnSeat === mySeat,
  onWaiting: waiting => {
    const buttons = document.getElementById('action-buttons');
    buttons.classList.toggle('is-waiting', waiting);
    if (waiting) buttons.setAttribute('aria-busy', 'true');
    else buttons.removeAttribute('aria-busy');
  },
  onError: flashTip,
  onSuccess: () => sfx.bet(),
});
document.getElementById('btn-reconnect').addEventListener('click', () => {
  roomRecovery.start();
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
  const participant=state?.tournament?.members.find(m=>m.name===state.players[mySeat]?.name);
  if(state?.tournament?.status==='running'&&participant?.status==='active'&&!confirm('退出将作为退赛，已投入筹码留在底池，剩余筹码退出赛事，不能重新参赛。确定退出？'))return;
  leavingRoom = true;
  leaveBtn.disabled = true;
  leaveBtn.textContent = '退出中…';
  closeMenu();
  clearLastRoom(); // 先断开自动恢复资格，退出期间即使 socket 抖动也不会回座
  roomRecovery.cancel();
  actionDelivery.cancel();
  roomConnectionReady = false;
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
  document.getElementById('set-rebuy-row').classList.toggle('hidden',state.mode==='tournament');
  document.getElementById('set-blind-interval-row').classList.toggle('hidden',state.mode!=='tournament');
  if(state.tournament)document.getElementById('set-blind-interval').value=String(state.tournament.intervalMinutes);
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
  const chipsValue=id=>state.mode==='tournament'?Number(document.getElementById(id).value):parseInt(document.getElementById(id).value,10);
  const payload = {
    startChips: chipsValue('set-start-chips'),
    smallBlind: chipsValue('set-sb'),
    bigBlind: chipsValue('set-bb'),
    actionTime: parseInt(document.getElementById('set-action-time').value, 10),
    nextHandDelay: parseInt(document.getElementById('set-next-hand').value, 10),
    rebuyAllowed: state.mode!=='tournament' && document.getElementById('set-rebuy').value === 'true',
    locked: document.getElementById('set-locked').value === 'true',
  };
  if(state.mode==='tournament')payload.blindIntervalMinutes=Number(document.getElementById('set-blind-interval').value);
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
  render();
  roomRecovery.acceptState(s);
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
    return;
  }
  connOverlay.classList.remove('hidden');
  setConnState('连接恢复，正在回到牌局…', '');
  roomRecovery.start();
});
socket.on('disconnect', () => {
  roomConnectionReady = false;
  roomRecovery.cancel();
  actionDelivery.cancel();
  if (!activeRoomCode || document.getElementById('game').classList.contains('hidden')) {
    return;
  }
  sessionOverlay.classList.add('hidden');
  hideRaisePanel();
  resetFoldBtn();
  connOverlay.classList.remove('hidden');
  setConnState('连接断开，正在重连…', '座位会暂时保留；超过保护时间可能自动过牌或弃牌。', true);
});
socket.on('connect_error', () => {
  if (!activeRoomCode) return;
  roomConnectionReady = false;
  roomRecovery.cancel();
  setConnState('暂时连接不上服务器', '正在自动重试，你也可以立即重连或返回大厅。', true);
  connOverlay.classList.remove('hidden');
});

function render() {
  if (!state) return;
  try {
    renderForfeitShowcase();
    updateSquidMarks();
    updateWinnerSeats();
    renderTableInfo();
    renderSeats();
    renderCommunity();
    renderMyArea();
    renderLogs();
    renderChats();
    renderWinnerShowControls();
    renderIdentityControls();
    renderNextHandStatus();
    renderResults();
    renderTournament();
    if (!sessionOverlay.classList.contains('hidden')) renderSession();
    renderSquid();
    // 手牌、操作区和冻结提示都会影响桌面高度；全部更新后再量下注坐标。
    renderBets();
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
      'hidden', !(state.stage === 'waiting' && state.isHost && (!state.tournament || state.tournament.status==='waiting')));
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
  const view = typeof mobileView !== 'undefined' ? mobileView.size() : null;
  const w = view ? view.width : typeof window !== 'undefined' ? window.innerWidth : 1280;
  const h = view ? view.height : typeof window !== 'undefined' ? window.innerHeight : 800;
  const narrow = w <= 900;
  const veryNarrow = narrow && w <= 420;
  const landscape = w > h;
  const rx = 44;
  const ry = narrow ? (landscape ? 40 : 46) : 42; // 竖屏竖椭圆长轴
  let x = Math.max(narrow ? 14 : 9, Math.min(narrow ? 86 : 91, 50 + Math.cos(rad) * rx));
  let y = Math.max(narrow ? (landscape ? 11 : 8) : 9,
                   Math.min(narrow ? (landscape ? 80 : 86) : 71, 50 + Math.sin(rad) * ry));
  // 手机侧翼席位：收在中央区同一侧之外（竖桌纵向余量足，嵌放即可）
  if (narrow && index !== 0 && (x <= 30 || x >= 70)) {
    if (landscape) {
      y = y < 50 ? Math.min(y, 24) : Math.max(y, 88);
    } else {
      y = y < 50 ? Math.min(y, veryNarrow ? 24 : 26) : Math.max(y, veryNarrow ? 79 : 78);
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
    <img class="avatar-img" src="${avatarPng(p.seat)}" alt="${escapeHtml(p.name)} 的头像" />${squidMarkHtml(p)}
    <div class="seat-copy">
      <strong>${escapeHtml(p.name)}</strong>
      <span class="seat-chips">${p.chips}${p.frozen ? `<small class="frozen-chips"> 冻${p.frozen}</small>` : ''}</span>

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
    if (pos.y > 70) div.classList.add('lower-wing');
    if (pos.y < 20 && pos.x > 30 && pos.x < 70) div.classList.add('top-seat');

    div.innerHTML = `
      <div class="hole-cards"></div>
      <div class="seat-card">${seatCardHtml(p, false)}</div>
    `;

    // 仅用服务端公开的 holeCount 画牌背；牌面仍只在 revealed 后读取 p.hole，绝不推测底牌。
    const holeDiv = div.querySelector('.hole-cards');
    if (p.shownCards && p.shownCards.length) {
      // 自愿公开在席位文字与复盘显示，避免顶部牌面覆盖手机页头。
    } else if (p.hole && p.hole.length && state.revealed) {
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
    if (state.isHost && p.seat !== mySeat && !p.left && (!state.tournament || state.tournament.status==='waiting')) {
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
      <img class="avatar-img" src="${avatarPng(me.seat)}" alt="我的头像" />${squidMarkHtml(me)}
      <div class="seat-copy">
        <strong>${escapeHtml(me.name)}</strong>
        ${me.frozen ? `<span class="seat-chips hero-balances"><span>可用 ${me.chips}</span><span class="hero-frozen">冻结 ${me.frozen}</span></span>` : `<span class="seat-chips">${me.chips}</span>`}
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
  const readRect = el => typeof mobileView !== 'undefined' ? mobileView.rect(el) : el.getBoundingClientRect();
  const tableRect = readRect(tableEl);
  const wrapRect = readRect(wrap);
  if (!tableRect.width) return;

  // 障碍：桌心中央区三件套 + 全部席位卡（含 hero；自家卡单独判定不压数字）
  const obstacles = ['stage-label', 'pot-display', 'community']
    .map((id) => document.getElementById(id))
    .filter((el) => el && !el.classList.contains('hidden'))
    .map(readRect);
  const seatRects = new Map();
  document.querySelectorAll('#seats .seat').forEach((el) => {
    const card = el.querySelector('.seat-card');
    if (card && el.dataset.seat) seatRects.set(Number(el.dataset.seat), readRect(card));
  });
  const heroCard = document.querySelector('#hero-seat .seat-card');
  if (heroCard && mySeat >= 0) seatRects.set(mySeat, readRect(heroCard));

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

    // overlaps 的正 margin 缩小障碍（允许轻擦），负 margin 扩大障碍。
    // 中央区沿边允许轻擦 2px；其他席位卡保留 3px 间距；
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
      // 搜索点是视口中的中心；样式是 #bets 内的左上角（不含牌桌边框）。
      chip.style.left = (px - wrapRect.left - halfW) + 'px';
      chip.style.top = (py - wrapRect.top - halfH) + 'px';
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
      if (r.left < tableRect.left || r.right > tableRect.right ||
          r.top < tableRect.top || r.bottom > tableRect.bottom) continue;
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
    && !state.gameOver && state.players.filter(p=>!p.left&&p.connected&&!p.sittingOut).length >= (state.mode==='squid'?3:2);
  startBtn.classList.toggle('hidden', !showStart);
  const showRebuy = !state.gameOver && ['waiting', 'handover'].includes(state.stage)
    && me && cfg().rebuyAllowed !== false && (me.chips === 0 || (state.squid?.enabled && !state.squid.current && state.squid.waitingReason && me.chips <= (state.players.filter(p=>p.connected&&!p.sittingOut&&!p.left).length-1)*state.squid.payment));
  rebuyBtn.classList.toggle('hidden', !showRebuy);
  rebuyBtn.textContent = `重新买入（补充 ${cfg().startChips} 筹码）`;
  // 暂离/坐回按钮：对局中或局间都可以暂离；暂离状态显示坐回按钮
  const showSitOut = !state.tournament && me && !me.sittingOut && ['waiting', 'handover', 'preflop', 'flop', 'turn', 'river'].includes(state.stage) && !state.gameOver;
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
    if (foldContext && foldContext !== currentContext) resetFoldBtn();
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
    resetFoldBtn();
    bar.classList.add('hidden');
    hint.classList.add('hidden');
    hideRaisePanel();
    stopTurnTimer();
    const tournamentMember=state.tournament?.members.find(m=>m.name===me?.name);
    if(tournamentMember?.status==='eliminated')tip.textContent='你已淘汰，可查看比赛进度和名次。';
    else if (inHandActive) tip.textContent = '等待其他玩家行动…';
    else if (me && (me.folded || me.allIn) && state.stage !== 'handover') {
      tip.textContent = me.folded ? '你已弃牌，观战中' : '你已全押，等待摊牌';
    } else if (state.stage !== 'waiting') tip.textContent = '';
  }
}

function waitingTipText() {
  if (state.gameOver) return '游戏已结束';
  const count = state.players.length;
  if(state.mode==='squid'){const ready=state.players.filter(p=>p.connected&&!p.sittingOut&&!p.left).length;return ready<3?`当前有效${ready}人，等待至少3人开局`:state.isHost?`${ready}名玩家已就绪，可开始鱿鱼德州`:`${ready}名玩家已就绪，等待房主开始鱿鱼德州`;}
  if (count < 2) return `把房号 ${state.code} 发给朋友，凑齐 2 人即可开局`;
  return state.isHost ? `${count} 名玩家已就绪，可以开始游戏`
    : `${count} 名玩家已就绪，等待房主开始`;
}

function updateActionBar(me) {
  const toCall = state.currentBet - me.roundBet;
  const amounts = PokerExplanations.actionAmounts(state, me);
  const raiseAllowed = me.raiseAllowed !== false; // 兼容旧服务端：字段缺失时仍按可加注处理
  // "轮到你 · 跟注 335"式提示：金额数据全部来自服务端状态
  const hint = document.getElementById('action-hint');
  hint.innerHTML = toCall <= 0 ? '轮到你 · <b>可以过牌，无需投入</b>'
    : `轮到你 · <b>再投 ${PokerExplanations.number(amounts.call)} 跟注</b> · 余 ${PokerExplanations.number(amounts.afterCall)}`;
  const callBtn = document.getElementById('btn-check-call');
  callBtn.textContent = toCall <= 0 ? '过牌'
    : toCall >= me.chips ? `跟注全押 (${me.chips})` : `跟注 ${toCall}`;
  callBtn.onclick = () => toCall > 0 && toCall >= me.chips
    ? openAllInConfirmation('call') : sendAction(toCall <= 0 ? 'check' : 'call');

  const allInBtn = document.getElementById('btn-allin');
  allInBtn.textContent = `全押 ${PokerExplanations.number(me.chips)}`;
  allInBtn.onclick = () => openAllInConfirmation('allin');

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
  slider.step = 1; // 允许精确到整数筹码；全押上限不一定是大盲的整数倍。
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
    renderRaiseExplanation();
  };
  slider.oninput = syncRaiseViews;
  input.oninput = () => {
    const v = Number(input.value);
    if (!Number.isSafeInteger(v) || input.value === '') return renderRaiseExplanation();
    const clamped = Math.max(+slider.min, Math.min(+slider.max, v));
    slider.value = clamped;
    renderRaiseExplanation();
  };
  // P2-5：失焦时把显示值回写为钳制后的合法值（输入中不打断，确认金额始终一致）
  input.onblur = () => {
    const v = Number(input.value);
    if (!Number.isSafeInteger(v) || input.value === '') return renderRaiseExplanation();
    const clamped = Math.max(+slider.min, Math.min(+slider.max, v));
    input.value = clamped;
    slider.value = clamped;
    renderRaiseExplanation();
  };
  document.getElementById('raise-dec').onclick = () => {
    slider.value = Number(slider.value) - cfg().bigBlind;
    syncRaiseViews();
  };
  document.getElementById('raise-inc').onclick = () => {
    slider.value = Number(slider.value) + cfg().bigBlind;
    syncRaiseViews();
  };

  // 快捷下注：基于服务端权威的 pot / currentBet 计算"跟注后的底池"比例，
  // 低于最小合法加注自动抬到最小值，超出最大金额自动封顶（全押）
  const PRESET_FRAC = { third: 1 / 3, half: 1 / 2, twothird: 2 / 3, pot: 1 };
  const PRESET_BLINDS = { third: 2, half: 2.5, twothird: 3 };
  const opening = state.stage === 'preflop' && state.currentBet === state.bigBlind;
  document.querySelectorAll('.preset').forEach((btn) => {
    const preset = btn.dataset.preset;
    btn.hidden = opening && preset === 'pot';
    let openingTarget, openingValue, adjustment = '';
    if (opening && PRESET_BLINDS[preset]) {
      const multiple = PRESET_BLINDS[preset];
      openingTarget = Math.ceil(state.bigBlind * multiple);
      openingValue = Math.max(minRaiseTo, Math.min(maxRaiseTo, openingTarget));
      adjustment = openingValue > openingTarget ? '已提高到最小加注' : openingValue < openingTarget ? '已按筹码上限调整为全押' : '';
      btn.textContent = `${multiple}倍 ${PokerExplanations.number(openingValue)}${adjustment ? openingValue > openingTarget ? '最低' : '全押' : ''}`;
      btn.title = adjustment || `加注到 ${PokerExplanations.number(openingValue)}`;
      btn.setAttribute('aria-label', `${multiple}倍大盲，加注到 ${PokerExplanations.number(openingValue)}${adjustment ? `，${adjustment}` : ''}`);
    } else {
      const labels = { third: '1/3池', half: '1/2池', twothird: '2/3池', pot: '满池', allin: '全押' };
      btn.textContent = labels[preset];
      btn.title = '';
      btn.setAttribute('aria-label', labels[preset]);
    }
    btn.onclick = () => {
      let v;
      if (preset === 'allin') {
        v = maxRaiseTo;
      } else if (opening && PRESET_BLINDS[preset]) {
        v = openingValue;
      } else {
        const frac = PRESET_FRAC[preset];
        if (!frac) return;
        const potAfterCall = state.pot + toCall;
        const target = state.currentBet + Math.ceil(potAfterCall * frac);
        v = Math.max(minRaiseTo, Math.min(maxRaiseTo, target));
      }
      slider.value = v; input.value = v;
      renderRaiseExplanation();
      if (adjustment) document.getElementById('raise-explanation').textContent += ` ${adjustment}。`;
    };
  });

  const raiseBtn = document.getElementById('btn-toggle-raise');
  raiseBtn.textContent = isBet ? '下注' : '加注';
  raiseBtn.disabled = maxRaiseTo <= state.currentBet || !raiseAllowed;
  raiseBtn.onclick = onRaiseToggleClick;
  document.getElementById('btn-raise-confirm').onclick = confirmRaise;
  document.getElementById('btn-raise-cancel').onclick = cancelRaisePanel;
  input.disabled = !!allInIntent;
  if (allInIntent) slider.value = input.value = maxRaiseTo;
  document.getElementById('raise-panel').classList.toggle('allin-confirm', !!allInIntent);
  renderRaiseExplanation();
}

function renderRaiseExplanation() {
  const me = state?.players[mySeat];
  if (!me) return;
  const input = document.getElementById('raise-input');
  const confirm = document.getElementById('btn-raise-confirm');
  const invalid = !allInIntent && (input.value === '' || !Number.isSafeInteger(Number(input.value)));
  confirm.disabled = invalid;
  input.setAttribute('aria-invalid', String(invalid));
  if (invalid) {
    document.getElementById('raise-explanation').textContent = '请填写整数筹码，再确认下注。';
    return;
  }
  const amounts = PokerExplanations.actionAmounts(state, me, allInIntent
    ? me.roundBet + me.chips : document.getElementById('raise-slider').value);
  const isAllIn = amounts.extra === me.chips;
  if (confirm.firstChild?.nodeType === Node.TEXT_NODE) {
    confirm.firstChild.textContent = isAllIn ? '确认全押 ' : state.currentBet === 0 ? '确认下注到 ' : '确认加注到 ';
  }
  document.getElementById('raise-confirm-value').textContent = PokerExplanations.number(isAllIn ? amounts.extra : amounts.total);
  document.getElementById('raise-label').textContent = allInIntent ? '全押后，本轮合计下注' : state.currentBet === 0 ? '本轮下注到' : '本轮加注到';
  document.getElementById('raise-explanation').textContent =
    `本轮已投 ${PokerExplanations.number(me.roundBet)}；再投入 ${PokerExplanations.number(amounts.extra)}，可用余 ${PokerExplanations.number(amounts.remaining)}。` +
    (amounts.frozen ? `另有冻结 ${PokerExplanations.number(amounts.frozen)}，不参与本次下注。` : '');
}

function openAllInConfirmation(type) {
  const me = state?.players[mySeat], context = raiseContextKey(me);
  if (!context || !roomConnectionReady || !socket.connected || me.chips <= 0) return;
  const max = me.roundBet + me.chips;
  if (type === 'allin' && me.raiseAllowed === false && max > state.currentBet) return;
  if (type === 'call' && state.currentBet - me.roundBet < me.chips) return;
  resetFoldBtn();
  allInIntent = { type, context };
  raiseOpen = true;
  raiseContext = context;
  updateActionBar(me);
  document.getElementById('raise-panel').classList.remove('hidden');
  document.getElementById('action-bar').classList.add('raising');
  document.getElementById('btn-raise-confirm').focus();
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
  allInIntent = null;
  updateActionBar(me);
  document.getElementById('raise-panel').classList.remove('hidden');
  document.getElementById('action-bar').classList.add('raising');
  document.getElementById('btn-toggle-raise').classList.add('is-active');
}
function hideRaisePanel() {
  const wasAllIn = !!allInIntent;
  raiseOpen = false;
  raiseContext = '';
  allInIntent = null;
  document.getElementById('raise-panel').classList.remove('allin-confirm');
  document.getElementById('raise-input').disabled = false;
  if (wasAllIn) {
    const slider = document.getElementById('raise-slider');
    slider.value = slider.min;
    document.getElementById('raise-input').value = slider.value;
  }
  document.getElementById('raise-panel').classList.add('hidden');
  document.getElementById('action-bar').classList.remove('raising');
  document.getElementById('raise-panel').style.bottom = ''; // 清键盘兜底偏移
  const toggle = document.getElementById('btn-toggle-raise');
  if (toggle) toggle.classList.remove('is-active');
}
function cancelRaisePanel() {
  const trigger = allInIntent ? allInIntent.type === 'call' ? 'btn-check-call' : 'btn-allin' : 'btn-toggle-raise';
  hideRaisePanel();
  document.getElementById(trigger).focus();
}
function raiseContextKey(me) {
  if (!state || !me || me.folded || me.allIn || state.turnSeat !== mySeat ||
      !['preflop', 'flop', 'turn', 'river'].includes(state.stage)) return '';
  return [state.code, state.handNumber, state.stage, state.turnSeat,
    state.currentBet, me.roundBet, me.chips].join('|');
}
// 手机抽屉遮罩：点击等同取消
document.getElementById('raise-scrim').addEventListener('click', cancelRaisePanel);
document.getElementById('raise-panel').addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  cancelRaisePanel();
});
// 键盘弹起兜底（仅手机）：软键盘把抽屉盖住时，用 visualViewport 实测
// 键盘高度把抽屉抬到键盘上方；键盘收起自动归位。主路径（快捷/滑条/步进）不依赖键盘。
let wasCompactView = false;
const mobileView = createMobileView({
  root: document.getElementById('app-surface'), game: document.getElementById('game'),
  onNotice: showToast,
  onChange: view => {
    if (view.compact && !wasCompactView) setLogCollapsed(true);
    wasCompactView = view.compact;
    document.getElementById('btn-page-landscape').textContent = view.manual ? '恢复自动布局' : '横向牌桌';
    document.getElementById('btn-fullscreen').textContent = view.fullscreen ? '退出全屏' : '全屏游戏';
    if (state) requestAnimationFrame(() => { renderSeats(); renderBets(); });
  },
});
mobileView.refresh();
document.getElementById('btn-page-landscape').onclick = () => { closeMenu(); mobileView.toggleLandscape(); };
document.getElementById('btn-fullscreen').onclick = () => { closeMenu(); mobileView.toggleFullscreen(); };

document.getElementById('raise-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') confirmRaise();
});
/** 弃牌防误触：第一次点击进入确认态，2.5 秒内再点一次才真正弃牌。
 *  （此前用长按方案：普通单击不足 600ms 被当作取消，按钮看起来"没用"） */
const foldBtn = document.getElementById('btn-fold');
let foldArmed = false;
let foldContext = '';
let foldDisarmTimer = null;
foldBtn.addEventListener('click', () => {
  if (foldBtn.disabled) return;
  const context = raiseContextKey(state?.players[mySeat]);
  if (!context || !roomConnectionReady || !socket.connected) return;
  if (foldArmed && foldContext !== context) resetFoldBtn();
  if (!foldArmed) {
    foldArmed = true;
    foldContext = context;
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
  foldContext = '';
  clearTimeout(foldDisarmTimer);
  foldDisarmTimer = null;
  foldBtn.classList.remove('holding');
  foldBtn.textContent = '弃牌';
}

function confirmRaise() {
  const context = raiseContextKey(state?.players[mySeat]);
  if (!raiseOpen || !context || context !== raiseContext || !roomConnectionReady || !socket.connected) {
    hideRaisePanel();
    return;
  }
  if (allInIntent) {
    const type = allInIntent.type;
    if (allInIntent.context === context) sendAction(type);
    hideRaisePanel();
    return;
  }
  const slider = document.getElementById('raise-slider');
  let v = Number(document.getElementById('raise-input').value);
  if (!Number.isSafeInteger(v) || v <= 0) return;
  // 发送前钳制到合法范围，避免超限才被服务端打回
  v = Math.max(+slider.min, Math.min(+slider.max, v));
  sendAction('raise', v);
  hideRaisePanel();
}

function sendAction(type, amount) {
  actionDelivery.send({ type, amount });
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
  chatDelivery.setReadyRoom(state?.code, mySeat >= 0 && !!state?.players[mySeat]?.connected && socket.connected);
}

const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('btn-chat-send');
const chatError = document.getElementById('chat-error');
let chatDraftVersion = 0;
chatInput.addEventListener('input', () => { chatDraftVersion++; });
const chatDelivery = createChatDelivery({
  socket,
  getRoom:() => activeRoomCode,
  getDraft:() => ({value:chatInput.value,version:chatDraftVersion}),
  clearDraft:() => {chatInput.value='';chatDraftVersion++;},
  onChange:renderChatDelivery,
});
function renderChatDelivery(delivery) {
  chatSendBtn.disabled = delivery.pending || !delivery.ready;
  chatSendBtn.textContent = delivery.pending ? '发送中…' : '发送';
  chatError.textContent = delivery.status;
  chatError.dataset.kind = delivery.kind;
  const details = document.getElementById('chat-delivery-records');
  details.classList.toggle('hidden', !delivery.records.length);
  details.querySelector('summary').textContent = `发送记录 · ${delivery.records.length}条待处理`;
  const list = details.querySelector('ul');
  list.replaceChildren();
  delivery.records.forEach(record => {
    const li=document.createElement('li'),text=document.createElement('p'),note=document.createElement('small');
    text.textContent=record.raw; note.textContent=record.message;
    li.append(text,note);
    if (record.kind !== 'pending') {
      const retry=document.createElement('button');
      retry.type='button';retry.textContent=record.kind==='unconfirmed'?'核对记录后重发':'手动重发';
      retry.disabled=delivery.pending || !delivery.ready;
      retry.onclick=()=>chatDelivery.send(record.id);
      li.appendChild(retry);
    }
    list.appendChild(li);
  });
}
chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  chatDelivery.send();
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
    `${isCurrentResult ? '' : `第 ${r.handNumber} 局 · `}${r.noWinner?'本手无赢家':r.forfeit ? '其余玩家全部弃牌' : '摊牌结算'}`;

  // 第一层：牌桌直显横幅（主池赢家 + 赢取金额 + 牌型）
  const mainPot = r.pots[0];
  const winnerNames = mainPot.winners.map((w) => escapeHtml(w.name)).join('、');
  const winnerHand = mainPot.winners[0]?.handName
    ? escapeHtml(mainPot.winners[0].handName) : '对手全部弃牌';
  const mainPotWinnerAmount = Number.isFinite(mainPot.winners[0]?.amountWon)
    ? mainPot.winners[0].amountWon : mainPot.amount;
  const potName = r.pots.length > 1 ? '主池' : '底池';
  const mainPotAmountLabel = mainPot.winners.length > 1 ? `${potName}合计分得` : `分得${potName}`;
  if (isCurrentResult) {
    winnerBanner.innerHTML = r.noWinner?'本手无赢家，投入已退回':`<b>${winnerNames}</b><span class="winner-amount">${mainPotAmountLabel} <em>+${mainPot.winners.length > 1 ? mainPot.amount : mainPotWinnerAmount}</em></span>` +
      `<span class="winner-hand">${winnerHand}${r.pots.length > 1 ? ` · 另有 ${r.pots.length - 1} 个边池分别结算` : ''}</span>`;
    winnerBanner.classList.remove('hidden');
  } else {
    winnerBanner.classList.add('hidden');
  }
  resultDetailBtn.textContent = isCurrentResult ? '查看本局详情' : `回看第 ${r.handNumber} 局`;
  resultDetailBtn.classList.remove('hidden');
  resultOverlay.classList.toggle('hidden', !resultDetailOpen); // 第二层仅在主动查看时显示
  document.getElementById('result-overview').textContent =
    `本局底池合计 ${PokerExplanations.number(r.pots.reduce((sum, pot) => sum + pot.amount, 0))} 筹码。` +
    (r.noWinner ? '本手无人有资格获胜，各人投入已退回。' : r.forfeit ? '其他玩家全部弃牌，无需亮牌即可获胜。' : r.pots.length > 1
      ? '主池、边池各自比较有资格玩家的牌力，赢家可以不同。' : '摊牌按最佳五张比较，同牌力时平分。') +
    '底池分得含本人投入，实际输赢看净盈亏。';

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
          const label = PokerExplanations.signed(delta);
          const breakdown = PokerExplanations.resultBreakdown(r, entry);
          const mine = entry.name === state.players[mySeat]?.name;
          const hasPayment = r.squidEvents?.some(event => event.type === 'payment');
          return `<div class="hand-change ${tone}${hasPayment ? ' has-payment' : ''}">
            <div class="hand-change-info"><span>${escapeHtml(entry.name)}${mine ? '（你）' : ''}</span>
              <small>${breakdown.returned === null ? '底池分配未记录' : `底池分得 ${PokerExplanations.number(breakdown.returned)}`}${hasPayment ? `<br>德州 ${PokerExplanations.signed(breakdown.pokerNet)} · 鱿鱼 ${PokerExplanations.signed(breakdown.squidNet)}` : ''}</small></div>
            <div class="hand-change-net"><small>${delta > 0 ? '净赢' : delta < 0 ? '净输' : '持平'}</small><b>${label}</b></div>
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
      if (Number.isFinite(winner.amountWon)) return `分得 ${PokerExplanations.number(winner.amountWon)} 筹码`;
      if (pot.winners.length === 1) return `分得底池 ${PokerExplanations.number(pot.amount)} 筹码`;
      return `与 ${pot.winners.length - 1} 位赢家共享底池（个人分配未记录）`;
    };
    row.innerHTML = `
      <div class="pot-label">${label} · ${PokerExplanations.number(pot.amount)} 筹码${pot.winners.length > 1 ? ' · 平分' : ''}</div>
      ${r.noWinner ? `<p class="pot-explanation">无人获胜；${(r.refunds||[]).map(e=>`${escapeHtml(e.name)} 退回 ${PokerExplanations.number(e.amount)}`).join('、')}。</p>` : ''}
      ${i > 0 ? '<p class="pot-explanation">较多投入形成的独立底池，只在有资格参与本池的玩家间结算。</p>' : ''}
      ${pot.winners.length > 1 ? '<p class="pot-explanation">下方为各人实分金额；零头筹码从庄家左侧赢家起分配。</p>' : ''}
      ${pot.winners.map((w) => `
        <div class="winners">
          <img class="winner-avatar" src="${avatarPng(w.seat)}" alt="" />
          <div class="winner-info">
            <div class="winner-name"><b>${escapeHtml(w.name)}</b> ${winnerAmountLabel(w)}</div>
            ${w.handName ? `<div class="hand-name">牌型: ${escapeHtml(w.handName)}</div>` : '<div class="hand-name">对手全部弃牌</div>'}
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
      if(state.gameOver){nextTip.textContent=state.tournament?'锦标赛已结束，可查看比赛名次。':'游戏结束！刷新页面可开新房间。';return;}
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
  } else if (state.gameOver) {
    nextTip.textContent = state.tournament?'锦标赛已结束，可查看比赛名次。':'游戏结束！刷新页面可开新房间。';
    nextBtn.classList.add('hidden');
  } else if (state.nextHandPaused) {
    nextTip.textContent = '下一局已暂停，等待房主恢复';
    nextBtn.classList.add('hidden');
  } else {
    nextTip.textContent = state.nextHandDeadline ? `${Math.max(0, Math.ceil((state.nextHandDeadline - Date.now()) / 1000))} 秒后自动开始下一局…` : '等待可参与玩家或重买后继续';
    nextBtn.classList.toggle('hidden', !state.isHost);
  }
}

let tournamentClockTimer=null, tournamentTimeOffset=0, tournamentFinishShown='';
function updateTournamentClock(){
  const t=state?.tournament,el=document.getElementById('tournament-clock');
  if(!t)return;
  if(t.status==='waiting'){el.textContent=`锦标赛 · ${t.intervalMinutes}分钟升盲 · 禁止补买`;return;}
  if(t.status==='finished'){const winner=t.members.find(m=>m.status==='champion');el.textContent=winner?`锦标赛结束 · 冠军 ${winner.name}`:'锦标赛结束 · 无冠军';return;}
  const current=`第${t.level}级 ${t.smallBlind}/${t.bigBlind}`;
  const seconds=t.nextAt?Math.max(0,Math.ceil((t.nextAt-(Date.now()+tournamentTimeOffset))/1000)):0;
  const remaining=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
  if(t.pendingLevel>t.level){el.textContent=`${current} · 下手第${t.pendingLevel}级 ${t.pendingBlinds.smallBlind}/${t.pendingBlinds.bigBlind}${t.nextAt?` · 再过${remaining}升盲`:''}`;return;}
  if(!t.nextAt){el.textContent=`${current} · 盲注已封顶`;return;}
  el.textContent=`${current} · 下档 ${t.upcoming.smallBlind}/${t.upcoming.bigBlind} · ${remaining} 后升盲，下手生效`;
}
function openTournament(){
  tournamentOverlay.classList.remove('hidden');
  document.getElementById('btn-tournament-close').focus();
}
function closeTournament(){
  if(tournamentOverlay.classList.contains('hidden'))return;
  tournamentOverlay.classList.add('hidden');
  restoreModalFocus(document.getElementById('btn-tournament-open'),[menuBtn]);
}
document.getElementById('btn-tournament-open').addEventListener('click',openTournament);
document.getElementById('btn-tournament-close').addEventListener('click',closeTournament);
tournamentOverlay.addEventListener('click',event=>{if(event.target===tournamentOverlay)closeTournament();});
function renderTournament(){
  const t=state.tournament,bar=document.getElementById('tournament-bar');
  bar.classList.toggle('hidden',!t);
  if(!t){clearInterval(tournamentClockTimer);tournamentClockTimer=null;tournamentOverlay.classList.add('hidden');return;}
  tournamentTimeOffset=t.serverNow-Date.now();
  updateTournamentClock();
  if(t.status==='running'&&!tournamentClockTimer)tournamentClockTimer=setInterval(updateTournamentClock,1000);
  if(t.status!=='running'){clearInterval(tournamentClockTimer);tournamentClockTimer=null;}
  const winner=t.members.find(m=>m.status==='champion');
  document.getElementById('tournament-result-note').textContent=t.status==='finished'?(winner?`比赛结束，冠军：${winner.name}`:'比赛结束，所有参赛者退赛，无冠军。'):'比赛中；开赛后禁止补买和新入座。暂停下一手不暂停升盲时钟。';
  const members=[...t.members].sort((a,b)=>(a.rank??0)-(b.rank??0));
  document.getElementById('tournament-rankings').innerHTML=members.length?members.map(m=>{
    const rank=m.rank?`第${m.rank}名`:'比赛中';
    const status=m.status==='champion'?'冠军':m.status==='eliminated'?'已淘汰':m.status==='withdrawn'?`退赛 · 剩余 ${PokerExplanations.number(m.withdrawnChips)} 筹码退出赛事`:'';
    return `<div class="tournament-rank"><b>${escapeHtml(m.name)}</b><span>${rank}${status?` · ${status}`:''}</span></div>`;
  }).join(''):'尚未开赛。';
  const finishKey=`${state.code}:${state.handNumber}`;
  if(t.status==='finished'&&tournamentFinishShown!==finishKey){tournamentFinishShown=finishKey;openTournament();}
}

function openSession() {
  closeMenu();
  renderSession();
  sessionOverlay.classList.remove('hidden');
  document.getElementById('btn-session-close').focus();
}
function closeSession() {
  if (sessionOverlay.classList.contains('hidden')) return;
  sessionOverlay.classList.add('hidden');
  restoreModalFocus(menuBtn);
}
document.getElementById('btn-session').addEventListener('click', openSession);
document.getElementById('btn-session-close').addEventListener('click', closeSession);
sessionOverlay.addEventListener('click', event => { if (event.target === sessionOverlay) closeSession(); });

/** 使用服务端战绩；已归档离场记录的资产为买入加盈亏，与 CSV 一致。 */
function renderSession() {
  const box = document.getElementById('session-box');
  const list = state.session || [];
  const settled = ['waiting', 'handover'].includes(state.stage);
  const names = new Map(), seen = new Map();
  list.forEach(e => names.set(e.name, (names.get(e.name) || 0) + 1));
  const totals = e => e.estate ?? (e.left ? e.buyIn + e.pl : e.chips);
  document.getElementById('session-status').textContent = settled
    ? '已结算战绩，可在局间下载。'
    : '本手尚未结算，总资产含本手已投入，盈亏待结算更新；请在局间下载战绩。';
  document.getElementById('session-list').innerHTML = list.length ? list.map(e => {
    const index = (seen.get(e.name) || 0) + 1;
    seen.set(e.name, index);
    const suffix = names.get(e.name) > 1 ? ` · 同名记录 ${index}` : '';
    const status = e.left ? (e.estate != null && !settled ? '已离场，本手待结算' : '已离场') : '在场';
    const frozen = e.frozen ? `<small class="session-frozen">含冻结 ${PokerExplanations.number(e.frozen)}</small>` : '';
    const plCls = e.pl > 0 ? 'pl-pos' : e.pl < 0 ? 'pl-neg' : '';
    return `<section class="session-entry"><div class="session-player"><b>${escapeHtml(e.name)}</b><span>${status}${suffix}</span></div>
      <dl><div><dt>买入</dt><dd>${PokerExplanations.number(e.buyIn)}</dd></div>
      <div><dt>总资产</dt><dd>${PokerExplanations.number(totals(e))}${frozen}</dd></div>
      <div><dt>净盈亏</dt><dd class="${plCls}">${PokerExplanations.signed(e.pl)}</dd></div>
      <div><dt>手数</dt><dd>${PokerExplanations.number(e.hands)}</dd></div>
      <div><dt>胜场</dt><dd>${PokerExplanations.number(e.wins)}</dd></div></dl></section>`;
  }).join('') : '<p class="session-note">暂无战绩。</p>';
  box.classList.toggle('hidden', !list.length);
  box.querySelector('tbody').innerHTML = list.map((e) => {
    const chips = `${PokerExplanations.number(totals(e))}${e.frozen ? `（冻${PokerExplanations.number(e.frozen)}）` : ''}`;
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
  if (w.voluntaryCards && w.voluntaryCards.length) return '<div class="hand-name">自愿亮牌</div><div class="win-cards">' + w.voluntaryCards.map(e => `<span>${e.index === 0 ? '左' : '右'}张${miniCardsHtml([e.card], [])}</span>`).join('') + '</div>';
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
  btn.classList.toggle('hidden', !state.isHost || state.tournament?.status==='finished');
  btn.textContent = paused ? '恢复下一局' : '暂停下一局';
  btn.setAttribute('aria-pressed', String(paused));
  document.getElementById('next-hand-status').textContent = state.tournament?.status==='finished'?'锦标赛已结束':isForfeitIntermission() ? forfeitStatus() : (paused ? `下一局已暂停，当前手照常进行${state.tournament?'；升盲时钟继续':''}` : '');
  const settled = ['waiting', 'handover'].includes(state.stage);
  document.getElementById('btn-export-session').disabled = !settled;
  document.getElementById('btn-session-export').disabled = !settled;
  document.getElementById('export-session-tip').textContent = settled
    ? '导出已结算战绩，包含已离场记录；离场筹码按离场时记录。'
    : '本手尚未结算，请在局间下载战绩。';
}
document.getElementById('btn-pause-next').onclick = () => {
  socket.emit('set_next_hand_paused', { paused: !state.nextHandPaused }, res => {
    if (!res || !res.ok) alert((res && res.err) || '操作失败');
  });
};
function exportSession() {
  socket.emit('export_session', null, res => {
    if (!res || !res.ok) return alert((res && res.err) || '导出失败');
    const url = URL.createObjectURL(new Blob([res.csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = res.filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}
document.getElementById('btn-export-session').onclick = exportSession;
document.getElementById('btn-session-export').onclick = exportSession;

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

function renderWinnerShowControls() {
  const box = document.getElementById('winner-show-controls');
  const winner = state.results && state.results.forfeit && state.results.pots[0].winners[0];
  const allowed = state.stage === 'handover' && winner && winner.seat === mySeat;
  box.classList.toggle('hidden', !allowed);
  if (!allowed) { box.innerHTML = ''; return; }
  const shown = (winner.voluntaryCards || []).map(e => e.index);
  box.innerHTML = '<span>自愿亮牌</span>' + [[0,'左张'],[1,'右张'],[2,'两张']].map(([i,label]) => `<button type="button" class="btn btn-ghost btn-small" data-show-index="${i}" data-show-hand="${state.handNumber}" ${i === 2 ? (shown.length === 2 ? 'disabled' : '') : (shown.includes(i) ? 'disabled' : '')}>${label}${shown.includes(i) ? '已亮' : ''}</button>`).join('');
}
document.getElementById('winner-show-controls').onclick = e => {
  const b = e.target.closest('[data-show-index]');
  if (!b) return;
  const i = Number(b.dataset.showIndex);
  socket.emit('show_winner_cards', {handNumber:Number(b.dataset.showHand), indices:i === 2 ? [0,1] : [i]}, r => { if (!r.ok) flashTip(r.err); });
};

function isForfeitIntermission() { return state && state.stage === 'handover' && state.results && state.results.forfeit; }
function forfeitStatus() {
  if(state.tournament?.status==='finished')return '锦标赛已结束';
  if (state.nextHandPaused) return '下一局已暂停';
  if (state.nextHandDeadline) return `下一局 ${Math.max(0, Math.ceil((state.nextHandDeadline-Date.now())/1000))} 秒`;
  return '等待玩家就绪';
}
// 动画去重只用内存；首次当前手快照作为基线，刷新/重连不重播已亮牌。
const revealSeen = new Set();
const revealHands = new Set();
function renderForfeitShowcase() {
  const active = isForfeitIntermission();
  document.getElementById('table').classList.toggle('forfeit-intermission', !!active);
  document.getElementById('play-stage').classList.toggle('forfeit-summary', !!active);
  const panel = document.getElementById('forfeit-showcase');
  panel.classList.toggle('hidden', !active);
  if (!active) { panel.innerHTML=''; delete panel.dataset.key; return; }
  const winner = state.results.pots[0].winners[0];
  const shown = winner.voluntaryCards || [];
  const handKey = `${state.code}:${state.handNumber}`;
  const firstSnapshot = !revealHands.has(handKey);
  revealHands.add(handKey);
  const key = handKey + JSON.stringify(shown);
  if (panel.dataset.key === key) return;
  panel.dataset.key=key;
  const amount = Number.isFinite(winner.amountWon) ? winner.amountWon : state.results.pots[0].amount;
  panel.innerHTML=`<div class="showcase-owner"><img src="${avatarPng(winner.seat)}" alt="" /><b>${escapeHtml(winner.name)}</b><span>分得 ${amount}</span></div><div class="showcase-cards"></div>`;
  const slots=panel.querySelector('.showcase-cards');
  for (let index=0;index<2;index++) {
    const entry=shown.find(e=>e.index===index);
    const slot=document.createElement('div');slot.className='showcase-slot';slot.setAttribute('aria-label',`${index===0?'左':'右'}张${entry?'已公开':'未公开'}`);
    if(entry) {
      slot.appendChild(cardEl(entry.card,false));
      const seenKey=handKey+':'+index;
      if(!firstSnapshot && !revealSeen.has(seenKey)) slot.classList.add('reveal-flip');
      revealSeen.add(seenKey);
    } else {
      const back=document.createElement('img');back.src='assets/a1/card-back.png';back.alt='未公开';back.className='showcase-back';slot.appendChild(back);
    }
    slots.appendChild(slot);
  }

}
setInterval(()=>{if(isForfeitIntermission()) document.getElementById('next-hand-status').textContent=forfeitStatus();},1000);


// 鱿鱼仅使用服务器公开的标记与资产，不读取或推测底牌。
let squidSeenRoom='', squidSeenSeq=null;
const squidGlow=new Map();
function updateSquidMarks(){
  const s=state.squid;if(!s)return;
  if(squidSeenRoom!==state.code){squidSeenRoom=state.code;squidSeenSeq=null;squidGlow.clear();}
  const history=s.history||[],seq=history.at(-1)?.seq||0;
  if(squidSeenSeq!==null)for(const e of history)if(e.seq>squidSeenSeq&&e.type==='mark')squidGlow.set(e.name,Date.now());
  squidSeenSeq=seq;
}
function squidMarkHtml(p){
  const s=state.squid;if(!s?.enabled)return '';
  let marked=s.current?.members.some(m=>m.name===p.name&&m.marked);
  if(!s.current&&state.stage==='handover'&&state.results?.squidEvents?.some(e=>e.type==='payment'&&e.round===s.round))
    marked=(s.history||[]).some(e=>e.round===s.round&&e.type==='mark'&&e.name===p.name);
  if(!marked)return '';
  const elapsed=Date.now()-(squidGlow.get(p.name)||0),glow=elapsed<650;
  return `<span class="squid-mark${glow?' squid-glow':''}" ${glow?`style="animation-delay:-${elapsed}ms"`:''} title="本轮已得鱿鱼标记" aria-label="本轮已得鱿鱼标记">◆</span>`;
}
function squidEventText(e){
  if(e.type==='round')return `第${e.round}轮开始：${e.names.join('、')}；末位需向其余每人支付 ${PokerExplanations.number(e.payment??e.bb)} 筹码，开轮每人先冻结 ${PokerExplanations.number((e.names.length-1)*(e.payment??e.bb))}。冻结仍属本人资产。`;
  if(e.type==='mark')return `${e.name} 主池独赢，获得标记，本轮冻结筹码退回可用余额。解冻不是额外获利。`;
  if(e.type==='payment')return `${e.from} 为本轮末位，从冻结筹码支付 ${PokerExplanations.number(e.total)}；${e.to.join('、')}各收 ${PokerExplanations.number(e.payment??e.bb)}（${e.to.length} 人 × ${PokerExplanations.number(e.payment??e.bb)}）。`;
  return `第${e.round}轮取消并解冻：${e.reason}`;
}
function renderSquid(){
  const s=state.squid||{enabled:false},safe=['waiting','handover'].includes(state.stage);
  const progress=document.getElementById('squid-progress');
  progress.classList.toggle('hidden',!s.enabled);
  progress.textContent=s.current?`鱿鱼第${s.current.round}轮 · 已发${s.current.members.filter(m=>m.marked).length}/${s.current.members.length-1}`:`鱿鱼 · ${s.round?`第${s.round}轮已结束`:'等待开轮'}`;
  const controls=document.getElementById('squid-controls');
  controls.classList.toggle('hidden',!s.enabled||!state.isHost||!safe);
  document.getElementById('btn-squid-cancel').classList.toggle('hidden',!s.current);
  const roomPayment=document.getElementById('room-payment');
  if(roomPayment.dataset.saved!==String(s.payment)){
    if(document.activeElement!==roomPayment)roomPayment.value=s.payment;
    roomPayment.dataset.saved=String(s.payment);
  }
  document.getElementById('squid-current-setting').textContent=s.current?`本轮向每人支付${s.current.payment}；下轮向每人支付${s.payment}。保存只改变下轮，本轮冻结和标记不变。`:`下轮向每人支付${s.payment}筹码。`;
  document.querySelector('#room-setup summary').textContent=state.mode==='squid'?'鱿鱼德州 · 房间设置':state.tournament?'单桌锦标赛 · 房间设置':'经典德州 · 房间设置';
  document.getElementById('room-mode-info').textContent=state.mode==='squid'?'普通52张德州＋经典鱿鱼，3–6人。主池独赢得标记；一轮最多发人数−1个，最后未得标记者支付。玩法固定。':state.tournament?'单桌锦标赛，禁止补买和开赛后新入座。暂停下一手时升盲时钟继续；服务器重启不保留赛事。':'普通52张德州扑克，2–6人。玩法固定。';
  const c=cfg();
  document.getElementById('room-settings-info').textContent=`起始${c.startChips} · 盲注${c.smallBlind}/${c.bigBlind} · 行动${c.actionTime}秒 · 局间${c.nextHandDelay}秒 · ${c.rebuyAllowed===false?'禁止':'允许'}重买`;
  const preview=document.getElementById('room-payment-preview'),n=state.players.filter(p=>p.connected&&!p.sittingOut&&!p.left).length;
  preview.classList.toggle('hidden',!s.enabled);
  preview.textContent=s.current?`本轮${s.current.members.length}人，向每人支付${s.current.payment}，每人初始冻结${(s.current.members.length-1)*s.current.payment}；下轮向每人支付${s.payment}。新玩家下轮参加。`:n<3?`当前有效${n}人，不足3人，等待开轮。向每人支付${s.payment}。`:`当前有效${n}人：下轮末位总付${(n-1)*s.payment}，每人开轮冻结${(n-1)*s.payment}。实际以开轮人数为准。`;
  const events=state.stage==='handover'?(state.results?.squidEvents||[]):[];
  const payment=events.findLast(e=>e.type==='payment');
  const last=(s.history||[]).at(-1);
  const summary=document.getElementById('squid-summary');
  summary.textContent=s.waitingReason||(payment?`鱿鱼：${payment.from} 付${payment.total} · 其余${payment.to.length}人各收${payment.payment??payment.bb}`:(safe&&last?.type==='cancel'?squidEventText(last):''));
  summary.classList.toggle('hidden',!summary.textContent);
  const r=state.stage==='handover'?state.results:state.lastResult;
  const detail=document.getElementById('squid-result'),detailEvents=r?.squidEvents||[];
  detail.classList.toggle('hidden',!detailEvents.length);
  detail.innerHTML=detailEvents.length?`<h3>鱿鱼记录</h3>${detailEvents.map(e=>`<p>${escapeHtml(squidEventText(e))}</p>`).join('')}<p>本局净盈亏已含鱿鱼收付；底池分得金额仅为德州结算。冻结、解冻不计盈亏。</p>`:'';
}
document.getElementById('btn-squid-payment-save').onclick=()=>socket.emit('set_squid_payment',{payment:Number(document.getElementById('room-payment').value)},r=>{if(!r?.ok)flashTip(r?.err||'保存失败');else flashTip('已保存，仅下一轮生效');});
document.getElementById('btn-squid-cancel').onclick=()=>socket.emit('cancel_squid_round',null,r=>{if(!r?.ok)flashTip(r?.err||'操作失败');});
