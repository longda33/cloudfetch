import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectKind,
  sanitizeFilename,
  filenameFromUrl,
  humanSize,
} from '../src/util/links.js';

test('detectKind 识别常见链接类型', () => {
  assert.equal(detectKind('https://a.com/v.m3u8'), 'hls');
  assert.equal(detectKind('https://a.com/live/index.m3u8?token=1'), 'hls');
  assert.equal(detectKind('https://a.com/v.mp4'), 'http');
  assert.equal(detectKind('rtmp://a.com/live/stream'), 'rtmp');
  assert.equal(detectKind('https://a.com/v.mpd'), 'dash');
});

test('sanitizeFilename 挡住路径穿越与非法字符', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(sanitizeFilename('a/b\\c.mp4'), 'a_b_c.mp4');
  assert.equal(sanitizeFilename('..hidden'), 'hidden');
  assert.equal(sanitizeFilename(''), '');
  assert.equal(sanitizeFilename('CON.txt'), '_CON.txt');
  assert.equal(sanitizeFilename('x'.repeat(300) + '.mp4').length, 180);
});

test('filenameFromUrl 遇到畸形百分号编码不会抛异常', () => {
  // 修复前这里会抛 URIError: URI malformed
  const name = filenameFromUrl('https://a.com/%zz/%E4%BD');
  assert.equal(typeof name, 'string');
  assert.ok(name.length > 0);
});

test('filenameFromUrl 保留已知扩展名，未知的补默认值', () => {
  assert.equal(filenameFromUrl('https://a.com/dir/movie.mp4'), 'movie.mp4');
  assert.equal(filenameFromUrl('https://a.com/dir/stream', 'flv'), 'stream.flv');
});

test('humanSize 处理边界值', () => {
  assert.equal(humanSize(0), '0 B');
  assert.equal(humanSize(-1), '—');
  assert.equal(humanSize(1024), '1.00 KB');
  assert.equal(humanSize(NaN), '—');
});
