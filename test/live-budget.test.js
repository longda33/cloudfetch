/**
 * 直播录制时长上限的预算计算。
 *
 * 这里钉住一个真实 bug：到达 maxSeconds 后 ffmpeg 正常退出（code 0），
 * 外层 while 循环不会报错、也不会命中「连续无数据」，于是立刻重连；
 * 此时剩余量算成 0，而 0 的语义是「不限」→ 无限录制。
 *
 * 实测（真实 ffmpeg + 无限推流）：修复前 45 秒仍在 downloading，
 * 修复后 7 秒结束、3 段。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  remainingRecordSeconds,
  recordingBudgetExhausted,
} from '../src/downloader.js';

test('未设上限时剩余量恒为 0（0 表示不限）', () => {
  assert.equal(remainingRecordSeconds(0, 0), 0);
  assert.equal(remainingRecordSeconds(999, 0), 0);
  assert.equal(recordingBudgetExhausted(999, 0), false, '不限就不该判定为录满');
});

test('正常推进时剩余量递减', () => {
  assert.equal(remainingRecordSeconds(0, 1800), 1800);
  assert.equal(remainingRecordSeconds(600, 1800), 1200);
  assert.equal(remainingRecordSeconds(1799, 1800), 1);
});

test('录满时剩余量为 0，且必须判定为「该停止」', () => {
  assert.equal(remainingRecordSeconds(1800, 1800), 0);
  assert.equal(recordingBudgetExhausted(1800, 1800), true);

  // 关键：剩余量 0 不能被当成"不限"继续录
  assert.equal(recordingBudgetExhausted(1800, 1800), true);
});

test('超出上限（最后一段通常会超一点）仍然判定为录满', () => {
  assert.equal(remainingRecordSeconds(1802, 1800), 0, '不能返回负数');
  assert.equal(recordingBudgetExhausted(1802, 1800), true);
});

test('没有产出任何分段时不算录满', () => {
  assert.equal(recordingBudgetExhausted(0, 1800), false);
});

test('异常输入不会算出负数', () => {
  assert.equal(remainingRecordSeconds(-5, 1800), 1800);
  assert.equal(remainingRecordSeconds(NaN, 1800), 1800);
});
