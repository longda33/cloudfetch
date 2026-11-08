/**
 * 磁盘清理与异步重传的测试。
 *
 * 背景：1 GiB 的卷上跑 30 分钟一段的直播，一个 300MB 的失败分段就能把盘撑满。
 * 之前有两个问题：
 *   1) remove()/clearFinished() 只从内存删任务，磁盘目录原样留着 ——
 *      用户点了删除以为空间回来了，其实没有
 *   2) 重传接口同步等上传完成，300MB 要 1-3 分钟，而 Unikraft 网关
 *      60 秒就返回 504，界面显示失败但后台其实传成功了
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'cf-disk-'));
process.env.DATA_DIR = TMP;
process.env.TMP_DIR = path.join(TMP, 'tmp');
process.env.PANEL_PASSWORD = 'test-password';
process.env.SESSION_SECRET = 'test-secret-disk';
process.env.OPENLIST_URL = 'http://127.0.0.1:1';
process.env.OPENLIST_TOKEN = 'dummy';

/** 造一个任务对象直接塞进 manager，避免真的去下载 */
function seedTask(mgr, { id, status, files = [] }) {
  const task = {
    id,
    url: 'http://example.com/x',
    filename: 'x.bin',
    kind: 'http',
    live: false,
    upload: true,
    segment: false,
    status,
    phase: '已完成',
    createdAt: Date.now(),
    startedAt: Date.now() - 1000,
    finishedAt: Date.now(),
    size: files.reduce((a, f) => a + f.size, 0),
    downloaded: 0,
    uploaded: 0,
    total: 0,
    percent: 100,
    speed: 0,
    eta: 0,
    logs: [],
    segments: [],
    failedSegments: [],
    remotePath: '',
    localPath: '',
    error: '',
  };
  mgr.tasks.set(id, task);
  return { task, files };
}

async function makeJobDir(id, files) {
  const dir = path.join(process.env.TMP_DIR, id);
  await fsp.mkdir(dir, { recursive: true });
  for (const f of files) {
    await fsp.writeFile(path.join(dir, f.name), Buffer.alloc(f.size, 1));
  }
  return dir;
}

test('remove() 会连磁盘目录一起删掉', async (t) => {
  t.after(async () => {
    await fsp.rm(TMP, { recursive: true, force: true });
  });

  const { getTaskManager } = await import('../src/tasks.js');
  const mgr = getTaskManager();

  const id = 'aaaa1111-2222-3333-4444-555566667777';
  seedTask(mgr, { id, status: 'failed' });
  const dir = await makeJobDir(id, [{ name: '0001_a.flv', size: 4096 }]);

  // 确认目录真的建出来了
  assert.equal(await fsp.stat(dir).then(() => true).catch(() => false), true);

  const ok = await mgr.remove(id);
  assert.equal(ok, true, 'remove 应返回 true');
  assert.equal(mgr.tasks.has(id), false, '任务应从内存移除');

  const stillThere = await fsp.stat(dir).then(() => true).catch(() => false);
  assert.equal(stillThere, false, `磁盘目录必须被删掉：${dir}`);
});

test('clearFinished() 会清掉所有已结束任务的目录，但保留进行中的', async (t) => {
  t.after(async () => {
    await fsp.rm(TMP, { recursive: true, force: true });
  });

  const { getTaskManager } = await import('../src/tasks.js');
  const mgr = getTaskManager();

  const doneId = 'bbbb1111-2222-3333-4444-555566667777';
  const failId = 'cccc1111-2222-3333-4444-555566667777';
  const runningId = 'dddd1111-2222-3333-4444-555566667777';

  seedTask(mgr, { id: doneId, status: 'done' });
  seedTask(mgr, { id: failId, status: 'failed' });
  seedTask(mgr, { id: runningId, status: 'downloading' });

  const dirDone = await makeJobDir(doneId, [{ name: 'a.flv', size: 1024 }]);
  const dirFail = await makeJobDir(failId, [{ name: 'b.flv', size: 2048 }]);
  const dirRun = await makeJobDir(runningId, [{ name: 'c.flv', size: 3072 }]);

  const n = await mgr.clearFinished();
  assert.equal(n, 2, '应清掉 2 个已结束任务');

  assert.equal(await fsp.stat(dirDone).then(() => true).catch(() => false), false, 'done 目录应删除');
  assert.equal(await fsp.stat(dirFail).then(() => true).catch(() => false), false, 'failed 目录应删除');
  assert.equal(
    await fsp.stat(dirRun).then(() => true).catch(() => false),
    true,
    '进行中的任务目录必须保留',
  );
});

