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
 * 失败策略：任何一步失败都不影响已经成功的 OpenList 上传，
 * 只是这段视频没有 MP4 版本，会在日志里明确写出来。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, transcodeConfigured } from './config.js';
import { getR2 } from './r2.js';

export class TranscodeError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'TranscodeError';
    this.status = status;
  }
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
    throw new TranscodeError('未配置 GITHUB_REPO / GITHUB_TOKEN，无法触发转码');
  }

  const url = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'cloudfetch',
    },
    body: JSON.stringify({ ref, inputs }),
    signal,
  });

  // 成功返回 204 No Content
  if (res.status === 204) return { ok: true };
  if (res.status === 404) {
    throw new TranscodeError(
      `触发失败：仓库或 workflow 不存在（${repo} / ${workflow}）。` +
        '检查 GITHUB_REPO 拼写、workflow 文件名，以及 PAT 是否有 Actions 写权限',
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

/**
 * 把单个文件送上转码链路。
 *
 * @param {object} p
 * @param {string} p.localPath   本地文件绝对路径
 * @param {string} p.remoteName  最终想要的 MP4 文件名（不含扩展名也行，这里统一补 .mp4）
 * @param {string} p.openlistDir OpenList 目标目录，Actions 转完传到这里
 * @param {string} p.taskId      任务 id，用于在 R2 里归类
 * @param {number} [p.index]     段序号，多段时用于命名
 * @param {function} [p.onLog]   日志回调
 * @returns {Promise<{ok:boolean, key?:string, error?:string}>}
 */
export async function submitForTranscode({ localPath, remoteName, openlistDir, taskId, index, onLog }) {
  if (!transcodeConfigured()) {
    return { ok: false, error: '转码链路未配置（缺 R2 或 GitHub 参数）' };
  }

  const r2 = getR2();
  const base = path.basename(remoteName, path.extname(remoteName));
  // R2 里的键：prefix/taskId/0001_xxx.flv，和 OpenList 的目录结构对齐便于排查
  const key = `${config.r2.prefix}/${taskId}/${base}.flv`;

  try {
    const st = await fsp.stat(localPath);
    onLog?.(`上传到 R2 中转：${key}（${(st.size / 1048576).toFixed(1)} MB）`);
    await r2.putFile(localPath, key, { contentType: 'video/x-flv' });

    // 预签名 URL 给 Actions 下载用，避免在仓库里存 R2 密钥
    const url = r2.presignGet(key, config.r2.presignExpires);

    const inputs = {
      source_url: url,
      r2_key: key,
      out_name: `${base}.mp4`,
      openlist_dir: openlistDir,
      crf: String(config.transcode.crf),
      preset: config.transcode.preset,
      task_id: taskId,
      seg_index: String(index ?? 0),
    };

    onLog?.('触发 GitHub Actions 转码…');
    await dispatchTranscode(inputs);
    onLog?.(`已触发转码：${base}.mp4 → ${openlistDir}`);
    return { ok: true, key };
  } catch (e) {
    onLog?.(`转码提交失败：${e.message}`);
    return { ok: false, error: e.message, key };
  }
}

/**
 * 批量提交一个任务的产物。
 *
 * 分段模式：每段单独转一个 MP4（用户明确要求逐段转）。
 * 好处是失败只影响一段，且并行度可以拉高；代价是文件数变多。
 */
export async function submitTaskArtifacts({ files, openlistDir, taskId, onLog }) {
  if (!transcodeConfigured()) {
    onLog?.('转码链路未配置，跳过转码（文件已按原格式上传 OpenList）');
    return { submitted: 0, failed: 0, skipped: true };
  }

  let submitted = 0;
  let failed = 0;

  for (const f of files) {
    const r = await submitForTranscode({
      localPath: f.path,
      remoteName: f.filename,
      openlistDir,
      taskId,
      index: f.index,
      onLog,
    });
    if (r.ok) submitted++;
    else failed++;
  }

  return { submitted, failed, skipped: false };
}
