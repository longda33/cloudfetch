/**
 * 转码失败时「保留源分段」的保护测试。
 *
 * 背景（真实事故）：
 *   一场 2.4 小时直播切成 29 段（1.42GB），提交合并转码后撞上
 *   Actions 超时被取消，mp4State 标成 failed。用户看到任务显示失败，
 *   就点了删除清理界面 —— 于是这 29 段源文件全被 _disposeTask 删掉。
 *   等修好转码参数想重跑时，**源数据已经不存在了**，那场直播彻底丢失。
 *
 * 修复后的规则：
 *   - mp4State === 'failed' 的分段，默认保留
 *   - 只有 remove({force:true}) 才删
 *   - clearFinished() 永不 force（批量清理最容易误伤）
 *   - mp4State === 'pending' 的分段无论如何都不删（Actions 正在用）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * 造一个最小可用的 TaskManager，并替换掉 getR2。
 *
 * 不真的连 R2 —— 我们要断言的是「哪些 key 被要求删除」，
 * 不是「R2 删成功了没有」。
 */
async function makeMgr() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cf-keep-'));
  process.env.DATA_DIR = tmp;
  process.env.TMP_DIR = path.join(tmp, 'tmp');
  await fsp.mkdir(process.env.TMP_DIR, { recursive: true });
  process.env.PANEL_PASSWORD = 'pw';
  process.env.SESSION_SECRET = 'sec';
  // 让 _disposeTask 认为 R2 已配置，才会走进分类逻辑
  process.env.R2_ACCOUNT_ID = 'acct';
  process.env.R2_ACCESS_KEY_ID = 'ak';
  process.env.R2_SECRET_ACCESS_KEY = 'sk';
  process.env.R2_BUCKET = 'bucket';

  const r2mod = await import('../src/r2.js');

  /** 记录被删的 key */
  const deleted = [];
  const fake = {
    deleteObject: async (key) => {
      deleted.push(key);
      return true;
    },
  };
  // 通过显式注入点替换单例（ESM 具名导出不能直接赋值覆盖）
  r2mod.__setR2ForTest(fake);

  const { TaskManager } = await import('../src/tasks.js');
  const mgr = new TaskManager();

  return {
    mgr,
    deleted,
    tmp,
    cleanup: async () => {
      r2mod.__setR2ForTest(null);
      await fsp.rm(tmp, { recursive: true, force: true });
    },
  };
}

test('转码失败的分段：remove 默认不删 R2 源文件', async (t) => {
  const { mgr, deleted, cleanup } = await makeMgr();
  t.after(cleanup);

  const id = 'task-failed-1';
  mgr.tasks.set(id, {
    id,
    status: 'done',
    createdAt: Date.now(),
    segments: [
      { index: 1, r2Key: 'p/0001.flv', mp4State: 'failed' },
      { index: 2, r2Key: 'p/0002.flv', mp4State: 'failed' },
    ],
    mp4State: 'failed',
  });

  await mgr.remove(id);

  assert.deepEqual(deleted, [], `默认不该删任何 R2 对象，实际删了：${deleted.join(',')}`);
  assert.equal(mgr.tasks.has(id), false, '任务本身应该从列表移除');
});

test('转码失败的分段：remove({force:true}) 才删', async (t) => {
  const { mgr, deleted, cleanup } = await makeMgr();
  t.after(cleanup);

  const id = 'task-failed-2';
  mgr.tasks.set(id, {
    id,
    status: 'done',
    createdAt: Date.now(),
    segments: [
      { index: 1, r2Key: 'p/0001.flv', mp4State: 'failed' },
      { index: 2, r2Key: 'p/0002.flv', mp4State: 'failed' },
    ],
    mp4State: 'failed',
  });

  await mgr.remove(id, { force: true });

  assert.deepEqual(
    deleted.sort(),
    ['p/0001.flv', 'p/0002.flv'],
    `force 时应该全删，实际：${deleted.join(',')}`,
  );
});

test('已成功的分段：正常删除，不受保护影响', async (t) => {
  const { mgr, deleted, cleanup } = await makeMgr();
  t.after(cleanup);

  const id = 'task-done';
  mgr.tasks.set(id, {
    id,
    status: 'done',
    createdAt: Date.now(),
    segments: [
      { index: 1, r2Key: 'p/0001.flv', mp4State: 'done' },
      { index: 2, r2Key: 'p/0002.flv', mp4State: 'done' },
    ],
  });

  await mgr.remove(id);

  assert.deepEqual(
    deleted.sort(),
    ['p/0001.flv', 'p/0002.flv'],
    '转码成功的分段没有保留价值，应该删',
  );
});

test('转码中的分段：无论如何都不删（Actions 正在用）', async (t) => {
  const { mgr, deleted, cleanup } = await makeMgr();
  t.after(cleanup);

  const id = 'task-pending';
  mgr.tasks.set(id, {
    id,
    status: 'done',
    createdAt: Date.now(),
    segments: [
      { index: 1, r2Key: 'p/0001.flv', mp4State: 'pending' },
      { index: 2, r2Key: 'p/0002.flv', mp4State: 'failed' },
    ],
    mp4State: 'pending',
    mergedSubmitted: true,
  });

  // 整个任务在合并转码中，直接返回，一个都不删
  await mgr.remove(id);
  assert.deepEqual(deleted, [], '合并转码进行中，不该删任何东西');
});

