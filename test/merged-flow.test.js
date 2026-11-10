/**
 * 「整场合并转码」链路的回归测试。
 *
 * 这组用例钉住的是 01a6dea 之后暴露出来的问题：
 *   1) dispatch 的字段必须都在 workflow 里声明过（否则 GitHub 返回 422）
 *   2) 合并提交后必须进入 pending，轮询器才可能确认到 MP4
 *   3) 历史记录要把合并任务当成"一个 MP4"，而不是"N 段未完成"
 *   4) 重试必须是「重新提交一次合并」，不能退化成逐段转码
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'cf-merged-'));
process.env.DATA_DIR = TMP;
process.env.TMP_DIR = path.join(TMP, 'tmp');
process.env.PANEL_PASSWORD = 'test-password';
process.env.SESSION_SECRET = 'test-secret-merged';
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
process.env.TRANSCODE_POLL_INTERVAL = '3600000';

const calls = [];
/** 每次 dispatch 发出的 inputs，用来断言字段与次数 */
const dispatched = [];
let openlistHas = false;

const jsonRes = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
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
    try {
      dispatched.push(JSON.parse(opts.body || '{}').inputs || {});
    } catch {
      dispatched.push({});
    }
    return new Response(null, { status: 204 });
  }
  if (u.includes('r2.cloudflarestorage')) {
    calls.push(`${m.toLowerCase()}-r2`);
    return new Response('ok', { status: 200, headers: { 'content-length': '123' } });
  }
  if (u.includes('/api/fs/get')) {
    calls.push('ol-get');
    return openlistHas
      ? jsonRes({ code: 200, data: { name: 'x.mp4' } })
      : jsonRes({ code: 500, message: 'not found' });
  }
  if (u.includes('/api/fs/')) {
    calls.push('ol-api');
    return jsonRes({ code: 200, data: {} });
  }
  return new Response('{}', { status: 200 });
};

const { getTaskManager, STATUS } = await import('../src/tasks.js');
const { config } = await import('../src/config.js');
const { buildTranscodeInputs } = await import('../src/transcode.js');

const mgr = getTaskManager();
const count = (kind) => calls.filter((c) => c === kind).length;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 造一个「录完 3 段、已提交合并转码」的任务 */
function makeMergedTask(id, { mp4State = 'pending', withRemote = false } = {}) {
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
    size: 3072,
    downloaded: 3072,
    total: 3072,
    percent: 100,
    speed: 0,
    eta: 0,
    uploaded: 0,
    phase: '合并转码中',
    remotePath: withRemote ? '/cloudfetch/2026-11-08/live_x_abcd/live_x.mp4' : '',
    expectedPath: '/cloudfetch/2026-11-08/live_x_abcd/live_x.mp4',
    localPath: '',
    mp4State,
    mp4SubmittedAt: Date.now(),
    mergedSubmitted: mp4State === 'pending' || mp4State === 'done',
    mergeKeys: [1, 2, 3].map((i) => `cloudfetch/${id}/000${i}_live_x.flv`),
    segmentsSubmitted: 3,
    segmentCount: 3,
    segmentsUploaded: withRemote ? 3 : 0,
    error: '',
    failedSegments: [],
    logs: [],
    segments: [1, 2, 3].map((i) => ({
      index: i,
      filename: `000${i}_live_x.flv`,
      size: 1024,
      remotePath: '',
      expectedPath: '',
      mp4State: withRemote ? 'merged' : 'staged',
      r2Key: `cloudfetch/${id}/000${i}_live_x.flv`,
      localPath: path.join(config.tmpDir, id, `000${i}_live_x.flv`),
    })),
  };
  mgr.tasks.set(id, t);
  return t;
}

test.after(async () => {
  mgr.flushState();
  await fsp.rm(TMP, { recursive: true, force: true });
});

test('dispatch 发送的每个字段都在 workflow 的 inputs 里声明过', async () => {
  const yml = await fsp.readFile(
    path.join(ROOT, '.github', 'workflows', 'transcode.yml'),
    'utf8',
  );
  const block = yml.split('inputs:')[1].split(/\nconcurrency:/)[0];
  const declared = new Set([...block.matchAll(/^ {6}([a-z0-9_]+):/gm)].map((m) => m[1]));

  const sent = Object.keys(
    buildTranscodeInputs({ r2Keys: ['a'], outName: 'x.mp4', openlistDir: '/d', taskId: 't' }),
  );
  const undeclared = sent.filter((k) => !declared.has(k));
  assert.deepEqual(
    undeclared,
    [],
    `这些字段没在 workflow 里声明，GitHub 会返回 422 Unexpected inputs provided：${undeclared.join(', ')}`,
  );

  // 单文件模式同样要全部声明（r2_key 用来清理 R2 源文件）
  const single = Object.keys(
    buildTranscodeInputs({
      sourceUrl: 'https://x/y',
      r2Key: 'k',
      outName: 'x.mp4',
      openlistDir: '/d',
      taskId: 't',
    }),
  );
  assert.deepEqual(single.filter((k) => !declared.has(k)), []);
});

