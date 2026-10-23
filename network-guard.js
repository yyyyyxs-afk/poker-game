const { isIP } = require('net');
const ipaddr = require('ipaddr.js');
const proxyaddr = require('proxy-addr');

// 每个进程共享计数；重建连接、退出房间或换昵称不会重置网络配额。
const LIMITS = Object.freeze({
  create: { limit: 20, windowMs: 60000 },
  join: { limit: 60, windowMs: 60000 },
  missingRoom: { limit: 15, windowMs: 60000 },
  chatPlayer: { limit: 3, windowMs: 2000 },
  chatAddress: { limit: 60, windowMs: 10000 },
});

class WindowLimiter {
  constructor({ limit, windowMs, maxKeys = 10000, now = Date.now }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.now = now;
    this.records = new Map();
    this.nextSweep = 0;
  }

  take(key) {
    const now = this.now();
    if (now >= this.nextSweep) {
      // 惰性回收，无常驻定时器；流量停止后占用也不会继续增长。
      for (const [k, times] of this.records) {
        if (times[times.length - 1] <= now - this.windowMs) this.records.delete(k);
      }
      this.nextSweep = now + Math.min(this.windowMs, 30000);
    }
    let times = this.records.get(key);
    if (!times) {
      // 满额时拒绝新 key，不能驱逐尚有效的记录给攻击者刷新额度。
      if (this.records.size >= this.maxKeys) return { ok: false, retryAfterMs: this.windowMs };
      times = [];
      this.records.set(key, times);
    }
    while (times.length && times[0] <= now - this.windowMs) times.shift();
    if (times.length >= this.limit) return { ok: false, retryAfterMs: times[0] + this.windowMs - now };
    times.push(now);
    return { ok: true };
  }
}

function addressKey(address) {
  if (typeof address !== 'string' || !isIP(address)) return 'unknown';
  const parsed = ipaddr.process(address);
  if (parsed.kind() === 'ipv4') return `v4:${parsed.toString()}`;
  // IPv6 同一 /64 网络共用配额，避免仅换地址尾部就获得新额度。
  return `v6:${Buffer.from(parsed.toByteArray().slice(0, 8)).toString('hex')}`;
}

function createNetworkPolicy(env = process.env) {
  const proxies = (env.POKER_TRUSTED_PROXIES || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const entry of proxies) {
    const parts = entry.split('/');
    const family = isIP(parts[0]);
    if (!family || parts.length > 2 || (parts.length === 2 &&
      (!/^\d+$/.test(parts[1]) || Number(parts[1]) < 1 || Number(parts[1]) > (family === 4 ? 32 : 128)))) {
      throw new Error('POKER_TRUSTED_PROXIES 必须是明确的 IP 或 CIDR，不能信任所有来源');
    }
  }
  const trust = proxyaddr.compile(proxies);
  const entries = (env.POKER_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origins = new Set(entries.map((entry) => {
    let url;
    try { url = new URL(entry); } catch (_) { /* 下方统一返回配置错误 */ }
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
      throw new Error('POKER_ALLOWED_ORIGINS 必须是 http/https 网站来源，不能包含路径或通配符');
    }
    return url.origin;
  }));

  return {
    clientKey(request) {
      const peer = request.socket && request.socket.remoteAddress;
      try {
        // 默认不解析用户可自行构造的转发头。
        const address = proxies.length && peer && trust(peer) ? proxyaddr(request, trust) : peer;
        return isIP(address || '') ? addressKey(address) : addressKey(peer);
      } catch (_) {
        return addressKey(peer);
      }
    },
    allowsOrigin(origin) {
      // 无 Origin 的原生客户端仍受业务限频约束；来源限制不等于账号鉴权。
      return origins.size === 0 || origin === undefined || origins.has(origin);
    },
  };
}

function createGuards() {
  return Object.fromEntries(Object.entries(LIMITS).map(([name, policy]) => [name, new WindowLimiter(policy)]));
}

module.exports = { WindowLimiter, LIMITS, addressKey, createNetworkPolicy, createGuards };
