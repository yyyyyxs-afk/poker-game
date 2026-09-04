export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      server.addEventListener('message', (event) => server.send(event.data));

      return new Response(null, { status: 101, webSocket: client });
    }

    return env.ASSETS.fetch(request);
  },
};
