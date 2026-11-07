import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

/**
 * 配置模块在 import 时就读取环境变量，所以必须先把环境准备好再动态导入。
 * node --test 每个测试文件跑在独立进程里，不会互相污染。
 */
process.env.DATA_DIR = path.join(os.tmpdir(), `cloudfetch-test-${process.pid}`);
process.env.MAX_CONCURRENT = '';
process.env.MAX_FILE_SIZE = '';
process.env.LIVE_SEGMENT_SECONDS = '';
delete process.env.SESSION_SECRET;

const { config } = await import('../src/config.js');
const { buildRemotePath } = await import('../src/openlist.js');

test('空字符串环境变量回退到默认值（Number("") === 0 的坑）', () => {
  assert.equal(config.download.maxConcurrent, 2);
  assert.equal(config.download.maxFileSize, 20 * 1024 * 1024 * 1024);
  assert.equal(config.download.liveSegmentSeconds, 1800);
});

test('未配置 SESSION_SECRET 时随机生成，绝不能是硬编码默认值', () => {
  assert.match(config.auth.secret, /^[0-9a-f]{64}$/);
  assert.notEqual(config.auth.secret, 'cloudfetch-default-secret-change-me');
});

test('远端路径包含任务短 id，且日期目录按任务创建时间算', () => {
  const created = new Date(2026, 0, 2, 10, 0, 0).getTime();
  const p = buildRemotePath('0001_a.flv', {
    taskId: 'abcd1234efgh',
    baseName: 'live_20260101',
    date: created,
  });
  assert.ok(p.includes('/2026-01-02/'), p);
  assert.ok(p.includes('live_20260101_abcd1234'), p);
  assert.ok(p.endsWith('/0001_a.flv'), p);
});
