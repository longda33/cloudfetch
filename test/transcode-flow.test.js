/**
 * 转码链路的回归测试。
 *
 * 钉住三件事（都是真实踩过的）：
 *   1) 分段不会被重复提交转码 —— 之前录制时提交一次、任务收尾又提交一次
 *   2) "已提交"不等于"已完成" —— remotePath 必须等 MP4 真在 OpenList 出现才写
 *   3) 转码失败后能从 R2 源文件重试，不需要重新录制
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'cf-tc-'));
process.env.DATA_DIR = TMP;
process.env.TMP_DIR = path.join(TMP, 'tmp');
process.env.PANEL_PASSWORD = 'test-password';
process.env.SESSION_SECRET = 'test-secret-transcode';
process.env.OPENLIST_URL = 'http://openlist.test';
process.env.OPENLIST_TOKEN = 'ol-token';
process.env.DELETE_AFTER_UPLOAD = 'true';
process.env.R2_ACCOUNT_ID = 'acct';
process.env.R2_ACCESS_KEY_ID = 'ak';
process.env.R2_SECRET_ACCESS_KEY = 'sk';
process.env.R2_BUCKET = 'bucket';
process.env.GH_REPO = 'user/repo';
process.env.GH_TOKEN = 'gh-token';
process.env.TRANSCODE_ENABLED = 'true';
// 轮询器在测试里手动调用，别让定时器插进来
process.env.TRANSCODE_POLL_INTERVAL = '3600000';

const calls = [];
/** OpenList 里是否"已经有"目标 MP4 */
let openlistHas = false;

const jsonRes = (obj) =>
  new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = String(opts.method || 'GET').toUpperCase();
  try {
    await opts.body?.cancel?.();
  } catch {
    /* ignore */
  }

  if (u.includes('api.github.com')) {
    calls.push('dispatch');
    return new Response(null, { status: 204 });
  }
  if (u.includes('r2.cloudflarestorage')) {
    calls.push(`${m.toLowerCase()}-r2`);
    return new Response('ok', {
      status: 200,
      headers: { 'content-length': '123' },
    });
  }
  if (u.includes('/api/fs/get')) {
    calls.push('ol-get');
    return openlistHas ? jsonRes({ code: 200, data: { name: 'x.mp4' } }) : jsonRes({ code: 500, message: 'not found' });
  }
  if (u.includes('/api/fs/')) {
    calls.push('ol-api');
    return jsonRes({ code: 200, data: {} });
  }
  return new Response('{}', { status: 200 });
};

const { getTaskManager, STATUS } = await import('../src/tasks.js');
const { config } = await import('../src/config.js');

const mgr = getTaskManager();
const count = (kind) => calls.filter((c) => c === kind).length;

/** 造一个"直播录完、每段都已提交转码"的任务 */
function makeLiveTask(id, { mp4State = 'pending' } = {}) {
  const t = {
    id,
    url: 'http://example.com/live.flv',
    baseName: 'live_x',
    filename: '%04d_live_x.flv',
    kind: 'live',
    live: true,
    upload: true,
    segment: true,
    status: STATUS.DONE,
    createdAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: Date.now(),
    size: 4096,
    downloaded: 4096,
    total: 4096,
    percent: 100,
    speed: 0,
    eta: 0,
    uploaded: 0,
    phase: '转码中',
    remotePath: '',
    expectedPath: '',
    localPath: '',
    mp4State: 'none',
    segmentsSubmitted: 2,
    segmentCount: 2,
    segmentsUploaded: 0,
    error: '',
    failedSegments: [],
    logs: [],
    segments: [
      {
        index: 1,
        filename: '0001_live_x.flv',
        size: 2048,
        remotePath: '',
        expectedPath: '/cloudfetch/2026-11-08/live_x_abcd/0001_live_x.mp4',
        mp4State,
        r2Key: `cloudfetch/${id}/0001_live_x.flv`,
        submittedAt: Date.now(),
        localPath: path.join(config.tmpDir, id, '0001_live_x.flv'),
      },
      {
        index: 2,
        filename: '0002_live_x.flv',
        size: 2048,
        remotePath: '',
        expectedPath: '/cloudfetch/2026-11-08/live_x_abcd/0002_live_x.mp4',
        mp4State,
        r2Key: `cloudfetch/${id}/0002_live_x.flv`,
        submittedAt: Date.now(),
        localPath: path.join(config.tmpDir, id, '0002_live_x.flv'),
      },
    ],
  };
  mgr.tasks.set(id, t);
  return t;
}