test('混合状态：只删成功的，保留失败的', async (t) => {
  const { mgr, deleted, cleanup } = await makeMgr();
  t.after(cleanup);

  const id = 'task-mixed';
  mgr.tasks.set(id, {
    id,
    status: 'done',
    createdAt: Date.now(),
    segments: [
      { index: 1, r2Key: 'p/0001.flv', mp4State: 'done' },
      { index: 2, r2Key: 'p/0002.flv', mp4State: 'failed' },
      { index: 3, r2Key: 'p/0003.flv', mp4State: 'done' },
    ],
  });

  await mgr.remove(id);

  assert.deepEqual(
    deleted.sort(),
    ['p/0001.flv', 'p/0003.flv'],
    `应该只删成功的两段，实际：${deleted.join(',')}`,
  );
});

test('clearFinished：批量清理也保留失败分段', async (t) => {
  const { mgr, deleted, cleanup } = await makeMgr();
  t.after(cleanup);

  mgr.tasks.set('a', {
    id: 'a',
    status: 'done',
    createdAt: Date.now(),
    segments: [{ index: 1, r2Key: 'a/0001.flv', mp4State: 'failed' }],
    mp4State: 'failed',
  });
  mgr.tasks.set('b', {
    id: 'b',
    status: 'done',
    createdAt: Date.now(),
    segments: [{ index: 1, r2Key: 'b/0001.flv', mp4State: 'done' }],
  });

  const { removed, kept } = await mgr.clearFinished();

  assert.equal(removed, 1, '只应清掉成功那个任务');
  assert.equal(kept, 1, '失败任务要留在列表里，否则源文件会变成孤儿');
  assert.deepEqual(
    deleted,
    ['b/0001.flv'],
    `批量清理应只删成功的，实际：${deleted.join(',')}`,
  );
  assert.equal(mgr.tasks.has('a'), true, '有受保护源分段的任务不能被批量清掉');
});

/* ---------------- 合并转码（真正出事故的那条路径） ---------------- */

/**
 * 合并流程里，失败状态挂在**任务**上（t.mp4State='failed'），
 * 而每段仍是 'staged'（只表示"已存进 R2"）。
 *
 * 只按段级 mp4State 分类的话，staged 既不是 pending 也不是 failed，
 * 会被当成正常段全删 —— 这正是 29 段 1.42GB 丢失那次的情形。
 */
function mergedFailedTask(id, n = 3) {
  return {
    id,
    status: 'done',
    createdAt: Date.now(),
    finishedAt: Date.now(),
    mergedSubmitted: true,
    mergeKeys: Array.from({ length: n }, (_, i) => `${id}/000${i + 1}.flv`),
    mp4State: 'failed',
    mergeError: '转码超时：超过等待上限仍未在 OpenList 看到 MP4',
    segmentCount: n,
    segmentsUploaded: 0,
    segments: Array.from({ length: n }, (_, i) => ({
      index: i + 1,
      r2Key: `${id}/000${i + 1}.flv`,
      mp4State: 'staged',
      remotePath: '',
    })),
  };
}

test('合并失败（段是 staged）：remove 默认保留全部源分段', async (t) => {
  const { mgr, deleted, cleanup } = await makeMgr();
  t.after(cleanup);

  const id = 'merged-failed-remove';
  mgr.tasks.set(id, mergedFailedTask(id));

  await mgr.remove(id);

  assert.deepEqual(
    deleted,
    [],
    `合并失败时源分段必须保留，实际删了 ${deleted.length} 个：${deleted.join(',')}`,
  );
  assert.equal(mgr.tasks.has(id), false, '任务本身应该从列表移除');
});

test('合并失败（段是 staged）：clearFinished 也保留全部源分段', async (t) => {
  const { mgr, deleted, cleanup } = await makeMgr();
  t.after(cleanup);

  const id = 'merged-failed-clear';
  mgr.tasks.set(id, mergedFailedTask(id));

  const r = await mgr.clearFinished();

  assert.deepEqual(deleted, [], '批量清理绝不能烧掉合并失败的源分段');
  assert.equal(r.kept, 1, '应报告有 1 条任务因保留源文件未清理');
  assert.equal(mgr.tasks.has(id), true, '这类任务必须留在列表里，否则界面上再也找不到');
});

test('合并失败：remove({force:true}) 才真的删源分段', async (t) => {
  const { mgr, deleted, cleanup } = await makeMgr();
  t.after(cleanup);

  const id = 'merged-failed-force';
  mgr.tasks.set(id, mergedFailedTask(id, 2));

  await mgr.remove(id, { force: true });

  assert.deepEqual(
    deleted.sort(),
    ['merged-failed-force/0001.flv', 'merged-failed-force/0002.flv'],
    `force 时应该全删，实际：${deleted.join(',')}`,
  );
});

test('合并成功（段是 merged）：源分段正常删除', async (t) => {
  const { mgr, deleted, cleanup } = await makeMgr();
  t.after(cleanup);

  const id = 'merged-done';
  const task = mergedFailedTask(id, 2);
  task.mp4State = 'done';
  task.mergeError = '';
  task.remotePath = '/cloudfetch/x/live.mp4';
  for (const s of task.segments) s.mp4State = 'merged';
  mgr.tasks.set(id, task);

  await mgr.remove(id);

  assert.deepEqual(
    deleted.sort(),
    ['merged-done/0001.flv', 'merged-done/0002.flv'],
    '合并成功后 R2 源文件没有保留价值，应该清掉',
  );
});
