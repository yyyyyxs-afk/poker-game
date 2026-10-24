// 仅负责聊天发送回执；不改变聊天协议、牌局行动或重连身份。
function createChatDelivery({socket, getRoom, getDraft, clearDraft, onChange, waitMs = 8000}) {
  let joinedRoom = '', pending = null, sequence = 0, disconnected = false;
  let status = '', kind = 'neutral';
  const records = [];
  const normalized = text => text.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const ready = () => !!getRoom() && socket.connected && joinedRoom === getRoom();
  const snapshot = () => ({ready:ready(), pending:!!pending, status, kind,
    records:records.filter(r=>r.room===getRoom()).map(r=>({...r}))});
  const notify = () => onChange(snapshot());
  function finish(attempt, result, message) {
    if (pending !== attempt) return; // 超时、断线或后续请求已取代的旧回执不能改 UI。
    pending = null;
    const record = attempt.record;
    if (result === 'confirmed') {
      records.splice(records.indexOf(record), 1);
      const draft = getDraft();
      if (getRoom() === attempt.room && draft.value === attempt.raw && draft.version === attempt.version) clearDraft();
      status = '已确认发送'; kind = 'confirmed';
    } else {
      record.kind = result;
      record.message = message;
      status = message; kind = result === 'rejected' ? 'error' : 'neutral';
    }
    notify();
  }
  function send(retryId) {
    if (pending) return false;
    if (!ready()) { status='连接尚未恢复，未发送；草稿已保留。'; kind='neutral'; notify(); return false; }
    const draft = getDraft();
    const previous = retryId == null ? null : records.find(r=>r.id===retryId && r.room===getRoom() && r.kind!=='pending');
    if (retryId != null && !previous) return false;
    const raw = previous ? previous.raw : draft.value;
    const text = raw.trim();
    if (!text) return false;
    if (!previous && records.some(r=>r.room===getRoom() && r.kind==='unconfirmed' && normalized(r.raw)===normalized(raw))) {
      status='这条消息尚未确认，请先核对聊天记录，再在发送记录中手动重发。'; kind='neutral'; notify(); return false;
    }
    const record = previous || {id:++sequence, room:getRoom(), raw};
    if (!previous) records.push(record);
    record.kind='pending'; record.message='等待回执';
    const attempt = {record, room:getRoom(), raw, version:draft.value===raw ? draft.version : null};
    pending=attempt; status='发送中，等待回执…'; kind='neutral'; notify();
    // 连接不可写时丢弃，不进入 Socket.IO 离线队列；超时会清理回调，不自动重发。
    try {
      socket.timeout(waitMs).volatile.emit('chat_message', {text}, (error, response) => {
        if (pending !== attempt) return;
        if (error) finish(attempt,'unconfirmed','送达状态未确认；请先核对聊天记录，再决定是否重发。');
        else if (response?.ok === true) finish(attempt,'confirmed');
        else if (response?.ok === false) finish(attempt,'rejected',`未发送：${response.err || '服务端拒绝了消息'}`);
        else finish(attempt,'unconfirmed','回执无效，送达状态未确认；请先核对聊天记录。');
      });
    } catch (_) {
      finish(attempt,'unconfirmed','送达状态未确认；请先核对聊天记录，再决定是否重发。');
    }
    return true;
  }
  socket.on('disconnect', () => {
    joinedRoom=''; disconnected=true;
    if (pending) finish(pending,'unconfirmed','连接中断，送达状态未确认；恢复后请先核对聊天记录。');
    else {status='连接中断，草稿已保留；恢复后可查看聊天记录。';kind='neutral';notify();}
  });
  return {
    send, snapshot,
    setReadyRoom(room, joined) {
      joinedRoom = joined ? room : '';
      if (disconnected && ready()) {
        disconnected=false;status='连接已恢复；请核对聊天记录，未确认消息不会自动重发。';kind='neutral';
      }
      if (pending && pending.room !== getRoom()) finish(pending,'unconfirmed','已切换房间，原消息送达状态未确认。');
      else notify();
    },
    refresh() {
      if (pending && pending.room !== getRoom()) finish(pending,'unconfirmed','已切换房间，原消息送达状态未确认。');
      else notify();
    },
  };
}
if (typeof module !== 'undefined') module.exports = {createChatDelivery};
