/**
 * 服务状态探测接口的测试。
 *
 * 背景：右上角状态灯之前读的是 /api/health 里的 transcode.enabled，
 * 那只说明「环境变量填了」——R2 密钥过期、OpenList 挂了，
 * 灯照样是绿的。等于没在监控。
 *
 * /api/status 改成真发网络请求探测，这个测试保证：
 *   1) 配置缺失时明确返回 ok:false + 原因，而不是抛异常
 *   2) 网络不通时也是 ok:false + 原因，接口本身不 500
 *   3) 响应结构稳定（前端依赖这几个字段名）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'cf-status-'));
process.env.DATA_DIR = TMP;
process.env.PANEL_PASSWORD = 'test-password';
process.env.SESSION_SECRET = 'test-secret-status';

test('R2 ping：未配置时返回 ok:false 且不抛异常', async (t) => {
  t.after(async () => {
    await fsp.rm(TMP, { recursive: true, force: true });
  });

  // 清掉所有 R2 变量
  for (const k of [
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET',
    'R2_ENDPOINT',
  ]) {
    delete process.env[k];
  }

  const { R2Client } = await import('../src/r2.js');
  const c = new R2Client({
    accountId: '',
    accessKeyId: '',
    secretAccessKey: '',
    bucket: '',
    endpoint: '',
  });

  const r = await c.ping({ prefix: 'cloudfetch' });
  assert.equal(r.ok, false, '未配置时应返回 ok:false');
  assert.match(r.reason, /未配置/, `原因应说明未配置，实际：${r.reason}`);
});

test('R2 ping：连不上时返回 ok:false 而不是抛错', async (t) => {
  t.after(async () => {
    await fsp.rm(TMP, { recursive: true, force: true });
  });

  const { R2Client } = await import('../src/r2.js');
  // 指向一个必然拒绝连接的地址
  const c = new R2Client({
    accountId: 'testacct',
    accessKeyId: 'AKIDTEST',
    secretAccessKey: 'SECRETTEST',
    bucket: 'testbucket',
    endpoint: 'http://127.0.0.1:1',
  });

  const r = await c.ping({ prefix: 'cloudfetch' });
  assert.equal(r.ok, false, '连不上时应返回 ok:false');
  assert.ok(r.reason && r.reason.length > 0, '应带上失败原因');
  // 关键：不能抛异常，否则接口会 500，前端状态灯永远停在"检测中"
});

test('/api/status 返回稳定的结构，且两个服务互不阻塞', async (t) => {
  t.after(async () => {
    await fsp.rm(TMP, { recursive: true, force: true });
  });

  // 都指向不可达地址，模拟"两个服务都挂了"
  process.env.R2_ACCOUNT_ID = 'testacct';
  process.env.R2_ACCESS_KEY_ID = 'AKIDTEST';
  process.env.R2_SECRET_ACCESS_KEY = 'SECRETTEST';
  process.env.R2_BUCKET = 'testbucket';
  process.env.R2_ENDPOINT = 'http://127.0.0.1:1';
  process.env.OPENLIST_URL = 'http://127.0.0.1:1';
  process.env.OPENLIST_TOKEN = 'dummy';
  process.env.PORT = '0';

  const { resetR2 } = await import('../src/r2.js');
  resetR2();

  const { server } = await import('../src/server.js');
  try {
    await new Promise((resolve) => {
      if (server.listening) return resolve();
      server.once('listening', resolve);
    });
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    /**
     * /api/status 需要登录（它会把 R2 桶名、OpenList 用户名吐出来，
     * 不该对匿名用户暴露）。所以先登录拿 cookie。
     */
    const loginRes = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-password' }),
    });
    assert.equal(loginRes.status, 200, '测试用密码应能登录');
    const cookie = loginRes.headers.get('set-cookie')?.split(';')[0] || '';
    assert.ok(cookie, '登录应下发 cookie');

    const started = Date.now();
    const res = await fetch(`${base}/api/status`, { headers: { Cookie: cookie } });
    const ms = Date.now() - started;

    assert.equal(res.status, 200, '两个服务都挂时，接口本身仍应返回 200');

    const body = await res.json();

    // 结构断言：前端依赖这几个字段
    assert.ok('r2' in body, '响应应含 r2 字段');
    assert.ok('openlist' in body, '响应应含 openlist 字段');
    assert.equal(typeof body.r2.ok, 'boolean');
    assert.equal(typeof body.openlist.ok, 'boolean');
    assert.equal(typeof body.r2.reason, 'string');
    assert.equal(typeof body.openlist.reason, 'string');
    assert.equal(typeof body.checkedAt, 'number');

    // 两个都不可达，都应该是 false
    assert.equal(body.r2.ok, false);
    assert.equal(body.openlist.ok, false);

    // 并发探测：两个各 8 秒超时，串行会 16 秒以上，并发应该快得多
    // 连不上是立即 ECONNREFUSED，所以这里应该很快
    assert.ok(ms < 12000, `并发探测应较快完成，实际 ${ms}ms`);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