test('合并任务提交后必须处于 pending，否则轮询器永远确认不到', () => {
  const t = makeMergedTask('merged-pending');
  assert.equal(t.mp4State, 'pending');
  assert.ok(t.expectedPath, '必须记下预期路径供轮询器查询');
});

test('转码超时必须比 workflow 的 timeout-minutes 更长', async () => {
  const yml = await fsp.readFile(
    path.join(ROOT, '.github', 'workflows', 'transcode.yml'),
    'utf8',
  );
  const m = yml.match(/timeout-minutes:\s*(\d+)/);
  assert.ok(m, 'transcode.yml 里应该有 timeout-minutes');

  const jobMinutes = Number(m[1]);
  const svcMinutes = config.transcode.timeoutMs / 60000;
  assert.ok(
    svcMinutes > jobMinutes,
    `服务端超时 ${svcMinutes} 分钟必须大于 workflow 的 ${jobMinutes} 分钟；` +
      '否则 Actions 还在跑就被判失败，用户点重试会排队跑第二遍',
  );
});

test('历史记录只保留少量分段明细，避免 history.json 膨胀', () => {
  const t = makeMergedTask('merged-big');
  // 一场 3 小时直播 ≈ 288 段
  t.segments = Array.from({ length: 288 }, (_, i) => ({
    index: i + 1,
    filename: `0${i + 1}_live_x.flv`,
    size: 50 * 1024 * 1024,
    remotePath: '',
    expectedPath: '',
    mp4State: 'staged',
    r2Key: `cloudfetch/${t.id}/0${i + 1}_live_x.flv`,
    localPath: '',
  }));
  t.segmentCount = 288;
  t.segmentsSubmitted = 288;

  const rec = mgr._historyRecord(t);

  assert.equal(rec.segmentCount, 288, '聚合字段必须保留完整数字');
  assert.equal(rec.segmentsSubmitted, 288);
  assert.ok(
    rec.segments.length <= 20,
    `明细应截断到 20 条，实际 ${rec.segments.length}`,
  );

  const bytes = Buffer.byteLength(JSON.stringify(rec));
  assert.ok(
    bytes < 8 * 1024,
    `单条历史记录应小于 8KB（200 条约 1.6MB），实际 ${(bytes / 1024).toFixed(1)}KB`,
  );
});

test('轮询确认到 MP4 后写 remotePath，并把所有段标成 merged', async () => {
  const t = makeMergedTask('merged-confirm');
  openlistHas = true;
  calls.length = 0;

  await mgr._confirmTranscodes();

  assert.equal(t.remotePath, t.expectedPath, '确认后必须写 remotePath');
  assert.equal(t.mp4State, 'done');
  assert.equal(t.segmentsUploaded, 3, '合并完成时所有段一起算已落地');
  for (const s of t.segments) {
    assert.equal(s.mp4State, 'merged');
    assert.equal(s.remotePath, '', '段本身不在 OpenList，不能写 remotePath');
  }

  const rec = mgr._historyRecord(t);
  assert.equal(rec.merged, true);
  assert.equal(rec.segmentsUploaded, 3, '历史记录不能把已合并的段算成未完成');
  assert.equal(rec.transcodePending, 0);
  openlistHas = false;
});

test('合并超时标记 failed，历史记录带上原因', async () => {
  const t = makeMergedTask('merged-timeout');
  t.mp4SubmittedAt = Date.now() - config.transcode.timeoutMs - 60_000;
  openlistHas = false;

  await mgr._confirmTranscodes();

  assert.equal(t.mp4State, 'failed');
  assert.match(t.mergeError, /超时/);

  const rec = mgr._historyRecord(t);
  assert.equal(rec.merged, true);
  assert.equal(rec.transcodeFailed, 1, '合并任务算一个待重试项，不是 N 段');
  assert.match(rec.mergeError, /超时/);
});

test('已合并成功的任务不允许再重试', () => {
  const t = makeMergedTask('merged-done', { mp4State: 'done', withRemote: true });
  const r = mgr.canRetryUpload(t.id);
  assert.equal(r.ok, false);
  assert.match(r.error, /无需重试/);
});

