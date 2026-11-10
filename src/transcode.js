/**
 * 转码调度：把录制好的文件丢到 R2，再触发 GitHub Actions 去转码。
 *
 * 为什么不在 Unikraft 上直接转：
 *   实例只有 1 vCPU，ffmpeg 转 30 分钟 1080p 要跑半小时以上，
 *   而且转码期间录制会被拖慢。GitHub Actions 免费给 4 核，
 *   公开仓库分钟数无限，把 CPU 活外包出去最划算。
 *
 * 完整链路：
 *   本地 FLV → R2 → workflow_dispatch → Actions 下载 → ffmpeg → 传 OpenList
 *
 * 注意：dispatch 返回 204 只代表"已排队"，不代表转码完成。
 * MP4 是否真的落地由 TaskManager 的轮询器去 OpenList 确认（见 tasks.js）。
 */
import { config } from './config.js';

export class TranscodeError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'TranscodeError';
    this.status = status;
  }
}

/**
 * 组装 workflow_dispatch 的 inputs。
 *
 * 集中在一处：GitHub 要求所有 input 都是字符串，而且字段名必须和
 * transcode.yml 里声明的一致。之前三个调用点各拼一遍，改一个字段
 * 很容易漏掉另外两个。
 */
export function buildTranscodeInputs({ sourceUrl, r2Key, r2Keys, outName, openlistDir, taskId, mode }) {
  /**
   * 返回的每个键都必须在 transcode.yml 的 `on.workflow_dispatch.inputs`
   * 里声明过。
   *
   * GitHub 的 dispatch 接口对未声明的 input 直接返回
   * 422 `Unexpected inputs provided: ["xxx"]`，整条转码链路会挂掉，
   * 而且报错信息里不会告诉你是哪个字段少了声明。
   * test/transcode-flow.test.js 里有一条用例专门比对这两个集合。
   */
  return {
    // 单文件模式用 source_url，多段合并模式用 r2_keys（逗号分隔）
    source_url: String(sourceUrl || ''),
    // 单文件模式下用来在 Actions 里删掉 R2 源文件（合并模式用 r2_keys 逐段删）
    r2_key: String(r2Key || ''),
    r2_keys: Array.isArray(r2Keys) ? r2Keys.join(',') : String(r2Keys || ''),
    out_name: String(outName),
    openlist_dir: String(openlistDir),
    /**
     * 输出方式：'remux'（默认）| 'cfr'。
     *
     * remux —— 纯 -c copy，快 1600 倍、字面无损；缺点是把源里坏掉的
     *          帧率原样带进 MP4，部分播放器（PotPlayer）拖不动进度条
     * cfr   —— 重编码成恒定帧率，任何播放器都能拖，但要花几十分钟
     *
     * 这里**始终发显式值**，不发空串：GitHub 的 workflow input 有默认值，
     * 但显式传空串会覆盖它，到了 worker 里 MODE='' 又会被当成"未设置"，
     * 默认值等于被绕过两次，行为很难追踪。默认值只在 tasks.js 里定义一次。
     */
    mode: mode === 'cfr' ? 'cfr' : 'remux',
    crf: String(config.transcode.crf),
    preset: String(config.transcode.preset),
    task_id: String(taskId),
  };
}

/**
 * 触发 GitHub Actions 的 workflow_dispatch。
 *
 * 用 inputs 传参，不传文件内容 —— Actions 那边凭 presigned URL 自己去 R2 取。
 * 这样 PAT 泄漏也只能触发转码，拿不到任何数据。
 */
export async function dispatchTranscode(inputs, { signal } = {}) {
  const { repo, workflow, ref, token } = config.transcode;
  if (!repo || !token) {
    throw new TranscodeError('未配置 GH_REPO / GH_TOKEN，无法触发转码');
  }

  const url = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;

  /**
   * 必须带超时。
   *
   * dispatch 发生在录制收尾阶段，调用方要等它返回才会把任务标成 done。
   * GitHub 偶尔会长时间不响应（不是失败，就是挂着），而 fetch 默认
   * 永不超时 —— 一次挂住就等于任务永远停在「下载中」，用户只能重启服务。
   */
  const timeout = AbortSignal.timeout(Math.max(5000, config.transcode.dispatchTimeoutMs));
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'cloudfetch',
      },
      body: JSON.stringify({ ref, inputs }),
      signal: merged,
    });
  } catch (e) {
    if (e?.name === 'TimeoutError') {
      throw new TranscodeError(
        `触发转码超时（${Math.round(config.transcode.dispatchTimeoutMs / 1000)} 秒无响应）。` +
          'GitHub API 可能临时不可用，稍后可在历史记录里重试',
        0,
      );
    }
    throw e;
  }

  // 成功返回 204 No Content
  if (res.status === 204) return { ok: true };
  if (res.status === 404) {
    throw new TranscodeError(
      `触发失败：仓库或 workflow 不存在（${repo} / ${workflow}）。` +
        '检查 GH_REPO 拼写、workflow 文件名，以及 PAT 是否有 Actions 写权限',
      404,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new TranscodeError(
      `触发失败：PAT 无效或权限不足（HTTP ${res.status}）。` +
        'fine-grained PAT 需要 Actions: Read and write，且仓库要在授权列表里',
      res.status,
    );
  }
  const txt = await res.text().catch(() => '');
  throw new TranscodeError(`触发失败：HTTP ${res.status} ${txt.slice(0, 300)}`, res.status);
}
