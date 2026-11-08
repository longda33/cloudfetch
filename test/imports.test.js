/**
 * 模块导入完整性测试。
 *
 * 为什么需要这个测试：
 *   Node 的 ESM 导入是运行时解析的，`node --check` 只做语法检查，
 *   发现不了「用了某个标识符但没 import」这类错误。
 *
 *   实际踩过：server.js 里用了 transcodeConfigured() 但没 import，
 *   node --check 通过、单元测试通过、本地启动也正常（因为不访问
 *   /api/health 就不触发），部署到线上才在请求时抛
 *   ReferenceError: transcodeConfigured is not defined。
 *
 *   所以这里真的把 server 模块加载一遍，并对关键路由发一次请求，
 *   确保所有导入在运行时都能解析。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'cf-import-test-'));

// 必须先设好环境变量，config.js 在导入时就会读
process.env.DATA_DIR = TMP;
process.env.PANEL_PASSWORD = 'test-password';
process.env.SESSION_SECRET = 'test-secret-for-import-test';
process.env.OPENLIST_URL = 'http://127.0.0.1:1';
process.env.OPENLIST_TOKEN = 'dummy';

test('所有核心模块能被加载，导出符合预期', async (t) => {
  t.after(async () => {
    await fsp.rm(TMP, { recursive: true, force: true });
  });

  // config：导出 transcodeConfigured，且是函数
  const cfg = await import('../src/config.js');
  assert.equal(typeof cfg.transcodeConfigured, 'function', 'config 应导出 transcodeConfigured');
  assert.equal(typeof cfg.config, 'object');
  assert.equal(typeof cfg.printConfig, 'function');
  // 未配 R2 时应该返回 false，而不是抛错
  assert.equal(cfg.transcodeConfigured(), false, '没配 R2/GitHub 时应返回 false');

  // r2：导出 getR2，实例上有所需方法
  const r2 = await import('../src/r2.js');
  assert.equal(typeof r2.getR2, 'function');
  const client = r2.getR2();
  for (const m of ['putFile', 'deleteObject', 'headObject', 'presignGet']) {
    assert.equal(typeof client[m], 'function', `R2Client 缺少 ${m}`);
  }

  // transcode：组装 inputs + 触发
  const tc = await import('../src/transcode.js');
  assert.equal(typeof tc.buildTranscodeInputs, 'function');
  assert.equal(typeof tc.dispatchTranscode, 'function');
  // inputs 的所有值都必须是字符串，否则 GitHub 直接 422
  const inputs = tc.buildTranscodeInputs({
    sourceUrl: 'https://example.com/x',
    r2Key: 'k',
    outName: 'a.mp4',
    openlistDir: '/dir',
    taskId: 't1',
    segIndex: 3,
  });
  for (const [k, v] of Object.entries(inputs)) {
    assert.equal(typeof v, 'string', `input ${k} 必须是字符串`);
  }

  // tasks：转码确认轮询器存在（提交后靠它把任务推进到已完成）
  const tasks = await import('../src/tasks.js');
  const mgr = tasks.getTaskManager();
  assert.equal(typeof mgr._confirmTranscodes, 'function', 'TaskManager 缺少 _confirmTranscodes');
  assert.equal(typeof mgr._remoteDirOf, 'function', 'TaskManager 缺少 _remoteDirOf');

  // openlist：上传相关方法
  const ol = await import('../src/openlist.js');
  assert.equal(typeof ol.getOpenList, 'function');
  assert.equal(typeof ol.buildRemotePath, 'function');
});

test('server 模块加载后，/api/health 不抛 ReferenceError', async (t) => {
  t.after(async () => {
    await fsp.rm(TMP, { recursive: true, force: true });
  });

  /**
   * 直接 import server.js 会真的 listen 一个端口。
   * 用 PORT=0 让它随机分配，测完关掉，避免和别的测试抢端口。
   */
  process.env.PORT = '0';
  const { server } = await import('../src/server.js');
  assert.ok(server, 'server 应导出 http.Server 实例');

  try {
    await new Promise((resolve) => {
      if (server.listening) return resolve();
      server.once('listening', resolve);
    });
    const { port } = server.address();

    // 关键：真的请求一次，让路由里的所有标识符都被求值
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200, `/api/health 应返回 200，实际 ${res.status}`);

    const body = await res.json();
    assert.equal(body.ok, true);
    // 转码状态字段必须存在（这是修复的那个 bug）
    assert.ok('transcode' in body, 'health 应包含 transcode 字段');
    assert.equal(typeof body.transcode.enabled, 'boolean');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
