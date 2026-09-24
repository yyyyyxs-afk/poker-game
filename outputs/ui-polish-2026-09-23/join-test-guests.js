const { io } = require('socket.io-client');

const url = process.env.HARNESS_URL || 'http://localhost:3456';
const code = String(process.argv[2] || '').trim().toUpperCase();
const names = ['小帆', '阿飞', '可乐', '兔子', 'Lemon'];
const clients = [];
const latest = new Array(names.length).fill(null);
const busy = new Set();
const receivedChat = new Set();
const chatProbeIn = String(process.env.CHAT_PROBE_IN || '');
const chatProbeOut = String(process.env.CHAT_PROBE_OUT || '');

if (!code) throw new Error('Usage: node outputs/ui-polish-2026-09-23/join-test-guests.js ROOM_CODE');

async function join(name, index) {
  const client = io(url, { transports: ['websocket'] });
  clients.push(client);
  client.on('state', (state) => {
    latest[index] = state;
    if (chatProbeOut && !receivedChat.has(index) &&
        Array.isArray(state.chatMessages) && state.chatMessages.some((message) => message.text === chatProbeOut)) {
      receivedChat.add(index);
      console.log(`${name} received browser chat`);
    }
    if (!['preflop', 'flop', 'turn', 'river'].includes(state.stage)) return;
    if (state.turnSeat !== state.youSeat || busy.has(index)) return;
    busy.add(index);
    setTimeout(() => {
      busy.delete(index);
      const current = latest[index];
      if (!current || current.turnSeat !== current.youSeat ||
          current.handNumber !== state.handNumber || current.stage !== state.stage) return;
      const player = current.players[current.youSeat];
      if (!player || player.folded || player.allIn) return;
      const toCall = current.currentBet - player.roundBet;
      client.emit('action', { type: toCall > 0 ? 'call' : 'check' }, (result) => {
        if (result && !result.ok && result.err !== '还没轮到你行动') {
          console.log(`${name} action rejected: ${result.err}`);
        }
      });
    }, 450 + Math.floor(Math.random() * 250));
  });

  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${name} join timed out`)), 5000);
    client.emit('join_room', { code, name }, (reply) => {
      clearTimeout(timeout);
      if (reply && reply.ok) resolve(reply);
      else reject(new Error(`${name} join failed: ${(reply && reply.err) || 'unknown error'}`));
    });
  });
  console.log(`joined ${name} seat=${result.seat}`);
}

(async () => {
  for (let i = 0; i < names.length; i += 1) await join(names[i], i);
  console.log(`five socket guests ready in ${code}`);
  if (chatProbeIn) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    clients[0].emit('chat_message', { text: chatProbeIn }, (reply) => {
      console.log(`bot chat ${reply && reply.ok ? 'accepted' : `rejected: ${(reply && reply.err) || 'unknown error'}`}`);
    });
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

process.on('SIGINT', () => {
  clients.forEach((client) => client.disconnect());
  process.exit(0);
});
