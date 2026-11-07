/**
 * 会话签名与 Cookie 解析。
 *
 * 单独抽成模块有两个原因：
 *  1) 安全逻辑必须能被单元测试覆盖，而 server.js 一 import 就会 listen，没法测
 *  2) 签发/校验/过期判断集中在一处，避免两边的实现悄悄漂移
 */
import crypto from 'node:crypto';

/** 会话有效期。必须与 Set-Cookie 的 Max-Age 保持一致 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 允许的时钟偏差：容器时钟略慢于签发端时，别让刚签发的会话立刻失效 */
const CLOCK_SKEW_MS = 60 * 1000;

/**
 * 签发会话 token：`<时间戳>.<HMAC>`。
 * 时间戳参与签名，所以客户端改不了有效期。
 */
export function signSession(secret, now = Date.now()) {
  const payload = String(now);
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

/**
 * 校验会话 token。
 *
 * 光验签名是不够的：Cookie 的 Max-Age 只是浏览器侧的约束，
 * 抓到的 token 在服务端必须也会过期，否则等于永久有效。
 */
export function verifySession(secret, value, now = Date.now()) {
  if (!value) return false;
  const [payload, sig] = String(value).split('.');
  if (!payload || !sig) return false;
  // payload 只能是纯数字时间戳，顺带挡掉超长输入
  if (!/^\d{1,16}$/.test(payload)) return false;

  const expect = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (sig.length !== expect.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;

  const age = now - Number(payload);
  return age <= SESSION_TTL_MS && age >= -CLOCK_SKEW_MS;
}

/** 常量时间比较，避免时序侧信道 */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // 长度不同也要走一次比较，避免通过耗时判断长度
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/** 解析 Cookie 头。畸形百分号编码退化为原始值，不要让整个请求 500 */
export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    const raw = part.slice(i + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}