test('remove() 拒绝删除进行中的任务，且不动磁盘', async (t) => {
  t.after(async () => {
    await fsp.rm(TMP, { recursive: true, force: true });
  });

  const { getTaskManager } = await import('../src/tasks.js');
  const mgr = getTaskManager();

  const id = 'eeee1111-2222-3333-4444-555566667777';
  seedTask(mgr, { id, status: 'downloading' });
  const dir = await makeJobDir(id, [{ name: 'x.flv', size: 512 }]);
  mgr.running.add(id);

  const ok = await mgr.remove(id);
  assert.equal(ok, false, '进行中的任务不能删');
  assert.equal(mgr.tasks.has(id), true, '任务应还在');
  assert.equal(
    await fsp.stat(dir).then(() => true).catch(() => false),
    true,
    '进行中的任务目录不能删',
  );

  mgr.running.delete(id);
});

test('_removeJobDir 挡住路径穿越', async (t) => {
  t.after(async () => {
    await fsp.rm(TMP, { recursive: true, force: true });
  });

  const { getTaskManager } = await import('../src/tasks.js');
  const mgr = getTaskManager();

  // 造一个 tmpDir 之外的目录，试着用穿越路径删它
  const outside = path.join(TMP, 'IMPORTANT');
  await fsp.mkdir(outside, { recursive: true });
  await fsp.writeFile(path.join(outside, 'keep.txt'), 'must survive');

  // 各种恶意 id
  for (const evil of ['../IMPORTANT', '..', '../../etc', 'a/../../IMPORTANT']) {
    await mgr._removeJobDir(evil);
  }

  const survived = await fsp
    .stat(path.join(outside, 'keep.txt'))
    .then(() => true)
    .catch(() => false);
  assert.equal(survived, true, '路径穿越必须被挡住，tmpDir 外的文件不能被删');
});

test('canRetryUpload：没有待补传分段时明确拒绝', async (t) => {
  t.after(async () => {
    await fsp.rm(TMP, { recursive: true, force: true });
  });

  const { getTaskManager } = await import('../src/tasks.js');
  const mgr = getTaskManager();

  const id = 'ffff1111-2222-3333-4444-555566667777';
  const { task } = seedTask(mgr, { id, status: 'done' });
  // 所有分段都已落地
  task.segments = [
    { index: 1, filename: 'a.flv', size: 100, remotePath: '/remote/a.mp4', mp4State: 'done' },
  ];

  const r = mgr.canRetryUpload(id);
  assert.equal(r.ok, false);
  assert.match(r.error, /没有待补传/);
});

test('canRetryUpload：进行中的任务拒绝，已结束且有失败分段时通过', async (t) => {
  t.after(async () => {
    await fsp.rm(TMP, { recursive: true, force: true });
  });

  const { getTaskManager } = await import('../src/tasks.js');
  const mgr = getTaskManager();

  // 进行中
  const runId = '11112222-3333-4444-5555-666677778888';
  seedTask(mgr, { id: runId, status: 'downloading' });
  mgr.running.add(runId);
  const r1 = mgr.canRetryUpload(runId);
  assert.equal(r1.ok, false);
  assert.match(r1.error, /仍在进行中/);
  mgr.running.delete(runId);

  // 已结束，有一个失败分段
  const failId = '22223333-4444-5555-6666-777788889999';
  const { task } = seedTask(mgr, { id: failId, status: 'done' });
  task.segments = [
    { index: 1, filename: 'a.flv', size: 100, remotePath: '/remote/a.mp4' },
    { index: 2, filename: 'b.flv', size: 200, remotePath: '' },
  ];
  task.failedSegments = [{ index: 2, filename: 'b.flv', size: 200, error: 'boom' }];

  const r2 = mgr.canRetryUpload(failId);
  assert.equal(r2.ok, true, `应允许重传，实际：${r2.error}`);
  assert.equal(r2.count, 1, '只有第 2 段待补传');

  // 正在转码的段不算待补传
  task.segments[1].mp4State = 'pending';
  task.failedSegments = [];
  const r3 = mgr.canRetryUpload(failId);
  assert.equal(r3.ok, false, '正在转码的段不应算作待补传');
});
