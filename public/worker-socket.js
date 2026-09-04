(function () {
  window.createWorkerSocket = function createWorkerSocket() {
    const handlers = new Map();
    const pending = new Map();
    let ws = null;
    let nextId = 1;
    let reconnectTimer = null;
    let closedByUser = false;

    const socket = {
      id: '',
      connected: false,
      on(event, fn) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(fn);
        return socket;
      },
      emit(event, ...args) {
        const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        const payload = args.length ? args[0] : null;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          if (callback) callback({ ok: false, err: '连接尚未就绪，请稍后重试' });
          return socket;
        }
        const id = callback ? nextId++ : 0;
        if (callback) pending.set(id, callback);
        ws.send(JSON.stringify({ id, event, payload }));
        return socket;
      },
      disconnect() {
        closedByUser = true;
        clearTimeout(reconnectTimer);
        if (ws) ws.close(1000, 'client disconnect');
      },
    };

    function dispatch(event, data) {
      (handlers.get(event) || []).forEach((fn) => fn(data));
    }

    function connect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${protocol}//${location.host}/ws`);
      ws.addEventListener('open', () => {
        socket.connected = true;
        dispatch('connect');
      });
      ws.addEventListener('message', (message) => {
        let packet;
        try { packet = JSON.parse(message.data); } catch (_) { return; }
        if (packet.ack) {
          const callback = pending.get(packet.ack);
          if (callback) {
            pending.delete(packet.ack);
            callback(packet.data);
          }
          return;
        }
        if (packet.event === 'welcome') socket.id = packet.data?.id || '';
        dispatch(packet.event, packet.data);
      });
      ws.addEventListener('close', () => {
        const wasConnected = socket.connected;
        socket.connected = false;
        for (const callback of pending.values()) callback({ ok: false, err: '连接已断开' });
        pending.clear();
        if (wasConnected) dispatch('disconnect');
        if (!closedByUser) reconnectTimer = setTimeout(connect, 1200);
      });
    }

    setTimeout(connect, 0);
    return socket;
  };
})();
