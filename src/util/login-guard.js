/**
 * 登录失败限流。
 *
 * 抽成独立模块有两个原因：
 *   1) 能单测 —— 之前它埋在 server.js 里，而 server.js 一 import 就 listen，
 *      测试根本没法加载
 *   2) 明确语义 —— 只有**密码错误**才计数，登录成功要清零
 *
 * 曾经的 bug：计数写在「检查是否封禁」里，于是每次成功登录也 +1。
 * 同一 IP 登录 20 次（刷新页面、换设备、会话过期重登都算）之后，
 * 正确密码也会被 429 挡住 10 分钟。
 */

export function createLoginGuard({
  windowMs = 10 * 60 * 1000,
  maxAttempts = 20,
  /** 来源过多时清空，避免内存被伪造 IP 撑爆 */
  maxEntries = 5000,
} = {}) {
  /** @type {Map<string, {count:number, resetAt:number}>} */
  const hits = new Map();

  const prune = (ip, now) => {
    const rec = hits.get(ip);
    if (!rec) return null;
    if (now > rec.resetAt) {
      hits.delete(ip);
      return null;
    }
    return rec;
  };

  return {
    /** 只读检查，不计数 */
    blocked(ip) {
      const rec = prune(ip, Date.now());
      return Boolean(rec && rec.count >= maxAttempts);
    },

    /** 记一次失败（只在密码错误时调用） */
    noteFailure(ip) {
      const now = Date.now();
      if (hits.size > maxEntries) hits.clear();
      const rec = prune(ip, now);
      if (!rec) {
        hits.set(ip, { count: 1, resetAt: now + windowMs });
        return;
      }
      rec.count++;
    },

    /** 登录成功：清掉这个来源的失败计数 */
    clear(ip) {
      hits.delete(ip);
    },

    /** 仅供测试/排障 */
    get size() {
      return hits.size;
    },
  };
}
