/**
 * 新增的两个表单选项：输出方式（mode）和录制时长（maxSeconds）。
 *
 * 这两个参数从「网页表单 → /api/tasks → TaskManager.create → 任务对象」
 * 一路透传，中间任何一环漏了都会静默失效 —— 用户选了「不限」却录 5 分钟，
 * 或者选了 remux 却走了 cfr，都不会报错，只会产出和预期不符的东西。
 *
 * 所以这里直接测 create() 的落库结果，不测 HTTP 层：
 * 参数真正存进任务对象，后续链路才可能读到。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'cf-opts-'));
process.env.DATA_DIR = TMP;
process.env.TMP_DIR = path.join(TMP, 'tmp');
process.env.PANEL_PASSWORD = 'test-password';
process.env.SESSION_SECRET = 'test-secret-opts';

const { TaskManager } = await import('../src/tasks.js');

function fresh() {
  return new TaskManager();
}

test('mode 默认是 cfr（不传时）', () => {
  const mgr = fresh();
  const t = mgr.create({ url: 'https://example.com/a.mp4' });
  assert.equal(t.mode, 'cfr');
});

test('mode=remux 能存下来', () => {
  const mgr = fresh();
  const t = mgr.create({ url: 'https://example.com/a.mp4', mode: 'remux' });
  assert.equal(t.mode, 'remux');
});

test('mode 传非法值时退回 cfr，不抛错', () => {
  const mgr = fresh();
  // 前端被改坏、或者有人手工打 API 时可能出现任意字符串
  for (const bad of ['CFR', 'copy', '', null, undefined, 'REMUX ', 123]) {
    const t = mgr.create({ url: 'https://example.com/a.mp4', mode: bad });
    assert.equal(t.mode, 'cfr', `mode=${JSON.stringify(bad)} 应退回 cfr`);
  }
});

test('maxSeconds 默认 0（不限）', () => {
  const mgr = fresh();
  const t = mgr.create({ url: 'https://example.com/a.mp4' });
  assert.equal(t.maxSeconds, 0);
});

test('maxSeconds 正常值能存下来', () => {
  const mgr = fresh();
  for (const sec of [1800, 3600, 7200, 10800, 21600]) {
    const t = mgr.create({ url: 'https://example.com/a.mp4', maxSeconds: sec });
    assert.equal(t.maxSeconds, sec);
  }
});

test('maxSeconds 字符串数字也能识别（表单 value 都是字符串）', () => {
  const mgr = fresh();
  const t = mgr.create({ url: 'https://example.com/a.mp4', maxSeconds: '3600' });
  assert.equal(t.maxSeconds, 3600);
});

test('maxSeconds 负数归零，超上限截断到 24 小时', () => {
  const mgr = fresh();
  // 负数和垃圾值都当成「不限」，不能让 ffmpeg 收到 -t -5
  for (const bad of [-1, -999, NaN, 'abc', null, undefined, {}]) {
    const t = mgr.create({ url: 'https://example.com/a.mp4', maxSeconds: bad });
    assert.equal(t.maxSeconds, 0, `maxSeconds=${JSON.stringify(bad)} 应为 0`);
  }
  // 24 小时上限：防止有人传个巨大数字把 ffmpeg 挂到天荒地老
  const t = mgr.create({ url: 'https://example.com/a.mp4', maxSeconds: 999999 });
  assert.equal(t.maxSeconds, 86400);
});

test('两个参数同时传都生效', () => {
  const mgr = fresh();
  const t = mgr.create({
    url: 'https://example.com/live.flv',
    mode: 'remux',
    maxSeconds: 7200,
  });
  assert.equal(t.mode, 'remux');
  assert.equal(t.maxSeconds, 7200);
});

test('cleanup', async () => {
  await fsp.rm(TMP, { recursive: true, force: true });
});
