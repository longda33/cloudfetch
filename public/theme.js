/**
 * 主题初始化。
 *
 * 必须在首帧前执行（放在 <head> 里、样式表之前），否则会先渲染一帧默认主题
 * 再跳变，视觉上就是"闪白"。
 *
 * 之所以单独成文件而不是内联：CSP 的 script-src 'self' 不允许内联脚本，
 * 而内联脚本的哈希/nonce 方案会随 HTML 改动静默失效。
 */
try {
  var saved = localStorage.getItem('cf-theme');
  document.documentElement.dataset.theme =
    saved || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
} catch (e) {
  /* 隐私模式下 localStorage 会抛异常，忽略即可，用默认深色 */
}
