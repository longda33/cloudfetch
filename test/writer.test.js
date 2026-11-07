import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openWriter, pipeInto } from '../src/util/writer.js';

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cf-writer-'));

test('正常写入并落盘', async () => {
  const p = path.join(tmpDir, 'a.bin');
  const w = openWriter(p);
  await w.write(Buffer.from('hello '));
  await w.write(Buffer.from('world'));
  await w.end();
  assert.equal(await fsp.readFile(p, 'utf8'), 'hello world');
});

test('追加模式不清空原内容', async () => {
  const p = path.join(tmpDir, 'b.bin');
  await fsp.writeFile(p, 'abc');
  const w = openWriter(p, 'a');
  await w.write(Buffer.from('def'));
  await w.end();
  assert.equal(await fsp.readFile(p, 'utf8'), 'abcdef');
});

test('目录不存在时 end() 以错误拒绝，而不是永久挂起', async () => {
  const w = openWriter(path.join(tmpDir, 'no-such-dir', 'c.bin'));
  await assert.rejects(() => w.end(), /ENOENT/);
});

test('pipeInto 顺序拼接多个文件', async () => {
  const a = path.join(tmpDir, 'p1');
  const b = path.join(tmpDir, 'p2');
  const out = path.join(tmpDir, 'p3');
  await fsp.writeFile(a, 'foo');
  await fsp.writeFile(b, 'bar');
  const w = openWriter(out);
  await pipeInto(w, a);
  await pipeInto(w, b);
  await w.end();
  assert.equal(await fsp.readFile(out, 'utf8'), 'foobar');
});

test('pipeInto 遇到不存在的源文件会抛错', async () => {
  const out = path.join(tmpDir, 'p4');
  const w = openWriter(out);
  await assert.rejects(() => pipeInto(w, path.join(tmpDir, 'nope')));
  w.destroy();
});
