const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const PokerExplanations = require('../public/poker-explanations');
const source = fs.readFileSync(require.resolve('../public/client.js'), 'utf8');

const me = { name: '本人', chips: 1993, roundBet: 10, frozen: 150 };
assert.deepEqual(PokerExplanations.actionAmounts({ currentBet: 20 }, me, 333),
  { call: 10, afterCall: 1983, max: 2003, total: 333, extra: 323, remaining: 1670, frozen: 150 });
assert.equal(PokerExplanations.actionAmounts({ currentBet: 3000 }, me, 2003).call, 1993);
assert.equal(PokerExplanations.actionAmounts({ currentBet: 0 }, me, 3000).remaining, 0);
assert.equal(PokerExplanations.actionAmounts({ currentBet: 0 }, me).call, 0);

const result = {
  pots: [{ amount: 1500, winners: [{ name: '甲', amountWon: 1500 }] },
    { amount: 1000, winners: [{ name: '乙', amountWon: 1000 }] }],
  squidEvents: [{ type: 'round', payment: 50 }, { type: 'mark', name: '甲' },
    { type: 'payment', from: '丙', to: ['甲', '乙'], payment: 50, total: 100 }],
};
assert.deepEqual(PokerExplanations.resultBreakdown(result, { name: '甲', delta: 1050 }),
  { returned: 1500, pokerNet: 1000, squidNet: 50 });
assert.deepEqual(PokerExplanations.resultBreakdown(result, { name: '乙', delta: 50 }),
  { returned: 1000, pokerNet: 0, squidNet: 50 });
assert.deepEqual(PokerExplanations.resultBreakdown(result, { name: '丙', delta: -1100 }),
  { returned: 0, pokerNet: -1000, squidNet: -100 });
const split = { pots: [{ amount: 101, winners: [{ name: '甲', amountWon: 51 }, { name: '乙', amountWon: 50 }] }] };
assert.equal(PokerExplanations.resultBreakdown(split, { name: '甲', delta: 1 }).returned, 51);
assert.equal(PokerExplanations.resultBreakdown(split, { name: '乙', delta: 0 }).returned, 50);
assert.equal(PokerExplanations.resultBreakdown({ pots: [{ winners: [{ name: '甲' }] }] }, { name: '甲', delta: 1 }).returned, null);
assert.deepEqual(PokerExplanations.resultBreakdown({ squidEvents: [{ type: 'mark', name: '甲' }] }, { name: '甲', delta: 0 }),
  { returned: 0, pokerNet: 0, squidNet: 0 }, '解冻不是鱿鱼净收益');

// 执行生产函数本身，检查危险操作的发送时点、失效上下文及精确金额。
const elements = new Map(), sent = [];
function element(id) {
  if (!elements.has(id)) {
    const classes = new Set();
    elements.set(id, { value: '', style: {}, disabled: false, textContent: '', innerHTML: '',
      firstChild: { nodeType: 3, textContent: '' }, focus() {}, setAttribute() {},
      listeners: {}, addEventListener(event, callback) { this.listeners[event] = callback; },
      classList: { add: value => classes.add(value), remove: value => classes.delete(value),
        contains: value => classes.has(value), toggle(value, yes) { if (yes) classes.add(value); else classes.delete(value); } } });
  }
  return elements.get(id);
}
const context = { PokerExplanations, state: { code: 'ABC123', handNumber: 1, stage: 'preflop', turnSeat: 0,
  currentBet: 20, bigBlind: 20, minRaise: 20, pot: 30, players: [{ ...me }] }, mySeat: 0,
  roomConnectionReady: true, socket: { connected: true }, raiseOpen: false, raiseContext: '', allInIntent: null,
  Node: { TEXT_NODE: 3 }, cfg: () => ({ bigBlind: 20 }), resetFoldBtn() {},
  document: { getElementById: element, querySelectorAll: () => [] }, sendAction: (...args) => sent.push(args) };
const names = ['updateActionBar', 'renderRaiseExplanation', 'openAllInConfirmation', 'onRaiseToggleClick',
  'hideRaisePanel', 'cancelRaisePanel', 'raiseContextKey', 'confirmRaise'];