test('合并失败后重试只触发一次合并，不逐段拆', async () => {
  const t = makeMergedTask('merged-retry', { mp4State: 'failed' });
  calls.length = 0;
  dispatched.length = 0;

  const r = await mgr.retryFailedSegments(t.id);

  assert.equal(r.merged, true);
  assert.equal(count('dispatch'), 1, `应只提交一次合并，实际 ${count('dispatch')} 次`);
  assert.equal(t.mp4State, 'pending', '重试后应回到 pending 等确认');
  assert.equal(t.mergedSubmitted, true);

  const inputs = dispatched[0];
  assert.equal(inputs.r2_keys.split(',').length, 3, '一次提交要带上全部段');
  assert.equal(inputs.out_name, 'live_x.mp4', '输出应是整场一个文件名');
});

test('重试合并要沿用任务的 mode，不能悄悄换成默认值', async () => {
  const t = makeMergedTask('merged-mode', { mp4State: 'failed' });
  t.mode = 'cfr'; // 用户特意选了重编码
  calls.length = 0;
  dispatched.length = 0;

  await mgr.retryFailedSegments(t.id);

  assert.equal(dispatched[0].mode, 'cfr', '重试时把 cfr 丢了，产物会变成 remux');
});

test('buildTranscodeInputs 不传 mode 时按默认 remux', () => {
  const inputs = buildTranscodeInputs({
    r2Keys: ['a'],
    outName: 'x.mp4',
    openlistDir: '/d',
    taskId: 't',
  });
  assert.equal(inputs.mode, 'remux', '默认输出方式应为原样封装');
  assert.equal(
    buildTranscodeInputs({ r2Keys: ['a'], outName: 'x.mp4', openlistDir: '/d', taskId: 't', mode: 'cfr' }).mode,
    'cfr',
  );
});

test('缺段时补传后再合并，仍然只提交一次', async () => {
  const t = makeMergedTask('merged-fill', { mp4State: 'failed' });
  // 第 2 段丢了 R2，但本地还在
  t.segments[1].r2Key = '';
  const local = path.join(config.tmpDir, t.id, t.segments[1].filename);
  await fsp.mkdir(path.dirname(local), { recursive: true });
  await fsp.writeFile(local, 'fake-flv');

  calls.length = 0;
  dispatched.length = 0;

  const r = await mgr.retryFailedSegments(t.id);

  assert.equal(r.uploaded, 1, '应补传 1 段');
  assert.equal(count('put-r2'), 1);
  assert.equal(count('dispatch'), 1, '补传后只提交一次合并');
  assert.equal(dispatched[0].r2_keys.split(',').length, 3);
});

test('合并转码进行中时删任务不清 R2；失败时默认保留，force 才清', async () => {
  const t = makeMergedTask('merged-dispose-pending', { mp4State: 'pending' });
  calls.length = 0;
  mgr._disposeTask(t);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(count('delete-r2'), 0, 'Actions 正在下载，不能删');

  /**
   * 合并失败：段是 staged、失败状态挂在任务上。
   * 这些源分段是重跑的唯一依据，默认必须保留 ——
   * 曾经因为按段级状态分类，29 段 1.42GB 被整场删光。
   */
  const t2 = makeMergedTask('merged-dispose-failed', { mp4State: 'failed' });
  calls.length = 0;
  mgr._disposeTask(t2);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(count('delete-r2'), 0, '失败时默认保留源分段，方便重跑');

  calls.length = 0;
  mgr._disposeTask(t2, { force: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(count('delete-r2'), 3, 'force 才允许清掉失败分段');
});

test('旧记录只有 mergeError 时也能识别成合并任务，走一次合并重试', async () => {
  const t = makeMergedTask('merged-legacy', { mp4State: 'failed' });
  // 模拟修复前写下的记录：没有 mergeKeys / mergedSubmitted
  delete t.mergedSubmitted;
  delete t.mergeKeys;
  t.mp4State = 'none';
  t.mergeError = '触发失败：HTTP 422 Unexpected inputs provided';

  calls.length = 0;
  dispatched.length = 0;

  const r = await mgr.retryFailedSegments(t.id);

  assert.equal(r.merged, true, '旧记录不能退化成逐段转码');
  assert.equal(count('dispatch'), 1);
  assert.equal(dispatched[0].out_name, 'live_x.mp4');
});

test('并发重试只执行一次（接口是 202，必须服务端加锁）', async () => {
  const t = makeMergedTask('merged-race', { mp4State: 'failed' });
  calls.length = 0;
  dispatched.length = 0;

  const results = await Promise.allSettled([
    mgr.retryFailedSegments(t.id),
    mgr.retryFailedSegments(t.id),
  ]);

  const okCount = results.filter((r) => r.status === 'fulfilled').length;
  assert.equal(okCount, 1, '只有一次应该成功');
  assert.equal(count('dispatch'), 1, `只能派一次合并，实际 ${count('dispatch')} 次`);
  assert.match(
    results.find((r) => r.status === 'rejected')?.reason?.message || '',
    /正在重试中/,
  );
});
