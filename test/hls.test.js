import test from 'node:test';
import assert from 'node:assert/strict';
import { hlsNeedsFfmpeg } from '../src/downloader.js';

const BASE = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:4',
  '#EXTINF:4.0,',
  'seg0.ts',
  '#EXT-X-ENDLIST',
  '',
].join('\n');

test('普通 TS 播放列表不需要 ffmpeg', () => {
  assert.equal(hlsNeedsFfmpeg(BASE), false);
});

test('AES-128 加密需要 ffmpeg（自己拼出来是密文）', () => {
  const p = BASE.replace('#EXTINF', '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF');
  assert.equal(hlsNeedsFfmpeg(p), true);
});

test('SAMPLE-AES 加密需要 ffmpeg', () => {
  const p = BASE.replace('#EXTINF', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"\n#EXTINF');
  assert.equal(hlsNeedsFfmpeg(p), true);
});

test('METHOD=NONE 表示未加密，不需要 ffmpeg', () => {
  const p = BASE.replace('#EXTINF', '#EXT-X-KEY:METHOD=NONE\n#EXTINF');
  assert.equal(hlsNeedsFfmpeg(p), false);
});

test('EXT-X-MAP（fMP4）需要 ffmpeg', () => {
  const p = BASE.replace('#EXTINF', '#EXT-X-MAP:URI="init.mp4"\n#EXTINF');
  assert.equal(hlsNeedsFfmpeg(p), true);
});