test.after(async () => {
  // 先同步落盘再删目录，否则 1 秒防抖的异步写会在删完之后报 ENOENT
  mgr.flushState();
  await fsp.rm(TMP, { recursive: true, force: true });
});

test('转码中的段不会被再次提交（防重复跑 Actions）', async () => {
  const t = makeLiveTask('live-pending', { mp4State: 'pending' });
  calls.length = 0;

  await assert.rejects(() => mgr.retryFailedSegments(t.id), /没有待重试的段/);
  assert.equal(count('dispatch'), 0, 'pending 的段不该再触发转码');
});

test('转码失败可以从 R2 源文件重试，只触发一次', async () => {
  const t = makeLiveTask('live-failed', { mp4State: 'failed' });
  // 本地文件已删（默认 deleteAfterUpload=true），只剩 R2 源文件
  calls.length = 0;

  const r = await mgr.retryFailedSegments(t.id);

  assert.equal(r.submitted, 2, `应重新提交 2 段，实际 ${r.submitted}（${JSON.stringify(t.failedSegments)}）`);
  assert.equal(count('dispatch'), 2, `每段只该触发一次，实际 ${count('dispatch')} 次`);
  assert.equal(count('put-r2'), 0, '本地已删时应复用 R2 源文件，不该重传');

  for (const s of t.segments) {
    assert.equal(s.mp4State, 'pending', '重试后应回到 pending');
    assert.equal(s.remotePath, '', '确认落地前不能写 remotePath');
  }
});

test('确认落地后才写 remotePath，并把任务推进到已完成', async () => {
  const t = makeLiveTask('live-confirm', { mp4State: 'pending' });
  openlistHas = true;
  calls.length = 0;

  await mgr._confirmTranscodes();

  for (const s of t.segments) {
    assert.equal(s.mp4State, 'done', 'OpenList 里有文件就该标记 done');
    assert.equal(s.remotePath, s.expectedPath, 'remotePath 应等于预期路径');
  }
  assert.equal(t.segmentsUploaded, 2);
  assert.equal(t.phase, '已完成', '全部落地后 phase 应回到已完成');
  assert.equal(t.status, STATUS.DONE);
  openlistHas = false;
});

test('超过超时时间仍未落地则标记失败，并计入历史', async () => {
  const t = makeLiveTask('live-timeout', { mp4State: 'pending' });
  // 把提交时间推回到超时之前
  const old = Date.now() - config.transcode.timeoutMs - 60_000;
  for (const s of t.segments) s.submittedAt = old;
  openlistHas = false;

  await mgr._confirmTranscodes();

  assert.equal(t.segments[0].mp4State, 'failed');
  assert.equal(t.segments[0].remotePath, '', '失败时不能留下一个不存在的路径');

  const rec = mgr._historyRecord(t);
  assert.equal(rec.transcodeFailed, 2, '历史记录应带上转码失败数');
  assert.equal(rec.transcodePending, 0);
});

test('删除任务：默认保留失败分段的 R2 源文件，force 才清', async () => {
  /**
   * 这条测试原来断言的是旧行为「删除任务会清掉失败的 R2 源文件」。
   *
   * 那个行为出过事故：一场 2.4 小时直播转码超时，用户看到"失败"
   * 就点删除，29 段源文件全被清掉，修好后也没法重跑，直播永久丢失。
   *
   * 现在的规则反过来了：失败分段默认**保留**，只有 force 才删。
   * 详细的分支覆盖见 test/keep-failed-segments.test.js，
   * 这里保留一条最核心的对照，防止有人把默认值改回去。
   */
  const t = makeLiveTask('live-dispose', { mp4State: 'failed' });
  calls.length = 0;
  mgr._disposeTask(t);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(count('delete-r2'), 0, '默认不该删失败分段的源文件');

  // force 时才删
  const t2 = makeLiveTask('live-dispose-force', { mp4State: 'failed' });
  calls.length = 0;
  mgr._disposeTask(t2, { force: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(count('delete-r2'), 2, 'force 时应清理失败分段的源文件');

  // 正在转码的无论如何都不删
  const t3 = makeLiveTask('live-dispose-2', { mp4State: 'pending' });
  calls.length = 0;
  mgr._disposeTask(t3, { force: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(count('delete-r2'), 0, '正在转码的源文件不能删（Actions 还在下载）');
});

test('提交转码的旧入口已移除（防止有人又接回去）', () => {
  assert.equal(typeof mgr._submitTranscodes, 'undefined');
});
