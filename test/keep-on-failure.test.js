/**
 * 上传失败时必须保留本地文件。
 *
 * 这是用户明确要求的行为：失败的文件要持久保留，能重传。
 *
 * 之前踩过两次坑：
 *   1) 单文件上传失败没登记 failedSegments，清理逻辑以为"传完了"，
 *      把整个 jobDir 删掉，下载好的文件白下
 *   2) 直播分段失败后，如果 remotePath 恰好有值（新流程会在提交转码时
 *      就填上），清理条件会误判成成功
 *
 * 这里用真实的 TaskManager 跑一个会失败的任务，断言目录还在。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'cf-keep-'));
process.env.DATA_DIR = TMP;
process.env.TMP_DIR = path.join(TMP, 'tmp');
process.env.PANEL_PASSWORD = 'test-password';
process.env.SESSION_SECRET = 'test-secret-keep';
// OpenList 指向一个必然失败的地址，让上传必定出错
process.env.OPENLIST_URL = 'http://127.0.0.1:1';
process.env.OPENLIST_TOKEN = 'dummy';

/** 起一个本地 HTTP 服务当下载源 */
async function startSource(bytes) {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.length),
    });
    res.end(bytes);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: srv.address().port };
}

test('单文件上传失败：任务目录保留，文件还在，可以重传', async (t) => {
  t.after(async () => {
    await fsp.rm(TMP, { recursive: true, force: true });
  });

  const payload = Buffer.alloc(64 * 1024, 9);
  const { srv, port } = await startSource(payload);

  try {
    const { getTaskManager } = await import('../src/tasks.js');
    const mgr = getTaskManager();

    const created = mgr.create({
      url: `http://127.0.0.1:${port}/file.bin`,
      upload: true,
      segment: false,
    });
    const task = Array.isArray(created) ? created[0] : created;
    assert.ok(task?.id, '应创建出任务');

    // 等任务结束（失败）
    await mgr.waitForIdle?.().catch(() => {});
    for (let i = 0; i < 200; i++) {
      const cur = mgr.get(task.id);
      if (cur && ['done', 'failed', 'canceled'].includes(cur.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const cur = mgr.get(task.id);
    assert.ok(cur, '任务应还在内存里');
    assert.equal(cur.status, 'failed', `上传失败时任务应为 failed，实际 ${cur.status}`);

    // 关键断言：失败记录被登记
    assert.ok(
      (cur.failedSegments?.length || 0) > 0,
      '上传失败必须登记 failedSegments，否则前端没有重传入口',
    );

    // 关键断言：任务目录和文件都还在
    const jobDir = path.join(process.env.TMP_DIR, task.id);
    const dirExists = await fsp
      .stat(jobDir)
      .then((s) => s.isDirectory())
      .catch(() => false);
    assert.equal(dirExists, true, `失败后任务目录必须保留：${jobDir}`);

    const entries = await fsp.readdir(jobDir).catch(() => []);
    const dataFiles = entries.filter((f) => !f.startsWith('.'));
    assert.ok(dataFiles.length > 0, `失败后目录里应有文件，实际：${entries.join(',')}`);

    // 文件内容完整（说明是"下完了但没传上去"，不是下了一半）
    const f = path.join(jobDir, dataFiles[0]);
    const st = await fsp.stat(f);
    assert.equal(st.size, payload.length, '保留下来的文件应该是完整下载的');
  } finally {
    srv.close();
  }
});