const functions = names.map(name => {
  const match = source.match(new RegExp(`function ${name}\\([^]*?\\n}`));
  assert.ok(match, `未找到生产函数 ${name}`); return match[0];
}).join('\n');
vm.createContext(context); vm.runInContext(functions, context);
const presets = ['third', 'half', 'twothird', 'pot', 'allin'].map(name => Object.assign(element(`preset-${name}`), { dataset: { preset: name } }));
context.document.querySelectorAll = () => presets;
context.updateActionBar(context.state.players[0]);
assert.equal(presets[0].textContent, '2倍 40');
assert.equal(presets[1].textContent, '2.5倍 50');
assert.equal(presets[2].textContent, '3倍 60');
assert.equal(presets[3].hidden, true);
context.onRaiseToggleClick(); presets[1].onclick();
assert.equal(Number(element('raise-input').value), 50);
assert.equal(element('raise-confirm-value').textContent, '50');
assert.equal(sent.length, 0, '快捷按钮只填金额');
context.updateActionBar(context.state.players[0]);
assert.equal(Number(element('raise-input').value), 50, '重复广播保留已选金额');
context.confirmRaise(); assert.deepEqual(sent.pop(), ['raise', 50]);
context.state.bigBlind = 21; context.state.currentBet = 21; context.state.minRaise = 21;
context.updateActionBar(context.state.players[0]);
assert.equal(presets[1].textContent, '2.5倍 53', '奇数大盲向上取整');
context.state.minRaise = 30; context.updateActionBar(context.state.players[0]);
assert.match(presets[0].textContent, /51最低/);
context.onRaiseToggleClick(); presets[0].onclick();
assert.match(element('raise-explanation').textContent, /提高到最小加注/);
context.hideRaisePanel();
context.state.minRaise = 21; context.state.players[0].chips = 35;
context.updateActionBar(context.state.players[0]); context.onRaiseToggleClick(); presets[2].onclick();
assert.match(presets[2].textContent, /45全押/);
assert.match(element('raise-explanation').textContent, /筹码上限调整为全押/);
assert.equal(element('raise-confirm-value').textContent, '35');
assert.equal(sent.length, 0); context.confirmRaise(); assert.deepEqual(sent.pop(), ['raise', 45]);
context.state.players[0] = { ...me, raiseAllowed: false }; context.updateActionBar(context.state.players[0]);
assert.equal(element('btn-toggle-raise').disabled, true, '加注权未重开时不能打开面板');
context.state.players[0] = { ...me }; context.state.bigBlind = 20; context.state.currentBet = 40; context.state.minRaise = 20;
context.updateActionBar(context.state.players[0]);
assert.equal(presets[0].textContent, '1/3池'); assert.equal(presets[3].hidden, false);
context.state.stage = 'flop'; context.state.currentBet = 20; context.updateActionBar(context.state.players[0]);
assert.equal(presets[1].textContent, '1/2池');
context.state.stage = 'preflop'; context.state.currentBet = 20;
context.updateActionBar(context.state.players[0]);
element('btn-allin').onclick();
assert.equal(sent.length, 0, '点全押入口只能打开确认，不能直接发送');
assert.equal(element('raise-input').value, 2003);
assert.equal(element('raise-confirm-value').textContent, '1,993');
assert.match(element('raise-explanation').textContent, /已投 10；再投入 1,993.*余 0.*冻结 150/);
context.confirmRaise(); assert.deepEqual(sent.pop(), ['allin']);
context.openAllInConfirmation('allin'); context.cancelRaisePanel(); context.confirmRaise();
assert.equal(sent.length, 0, '取消后旧确认不能发送');
context.onRaiseToggleClick();
assert.equal(Number(element('raise-input').value), 40, '取消全押后普通加注不能继承全押金额');
context.hideRaisePanel();
context.openAllInConfirmation('allin'); context.state.currentBet = 60; context.confirmRaise();
assert.equal(sent.length, 0, '下注条件变化后旧确认不能发送');
context.state.currentBet = 20; context.state.players[0].chips = 5; context.state.players[0].raiseAllowed = false;
context.updateActionBar(context.state.players[0]); element('btn-check-call').onclick();
assert.equal(sent.length, 0); assert.equal(element('raise-confirm-value').textContent, '5');
context.confirmRaise(); assert.deepEqual(sent.pop(), ['call'], '不足额全押跟注保留 call 语义和加注权限制');
context.state.players[0] = { ...me }; context.updateActionBar(context.state.players[0]);
context.onRaiseToggleClick(); element('raise-input').value = '333.5'; element('raise-input').oninput();
assert.equal(element('btn-raise-confirm').disabled, true);
element('raise-input').onblur(); context.confirmRaise();
assert.equal(sent.length, 0, '小数筹码不能悄悄截断后发送');
element('raise-input').value = ''; element('raise-input').oninput();
assert.equal(element('btn-raise-confirm').disabled, true);
context.hideRaisePanel(); context.updateActionBar(context.state.players[0]);
context.onRaiseToggleClick(); element('raise-input').value = 333; element('raise-input').oninput();
assert.equal(element('raise-slider').step, 1);
assert.equal(element('raise-confirm-value').textContent, '333');
assert.match(element('raise-explanation').textContent, /再投入 323.*余 1,670/);
context.confirmRaise(); assert.deepEqual(sent.pop(), ['raise', 333]);
context.openAllInConfirmation('allin'); context.socket.connected = false; context.confirmRaise();
assert.equal(sent.length, 0, '掉线时不能发送旧全押确认');

// 同一行动中的聊天等状态广播不能打断两次点击弃牌；换局/换金额则必须重新确认。
context.socket.connected = true; context.raiseOpen = false; context.allInIntent = null;
let disarm;
Object.assign(context, { setTimeout: callback => { disarm = callback; return 1; }, clearTimeout() {},
  renderHeroSeat() {}, lastTurnKey: '', sfx: { turn() {} }, navigator: {}, startTurnTimer() {}, stopTurnTimer() {} });
const foldStart = source.indexOf("const foldBtn = document.getElementById('btn-fold');");
vm.runInContext(source.slice(foldStart, source.indexOf('function confirmRaise()', foldStart)), context);
vm.runInContext(source.match(/function renderMyArea\([^]*?\n}/)[0], context);
element('btn-fold').listeners.click(); context.renderMyArea();
assert.equal(vm.runInContext('foldArmed', context), true, '相同行动状态广播不能取消弃牌确认');
element('btn-fold').listeners.click(); assert.deepEqual(sent.pop(), ['fold']);
element('btn-fold').listeners.click(); context.state.currentBet += 20; context.renderMyArea();
assert.equal(vm.runInContext('foldArmed', context), false, '行动条件变化必须取消旧弃牌确认');
element('btn-fold').listeners.click(); disarm();
assert.equal(vm.runInContext('foldArmed', context), false, '弃牌确认到时失效');
console.log('行动与结算检查通过：新增投入/合计、非整盲金额、全押确认/取消/过期/离线、边池分得、净盈亏和鱿鱼收付分解');
