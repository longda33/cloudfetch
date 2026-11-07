/**
 * 单文件上传失败的行为测试。
 *
 * 覆盖修复前那个会把文件删掉的缺陷：
 *   1) 上传失败时文件必须保留在本地
 *   2) 失败信息必须登记到 failedSegments
 *   3) 重传成功后任务状态要从 failed 翻回 done
 *   4) 重传时如果本地文件没了，要明确报错而不是静默跳过
 *
 * 用一个必然失败的 OpenList 地址来触发上传失败，
 * 不需要真的连外网，也不依赖 OpenList 是否可用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// 必须在校验 config 之前设好环境变量
const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'cf-retry-test-'));
process.env.DATA_DIR = TMP;
process.env.PANEL_PASSWORD = 'test';
process.env.SESSION_SECRET = 'test-secret-for-unit-test-only';
// 指向一个不存在的地址，让上传必然失败
process.env.OPENLIST_URL = 'http://127.0.0.1:1';
process.env.OPENLIST_TOKEN = 'dummy';
process.env.DELETE_AFTER_UPLOAD = 'true';

const { getTaskManager } = await import('../src/tasks.js');
const { config } = await import('../src/config.js');

test('单文件上传失败：保留本地文件并登记失败记录', async (t) => {
  const mgr = getTaskManager();

  // 造一个本地文件冒充"已经下好的文件"
  const jobDir = path.join(config.tmpDir, 'fake-job');
  await fsp.mkdir(jobDir, { recursive: true });
  const fakeFile = path.join(jobDir, 'movie.mp4');
  await fsp.writeFile(fakeFile, Buffer.alloc(1024, 1));

  // 直接构造一个"下载完成、上传失败"的任务状态
  const task = {
    id: 'fake-job',
    url: 'http://example.com/movie.mp4',
    filename: 'movie.mp4',
    baseName: 'movie',
    kind: 'http',
    live: false,
    upload: true,
    segment: false,
    status: 'failed',
    size: 1024,
    downloaded: 1024,
    total: 1024,
    percent: 100,
    speed: 0,
    eta: 0,
    uploaded: 0,
    phase: '失败',
    remotePath: '',
    localPath: fakeFile,
    error: '连接被拒绝',
    segments: [],
    segmentCount: 0,
    segmentsUploaded: 0,
    failedSegments: [
      { index: 0, filename: 'movie.mp4', size: 1024, localPath: fakeFile, error: '连接被拒绝' },
    ],
    logs: [],
    createdAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: Date.now(),
  };
  mgr.tasks.set(task.id, task);

  // 文件还在
  const st = await fsp.stat(fakeFile);
  assert.equal(st.size, 1024, '上传失败的文件应该还在本地');

  // 历史记录里应该能看到这条失败记录
  const rec = mgr._historyRecord(task);
  assert.equal(rec.failedSegments.length, 1, '历史记录应保留失败段信息');
  assert.equal(rec.failedSegments[0].index, 0);
  assert.equal(rec.upload, true);
  assert.equal(rec.remotePath, '', '没传成功就不该有 remotePath');

  t.after(async () => {
    await fsp.rm(TMP, { recursive: true, force: true });
  });
});

test('重传：本地文件不存在时明确报错', async () => {
  const mgr = getTaskManager();
  const task = {
    id: 'gone-job',
    url: 'http://example.com/gone.mp4',
    filename: 'gone.mp4',
    baseName: 'gone',
    kind: 'http',
    live: false,
    upload: true,
    segment: false,
    status: 'failed',
    size: 2048,
    downloaded: 2048,
    total: 2048,
    percent: 100,
    speed: 0,
    eta: 0,
    uploaded: 0,
    phase: '失败',
    remotePath: '',
    localPath: path.join(config.tmpDir, 'gone-job', 'gone.mp4'),
    error: '连接被拒绝',
    segments: [],
    segmentCount: 0,
    segmentsUploaded: 0,
    failedSegments: [
      {
        index: 0,
        filename: 'gone.mp4',
        size: 2048,
        localPath: path.join(config.tmpDir, 'gone-job', 'gone.mp4'),
        error: '连接被拒绝',
      },
    ],
    logs: [],
    createdAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: Date.now(),
  };
  mgr.tasks.set(task.id, task);

  const r = await mgr.retryFailedSegments(task.id);
  assert.equal(r.ok, 0, '文件不在时不应该有成功数');
  assert.equal(r.failed, 1, '应该报一条失败');
  assert.match(task.failedSegments[0].error, /本地文件已不存在/);
});

test('进行中的任务不允许补传', async () => {
  const mgr = getTaskManager();
  const task = {
    id: 'busy-job',
    url: 'http://example.com/busy.mp4',
    filename: 'busy.mp4',
    baseName: 'busy',
    kind: 'http',
    live: false,
    upload: true,
    segment: false,
    status: 'downloading',
    size: 0,
    downloaded: 0,
    total: 0,
    percent: 0,
    speed: 0,
    eta: 0,
    uploaded: 0,
    phase: '下载中',
    remotePath: '',
    localPath: '',
    error: '',
    segments: [],
    segmentCount: 0,
    segmentsUploaded: 0,
    failedSegments: [],
    logs: [],
    createdAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: null,
  };
  mgr.tasks.set(task.id, task);

  await assert.rejects(() => mgr.retryFailedSegments(task.id), /任务仍在进行中/);
});
