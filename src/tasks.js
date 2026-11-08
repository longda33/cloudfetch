/**
 * 任务管理：创建、排队、执行、状态持久化。
 * 下载 → 上传 → 删除本地，全流程在 worker 里跑，通过 EventEmitter 推送进度。
 */
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, transcodeConfigured } from './config.js';
import { runDownload } from './downloader.js';
import { getOpenList, buildRemotePath } from './openlist.js';
import { getHistoryStore } from './history.js';
import { buildTranscodeInputs, dispatchTranscode } from './transcode.js';
import { getR2 } from './r2.js';
import { detectKind, humanSize } from './util/links.js';

/** 目录剩余空间（字节）；拿不到就返回 null，不要因为探测失败就阻断任务 */
async function freeDiskBytes(dir) {
  try {
    const s = await fsp.statfs(dir);
    return s.bfree * s.bsize;
  } catch {
    return null;
  }
}

/** 按扩展名给 R2 对象挑 Content-Type。别再一律写 video/x-flv：HLS 的 .ts、DASH 的 .mp4 都会走这条路 */
function contentTypeOf(filename) {
  const ext = path.extname(filename).toLowerCase();
  return (
    {
      '.flv': 'video/x-flv',
      '.ts': 'video/mp2t',
      '.mp4': 'video/mp4',
      '.mkv': 'video/x-matroska',
      '.m4s': 'video/iso.segment',
    }[ext] || 'application/octet-stream'
  );
}

/** 文件名去掉扩展名后的部分（用于拼 MP4 输出名） */
function stemOf(filename) {
  const name = path.basename(String(filename || ''));
  return path.basename(name, path.extname(name)) || 'output';
}

/** 任务状态机 */
export const STATUS = {
  QUEUED: 'queued',       // 排队中
  DOWNLOADING: 'downloading',
  UPLOADING: 'uploading',
  DONE: 'done',
  FAILED: 'failed',
  CANCELED: 'canceled',
};

export class TaskManager extends EventEmitter {
  constructor() {
    super();
    // 每个 SSE 客户端都会挂一个 'update' 监听，默认上限 10 会一直刷警告
    this.setMaxListeners(0);
    /** @type {Map<string, object>} */
    this.tasks = new Map();
    this.queue = [];
    this.running = new Set();
    this._saveTimer = null;
    this._shuttingDown = false;
    this._loadState();
    this._startCleaner();
    this._startTranscodeWatcher();
  }

  // ---------------- 持久化 ----------------
  _loadState() {
    try {
      if (!fs.existsSync(config.stateFile)) return;
      const raw = fs.readFileSync(config.stateFile, 'utf8');
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      for (const t of arr) {
        // 重启后，未完成的任务标记为失败（进程已丢失）
        if ([STATUS.DOWNLOADING, STATUS.UPLOADING, STATUS.QUEUED].includes(t.status)) {
          t.status = STATUS.FAILED;
          t.error = '服务重启，任务中断';
          t.finishedAt = t.finishedAt || Date.now();
        }
        this.tasks.set(t.id, t);
      }
      console.log(`[tasks] 已恢复 ${this.tasks.size} 条历史任务`);
    } catch (e) {
      console.error(`[tasks] 恢复状态失败：${e.message}`);
    }
  }

