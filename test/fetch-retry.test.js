/**
 * fetchRetry 的行为测试。
 *
 * 这是 Actions 侧转码 worker 唯一的重试兜底：一次任务跑 2-4 小时，
 * 上传阶段一个 502 就整场失败。之前 worker 只对 409/429 重试，
 * 其它 5xx 直接放弃 —— 这组用例把「哪些错误该重试」钉死。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchRetry } from '../scripts/lib/fetch-retry.mjs';

/** 起一个按脚本应答的服务器；script 是状态码数组，用完后返回 200 */
async function withServer(script, fn) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    await new Promise((r) => req.on('end', r).resume());
    calls.push(req.url);
    const code = script.length ? script.shift() : 200;
    res.writeHead(code, { 'content-type': 'text/plain' });
    res.end(code === 200 ? 'ok' : `fail-${code}`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/x`;
  try {
    return await fn(url, calls);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** 不真的等退避 */
const fast = { sleep: async () => {} };

test('502 会重试并最终成功', async () => {
  await withServer([502, 502], async (url, calls) => {
    const res = await fetchRetry(url, { method: 'PUT', body: 'x' }, { attempts: 4, ...fast });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 3, `应请求 3 次（2 次 502 + 1 次成功），实际 ${calls.length}`);
  });
});

test('500 / 503 也重试', async () => {
  await withServer([500, 503], async (url, calls) => {
    const res = await fetchRetry(url, { method: 'PUT', body: 'x' }, { attempts: 4, ...fast });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 3);
  });
});

test('429 重试', async () => {
  await withServer([429], async (url, calls) => {
    const res = await fetchRetry(url, {}, { attempts: 3, ...fast });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 2);
  });
});

test('404 不重试，直接失败', async () => {
  await withServer([404, 200], async (url, calls) => {
    await assert.rejects(
      () => fetchRetry(url, {}, { attempts: 4, ...fast }),
      /HTTP 404/,
    );
    assert.equal(calls.length, 1, '4xx 是参数问题，不该重试');
  });
});

test('重试次数用尽后抛出最后一次错误', async () => {
  await withServer([502, 502, 502], async (url, calls) => {
    await assert.rejects(
      () => fetchRetry(url, {}, { attempts: 3, ...fast }),
      /HTTP 502/,
    );
    assert.equal(calls.length, 3);
  });
});

test('连接失败（网络错误）也会重试', async () => {
  // 先占一个端口再关掉，确保连接会被拒绝
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));

  let sleeps = 0;
  await assert.rejects(() =>
    fetchRetry(
      `http://127.0.0.1:${port}/x`,
      {},
      { attempts: 3, sleep: async () => { sleeps++; } },
    ),
  );
  assert.equal(sleeps, 2, '3 次尝试之间应该退避 2 次，说明网络错误确实重试了');
});

test('重试时会打印带次数的日志', async () => {
  await withServer([502], async (url) => {
    const logs = [];
    await fetchRetry(url, {}, { attempts: 2, sleep: async () => {}, log: (m) => logs.push(m) });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /第 1\/2 次失败.*502.*重试/);
  });
});
