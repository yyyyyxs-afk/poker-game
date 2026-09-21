const assert = require('assert');
const { WindowLimiter, addressKey, createNetworkPolicy } = require('../network-guard');

let now = 0;
const limiter = new WindowLimiter({ limit: 2, windowMs: 1000, maxKeys: 2, now: () => now });
assert.strictEqual(limiter.take('a').ok, true);
now = 500;
assert.strictEqual(limiter.take('a').ok, true);
assert.deepStrictEqual(limiter.take('a'), { ok: false, retryAfterMs: 500 });
assert.strictEqual(limiter.take('b').ok, true, '不同网络独立计数');
assert.strictEqual(limiter.take('c').ok, false, '容量满时不能丢弃有效配额');
assert.strictEqual(limiter.records.size, 2);
now = 1000;
assert.strictEqual(limiter.take('a').ok, true, '只恢复已经过期的那次请求');
assert.strictEqual(limiter.take('a').ok, false, '跨窗口边界不能突发双倍额度');
now = 2500;
assert.strictEqual(limiter.take('c').ok, true, '到期配额自动回收');
assert.strictEqual(limiter.records.size, 1);

function req(peer, forwarded) {
  return { socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': forwarded } };
}
assert.strictEqual(addressKey('::ffff:192.0.2.1'), addressKey('192.0.2.1'));
assert.strictEqual(addressKey('2001:db8:abcd:1::1'), addressKey('2001:0db8:abcd:0001::9999'));
assert.notStrictEqual(addressKey('2001:db8:abcd:1::1'), addressKey('2001:db8:abcd:2::1'));
const direct = createNetworkPolicy({});
assert.strictEqual(direct.clientKey(req('192.0.2.10', '198.51.100.1')), addressKey('192.0.2.10'));
const trusted = createNetworkPolicy({ POKER_TRUSTED_PROXIES: '127.0.0.1,::1,10.0.0.0/8' });
assert.strictEqual(trusted.clientKey(req('127.0.0.1', '192.0.2.1, 198.51.100.5')), addressKey('198.51.100.5'));
assert.strictEqual(trusted.clientKey(req('127.0.0.1', '198.51.100.5, 10.0.0.3')), addressKey('198.51.100.5'));
assert.strictEqual(trusted.clientKey(req('192.0.2.10', '198.51.100.1')), addressKey('192.0.2.10'));
assert.strictEqual(trusted.clientKey(req('127.0.0.1', 'invalid-address')), addressKey('127.0.0.1'));
assert.strictEqual(trusted.clientKey(req('127.0.0.1', undefined)), addressKey('127.0.0.1'));
for (const invalid of ['true', '1', '*', '0.0.0.0/0', '::/0', '127.0.0.1/33']) {
  assert.throws(() => createNetworkPolicy({ POKER_TRUSTED_PROXIES: invalid }), /POKER_TRUSTED_PROXIES/);
}
const restricted = createNetworkPolicy({ POKER_ALLOWED_ORIGINS: 'https://poker.example/,http://localhost:3000' });
assert.strictEqual(restricted.allowsOrigin('https://poker.example'), true);
assert.strictEqual(restricted.allowsOrigin('https://poker.example.attacker.test'), false);
assert.strictEqual(restricted.allowsOrigin('null'), false);
assert.strictEqual(restricted.allowsOrigin(undefined), true);
for (const invalid of ['*', 'null', 'https://poker.example/path', 'https://user:pass@poker.example']) {
  assert.throws(() => createNetworkPolicy({ POKER_ALLOWED_ORIGINS: invalid }), /POKER_ALLOWED_ORIGINS/);
}
console.log('网络防护单元验证通过：滚动配额、内存上限、可信代理、IPv6 与来源校验');