  _saveState() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(async () => {
      this._saveTimer = null;
      try {
        await fsp.writeFile(config.stateFile, this._serialize(), 'utf8');
      } catch (e) {
        console.error(`[tasks] 保存状态失败：${e.message}`);
      }
    }, 1000);
  }

  /**
   * 进程退出前同步落盘。
   * _saveState 是 1 秒防抖的异步写，SIGTERM 时很可能来不及。
   */
  flushState() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    try {
      fs.writeFileSync(config.stateFile, this._serialize(), 'utf8');
    } catch (e) {
      console.error(`[tasks] 退出前保存状态失败：${e.message}`);
    }
  }

  /**
   * 序列化任务列表。
   * 必须去掉运行时字段：_abort 是 AbortController，序列化成 {} 之后
   * 再读回来 `t._abort?.abort()` 会变成"不是函数"。
   */
  _serialize() {
    const arr = [...this.tasks.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, config.maxTasks)
      .map(({ _abort, _stopRequested, ...rest }) => rest);
    return JSON.stringify(arr, null, 2);
  }

  _startCleaner() {
    setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, t] of this.tasks) {
        if (
          [STATUS.DONE, STATUS.FAILED, STATUS.CANCELED].includes(t.status) &&
          t.finishedAt &&
          now - t.finishedAt > config.taskRetention
        ) {
          this.tasks.delete(id);
          this._disposeTask(t);
          changed = true;
        }
      }
      // 超出上限时删最老的已完成任务
      if (this.tasks.size > config.maxTasks) {
        const finished = [...this.tasks.values()]
          .filter((t) => [STATUS.DONE, STATUS.FAILED, STATUS.CANCELED].includes(t.status))
          .sort((a, b) => a.createdAt - b.createdAt);
        while (this.tasks.size > config.maxTasks && finished.length) {
          const t = finished.shift();
          this.tasks.delete(t.id);
          this._disposeTask(t);
          changed = true;
        }
      }
      if (changed) this._saveState();
    }, 5 * 60 * 1000).unref?.();
  }

  /**
   * 删除任务时清理它留下的所有东西：本地目录 + R2 中转对象。
   *
   * R2 里还留着源文件只有两种情况：转码失败（特意留着以便重试）、
   * 或者从未提交成功。用户主动删任务时这些都没用了，必须清掉 ——
   * R2 免费额度只有 10GB，历史垃圾不清会直接把额度占满，
   * 之后所有上传都失败，而且报错是 R2 PUT 403，很难联想到是空间问题。
   *
   * 正在转码（pending）的不能删：Actions 还在下载它。
   */
  _disposeTask(t) {
    const dir = path.join(config.tmpDir, t.id);
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});

    const r = config.r2;
    if (!r.accessKeyId || !r.secretAccessKey || !r.bucket) return;

    const keys = new Set();
    if (t.r2Key && t.mp4State !== 'pending') keys.add(t.r2Key);
    for (const s of t.segments || []) {
      if (s.r2Key && s.mp4State !== 'pending') keys.add(s.r2Key);
    }
    if (!keys.size) return;

    const r2 = getR2();
    for (const key of keys) {
      r2.deleteObject(key).catch(() => {});
    }
  }

  /**
   * 转码确认轮询。
   *
   * dispatch 只代表"已排队"。这里定期去 OpenList 查 MP4 是否真的出现：
   *   - 出现   → 段/任务标记 done，写入 remotePath
   *   - 超时   → 标记 failed，前端给出「重试」入口（从 R2 源文件重新触发）
   *
   * 没有这一步的话，"已提交转码"会被当成"已完成"：本地文件已删、
   * 网盘里却没有 MP4，用户看到绿色对勾但文件永远不出现。
   */
  _startTranscodeWatcher() {
    setInterval(() => {
      this._confirmTranscodes().catch(() => {});
    }, Math.max(15000, config.transcode.pollIntervalMs)).unref?.();
  }

  async _confirmTranscodes() {
    if (!transcodeConfigured()) return;
    const ol = getOpenList();
    if (!ol.configured) return;

    const now = Date.now();
    /**
     * 每次轮询最多查这么多段。
     * 10 个任务 × 20 段同时挂起的话，一次扫描就是 200 个请求，
     * 家用 OpenList 扛不住。查不完的下一轮继续，不影响正确性。
     */
    let budget = 20;

    for (const t of this.tasks.values()) {
      if (budget <= 0) break;
      if (t.status !== STATUS.DONE) continue;

      const pending = [];
      if (t.mp4State === 'pending') {
        pending.push({ item: t, path: t.expectedPath, at: t.mp4SubmittedAt });
      }
      for (const s of t.segments || []) {
        if (s.mp4State === 'pending') {
          pending.push({ item: s, path: s.expectedPath, at: s.submittedAt });
        }
      }
      if (!pending.length) continue;

      let changed = false;
      for (const p of pending) {
        if (budget <= 0) break;
        budget--;
        if (!p.path) {
          p.item.mp4State = 'failed';
          changed = true;
          continue;
        }
        // getFileInfo 内部吞掉异常返回 null，所以网络抖动只会推迟确认，不会误判成功
        const info = await ol.getFileInfo(p.path);
        if (info) {
          p.item.mp4State = 'done';
          p.item.remotePath = p.path;
          p.item.confirmedAt = now;
          changed = true;
          this._log(t, `转码完成：${p.path}`);
        } else if (now - (p.at || 0) > config.transcode.timeoutMs) {
          p.item.mp4State = 'failed';
          changed = true;
          this._log(
            t,
            `转码超时（${Math.round((now - (p.at || now)) / 60000)} 分钟未见 MP4）：${p.path}，可在历史记录里重试`,
          );
        }
      }
      if (!changed) continue;

      t.segmentsUploaded = (t.segments || []).filter((s) => s.remotePath).length;
      const stillPending = (t.segments || []).some((s) => s.mp4State === 'pending') ||
        (t.mp4State === 'pending' && !(t.segments || []).length);
      if (!stillPending) {
        t.phase = t._stopRequested ? '已停止' : '已完成';
      }
      this._emit(t);
      this._saveState();
      try {
        await getHistoryStore().upsert(this._historyRecord(t));
      } catch {
        /* ignore */
      }
    }
  }

  // ---------------- 任务操作 ----------------
  /**
   * @param {object} opts
   * @param {string} opts.url
   * @param {string} [opts.filename]
   * @param {boolean} [opts.upload=true] 完成后是否上传 OpenList
   * @param {boolean} [opts.segment=true] 直播是否按时间分段。
   *   false = 「全段下载」，整个直播录成一个大文件，不切段。
   *   注意：不分段时单文件会持续增长，需自行承担磁盘与上传体积风险。
   */
  create({ url, filename, upload = true, segment = true }) {
    if (!url || typeof url !== 'string') throw new Error('缺少 url');
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      if (!/^rtmp/i.test(url)) throw new Error('URL 格式不合法');
      parsed = null;
    }
    if (parsed && !['http:', 'https:', 'rtmp:', 'rtmps:'].includes(parsed.protocol)) {
      throw new Error(`不支持的协议：${parsed.protocol}`);
    }

    // 队列上限：否则一次请求塞几千条链接就能把进程拖死
    if (this.queue.length + this.running.size >= config.download.maxQueue) {
      throw new Error(`队列已满（上限 ${config.download.maxQueue} 个），请等现有任务结束`);
    }

    const id = crypto.randomUUID();
    // 任务基础名：用于远端子目录，便于人眼识别是哪一次录制
    // 直播用时间戳（此时还不知道最终文件名），普通下载用原文件名
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const baseName =
      (filename ? path.basename(filename).replace(/\.[a-z0-9]+$/i, '') : '') ||
      `${detectKind(url) === 'http' ? 'dl' : 'live'}_${ts}`;

    const task = {
      id,
      url,
      baseName,
      filename: filename || '',
      kind: detectKind(url),
      status: STATUS.QUEUED,
      upload: Boolean(upload),
      segment: segment !== false,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,

      // 进度
      total: 0,
      downloaded: 0,
      uploaded: 0,
      speed: 0,
      eta: 0,
      percent: 0,
      phase: '排队中',

      // 结果
      remotePath: '',
      localPath: '',
      size: 0,
      error: '',
      failedSegments: [],
      logs: [],

      /**
       * 转码状态（单文件用；分段任务看 segments[].mp4State）
       *   none    —— 没走转码，直接传了 OpenList
       *   pending —— 已提交 Actions，等 MP4 出现在 OpenList
       *   done    —— 已确认 MP4 落地，remotePath 才有值
       *   failed  —— 超时未出现，可重试
       */
      mp4State: 'none',
      expectedPath: '',
      r2Key: '',
      segmentsSubmitted: 0,
    };
    this.tasks.set(id, task);
    this.queue.push(id);
    this._saveState();
    this._emit(task);
    this._pump();
    return task;
  }

  /**
   * 取消任务。
   *
   * 关键：这里**不能**直接把状态改成 canceled。
   *
   * 之前就是这么写的，结果两个问题：
   *   1) 全段模式下点取消，ffmpeg 正常收尾并返回了文件路径，
   *      但任务状态已经是 canceled，上传流程直接跳过，
   *      录了半小时的文件白录。
   *   2) 分段模式下取消后，已录好的段还没来得及上传就被判死。
   *
   * 现在只做两件事：置停止标志 + abort。
   * 真正的状态由 _run 的收尾流程决定：
   *   - 已经录到内容 → 照常上传，最后标 done（phase 显示「已停止」）
   *   - 一点内容都没有 → 标 canceled
   */
  cancel(id) {
    const t = this.tasks.get(id);
    if (!t) return false;
    if ([STATUS.DONE, STATUS.FAILED, STATUS.CANCELED].includes(t.status)) return false;

    // 标记用户主动停止，供收尾流程判断该走「停止并上传」还是「直接取消」
    t._stopRequested = true;
    t.phase = '正在停止…';
    this._emit(t);

    t._abort?.abort();

    const qi = this.queue.indexOf(id);
    if (qi >= 0) {
      // 还在排队、没开始跑的任务，直接取消即可，没有内容要上传
      this.queue.splice(qi, 1);
      t.status = STATUS.CANCELED;
      t.phase = '已取消';
      t.finishedAt = Date.now();
      t._abort = null;
      this._saveState();
      this._emit(t);
    }
    // 正在运行的任务不在这里改状态，交给 _run 收尾
    return true;
  }

  remove(id) {
    const t = this.tasks.get(id);
    if (!t) return false;
    if (this.running.has(id)) return false;
    this.tasks.delete(id);
    this._disposeTask(t);
    this._saveState();
    this.emit('removed', { id });
    return true;
  }

  clearFinished() {
    let n = 0;
    for (const [id, t] of this.tasks) {
      if ([STATUS.DONE, STATUS.FAILED, STATUS.CANCELED].includes(t.status)) {
        this.tasks.delete(id);
        this._disposeTask(t);
        n++;
      }
    }
    if (n) this._saveState();
    return n;
  }

  list() {
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((t) => this._public(t, true));
  }

  get(id) {
    const t = this.tasks.get(id);
    return t ? this._public(t, true) : null;
  }

  /**
   * 对外暴露的任务快照。
   *
   * @param {object} t
   * @param {boolean} [withLogs=false] 是否带日志。
   *   SSE 的进度事件每 500ms 一次，每次都带 200 行日志纯属浪费带宽；
   *   日志单独走 'log' 事件推送，只有列表/详情这类一次性请求才需要带全量。
   */
  _public(t, withLogs = false) {
    const { _abort, _stopRequested, logs, ...rest } = t;
    return withLogs ? { ...rest, logs } : rest;
  }

  /**
   * 重试上传没传成功的段。
   *
   * 候选来源有两个，缺一不可：
   *   1) t.failedSegments —— 上传过程抛过异常的段
   *   2) t.segments 里 remotePath 为空的段 —— 从没成功上传的段
   *
   * 只靠 1) 是不够的：直播是异步上传，任务结束时可能还有段在排队没传完，
   * 或者用户中途停止导致后面的段压根没走到上传。这些段不会进
   * failedSegments，但确实需要补传。
   */
  async retryFailedSegments(id) {
    const t = this.tasks.get(id);
    if (!t) throw new Error('任务不存在');

    /**
     * 只允许对已结束的任务补传。
     *
     * 任务还在跑的时候，直播的分段上传是后台异步进行的，
     * 这时候再起一路补传会两路同时写同一个远端文件，互相覆盖。
     */
    if (this.running.has(id) || [STATUS.QUEUED, STATUS.DOWNLOADING, STATUS.UPLOADING].includes(t.status)) {
      throw new Error('任务仍在进行中，请等它结束后再重试上传');
    }

    const useTranscode = transcodeConfigured();
    const ol = getOpenList();
    if (!useTranscode && !ol.configured) throw new Error('OpenList 未配置，无法上传');

    /**
     * 合并三种来源，按 index 去重：
     *   1) segments 里 remotePath 为空、且不在 pending 的段
     *   2) failedSegments 里登记过的段
     *   3) mp4State === 'failed' 的段（转码超时，R2 源文件还在，只需重新触发）
     *
     * pending 的必须排除：它正在 Actions 里跑，再提交一次会跑两遍。
     */
    const byIndex = new Map();
    for (const s of t.segments || []) {
      if (s.remotePath) continue; // 已确认落地
      if (s.mp4State === 'pending') continue; // 正在转码，别重复提交
      byIndex.set(s.index, {
        index: s.index,
        filename: s.filename,
        size: s.size,
        localPath: s.localPath || '',
        r2Key: s.r2Key || '',
        expectedPath: s.expectedPath || '',
        mp4State: s.mp4State || 'none',
        error: '未完成',
      });
    }
    for (const f of t.failedSegments || []) {
      byIndex.set(f.index, { ...(byIndex.get(f.index) || {}), ...f });
    }

    /**
     * 单文件任务的兜底：没有 segments，但开了上传又没拿到 remotePath，
     * 且不在转码中，说明它从没成功过。补一条 index=0。
     */
    if (
      !(t.segments || []).length &&
      t.upload &&
      !t.remotePath &&
      t.mp4State !== 'pending' &&
      !byIndex.has(0)
    ) {
      byIndex.set(0, {
        index: 0,
        filename: t.filename || '',
        size: t.size || 0,
        localPath: t.localPath || '',
        r2Key: t.r2Key || '',
        expectedPath: t.expectedPath || '',
        mp4State: t.mp4State || 'none',
        error: '未完成',
      });
    }

    const list = [...byIndex.values()].sort((a, b) => a.index - b.index);
    if (!list.length) throw new Error('没有待重试的段');

    this._log(t, `开始重试 ${list.length} 个分段`);
    let submitted = 0;
    const still = [];
    const openlistDir = this._remoteDirOf(t);

    for (const item of list) {
      // 本地路径可能没记下来，按任务目录 + 文件名兜底
      const local = item.localPath || path.join(config.tmpDir, t.id, item.filename || '');
      const localOk = await fsp
        .stat(local)
        .then((s) => s.size > 0)
        .catch(() => false);
      const outName = `${stemOf(item.filename)}.mp4`;
      const expectedPath = `${openlistDir}/${outName}`;

      try {
        if (localOk) {
          // 本地还在：走完整链路（配了转码就先传 R2）
          if (useTranscode) {
            const key = await this._uploadToR2(t, item.index, item.filename, local);
            await this._dispatchOne(t, { key, outName, openlistDir, index: item.index });
            this._markPending(t, item, key, expectedPath);
            this._log(t, `第 ${item.index} 段已重新提交转码 → ${expectedPath}`);
          } else {
            const remote = buildRemotePath(item.filename, {
              taskId: t.id,
              baseName: t.baseName,
              // 用任务创建时间算日期目录：跨零点补传不该落到"第二天"的目录里
              date: t.createdAt,
            });
            await ol.uploadFile(local, remote, { onLog: (m) => this._log(t, m) });
            this._markDone(t, item, remote);
            this._log(t, `第 ${item.index} 段重试成功 → ${remote}`);
          }

          if (config.openlist.deleteAfterUpload) {
            await fsp.rm(local, { force: true }).catch(() => {});
            const seg = (t.segments || []).find((s) => s.index === item.index);
            if (seg) seg.deleted = true;
            if (!t.segments?.length) t.localPath = '';
          }
        } else if (useTranscode && item.r2Key) {
          /**
           * 本地已删，但 R2 里源文件还在（转码失败时特意保留）。
           * 这种情况不需要重传，只要重新触发一次 Actions —— 这是"假成功"
           * 场景下唯一可行的恢复路径，否则用户只能重新录一遍。
           */
          const r2 = getR2();
          const size = await r2.headObject(item.r2Key);
          if (size === null) {
            throw new Error('R2 源文件已被清理，无法重试（需重新录制）');
          }
          await this._dispatchOne(t, { key: item.r2Key, outName, openlistDir, index: item.index });
          this._markPending(t, item, item.r2Key, expectedPath);
          this._log(t, `第 ${item.index} 段已重新触发转码（复用 R2 源文件）`);
        } else {
          throw new Error('本地文件已不存在，无法重试');
        }
        submitted++;
      } catch (e) {
        still.push({ ...item, error: e.message });
        this._log(t, `第 ${item.index} 段重试仍失败：${e.message}`);
      }
    }

    t.failedSegments = still;
    t.segmentsUploaded = (t.segments || []).filter((s) => s.remotePath).length;
    t.segmentsSubmitted = (t.segments || []).filter(
      (s) => s.mp4State === 'pending' || s.mp4State === 'done',
    ).length;

    /**
     * 单文件补传成功后要把任务状态从 failed 翻回 done，
     * 否则历史记录里明明传上去了还显示「失败」。
     * 注意判据是"已确认落地"，不是"已提交"——转码中的还不算完成。
     */
    const landed = (t.segments || []).length ? t.segmentsUploaded > 0 : Boolean(t.remotePath);
    if (!still.length && t.status === STATUS.FAILED && landed) {
      t.status = STATUS.DONE;
      t.phase = t.mp4State === 'pending' ? '转码中' : '已完成';
      t.error = '';
    }

    this._emit(t);
    this._saveState();

    // 同步更新历史记录里的这条
    try {
      await getHistoryStore().upsert(this._historyRecord(t));
    } catch {
      /* ignore */
    }

    return { retried: list.length, submitted, failed: still.length };
  }

  /** 把本地文件传到 R2，返回对象键 */
  async _uploadToR2(t, index, filename, localPath) {
    const r2 = getR2();
    const base = stemOf(filename);
    const ext = path.extname(String(filename || '')).toLowerCase() || '.bin';
    const key = `${config.r2.prefix}/${t.id}/${base}${ext}`;
    this._log(t, `第 ${index} 段上传 R2 → ${key}`);
    await r2.putFile(localPath, key, { contentType: contentTypeOf(filename) });
    return key;
  }

  /** 触发一次转码 */
  async _dispatchOne(t, { key, outName, openlistDir, index }) {
    const r2 = getR2();
    await dispatchTranscode(
      buildTranscodeInputs({
        sourceUrl: r2.presignGet(key, config.r2.presignExpires),
        r2Key: key,
        outName,
        openlistDir,
        taskId: t.id,
        segIndex: index,
      }),
    );
  }

  /** 标记为"已提交转码，等待落地"，同时把字段同步回 segments 里的真实对象 */
  _markPending(t, item, key, expectedPath) {
    const at = Date.now();
    item.mp4State = 'pending';
    item.submittedAt = at;
    item.r2Key = key;
    item.expectedPath = expectedPath;
    item.remotePath = '';

    const seg = (t.segments || []).find((s) => s.index === item.index);
    if (seg) {
      seg.mp4State = 'pending';
      seg.submittedAt = at;
      seg.r2Key = key;
      seg.expectedPath = expectedPath;
      seg.remotePath = '';
    } else if (!(t.segments || []).length) {
      // 单文件：状态挂在任务上
      t.mp4State = 'pending';
      t.mp4SubmittedAt = at;
      t.r2Key = key;
      t.expectedPath = expectedPath;
      t.remotePath = '';
      t.segmentsSubmitted = 1;
    }

    t.failedSegments = (t.failedSegments || []).filter((x) => x.index !== item.index);
  }

  /** 标记为"已落地"（直接传 OpenList 的路径用） */
  _markDone(t, item, remotePath) {
    item.remotePath = remotePath;
    item.mp4State = 'none';

    const seg = (t.segments || []).find((s) => s.index === item.index);
    if (seg) {
      seg.remotePath = remotePath;
      seg.mp4State = 'none';
    } else if (!(t.segments || []).length) {
      t.remotePath = remotePath;
      t.mp4State = 'none';
    }

    t.failedSegments = (t.failedSegments || []).filter((x) => x.index !== item.index);
  }

  _emit(t) {
    // 不带 logs：进度事件很密集，日志由 'log' 事件单独推送
    this.emit('update', this._public(t));
  }

  _log(t, msg) {
    const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
    t.logs.push(line);
    if (t.logs.length > 200) t.logs.shift();
    this.emit('log', { id: t.id, line });
  }

  // ---------------- 调度 ----------------
  _pump() {
    if (this._shuttingDown) return;
    while (this.running.size < config.download.maxConcurrent && this.queue.length) {
      const id = this.queue.shift();
      const t = this.tasks.get(id);
      if (!t || t.status !== STATUS.QUEUED) continue;
      this.running.add(id);
      this._run(t).finally(() => {
        this.running.delete(id);
        this._pump();
      });
    }
  }

  /**
   * 进程退出前的收尾：不再接新任务，并 abort 所有在跑的。
   * 不 abort 的话，server 已经关了但下载还在写盘，ffmpeg 也会变成孤儿进程。
   */
  shutdown() {
    this._shuttingDown = true;
    this.queue.length = 0;
    for (const id of this.running) {
      this.tasks.get(id)?._abort?.abort();
    }
    // 把当前状态同步写盘，异步的 _saveState 来不及
    this.flushState();
  }

  async _run(t) {
    const ac = new AbortController();
    t._abort = ac;
    t.status = STATUS.DOWNLOADING;
    t.startedAt = Date.now();
    t.phase = '下载中';
    this._emit(t);
    this._saveState();

    // 每个任务独立目录
    const jobDir = path.join(config.tmpDir, t.id);

    let lastBytes = 0;
    let lastTime = Date.now();
    let speedSamples = [];

    const onProgress = (downloaded, total) => {
      const now = Date.now();
      const dt = (now - lastTime) / 1000;
      if (dt >= 0.4) {
        const inst = (downloaded - lastBytes) / dt;
        speedSamples.push(inst);
        if (speedSamples.length > 5) speedSamples.shift();
        const speed = speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length;
        t.speed = Math.max(0, Math.round(speed));
        lastBytes = downloaded;
        lastTime = now;
      }
      t.downloaded = downloaded;
      if (total) {
        t.total = total;
        t.percent = Math.min(99.9, (downloaded / total) * 100);
        if (t.speed > 0) t.eta = Math.round((total - downloaded) / t.speed);
      } else {
        // 直播/未知大小：用已下载量做展示，进度条走"不确定"模式
        t.percent = 0;
      }
      this._emit(t);
    };

    const onLog = (m) => this._log(t, m);

    // 直播分段上传：每段产出后立即上传并删本地，不占磁盘
    t.segmentsUploaded = 0;
    /** 上传失败的段，前端据此显示「重试」按钮 */
    t.failedSegments = [];

    /**
     * 在飞的分段上传集合。
     *
     * 上传必须 fire-and-forget（不能阻塞 ffmpeg 继续切段），但任务收尾时
     * 一定要等它们落定：否则下面用 dl.segments 快照算出来的 segmentsUploaded
     * 是旧值，历史记录里会显示「N 段未传」，而实际上几秒后就传完了。
     */
    const pendingUploads = new Set();

    /**
     * 分段处理：先传 R2，再触发转码，**不直接传 OpenList**。
     *
     * 流程（用户指定）：
     *   Unikraft 录制 → R2 → GitHub Actions 转码 → OpenList
     *
     * OpenList 只存最终的 MP4，不再存原始 FLV。
     * 好处是网盘里只有能直接播放的文件，不用再筛。
     *
     * 失败处理：任何一步失败都**不删本地文件**，
     * 并登记到 failedSegments，用户可以在历史记录里点「重传」。
     */
    const doUploadSegment = async (rec) => {
      if (!t.upload) {
        onLog(`第 ${rec.index} 段：未开启上传，保留本地`);
        return;
      }
      if (!transcodeConfigured()) {
        // 没配转码链路时退回旧行为：直接传 OpenList 存原始文件
        onLog(`第 ${rec.index} 段：转码链路未配置，直接传 OpenList`);
        await uploadSegmentToOpenList(rec);
        return;
      }

      onLog(`第 ${rec.index} 段开始处理：R2 → 转码 → OpenList（${humanSize(rec.size)}）`);
      try {
        await uploadSegmentToR2(rec);
      } catch (e) {
        onLog(`第 ${rec.index} 段 R2 上传失败：${e.message}（文件保留本地）`);
        recordFailure(rec, `R2 上传失败：${e.message}`);
        throw e;
      }

      /**
       * 这里只是"已提交"，不是"已完成"。
       *
       * 以前直接把 remotePath 写成 MP4 的最终路径，于是 Actions 失败时：
       * 任务显示已完成、本地已删、网盘里什么都没有；而且 remotePath 非空
       * 会让重试逻辑误判成"已传"，用户没有任何恢复入口。
       *
       * 现在只记录预期路径，等轮询器在 OpenList 真看到文件才写 remotePath。
       */
      rec.expectedPath = `${this._remoteDirOf(t)}/${stemOf(rec.filename)}.mp4`;
      rec.mp4State = 'pending';
      rec.submittedAt = Date.now();
      t.segmentsSubmitted = (t.segmentsSubmitted || 0) + 1;
      // 成功了就从失败列表里移除（可能是重传成功的）
      t.failedSegments = (t.failedSegments || []).filter((x) => x.index !== rec.index);
      onLog(`第 ${rec.index} 段已提交转码 → ${rec.expectedPath}`);
      this._emit(t);

      /**
       * R2 上传成功、转码已派出，本地文件就没用了。
       *
       * 注意顺序：失败时不删（上面 catch 里直接 throw，走不到这里），
       * 只有确认 R2 有了副本才删。
       */
      if (config.openlist.deleteAfterUpload) {
        try {
          await fsp.rm(rec.path, { force: true });
          rec.deleted = true;
        } catch (e) {
          onLog(`第 ${rec.index} 段删除失败：${e.message}`);
        }
      }
    };

    /** 把分段传到 R2 并触发转码 */
    const uploadSegmentToR2 = async (rec) => {
      const r2 = getR2();
      const ext = path.extname(String(rec.filename || '')).toLowerCase() || '.bin';
      const key = `${config.r2.prefix}/${t.id}/${stemOf(rec.filename)}${ext}`;

      await r2.putFile(rec.path, key, {
        contentType: contentTypeOf(rec.filename),
        signal: ac.signal,
      });
      rec.r2Key = key;

      // OpenList 目标目录（Actions 转完往这里传）
      const openlistDir = this._remoteDirOf(t);
      await dispatchTranscode(
        buildTranscodeInputs({
          sourceUrl: r2.presignGet(key, config.r2.presignExpires),
          r2Key: key,
          outName: `${stemOf(rec.filename)}.mp4`,
          openlistDir,
          taskId: t.id,
          segIndex: rec.index,
        }),
      );
      rec.transcodeSubmitted = true;
    };

    /** 旧路径：转码未配置时直接把 FLV 传 OpenList */
    const uploadSegmentToOpenList = async (rec) => {
      const ol = getOpenList();
      if (!ol.configured) {
        onLog(`第 ${rec.index} 段：OpenList 未配置，保留本地`);
        return;
      }
      const remote = buildRemotePath(rec.filename, {
        taskId: t.id,
        baseName: t.baseName,
        date: t.createdAt,
      });
      onLog(`第 ${rec.index} 段开始上传 → ${remote}（${humanSize(rec.size)}）`);
      try {
        await ol.uploadFile(rec.path, remote, { signal: ac.signal, onLog });
      } catch (e) {
        onLog(`第 ${rec.index} 段上传失败：${e.message}`);
        recordFailure(rec, e.message);
        throw e;
      }
      rec.remotePath = remote;
      rec.mp4State = 'none';
      t.segmentsUploaded = (t.segmentsUploaded || 0) + 1;
      t.failedSegments = (t.failedSegments || []).filter((x) => x.index !== rec.index);
      onLog(`第 ${rec.index} 段已上传：${remote}`);
      this._emit(t);

      if (config.openlist.deleteAfterUpload) {
        try {
          await fsp.rm(rec.path, { force: true });
          rec.deleted = true;
        } catch (e) {
          onLog(`第 ${rec.index} 段删除失败：${e.message}`);
        }
      }
    };

    /** 登记一个失败的分段，供前端「重传」按钮使用 */
    const recordFailure = (rec, error) => {
      t.failedSegments = [
        ...(t.failedSegments || []).filter((x) => x.index !== rec.index),
        {
          index: rec.index,
          filename: rec.filename,
          size: rec.size,
          localPath: rec.path,
          error,
        },
      ];
      this._emit(t);
    };

    /** 包装一层，把 promise 登记进集合；错误仍原样抛给下载器去记日志 */
    const uploadSegment = (rec) => {
      const task = doUploadSegment(rec);
      pendingUploads.add(task);
      task.catch(() => {}).finally(() => pendingUploads.delete(task));
      return task;
    };

    try {
      // mkdir 必须在 try 里：磁盘满/权限异常时，否则任务会永远停在 downloading
      await fsp.mkdir(jobDir, { recursive: true });

      /**
       * 磁盘余量闸门。
       * 5GB 配额下，一场长直播很容易把盘写满，写满后连状态文件都存不下，
       * 服务会进入"看起来还活着但什么都做不了"的状态。宁可提前拒绝。
       */
      const free = await freeDiskBytes(config.tmpDir);
      if (free !== null && free < config.download.minFreeSpace) {
        throw new Error(
          `磁盘剩余 ${humanSize(free)}，低于安全阈值 ${humanSize(config.download.minFreeSpace)}，已拒绝启动`,
        );
      }

      // ---------- 1. 下载 ----------
      // 注意：onSegment 必须无条件传入。
      // 之前写成 `t.live ? uploadSegment : undefined`，但 t.live 是在
      // downloadLive 内部才置 true 的，调用时还是 undefined，
      // 导致 onSegment 恒为 undefined，直播分段上传从未被触发。
      const dl = await runDownload(t, {
        url: t.url,
        dir: jobDir,
        filename: t.filename,
        segment: t.segment !== false,
        signal: ac.signal,
        onProgress,
        onLog,
        onSegment: uploadSegment,
      });

      if (ac.signal.aborted && !t._stopRequested) throw new Error('已取消');

      // 等所有分段上传落定，再计算最终状态（历史记录才不会漏记已传的段）
      if (pendingUploads.size) {
        onLog(`等待 ${pendingUploads.size} 段上传收尾…`);
        await Promise.allSettled([...pendingUploads]);
      }

      // ---------- 直播：多文件，逐段收尾 ----------
      if (dl.multiFile) {
        t.filename = dl.filename;
        t.size = dl.size;
        t.downloaded = dl.size;
        t.total = dl.size;
        t.percent = 100;
        t.speed = 0;
        t.localPath = '';

        const segs = dl.segments || [];
        t.segments = segs.map((s) => ({
          index: s.index,
          filename: s.filename,
          size: s.size,
          // 只有确认落地的段才有 remotePath；转码中的先记 expectedPath
          remotePath: s.remotePath || '',
          expectedPath: s.expectedPath || '',
          mp4State: s.mp4State || 'none',
          r2Key: s.r2Key || '',
          submittedAt: s.submittedAt || 0,
          deleted: Boolean(s.deleted),
          // 本地路径要留着：上传失败时「重传」按钮需要靠它找到文件
          localPath: s.path || s.localPath || '',
        }));
        t.segmentCount = segs.length;
        // 已落地数直接按实际带 remotePath 的段数算，
        // 避免 segmentsUploaded 计数和真实状态不一致
        t.segmentsUploaded = t.segments.filter((s) => s.remotePath).length;
        t.segmentsSubmitted = t.segments.filter(
          (s) => s.mp4State === 'pending' || s.mp4State === 'done',
        ).length;

        // 未上传的段（关闭了上传或未配置 OpenList）留在本地
        const kept = segs.filter((s) => !s.deleted && !s.remotePath).length;
        const failed = (t.failedSegments || []).length;
        const pendingMp4 = t.segments.filter((s) => s.mp4State === 'pending').length;
        onLog(
          `直播录制结束：共 ${segs.length} 段，已落地 ${t.segmentsUploaded} 段` +
            (pendingMp4 ? `，${pendingMp4} 段转码中` : '') +
            (failed ? `，${failed} 段失败` : '') +
            (!t.upload ? `，全部保留本地（${kept} 段）` : ''),
        );

        /**
         * 这里不再补提交转码。
         *
         * 每段在录制过程中已经由 doUploadSegment 提交过了，
         * 之前在这里又调一次 _submitTranscodes，导致每段被提交两遍：
         * 默认配置下本地文件已删，第二遍全部 stat 失败 → 写出一堆
         * 幽灵「转码提交失败」；关掉自动删本地时则是真的重复上传 + 重复跑 Actions。
         */
        t.status = STATUS.DONE;
        t.phase = t._stopRequested
          ? pendingMp4
            ? '已停止（转码中）'
            : '已停止'
          : pendingMp4
            ? '转码中'
            : '已完成';
        t.finishedAt = Date.now();
        this._emit(t);
        this._saveState();
        return;
      }

      // ---------- 单文件：原有流程 ----------
      t.localPath = dl.filePath;
      t.filename = dl.filename;
      t.size = dl.size;
      t.downloaded = dl.size;
      t.total = dl.size;
      t.percent = 100;
      t.speed = 0;
      onLog(`下载完成：${dl.filename}  ${humanSize(dl.size)}`);

      // ---------- 2. 上传 ----------
      if (t.upload) {
        const ol = getOpenList();
        if (!ol.configured) {
          onLog('未配置 OpenList，跳过上传，文件保留在本地');
          t.phase = '已完成（未上传）';
          t.status = STATUS.DONE;
          t.finishedAt = Date.now();
          this._emit(t);
          this._saveState();
          return;
        }

        t.status = STATUS.UPLOADING;
        t.phase = '上传中';
        t.percent = 0;
        this._emit(t);
        this._saveState();

        /**
         * 流程：本地 → R2 → GitHub Actions 转码 → OpenList 存 MP4
         *
         * 不直接把原始文件传 OpenList —— 网盘里只放最终能播的 MP4。
         * 转码链路没配时才退回「直接传 OpenList」。
         */
        if (transcodeConfigured()) {
          const r2 = getR2();
          const ext = path.extname(String(dl.filename || '')).toLowerCase() || '.bin';
          const base = stemOf(dl.filename);
          const key = `${config.r2.prefix}/${t.id}/${base}${ext}`;
          const openlistDir = this._remoteDirOf(t);

          try {
            onLog(`上传到 R2 → ${key}（${humanSize(dl.size)}）`);
            await r2.putFile(dl.filePath, key, {
              contentType: contentTypeOf(dl.filename),
              signal: ac.signal,
            });
            t.r2Key = key;
            t.percent = 100;
            this._emit(t);

            onLog('触发 GitHub Actions 转码…');
            await dispatchTranscode(
              buildTranscodeInputs({
                sourceUrl: r2.presignGet(key, config.r2.presignExpires),
                r2Key: key,
                outName: `${base}.mp4`,
                openlistDir,
                taskId: t.id,
                segIndex: 0,
              }),
            );

            /**
             * 只记"预期路径"，**不写 remotePath**。
             *
             * dispatch 返回 204 只代表排队成功。以前这里直接把 remotePath
             * 写成最终 MP4 路径并把任务标成 done，Actions 一失败就是
             * "本地已删 + 网盘没文件 + 状态已完成"的假成功。
             * 现在由轮询器确认文件真的出现后才落 remotePath。
             */
            t.transcoded = { submitted: 1, failed: 0, skipped: false };
            t.expectedPath = `${openlistDir}/${base}.mp4`;
            t.mp4State = 'pending';
            t.mp4SubmittedAt = Date.now();
            t.segmentsSubmitted = 1;
            t.remotePath = '';
            t.failedSegments = [];
            onLog(`已提交转码：${base}.mp4 → ${openlistDir}`);
            onLog('MP4 生成后会出现在 OpenList，任务自动转为「已完成」');
            this._emit(t);
            this._saveState();
          } catch (e) {
            // 任何一步失败都保留本地文件并登记，供「重传」使用
            t.failedSegments = [
              {
                index: 0,
                filename: dl.filename,
                size: dl.size,
                localPath: dl.filePath,
                error: e.message,
              },
            ];
            onLog(`转码提交失败：${e.message}（文件保留本地）`);
            this._emit(t);
            throw e;
          }

          // 只有 R2 上传 + 触发都成功，才删本地
          if (config.openlist.deleteAfterUpload) {
            try {
              await fsp.rm(dl.filePath, { force: true });
              onLog('已删除本地文件');
              t.localPath = '';
            } catch (e) {
              onLog(`删除本地文件失败：${e.message}`);
            }
          }
        } else {
          // ---------- 未配置转码：直接传 OpenList ----------
          const remote = buildRemotePath(dl.filename, {
            taskId: t.id,
            baseName: t.baseName,
            date: t.createdAt,
          });
          onLog(`开始上传 → ${remote}`);

          try {
            await ol.uploadFile(dl.filePath, remote, {
              signal: ac.signal,
              onProgress: (total, uploaded) => {
                t.uploaded = uploaded;
                t.percent = total ? Math.min(99.9, (uploaded / total) * 100) : 0;
                this._emit(t);
              },
              onLog,
            });
          } catch (e) {
            t.failedSegments = [
              {
                index: 0,
                filename: dl.filename,
                size: dl.size,
                localPath: dl.filePath,
                error: e.message,
              },
            ];
            this._emit(t);
            throw e;
          }

          t.remotePath = remote;
          t.percent = 100;
          t.failedSegments = [];
          onLog(`上传完成：${remote}`);
          this._emit(t);
          this._saveState();

          if (config.openlist.deleteAfterUpload) {
            try {
              await fsp.rm(dl.filePath, { force: true });
              onLog('已删除本地文件');
              t.localPath = '';
            } catch (e) {
              onLog(`删除本地文件失败：${e.message}`);
            }
          }
        }
      }

      t.status = STATUS.DONE;
      t.phase = t._stopRequested ? '已停止' : t.mp4State === 'pending' ? '转码中' : '已完成';
      t.finishedAt = Date.now();
      t.speed = 0;
      t.eta = 0;
      this._emit(t);
      this._saveState();
    } catch (e) {
      /**
       * 区分三种结束：
       *   _stopRequested  用户点了停止，且已经录到内容 → 不该算失败
       *   aborted         外部强制中断 → 取消
       *   其它            真失败
       *
       * 之前只看 ac.signal.aborted，导致「停止」被当成「取消」，
       * 已录好的文件被丢掉不上传。
       */
      const canceled = ac.signal.aborted && !t._stopRequested;
      /**
       * 用户点了停止，但也要看有没有真的录到东西。
       *
       * 之前只要有 _stopRequested 就标 done，于是"刚点开始就取消"的任务
       * 会显示成绿色「已完成 / 已停止」，实际一个字节都没有。
       */
      const hasContent = (t.size || 0) > 0 || (t.segments || []).length > 0;
      if (t._stopRequested && hasContent) {
        // 停止时已经有内容 → 保住成果
        t.status = STATUS.DONE;
        t.phase = '已停止';
        t.error = '';
        this._log(t, '已停止录制');
      } else if (t._stopRequested) {
        // 停了但什么都没录到 → 就是取消
        t.status = STATUS.CANCELED;
        t.phase = '已取消';
        t.error = '';
        this._log(t, '已取消（未录到任何内容）');
      } else {
        t.status = canceled ? STATUS.CANCELED : STATUS.FAILED;
        t.phase = canceled ? '已取消' : '失败';
        t.error = canceled ? '已取消' : e.message;
        this._log(t, canceled ? '任务已取消' : `失败：${e.message}`);
      }
      t.finishedAt = Date.now();
      t.speed = 0;
      this._emit(t);
      this._saveState();

      /**
       * 清理残留临时文件。
       *
       * 判据从「有没有失败记录」改成「有没有可能还没传出去的内容」，
       * 因为前者只覆盖直播分段，单文件上传失败时 failedSegments 是空的，
       * 会把已经下好的文件一起删掉。
       *
       * 只要满足任一条件就保留整个 jobDir：
       *   - 用户主动停止（文件可能是他想要的成果）
       *   - 有登记的上传失败记录
       *   - 开了上传，但还有内容既没落地也没进转码队列 —— 说明没传成功
       *
       * 注意 pending 也算"已经有着落"：源文件已经在 R2 里，
       * 本地这份删掉不会丢数据，不必为了它保留整个目录。
       */
      const segs = t.segments || [];
      const allHandled = segs.length
        ? segs.every((s) => s.remotePath || s.mp4State === 'pending' || s.mp4State === 'done')
        : Boolean(t.remotePath) || t.mp4State === 'pending' || t.mp4State === 'done';

      const mayHaveUnuploaded =
        Boolean(t._stopRequested) ||
        (t.failedSegments?.length || 0) > 0 ||
        (t.upload && !allHandled && ((t.size || 0) > 0 || segs.length > 0));

      if (!mayHaveUnuploaded) {
        try {
          await fsp.rm(jobDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    } finally {
      t._abort = null;
      t._stopRequested = false;

      // 写入历史记录（存到 OpenList，容器重建也不丢）
      try {
        await getHistoryStore().upsert(this._historyRecord(t));
      } catch (e) {
        console.error(`[history] 记录任务失败：${e.message}`);
      }
    }
  }

  /** 算任务的远端目录，供转码结果落地时对照 */
  _remoteDirOf(t) {
    /**
     * 一律按规则计算，不依赖已经上传成功的 remotePath。
     *
     * 之前优先从 segments[].remotePath 反推目录，但新流程里
     * remotePath 是在转码**提交时**就算出来的，那时还没有任何
     * 分段真的传成功 —— 反推会拿到空字符串，导致 Actions 把 MP4
     * 传到错误的位置。规则是确定性的，直接算更可靠。
     */
    return buildRemotePath('', {
      taskId: t.id,
      baseName: t.baseName,
      date: t.createdAt,
    }).replace(/\/$/, '');
  }

  /** 从任务对象提炼一条精简的历史记录（不含日志，避免体积过大） */
  _historyRecord(t) {
    const segs = t.segments || [];
    return {
      id: t.id,
      url: t.url,
      filename: t.filename,
      kind: t.kind,
      live: Boolean(t.live),
      upload: Boolean(t.upload),
      segment: t.segment !== false,
      status: t.status,
      size: t.size || 0,
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      remotePath: t.remotePath || '',
      segmentCount: t.segmentCount || segs.length || 0,
      segmentsUploaded: segs.filter((s) => s.remotePath).length,
      /**
       * 转码状态。
       * segmentsUploaded 只算"确认落地"的段；transcodePending 是已提交
       * 但 MP4 还没出现在 OpenList 的段数。前端据此显示「转码中 N 段」。
       */
      mp4State: t.mp4State || 'none',
      expectedPath: t.expectedPath || '',
      segmentsSubmitted: segs.filter((s) => s.mp4State === 'pending' || s.mp4State === 'done').length,
      transcodePending: segs.filter((s) => s.mp4State === 'pending').length +
        (t.mp4State === 'pending' && !segs.length ? 1 : 0),
      transcodeFailed: segs.filter((s) => s.mp4State === 'failed').length +
        (t.mp4State === 'failed' && !segs.length ? 1 : 0),
      failedSegments: (t.failedSegments || []).map((f) => ({
        index: f.index,
        filename: f.filename,
        size: f.size,
        error: f.error,
      })),
      remoteDir: (() => {
        const first = segs.find((s) => s.remotePath)?.remotePath || t.remotePath || '';
        if (!first) return '';
        const k = first.lastIndexOf('/');
        return k > 0 ? first.slice(0, k) : '';
      })(),
      // 直播分段只记远端路径，不记本地路径
      segments: segs.map((s) => ({
        index: s.index,
        filename: s.filename,
        size: s.size,
        remotePath: s.remotePath || '',
        expectedPath: s.expectedPath || '',
        mp4State: s.mp4State || 'none',
      })),
      error: t.error || '',
      /** 转码提交结果，前端用来显示「MP4 生成中」之类的提示 */
      transcoded: t.transcoded || null,
      duration:
        t.startedAt && t.finishedAt ? Math.round((t.finishedAt - t.startedAt) / 1000) : 0,
    };
  }
}

/** 单例 */
let _mgr = null;
export function getTaskManager() {
  if (!_mgr) _mgr = new TaskManager();
  return _mgr;
}
