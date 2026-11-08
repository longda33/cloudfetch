/**
 * 登录限流的回归测试。
 *
 * 核心是那条曾经踩过的坑：**成功登录不能计数**。
 * 之前把计数写在检查里，同一 IP 登录 20 次之后正确密码也会被 429 挡住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoginGuard } from '../src/util/login-guard.js';

test('连续 20 次密码错误后封禁', () => {
  const g = createLoginGuard({ maxAttempts: 20 });
  for (let i = 0; i < 20; i++) {
    assert.equal(g.blocked('1.1.1.1'), false, `第 ${i + 1} 次不该被封`);
    g.noteFailure('1.1.1.1');
  }
  assert.equal(g.blocked('1.1.1.1'), true, '第 20 次失败后应封禁');
});

test('成功登录不计数，连登 50 次也不会被封', () => {
  const g = createLoginGuard({ maxAttempts: 20 });
  for (let i = 0; i < 50; i++) {
    assert.equal(g.blocked('2.2.2.2'), false, `第 ${i + 1} 次成功登录后被误封`);
    // 成功登录只调 clear，不调 noteFailure
    g.clear('2.2.2.2');
  }
});

test('成功登录会清掉之前的失败计数', () => {
  const g = createLoginGuard({ maxAttempts: 20 });
  for (let i = 0; i < 19; i++) g.noteFailure('3.3.3.3');
  assert.equal(g.blocked('3.3.3.3'), false, '19 次失败还没到上限');

  g.clear('3.3.3.3'); // 用户这次输对了
  for (let i = 0; i < 19; i++) g.noteFailure('3.3.3.3');
  assert.equal(g.blocked('3.3.3.3'), false, '清零后应该重新计 19 次');
});

test('不同来源互不影响', () => {
  const g = createLoginGuard({ maxAttempts: 3 });
  for (let i = 0; i < 3; i++) g.noteFailure('a');
  assert.equal(g.blocked('a'), true);
  assert.equal(g.blocked('b'), false, '别的 IP 不该被连坐');
});

test('超过时间窗口后自动解封', async () => {
  const g = createLoginGuard({ maxAttempts: 2, windowMs: 60 });
  g.noteFailure('4.4.4.4');
  g.noteFailure('4.4.4.4');
  assert.equal(g.blocked('4.4.4.4'), true);
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(g.blocked('4.4.4.4'), false, '窗口过期后应放行');
});

test('来源过多时清空，内存不会无限增长', () => {
  const g = createLoginGuard({ maxAttempts: 5, maxEntries: 10 });
  for (let i = 0; i < 30; i++) g.noteFailure(`ip-${i}`);
  assert.ok(g.size <= 11, `map 大小应受控，实际 ${g.size}`);
});
