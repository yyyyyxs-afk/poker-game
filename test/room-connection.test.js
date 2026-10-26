const assert = require('node:assert/strict');
const { createRoomRecovery, createActionDelivery } = require('../public/room-connection');

function setup() {
  const requests = [], tasks = new Map(), changes = [], restored = [];
  let target = { code: 'ABC123', name: '朋友', token: 'local-test-credential' }, connects = 0, nextId = 0;
  const socket = {
    connected: true,
    connect() { connects++; },
    timeout(ms) { this.waitMs = ms; return this; },
    get volatile() { this.lossy = true; return this; },
    emit(event, payload, callback) {
      requests.push({ event, payload, callback, waitMs: this.waitMs, volatile: this.lossy });
      this.lossy = false;
    },
  };
  const recovery = createRoomRecovery({ socket, getTarget: () => target,
    onChange: (...args) => changes.push(args), onRestored: room => restored.push(room),
    schedule: (fn, ms) => { const id = ++nextId; tasks.set(id, { fn, ms }); return id; },
    unschedule: id => tasks.delete(id),
  });
  function tick() {
    const [id, task] = tasks.entries().next().value || [];
    assert.ok(task, '应有待执行的计时任务');
    tasks.delete(id); task.fn(); return task.ms;
  }
  return { socket, recovery, requests, tasks, changes, restored, tick,
    setTarget(value) { target = value; }, get connects() { return connects; } };
}
const validState = { code: 'ABC123', youSeat: 1, players: [{ name: '房主' }, { name: '朋友' }] };

{
  const f = setup(); f.recovery.start();
  assert.equal(f.requests[0].event, 'join_room');
  assert.equal(f.requests[0].volatile, undefined);
  assert.equal(f.requests[0].waitMs, 8000);
  // 真实服务端广播先于回执：即使回执丢失，已有本人状态也应恢复。
  assert.equal(f.recovery.acceptState(validState), true);
  assert.equal(f.restored.length, 1); assert.equal(f.tasks.size, 0);
  f.requests[0].callback(new Error('late timeout'));
  assert.equal(f.tasks.size, 0); assert.equal(f.restored.length, 1);
}
{
  const f = setup(); f.recovery.start();
  f.requests[0].callback(null, { ok: true });
  assert.equal(f.restored.length, 0, '仅成功回执不能解除旧牌局遮罩');
  for (let i = 0; i < 3; i++) {
    assert.equal(f.tick(), 8000);
    if (i < 2) assert.equal(f.tick(), 1500);
  }
  assert.equal(f.requests.length, 3); assert.equal(f.tasks.size, 0);
  assert.equal(f.changes.at(-1)[0], 'failed', '丢回执/丢状态最终给出手动入口，不能永久等待');
  f.recovery.start(); assert.equal(f.requests.length, 4);
  assert.equal(f.recovery.acceptState(validState), true);
}
{
  const f = setup(); f.recovery.start(); const old = f.requests[0];
  f.recovery.cancel(); f.socket.connected = false;
  old.callback(null, { ok: false, err: '迟到旧错误' });
  assert.equal(f.tasks.size, 0);
  assert.equal(f.recovery.acceptState(validState), false);
  f.recovery.start(); assert.equal(f.connects, 1); assert.equal(f.requests.length, 1, '离线重连不能排队 join');
  f.socket.connected = true; f.recovery.start();
  old.callback(new Error('timeout'));
  assert.equal(f.requests.length, 2); assert.equal(f.tasks.size, 1);
  assert.equal(f.recovery.acceptState({ ...validState, code: 'OTHER1' }), false);
  assert.equal(f.recovery.acceptState({ ...validState, youSeat: -1 }), false);
  assert.equal(f.recovery.acceptState({ ...validState, youSeat: 0 }), false);
  assert.equal(f.recovery.acceptState(validState), true);
}
{
  const f = setup(); f.recovery.start();
  f.requests[0].callback(new Error('timeout'));
  assert.equal(f.tasks.size, 1);
  f.requests[0].callback(new Error('duplicate timeout'));
  assert.equal(f.tasks.size, 1);
  // 用户退出或换房后，旧重试不能把页面带回原房。
  f.setTarget(null); f.tick(); assert.equal(f.tasks.size, 0); assert.equal(f.requests.length, 1);
  assert.equal(f.recovery.start(), false);
  f.setTarget({ code: 'ABC123', name: '朋友' });
  f.recovery.start(); assert.equal(f.requests.length, 1, '丢失凭证不能以新访客身份冒充恢复');
  assert.equal(f.changes.at(-1)[0], 'failed');
}
{
  const f = setup(); f.recovery.start();
  f.requests[0].callback(null, { ok: false, err: '房间不存在或已关闭' });
  f.tick(); f.requests[1].callback(null, { ok: false, err: '房间不存在或已关闭' });
  f.tick(); f.requests[2].callback(null, { ok: false, err: '房间不存在或已关闭' });
  assert.equal(f.changes.at(-1)[0], 'failed');
  assert.match(f.changes.at(-1)[1], /房间不存在/);
  assert.equal(f.tasks.size, 0);
}
{
  const f = setup(), waiting = [], errors = []; let ready = true, successes = 0;
  const delivery = createActionDelivery({ socket: f.socket, isReady: () => ready,
    onWaiting: value => waiting.push(value), onError: error => errors.push(error), onSuccess: () => successes++ });
  const action = { type: 'call' };
  f.socket.connected = false; assert.equal(delivery.send(action), false);
  f.socket.connected = true; ready = false; assert.equal(delivery.send(action), false);
  assert.equal(f.requests.length, 0, '断网或仅传输恢复但未回座时，下注不排队');
  ready = true; assert.equal(delivery.send(action), true); assert.equal(delivery.send(action), false);
  assert.equal(f.requests[0].volatile, true); assert.equal(f.requests[0].waitMs, 8000);
  f.requests[0].callback(new Error('timeout'));
  assert.match(errors.at(-1), /未确认.*不会自动重发/);
  assert.equal(f.requests.length, 1); assert.deepEqual(waiting, [true, false]);
  delivery.send({ type: 'check' });
  f.requests[0].callback(null, { ok: true });
  assert.equal(waiting.at(-1), true, '旧回执不能解除新操作等待态'); assert.equal(successes, 0);
  f.requests[1].callback(null, { ok: true }); assert.equal(successes, 1);
  delivery.send(action); delivery.cancel(); delivery.send(action);
  f.requests[2].callback(null, { ok: false, err: '迟到旧失败' });
  assert.equal(waiting.at(-1), true); assert.doesNotMatch(errors.at(-1), /迟到/);
  f.requests[3].callback(null, { ok: false, err: '尚未轮到你' }); assert.equal(errors.at(-1), '尚未轮到你');
}
console.log('房间连接检查通过：有限恢复、回执/状态丢失、反复断线、身份匹配、退出取消、行动防排队和旧回执隔离');
