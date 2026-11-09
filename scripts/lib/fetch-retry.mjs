/**
 * 带重试的 fetch（Actions 侧转码 worker 用）。
 *
 * 抽成独立模块的原因：worker 的 main() 在 import 时就执行，且依赖 ffmpeg，
 * 没法在单测里跑到上传阶段。而「哪些错误该重试」是这里最容易写错、
 * 也最影响长任务成败的部分，必须能单独验证。
 *
 * 规则：
 *   - 2xx            → 直接返回
 *   - 409 / 429 / 5xx → 退避重试
 *   - 其它 4xx        → 参数问题，立刻失败
 *   - 网络错误        → 重试
 *
 * body 必须是字符串或 Buffer（可重放）；流式 body 重试会失败。
 */

export async function fetchRetry(
  url,
  opts = {},
  { attempts = 4, label = '请求', log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {},
) {
  let lastErr;

  for (let i = 1; i <= attempts; i++) {
    let retryable = true;
    try {
      const res = await fetch(url, opts);
      if (res.ok) return res;

      const txt = await res.text().catch(() => '');
      lastErr = new Error(`${label} HTTP ${res.status} ${txt.slice(0, 200)}`);
      retryable = res.status === 409 || res.status === 429 || res.status >= 500;
    } catch (e) {
      lastErr = e;
      retryable = true;
    }

    if (!retryable || i === attempts) break;
    log(`  ${label} 第 ${i}/${attempts} 次失败：${lastErr.message}，${i}s 后重试`);
    await sleep(1000 * i);
  }

  throw lastErr;
}
