const assert = require('assert');

const BASE_URL = process.env.TEST_URL || 'http://127.0.0.1:8787';
const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/ws';

function openClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const client = { ws, state: null, pending: new Map(), nextId: 1, events: [] };
    const timeout = setTimeout(() => reject(new Error('连接 Cloudflare 测试服务超时')), 5000);
    ws.onmessage = (event) => {
      const packet = JSON.parse(event.data);
      if (packet.ack) {
        const callback = client.pending.get(packet.ack);
        if (callback) { client.pending.delete(packet.ack); callback(packet.data); }
      } else if (packet.event === 'state') client.state = packet.data;
      else if (packet.event === 'welcome') {
        clearTimeout(timeout);
        resolve(client);
      } else client.events.push(packet);
    };
    ws.onerror = () => reject(new Error('Cloudflare WebSocket 连接失败'));
  });
}

function request(client, event, payload = null) {
  return new Promise((resolve, reject) => {
    const id = client.nextId++;
    const timeout = setTimeout(() => reject(new Error(`${event} 回执超时`)), 5000);
    client.pending.set(id, (data) => { clearTimeout(timeout); resolve(data); });
    client.ws.send(JSON.stringify({ id, event, payload }));
  });
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

(async () => {
  const host = await openClient();
  let guest = await openClient();
  const third = await openClient();
  const outsider = await openClient();
  try {
    const created = await request(host, 'create_room', { name: '云测甲' });
    assert.ok(created.ok && /^[A-Z2-9]{6}$/.test(created.code));
    const joined = await request(guest, 'join_room', { code: created.code, name: '云测乙' });
    assert.ok(joined.ok && joined.token);
    assert.ok((await request(third, 'join_room', { code: created.code, name: '云测丙' })).ok);
    assert.ok(await waitUntil(() => host.state?.players.length === 3 && guest.state?.players.length === 3));

    assert.ok((await request(guest, 'sit_out')).ok);
    assert.ok(await waitUntil(() => host.state?.players[guest.state.youSeat]?.sittingOut));
    assert.ok((await request(guest, 'sit_back')).ok);
    guest.ws.close();
    assert.ok(await waitUntil(() => host.state?.players.some((player) => player.name === '云测乙' && !player.connected)));
    guest = await openClient();
    const rejoined = await request(guest, 'join_room', { code: created.code, name: '云测乙', token: joined.token });
    assert.ok(rejoined.ok, '断线后应能凭身份令牌恢复座位');
    assert.ok((await request(guest, 'emoji', { emoji: '👍' })).ok);
    assert.ok(await waitUntil(() => host.events.some((event) => event.event === 'emoji' && event.data.emoji === '👍')));
    assert.strictEqual((await request(guest, 'kick_player', { seat: third.state.youSeat })).ok, false);
    assert.ok((await request(host, 'kick_player', { seat: third.state.youSeat })).ok);
    assert.ok(await waitUntil(() => host.state?.players.length === 2));

    const settings = await request(host, 'update_settings', {
      startChips: 2000, smallBlind: 10, bigBlind: 20,
      actionTime: 20, nextHandDelay: 20, rebuyAllowed: true, locked: true,
    });
    assert.ok(settings.ok && settings.settings.locked);
    const blocked = await request(outsider, 'join_room', { code: created.code, name: '云测丁' });
    assert.strictEqual(blocked.ok, false);

    assert.ok((await request(host, 'start_game')).ok);
    assert.ok(await waitUntil(() => host.state?.stage === 'preflop'));
    const actor = host.state.turnSeat === host.state.youSeat ? host : guest;
    assert.ok((await request(actor, 'action', { type: 'fold' })).ok);
    assert.ok(await waitUntil(() => host.state?.stage === 'handover'));
    assert.strictEqual(host.state.pot, 0, '结算后桌面底池应归零');
    assert.strictEqual(host.state.players.reduce((sum, player) => sum + player.chips, 0), 4000);
    assert.strictEqual((await request(host, 'rebuy')).ok, false, '仍有筹码时不得重复重买');
    console.log('Cloudflare 冒烟测试通过：房间管理、互动、开局、弃牌结算、筹码守恒 ✅');
  } finally {
    host.ws.close();
    guest.ws.close();
    third.ws.close();
    outsider.ws.close();
  }
})().catch((error) => {
  console.error('Cloudflare 冒烟测试失败 ❌:', error.message);
  process.exitCode = 1;
});
