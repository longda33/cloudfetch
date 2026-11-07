import test from 'node:test';
import assert from 'node:assert/strict';
import {
  signSession,
  verifySession,
  safeEqual,
  parseCookies,
  SESSION_TTL_MS,
} from '../src/util/auth.js';

const SECRET = 'test-secret';

test('签发的会话能通过校验', () => {
  const token = signSession(SECRET);
  assert.equal(verifySession(SECRET, token), true);
});

test('换一个密钥就校验失败', () => {
  const token = signSession(SECRET);
  assert.equal(verifySession('another-secret', token), false);
});

test('篡改 payload 会失效', () => {
  const token = signSession(SECRET);
  const [, sig] = token.split('.');
  const forged = `${Number(Date.now()) + 1000}.${sig}`;
  assert.equal(verifySession(SECRET, forged), false);
});

test('过期会话被拒绝（Cookie Max-Age 只是浏览器侧约束）', () => {
  const issuedAt = Date.now() - SESSION_TTL_MS - 1000;
  const token = signSession(SECRET, issuedAt);
  assert.equal(verifySession(SECRET, token), false);
  // 同一时刻签发时应通过
  assert.equal(verifySession(SECRET, token, issuedAt + 1000), true);
});

test('畸形输入不会抛异常，只返回 false', () => {
  for (const v of ['', 'abc', '1.2.3', 'undefined.undefined', '.', 'null']) {
    assert.equal(verifySession(SECRET, v), false, `输入 ${JSON.stringify(v)}`);
  }
});

test('safeEqual 对长度不同的输入安全返回 false', () => {
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('abc', 'abc'), true);
});

test('parseCookies 容忍畸形百分号编码', () => {
  // decodeURIComponent('%') 会抛 URIError，不能让整个请求 500
  const c = parseCookies('a=1; cf_session=%E4%BD; bad');
  assert.equal(c.a, '1');
  assert.equal(c.cf_session, '%E4%BD');
  assert.equal(c.bad, undefined);
});
