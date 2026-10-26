// 房间恢复必须同时拿到当前身份的状态；仅连接成功或 join 回执不足以恢复操作。
function createRoomRecovery({ socket, getTarget, onChange, onRestored, waitMs = 8000,
  retryMs = 1500, maxAttempts = 3, schedule = setTimeout, unschedule = clearTimeout }) {
  let pending = null;
  const sameTarget = target => {
    const current = getTarget();
    return current && current.code === target.code && current.name === target.name && current.token === target.token;
  };
  function cancel() {
    if (!pending) return;
    unschedule(pending.timer);
    pending = null;
  }
  function attempt(target, number) {
    if (!socket.connected || !sameTarget(target)) return cancel();
    const request = { target, number, timer: null, failed: false };
    pending = request;
    onChange('restoring', `${target.code} · ${target.name}`);
    const failed = message => {
      if (pending !== request || request.failed) return;
      request.failed = true;
      unschedule(request.timer);
      if (!socket.connected || !sameTarget(target)) return cancel();
      if (number >= maxAttempts) {
        pending = null;
        onChange('failed', message || '暂未收到牌局状态，请手动重试；不会代你下注。');
        return;
      }
      // 只重试同一个带凭证的座位恢复，不重放下注、建房等操作。
      request.timer = schedule(() => {
        if (pending === request) attempt(target, number + 1);
      }, retryMs);
    };
    request.timer = schedule(() => failed(), waitMs);
    try {
      // 上方已同步检查 connected；允许当前连接暂时繁忙时发送，避免握手刚完成就丢恢复请求。
      socket.timeout(waitMs).emit('join_room', target, (error, response) => {
        if (pending !== request) return;
        if (error || response?.ok !== true) failed(response?.err);
        // 成功回执仍等 state；state 通常先于回执到达，也可能回执丢失。
      });
    } catch (_) { failed(); }
  }
  return {
    cancel,
    start() {
      cancel();
      const target = getTarget();
      if (!target) return false;
      if (!socket.connected) {
        onChange('offline', '尚未连上服务器，连接恢复后会自动恢复座位。');
        socket.connect();
        return false;
      }
      if (!target.token) {
        onChange('failed', '本机缺少原座位凭证，请返回大厅核对；不会冒用原座位。');
        return false;
      }
      attempt(target, 1);
      return true;
    },
    acceptState(state) {
      const request = pending;
      if (!request || !socket.connected || !sameTarget(request.target)) return false;
      if (state?.code !== request.target.code || !Number.isInteger(state.youSeat) || state.youSeat < 0
        || state.players?.[state.youSeat]?.name !== request.target.name) return false;
      cancel();
      onRestored(request.target);
      return true;
    },
  };
}

// 行动不能在离线时排队；一次只等待一个请求，旧回执不能解除新请求的等待态。
function createActionDelivery({ socket, isReady, onWaiting, onError, onSuccess, waitMs = 8000 }) {
  let pending = null;
  function cancel() {
    if (!pending) return;
    pending = null;
    onWaiting(false);
  }
  return {
    cancel,
    send(payload) {
      if (pending) return false;
      if (!socket.connected || !isReady()) {
        onError('牌局连接尚未恢复，本次操作未发送。');
        return false;
      }
      const request = {};
      pending = request;
      onWaiting(true);
      try {
        socket.timeout(waitMs).volatile.emit('action', payload, (error, response) => {
          if (pending !== request) return;
          cancel();
          if (error || typeof response?.ok !== 'boolean') {
            onError('操作结果未确认，请核对最新牌局后再操作；不会自动重发。');
          } else if (response.ok) onSuccess();
          else onError(response.err || '当前不能执行此操作。');
        });
      } catch (_) {
        if (pending === request) {
          cancel();
          onError('操作结果未确认，请核对最新牌局后再操作；不会自动重发。');
        }
      }
      return true;
    },
  };
}
if (typeof module !== 'undefined') module.exports = { createRoomRecovery, createActionDelivery };
