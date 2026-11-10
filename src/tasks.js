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

/**
 * 生成 YYYYMMDDHHmmss 形式的时间戳，**按中国时区**。
 *
 * 不能用 toISOString()：那是 UTC，容器里晚上 8 点之后录的东西
 * 会得到「前一天」的名字，而 OpenList 的日期目录是用
 * Intl + Asia/Shanghai 算的，两边对不上 —— 目录是 11-09，
 * 里面的文件叫 live_20261108_170000。
 */
function stampCN(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value || '00';
  return `${get('year')}${get('month')}${get('day')}${get('hour')}${get('minute')}${get('second')}`;
}

/**
 * 历史记录里最多保留多少条分段明细。
 *
 * 明细只用于前端推断「文件夹」按钮和合并任务特征，统计数字都是
 * 预聚合字段（segmentCount / segmentsUploaded / transcodePending）。
 * 不截断的话单条记录 32KB、200 条约 6MB，每次历史变更都要整份重传 OpenList。
 */
const HISTORY_SEGMENT_SAMPLE = 20;

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
    /**
     * 正在补传/重新合并的任务 id。
     *
     * 重传接口是 202 fire-and-forget，HTTP 层立刻就返回了，
     * 而 _retryMerged 要先 stat / 上传才把 mp4State 改成 pending。
     * 这段窗口里再点一次「重新合并」，canRetryUpload 看到的还是旧状态，
     * 于是会真的派出第二次 workflow_dispatch。
     * 用一个同步加锁的集合挡住它，不依赖前端的按钮禁用。
     */
    this.retrying = new Set();
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
          /**
           * 还有必须保留的 R2 源分段 → 不自动清。
           *
           * 任务一旦从列表消失，界面上就再也没有入口去「重新合并」或
           * 「强制删除」，那些分段会变成永久孤儿，只能手动进 R2 删。
           * 代价是这类任务会一直挂在列表里，但它们本来就是需要用户处理的。
           */
          if (this._hasProtectedSources(t)) {
            console.warn(
              `[tasks] 任务 ${id} 已过保留期，但仍有转码失败的源分段，暂不清理（可在界面上重试或强制删除）`,
            );
            continue;
          }
          this.tasks.delete(id);
          this._disposeTask(t);
          this._removeJobDir(id).catch(() => {});
          changed = true;
        }
      }
      // 超出上限时删最老的已完成任务（同样跳过有受保护源分段的）
      if (this.tasks.size > config.maxTasks) {
        const finished = [...this.tasks.values()]
          .filter(
            (t) =>
              [STATUS.DONE, STATUS.FAILED, STATUS.CANCELED].includes(t.status) &&
              !this._hasProtectedSources(t),
          )
          .sort((a, b) => a.createdAt - b.createdAt);
        while (this.tasks.size > config.maxTasks && finished.length) {
          const t = finished.shift();
          this.tasks.delete(t.id);
          this._disposeTask(t);
          this._removeJobDir(t.id).catch(() => {});
          changed = true;
        }
      }
      if (changed) this._saveState();
    }, 5 * 60 * 1000).unref?.();
  }

  /**
   * 计算某个任务删除时「哪些 R2 对象该删、哪些必须保留」。
   *
   * 纯函数，无副作用 —— _disposeTask / clearFinished / 过期清理器共用，
   * 保证三处对「什么该留」的判断完全一致。
   *
   * 规则：
   *   - pending            → 都不动（Actions 正在下载）
   *   - 合并任务整体失败    → 全部保留（段是 staged，但整场都失败）
   *   - 段级 failed        → 保留（旧的逐段转码路径）
   *   - 其它               → 删
   *   - force=true         → 除 pending 外全删
   */
  _planDispose(t, { force = false } = {}) {
    const del = new Set();
    const keep = new Set();

    const r = config.r2;
    if (!r.accessKeyId || !r.secretAccessKey || !r.bucket) return { del, keep };

    // 合并转码进行中：Actions 正在逐段拉取，删了它就会失败
    if (t.mergedSubmitted && t.mp4State === 'pending') return { del, keep };

    /**
     * 合并任务的失败状态挂在**任务**上，段本身还是 staged。
     *
     * 只看段级 mp4State 的话，staged 既不是 pending 也不是 failed，
     * 会被当成"正常段"全删 —— 这正是 2.4 小时直播（29 段）丢失那次的情形：
     * 转码超时后任务 mp4State=failed，但每段仍是 staged，删任务时 29 段全没了。
     */
    const merged = Boolean(t.mergedSubmitted || (t.mergeKeys || []).length);
    const mergedFailed = merged && t.mp4State === 'failed';

    const classify = (key, mp4State) => {
      if (!key) return;
      if (mp4State === 'pending') return;
      if ((mergedFailed || mp4State === 'failed') && !force) {
        keep.add(key);
        return;
      }
      del.add(key);
    };

    classify(t.r2Key, t.mp4State);
    for (const s of t.segments || []) classify(s.r2Key, s.mp4State);

    return { del, keep };
  }

  /**
   * 这个任务是否还有「必须保留」的 R2 源文件。
   *
   * 用来拦住批量清理和过期清理：任务一旦从列表里消失，
   * 界面上就再也没有入口去重跑或强制删除，源文件会变成永久孤儿。
   */
  _hasProtectedSources(t) {
    return this._planDispose(t).keep.size > 0;
  }

  /**
   * 删除任务时清理它留下的 R2 中转对象。
   *
   * 磁盘目录由 _removeJobDir 负责 —— 两件事分开，避免这里 fire-and-forget
   * 的 rm 和调用方 await 的 rm 重复执行。
   *
   * R2 里还留着源文件只有两种情况：转码失败（特意留着以便重试）、
   * 或者从未提交成功。用户主动删任务时这些都没用了，必须清掉 ——
   * R2 免费额度只有 10GB，历史垃圾不清会直接把额度占满，
   * 之后所有上传都失败，而且报错是 R2 PUT 403，很难联想到是空间问题。
   *
   * 正在转码的不能删：Actions 还在下载它。
   *
   * ---- 2026-11 补充：转码失败的分段**默认不删** ----
   *
   * 出过一次真实事故：一场 2.4 小时的直播（29 段，1.42GB）转码
   * 撞上 Actions 超时被取消，mp4State 标成 failed。用户看到任务
   * 显示失败，就点了删除清理界面 —— 于是这 29 段源文件全被删掉。
   * 等修好转码参数想重跑时，**源数据已经不存在了**，那场直播彻底丢失。
   *
   * 现在的规则见 _planDispose()。代价是失败任务会占着 R2 空间，
   * 这是有意的权衡：R2 免费 10GB 能存约 7 场这样的直播，
   * 而丢失的直播是找不回来的。
   *
   * @param {object} t 任务
   * @param {{force?: boolean}} [opts] force=true 时连失败的分段也删
   * @returns {{deleted: number, kept: number}} 删除与保留的计数
   */
  _disposeTask(t, { force = false } = {}) {
    const { del, keep } = this._planDispose(t, { force });

    if (del.size) {
      const r2 = getR2();
      for (const key of del) {
        r2.deleteObject(key).catch(() => {});
      }
    }

    /**
     * 记录「保留了几个」。
     *
     * 直接写 t.logs：调用点（remove / clearFinished）已经把任务从
     * this.tasks 删掉了，而 _log(t, ...) 只操作传入的对象本身，不会抛错。
     * 这条日志是给人看的说明，任务对象还在内存里，写进去前端也能看到。
     */
    if (keep.size && Array.isArray(t.logs)) {
      const line = `[${new Date().toLocaleTimeString('zh-CN', {
        hour12: false,
        timeZone: 'Asia/Shanghai',
      })}] 保留了 ${keep.size} 个转码失败的分段（可重试），未删除`;
      t.logs.push(line);
      if (t.logs.length > 200) t.logs.shift();
    }

    return { deleted: del.size, kept: keep.size };
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
          // 合并任务：MP4 是一个整体，落地后把所有段一起标成 merged
          if (p.item === t && t.mergedSubmitted) this._markMergedLanded(t, p.path);
          changed = true;
          this._log(t, `转码完成：${p.path}`);
        } else if (now - (p.at || 0) > config.transcode.timeoutMs) {
          p.item.mp4State = 'failed';
          if (p.item === t && t.mergedSubmitted) {
            t.mergeError = '转码超时：超过等待上限仍未在 OpenList 看到 MP4';
          }
          changed = true;
          this._log(
            t,
            `转码超时（${Math.round((now - (p.at || now)) / 60000)} 分钟未见 MP4）：${p.path}，可在历史记录里重试`,
          );
        }
      }
      if (!changed) continue;

      if (!(t.mergedSubmitted && t.mp4State === 'done')) {
        t.segmentsUploaded = (t.segments || []).filter((s) => s.remotePath).length;
      }
      /**
       * 合并任务的 pending 挂在任务上（t.mp4State），段本身是 staged。
       * 只判断段的话，合并转码中会被误判成"没有待办"，phase 提前变成已完成。
       */
      const stillPending =
        (t.segments || []).some((s) => s.mp4State === 'pending') || t.mp4State === 'pending';
      if (!stillPending) {
        t.phase = t._stopRequested
          ? '已停止'
          : t.mp4State === 'failed'
            ? '转码失败'
            : '已完成';
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
  /**
   * 创建任务。
   *
   * @param {object} opts
   * @param {string} opts.url
   * @param {string} [opts.filename]
   * @param {boolean} [opts.upload=true]
   * @param {boolean} [opts.segment=true]
   * @param {'cfr'|'remux'} [opts.mode='remux']
   *   转码输出方式。remux = 纯 -c copy（快 1600 倍、字面无损，
   *   但把源里坏掉的帧率原样带进 MP4，部分播放器拖不动进度条）；
   *   cfr = 重编码成恒定帧率（兼容性最好，但要花几十分钟）。
   *   见 scripts/transcode-worker.mjs 里 remuxToMp4 的说明。
   * @param {number} [opts.maxSeconds=0]
   *   最长录制秒数，0 = 不限制（录到用户手动停止或直播结束）。
   *   只对直播生效，普通文件下载忽略。
   */
  create({ url, filename, upload = true, segment = true, mode = 'remux', maxSeconds = 0 }) {
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
    const ts = stampCN();
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
      /**
       * 转码输出方式。'remux'（默认）| 'cfr'。
       * 校验放在这里而不是信任前端 —— 前端传错值时退回默认，
       * 不要让一个拼写错误导致 Actions 那边跑出意外的产物。
       * 顺手做 trim + 小写：'CFR' / ' remux ' 这种也认，别让大小写把人坑了。
       */
      mode: String(mode || '').trim().toLowerCase() === 'cfr' ? 'cfr' : 'remux',
      /**
       * 最长录制秒数。0 = 不限制。
       * 上限 24 小时，避免有人传个巨大数字把 ffmpeg 挂到天荒地老。
       * 只对直播有意义，普通下载由文件本身长度决定。
       */
      maxSeconds: Math.min(Math.max(Number(maxSeconds) || 0, 0), 86400),
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

  /**
   * 删除一个任务，并清掉它占用的磁盘目录。
   *
   * 之前只从内存里删，磁盘上的 tmp/<id>/ 原封不动留着。
   * 1GiB 的卷上，一个失败的 300MB 分段就够把盘撑满，
   * 而用户在界面上点了「删除」以为空间已经回来了。
   *
   * 运行中的任务拒绝删除（this.running 里有的），
   * 否则 ffmpeg 还在往目录里写，删了会出错。
   */
  /**
   * 删除单个任务。
   *
   * @param {string} id 任务 id
   * @param {{force?: boolean}} [opts]
   *   force=true 时连「转码失败的分段」也从 R2 删掉。
   *   默认 false —— 失败分段的源文件是重跑的唯一希望，
   *   误删会让整场直播永久丢失（真实事故，见 _disposeTask 注释）。
   * @returns {Promise<boolean>}
   */
  async remove(id, { force = false } = {}) {
    const t = this.tasks.get(id);
    if (!t) return false;
    if (this.running.has(id)) return false;

    this.tasks.delete(id);
    this._disposeTask(t, { force });
    this._saveState();
    this.emit('removed', { id });

    // 删磁盘目录放在最后：即使失败也不影响任务列表的一致性
    await this._removeJobDir(id);
    return true;
  }

  /**
   * 清掉所有已结束任务。
   *
   * 这里**永不 force**：批量清理最容易误伤，而且用户点这个按钮时
   * 想的是"清掉界面上那些已完成的任务"，不是"把失败任务的源文件也烧了"。
   * 失败分段要清，得走单个 remove({force:true})。
   *
   * 还有源分段要保留的任务**不删**：任务一消失，界面上就再没有
   * 「重新合并」和「强制删除」的入口，R2 里那些分段会变成永久孤儿。
   * 所以这类任务留在列表里，由用户决定是重试还是彻底删掉。
   *
   * @returns {Promise<{removed: number, kept: number}>}
   */
  async clearFinished() {
    const done = [];
    let kept = 0;
    for (const [id, t] of this.tasks) {
      if (![STATUS.DONE, STATUS.FAILED, STATUS.CANCELED].includes(t.status)) continue;
      if (this._hasProtectedSources(t)) {
        kept++;
        continue;
      }
      done.push(id);
    }
    for (const id of done) {
      const t = this.tasks.get(id);
      this.tasks.delete(id);
      this._disposeTask(t, { force: false });
    }
    if (done.length) this._saveState();

    // 串行删，避免同时发起大量 unlink 把 IO 打满
    for (const id of done) {
      await this._removeJobDir(id);
    }
    return { removed: done.length, kept };
  }

  /**
   * 彻底清空临时目录 —— 「清空磁盘」按钮。
   *
   * 和 clearFinished() 的区别：
   *
   *   clearFinished  只删**已知任务**的目录，而且会跳过有受保护源分段的
   *                  任务。它是「整理列表」，不是「腾空间」。
   *
   *   purgeDisk      扫 tmpDir 下**所有**条目，不管有没有对应任务。
   *                  残留目录（任务被删了但目录没删干净、上次进程崩溃
   *                  留下的半截文件、手动上传的测试文件）都能清掉。
   *
   * 为什么需要它：卷只有 973MB，实测用着用着会剩 929MB 可用、44MB 不翼而飞。
   * 那些字节不属于任何已知任务，clearFinished 永远够不着。
   *
   * 安全边界：
   *   - 正在跑的任务目录**跳过**，否则 ffmpeg 还在往里写
   *   - 只处理 tmpDir 的直接子项，不递归到 tmpDir 之外
   *   - 每个路径都做 resolve + 前缀校验，防止软链或路径穿越
   *
   * @returns {Promise<{freed: number, removed: number, skipped: number}>}
   */
  async purgeDisk() {
    /**
     * 正在跑的任务 id 集合。
     *
     * 同时看 running（正在下载）和 queue 里已经拿到 _abort 的，
     * 但排队中的任务还没建目录，只需要保护 running。
     */
    const busy = new Set(this.running.keys());

    let freed = 0;
    let removed = 0;
    let skipped = 0;

    const root = path.resolve(config.tmpDir);
    let entries;
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch (e) {
      // 目录不存在 = 本来就干净，不算错误
      if (e.code === 'ENOENT') return { freed: 0, removed: 0, skipped: 0 };
      throw e;
    }

    for (const ent of entries) {
      // 正在跑的任务，目录里可能有 ffmpeg 正在写的文件，别动
      if (busy.has(ent.name)) {
        skipped++;
        continue;
      }

      const target = path.join(root, ent.name);
      /**
       * 双重校验：resolve 之后必须仍在 root 之内。
       * readdir 返回的名字理论上不会有 ..，但软链可以指向外面，
       * 而 fsp.rm(recursive) 会顺着软链删 —— 那是灾难。
       */
      const resolved = path.resolve(target);
      if (!resolved.startsWith(root + path.sep)) {
        skipped++;
        continue;
      }

      // 先算体积，删完就没法算了
      const sz = await this._sizeOfPath(resolved);

      try {
        await fsp.rm(resolved, { recursive: true, force: true });
        freed += sz;
        removed++;
      } catch (e) {
        this.emit('log', { id: '', line: `[清空磁盘] ${ent.name} 删除失败：${e.message}` });
        skipped++;
      }
    }

    /**
     * 任务对象还在内存里，但目录已经没了。
     * 不清掉这些任务的 localPath，界面会显示一个不存在的路径，
     * 用户点「重传」会报 ENOENT。所以顺手把指向已删目录的 localPath 抹掉。
     */
    for (const t of this.tasks.values()) {
      if (t.localPath && !fs.existsSync(t.localPath)) t.localPath = '';
    }

    return { freed, removed, skipped };
  }

  /** 递归算一个路径占多少字节。出错就返回已累计的部分，不抛 */
  async _sizeOfPath(p) {
    let total = 0;
    let st;
    try {
      st = await fsp.lstat(p);
    } catch {
      return 0;
    }
    if (!st.isDirectory()) return st.size;

    let names;
    try {
      names = await fsp.readdir(p);
    } catch {
      return 0;
    }
    for (const n of names) {
      total += await this._sizeOfPath(path.join(p, n));
    }
    return total;
  }

  /** 删除某个任务的临时目录，失败只记日志不抛错 */
  async _removeJobDir(id) {
    // 只允许删 tmpDir 下、名字是任务 id 的目录，防止路径穿越
    const safe = String(id).replace(/[^a-zA-Z0-9-]/g, '');
    if (!safe || safe !== String(id)) return;
    const dir = path.join(config.tmpDir, safe);
    // 双重校验：解析后的路径必须真的在 tmpDir 之内
    if (!path.resolve(dir).startsWith(path.resolve(config.tmpDir) + path.sep)) return;
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch (e) {
      this.emit('log', { id, line: `[清理] 删除目录失败：${e.message}` });
    }
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
  /**
   * 判断任务能不能补传，不真的开始传。
   *
   * 给 HTTP 层用：重传要几分钟，接口不能同步等（Unikraft 网关 60 秒
   * 就超时），所以先同步校验一遍，能立刻判断的错直接返回 400，
   * 通过了再 fire-and-forget 交给 retryFailedSegments。
   *
   * @returns {{ok: boolean, error?: string, count?: number}}
   */
  canRetryUpload(id) {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };

    if (this.running.has(id) || [STATUS.QUEUED, STATUS.DOWNLOADING, STATUS.UPLOADING].includes(t.status)) {
      return { ok: false, error: '任务仍在进行中，请等它结束后再重试上传' };
    }
    if (this.retrying.has(id)) {
      return { ok: false, error: '正在重试中，请稍候' };
    }

    const useTranscode = transcodeConfigured();
    if (!useTranscode && !getOpenList().configured) {
      return { ok: false, error: 'OpenList 未配置，无法上传' };
    }

    /**
     * 合并模式：产物是整场一个 MP4，重试的语义是「重新提交一次合并」，
     * 不是逐段重传。不能走下面的逐段统计，否则：
     *   - 已经合并成功的任务也会显示「重传 N」
     *   - 点一下会把 36 段拆成 36 个 MP4
     */
    if (this._isMerged(t)) {
      if (t.mp4State === 'pending') {
        return { ok: false, error: '合并转码正在进行中，请等它结束' };
      }
      if (t.mp4State === 'done' && t.remotePath) {
        return { ok: false, error: '合并后的 MP4 已在网盘里，无需重试' };
      }
      const missing = (t.segments || []).filter((s) => !s.r2Key).length;
      return { ok: true, count: 1, merged: true, missing };
    }

    /**
     * 数待补传的段，按 index 去重。
     *
     * 同一段可能同时出现在两处：segments 里 remotePath 为空，
     * failedSegments 里也登记过 —— 直接相加会重复计数。
     * retryFailedSegments 内部就是用 Map 按 index 合并的，
     * 这里保持一致，否则接口报的段数比实际多。
     */
    const pending = new Set();
    for (const s of t.segments || []) {
      if (!s.remotePath && s.mp4State !== 'pending') pending.add(s.index);
    }
    for (const f of t.failedSegments || []) {
      pending.add(f.index);
    }

    if (pending.size === 0) return { ok: false, error: '没有待补传的分段' };
    return { ok: true, count: pending.size };
  }

  /** 这个任务是不是走「整场合并成一个 MP4」的流程 */
  _isMerged(t) {
    if (t.mergedSubmitted || (t.mergeKeys || []).length) return true;
    /**
     * 兼容旧记录：01a6dea 之后、本次修复之前创建的任务没有 mergeKeys，
     * 提交失败时只留下 mergeError。特征很明确：
     *   - 有 mergeError（说明尝试过合并）
     *   - 所有段都在 R2 里，且没有任何一段落地到 OpenList
     *
     * 不能只看「段都在 R2 且没落地」—— 逐段转码的任务也长这样，
     * 那样会把本该逐段重试的任务误判成合并任务。
     */
    if (!t.mergeError) return false;
    const segs = t.segments || [];
    return segs.length > 0 && segs.every((s) => s.r2Key) && segs.every((s) => !s.remotePath);
  }

  /**
   * 补传 / 重新合并的统一入口。
   *
   * 用 retrying 集合做同步互斥：接口是 202 fire-and-forget，调用方拿不到
   * "真正结束"的信号。不锁的话连点两次就会派出两次合并转码。
   */
  async retryFailedSegments(id) {
    if (this.retrying.has(id)) throw new Error('正在重试中，请稍候');
    this.retrying.add(id);
    try {
      return await this._retryFailedSegments(id);
    } finally {
      this.retrying.delete(id);
    }
  }

  async _retryFailedSegments(id) {
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

    // 合并任务：补齐缺失段后重新提交一次合并，不逐段转码
    if (this._isMerged(t)) return this._retryMerged(t);

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

  /**
   * 重试「整场合并」任务。
   *
   * 和逐段重试的区别：
   *   1) 先把没进 R2 的段补传上去（本地还在才行）
   *   2) 所有段齐了以后，重新提交**一次**合并转码
   *
   * 绝不能退回逐段转码 —— 那会产出 N 个 5 分钟的 MP4，
   * 和用户预期的一个完整视频完全不同。
   */
  async _retryMerged(t) {
    if (t.mp4State === 'pending') throw new Error('合并转码正在进行中，请等它结束');

    const segs = (t.segments || []).slice().sort((a, b) => a.index - b.index);
    if (!segs.length) throw new Error('没有可合并的分段');

    this._log(t, `重试合并转码：共 ${segs.length} 段，其中 ${segs.filter((s) => !s.r2Key).length} 段需要补传`);

    let uploaded = 0;
    for (const s of segs) {
      if (s.r2Key) continue;
      const local = s.localPath || path.join(config.tmpDir, t.id, s.filename || '');
      const exists = await fsp
        .stat(local)
        .then((st) => st.size > 0)
        .catch(() => false);
      if (!exists) {
        throw new Error(
          `第 ${s.index} 段既不在 R2 也没有本地文件，无法合并（只能重新录制）`,
        );
      }
      s.r2Key = await this._uploadToR2(t, s.index, s.filename, local);
      s.mp4State = 'staged';
      uploaded++;
      if (config.openlist.deleteAfterUpload) {
        await fsp.rm(local, { force: true }).catch(() => {});
        s.deleted = true;
      }
    }

    const keys = segs.filter((s) => s.r2Key).map((s) => s.r2Key);
    if (keys.length !== segs.length) {
      throw new Error(`仍有 ${segs.length - keys.length} 段没有进 R2，无法合并`);
    }

    const outName = `${t.baseName || 'live'}.mp4`;
    const openlistDir = this._remoteDirOf(t);
    t.mergeKeys = keys;
    t.expectedPath = `${openlistDir}/${outName}`;

    await dispatchTranscode(
      buildTranscodeInputs({
        r2Keys: keys,
        outName,
        openlistDir,
        taskId: t.id,
        // 重试要沿用任务原本的输出方式，否则用户选的 cfr 会被换成默认的 remux
        mode: t.mode,
      }),
    );

    t.mergedSubmitted = true;
    t.mp4State = 'pending';
    t.mp4SubmittedAt = Date.now();
    t.mergeError = '';
    t.segmentsUploaded = 0;
    t.segmentsSubmitted = segs.length;
    t.failedSegments = [];
    t.error = '';
    if (t.status === STATUS.FAILED) {
      t.status = STATUS.DONE;
      t.phase = '合并转码中';
    } else {
      t.phase = t._stopRequested ? '已停止（转码中）' : '合并转码中';
    }

    this._log(
      t,
      `已重新提交合并转码：${keys.length} 段${uploaded ? `（补传 ${uploaded} 段）` : ''} → ${outName}`,
    );
    this._emit(t);
    this._saveState();

    try {
      await getHistoryStore().upsert(this._historyRecord(t));
    } catch {
      /* ignore */
    }

    return { retried: 1, submitted: 1, failed: 0, uploaded, merged: true };
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

  /** 触发一次转码（单文件 / 逐段重试用） */
  async _dispatchOne(t, { key, outName, openlistDir }) {
    const r2 = getR2();
    await dispatchTranscode(
      buildTranscodeInputs({
        sourceUrl: r2.presignGet(key, config.r2.presignExpires),
        r2Key: key,
        outName,
        openlistDir,
        taskId: t.id,
        mode: t.mode,
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

  /**
   * 合并转码落地：MP4 是整场一个文件，所有段一起算「已落地」。
   *
   * 不给段写 remotePath —— 段本身并不在 OpenList 里（合并后就被删了），
   * 写了会让「文件夹」按钮和历史统计指向一个不存在的路径。
   */
  _markMergedLanded(t, remotePath) {
    t.remotePath = remotePath;
    t.mergeError = '';
    t.segmentsUploaded = t.segmentCount || (t.segments || []).length;
    for (const s of t.segments || []) {
      if (s.mp4State === 'staged' || s.mp4State === 'pending') s.mp4State = 'merged';
    }
  }

  _emit(t) {
    // 不带 logs：进度事件很密集，日志由 'log' 事件单独推送
    this.emit('update', this._public(t));
  }

  _log(t, msg) {
    // 固定中国时区：容器 TZ 已设成 Asia/Shanghai，但显式指定更稳妥，
    // 不受宿主机或以后改 TZ 影响
    const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}] ${msg}`;
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
      /**
       * upload=false 的语义：**只留 R2，不传 OpenList，本地立即删**。
       *
       * 以前这里是「保留本地」—— 那是错的。卷只有 973MB，一场 2 小时
       * 直播的 29 段共 1.4GB，留本地当场就把盘写满，后续任务全废。
       *
       * 而且「保留本地」对用户毫无价值：容器是无状态的，实例一重建
       * （每次部署都会重建）本地文件就没了，用户拿不到任何东西。
       *
       * R2 是持久存储，分段放那儿随时能取。所以这个分支只做一件事：
       * 把分段传上 R2，然后删本地。
       */
      if (!t.upload) {
        if (!getR2().configured) {
          /**
           * 没配 R2 就没地方放。
           *
           * 不能静默保留本地（盘会满），也不能直接删（数据全丢）。
           * 只能失败，并明确告诉用户原因 —— 这比悄悄丢数据好。
           */
          recordFailure(rec, '未开启上传且未配置 R2，分段无处安放');
          onLog(`第 ${rec.index} 段：未开启上传，且 R2 未配置 —— 无法保留，已记为失败`);
          return;
        }
        onLog(`第 ${rec.index} 段：只存 R2（不传 OpenList），本地删除`);
        try {
          await uploadSegmentToR2(rec);
          /**
           * 传完立即删本地。
           *
           * 这里不依赖外层清理：外层要等整场录完才跑，而分段是边录
           * 边产的，不即时删的话峰值磁盘占用还是整场大小。
           */
          await fsp.rm(rec.path, { force: true }).catch(() => {});
          rec.deleted = true;
        } catch (e) {
          onLog(`第 ${rec.index} 段 R2 上传失败：${e.message}（文件保留本地）`);
          recordFailure(rec, `R2 上传失败：${e.message}`);
        }
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
       * 分段只负责把 FLV 放进 R2，**不逐段转码**。
       *
       * 整场录完后由 _submitMergedTranscode() 一次性拉全部段、
       * concat 合并、转成一个 MP4 再传 OpenList。
       *
       * 为什么不逐段转：
       *   - 每段单独转再拼，接缝处时间戳跳变，拖动进度条会卡
       *   - 一次转码能重新分配码率，整场体积更小
       *   - 5 分钟一段时，一场 3 小时直播是 36 段，逐段触发就是
       *     36 次 Actions，分钟数吃不消
       */
      rec.r2Done = true;
      rec.mp4State = 'staged';
      t.segmentsSubmitted = (t.segmentsSubmitted || 0) + 1;
      // 成功了就从失败列表里移除（可能是重传成功的）
      t.failedSegments = (t.failedSegments || []).filter((x) => x.index !== rec.index);
      onLog(`第 ${rec.index} 段已存 R2（整场录完后统一合并转码）`);
      this._emit(t);

      /**
       * R2 上传成功，本地文件就没用了。
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

    /** 把分段传到 R2（不触发转码，等整场录完统一合并） */
    const uploadSegmentToR2 = async (rec) => {
      const r2 = getR2();
      const ext = path.extname(String(rec.filename || '')).toLowerCase() || '.bin';
      const key = `${config.r2.prefix}/${t.id}/${stemOf(rec.filename)}${ext}`;

      await r2.putFile(rec.path, key, {
        contentType: contentTypeOf(rec.filename),
        signal: ac.signal,
      });
      rec.r2Key = key;
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
        /**
         * 最长录制秒数，0 = 不限。
         * 只有直播会读它，普通文件下载忽略。
         */
        maxSeconds: t.maxSeconds || 0,
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
        /**
         * 口径统一：segmentsUploaded 只算「确认落地到 OpenList」的段。
         * 合并模式下这个值在 MP4 确认前恒为 0 —— 段只是在 R2 里排队，
         * 不能算已落地。已经存进 R2 的段数看 segmentsSubmitted。
         */
        t.segmentsUploaded = t.segments.filter((s) => s.remotePath).length;
        t.segmentsSubmitted = t.segments.filter((s) => s.r2Key).length;

        // 未上传的段（关闭了上传或未配置 OpenList）留在本地
        const kept = segs.filter((s) => !s.deleted && !s.r2Key).length;
        const failed = (t.failedSegments || []).length;
        onLog(
          `直播录制结束：共 ${segs.length} 段，已存 R2 ${t.segmentsSubmitted} 段` +
            (failed ? `，${failed} 段失败` : '') +
            (!t.upload ? `，全部保留本地（${kept} 段）` : ''),
        );

        /**
         * 整场录完，把 R2 上所有分段一次性交给 Actions 合并转码。
         *
         * 这是新流程的核心：分段只负责落地 R2，转码合并只在最后做一次。
         */
        const stagedKeys = t.segments
          .filter((s) => s.r2Key)
          .sort((a, b) => a.index - b.index)
          .map((s) => s.r2Key);
        // 缺段不合并：少几段拼出来的 MP4 能正常播放，但内容中间是断的，
        // 比直接失败更难发现。宁可留在「转码失败」让用户补齐后重试。
        const missingSegs = t.segments.length - stagedKeys.length;

        if (stagedKeys.length && transcodeConfigured() && !missingSegs) {
          const outName = `${t.baseName || 'live'}.mp4`;
          const openlistDir = this._remoteDirOf(t);
          t.mergeKeys = stagedKeys;
          t.expectedPath = `${openlistDir}/${outName}`;
          onLog(`提交合并转码：${stagedKeys.length} 段 → ${outName}`);
          try {
            // 不传 ac.signal：用户点「停止」时 signal 已经 abort，
            // 但停止之后照样应该把已录的内容合并出来
            await dispatchTranscode(
              buildTranscodeInputs({
                r2Keys: stagedKeys,
                outName,
                openlistDir,
                taskId: t.id,
                mode: t.mode,
              }),
            );
            t.mergedSubmitted = true;
            /**
             * 必须同步写上 mp4State=pending 和提交时间。
             *
             * 轮询器靠这两个字段去找 expectedPath；只写 mergedSubmitted
             * 的话 MP4 永远不会被确认，remotePath 永远为空，
             * 超时也永远不触发 —— 任务显示「完成」，网盘里却没有文件。
             */
            t.mp4State = 'pending';
            t.mp4SubmittedAt = Date.now();
            t.mergeError = '';
            onLog(`合并转码已提交，完成后 MP4 会出现在 ${t.expectedPath}`);
          } catch (e) {
            t.mergedSubmitted = false;
            t.mp4State = 'failed';
            t.mergeError = e.message;
            onLog(`合并转码提交失败：${e.message}（分段仍在 R2，可重试）`);
          }
        } else if (stagedKeys.length && missingSegs) {
          t.mergeKeys = stagedKeys;
          t.expectedPath = `${this._remoteDirOf(t)}/${t.baseName || 'live'}.mp4`;
          t.mp4State = 'failed';
          t.mergeError = `有 ${missingSegs} 段未上传到 R2，已跳过合并`;
          onLog(
            `有 ${missingSegs} 段未上传到 R2，跳过自动合并；补齐后在历史记录里点「重新合并」`,
          );
        } else if (stagedKeys.length) {
          onLog('转码链路未配置，分段保留在 R2，不会自动合并');
        }

        t.status = STATUS.DONE;
        t.phase = t._stopRequested
          ? t.mergedSubmitted
            ? '已停止（转码中）'
            : '已停止'
          : t.mp4State === 'pending'
            ? '合并转码中'
            : t.mp4State === 'failed'
              ? '合并转码失败'
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
      /**
       * upload=false 的单文件路径：只传 R2，不传 OpenList，然后删本地。
       *
       * 和分段模式同样的理由：本地留文件没意义（容器无状态，重建就没了），
       * 而且 973MB 的卷放不下几个大文件。R2 是持久存储，放那儿随时能取。
       */
      if (!t.upload) {
        const r2 = getR2();
        if (!r2.configured) {
          onLog('未开启上传，且 R2 未配置 —— 文件无处安放，任务失败');
          throw new Error('未开启上传且未配置 R2，文件无法保留');
        }
        t.status = STATUS.UPLOADING;
        t.phase = '存入 R2（不上传 OpenList）';
        t.percent = 0;
        this._emit(t);
        this._saveState();

        const ext = path.extname(String(dl.filename || '')).toLowerCase() || '.bin';
        const base = stemOf(dl.filename);
        const key = `${config.r2.prefix}/${t.id}/${base}${ext}`;
        onLog(`只存 R2：${key}（${humanSize(dl.size)}）`);
        await r2.putFile(dl.filePath, key, {
          contentType: contentTypeOf(dl.filename),
          signal: ac.signal,
        });

        t.r2Key = key;
        t.remotePath = `r2://${config.r2.bucket}/${key.replace(`${config.r2.prefix}/`, '')}`;
        /**
         * 立刻删本地。
         *
         * 和 upload=true 不同：那条路要等 Actions 转码完才删，
         * 因为转码读的是 R2 上的副本，本地确实可以马上删 —— 但历史上
         * 是等确认后才删。这里明确不走转码，传完就没用了，立即释放。
         */
        await fsp.rm(dl.filePath, { force: true }).catch(() => {});
        t.localPath = '';

        t.status = STATUS.DONE;
        t.phase = '已存入 R2';
        t.finishedAt = Date.now();
        t.percent = 100;
        onLog(`已存入 R2，本地已删除。路径：${t.remotePath}`);
        this._emit(t);
        this._saveState();
        return;
      }

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
                // 单文件也要带上输出方式：表单里选了 cfr 就该走 cfr
                mode: t.mode,
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
      /**
       * 「这一段已经有着落」的判定。
       *
       * staged / merged 也要算 —— 合并流程里段只到 R2 为止，
       * 本地那份删掉不会丢数据。漏掉它们会让直播任务的目录
       * 永远走不到清理分支。
       */
      const HANDLED = ['pending', 'done', 'staged', 'merged'];
      const allHandled = segs.length
        ? segs.every((s) => s.remotePath || HANDLED.includes(s.mp4State))
        : Boolean(t.remotePath) || HANDLED.includes(t.mp4State);

      const mayHaveUnuploaded =
        Boolean(t._stopRequested) ||
        (t.failedSegments?.length || 0) > 0 ||
        /**
         * 这里**不能**再带 `t.upload &&`。
         *
         * 以前 upload=false 表示「保留本地」，所以那时「未上传」不算
         * 需要保留的东西 —— 本来就要留着，谈不上"未上传会丢"。
         *
         * 现在 upload=false 表示「只存 R2」，语义反过来了：本地文件
         * 应该在传完 R2 后删掉。如果上传失败（failedSegments 非空），
         * 上面第一个条件已经兜住了；如果连 failedSegments 都没登记
         * （比如进程被 kill），本地那份就是唯一的副本，更不能删。
         *
         * 所以去掉 upload 判断，只要「有内容且没全部着落」就保留。
         */
        (!allHandled && ((t.size || 0) > 0 || segs.length > 0));

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
    /**
     * 这个任务是不是「合并转码」模式。
     *
     * 合并任务的产物是整场一个 MP4，段本身不会出现在 OpenList，
     * 所以不能用「有几段的 remotePath 非空」来算进度 —— 前端据此
     * 换一套展示（合并徽章 + 单个重传按钮），而不是逐段统计。
     */
    const merged = this._isMerged(t);
    return {
      id: t.id,
      url: t.url,
      filename: t.filename,
      kind: t.kind,
      live: Boolean(t.live),
      upload: Boolean(t.upload),
      segment: t.segment !== false,
      /**
       * 转码输出方式与录制时长上限。
       *
       * 历史记录里也要存：「重下」按钮要沿用原任务的设置，
       * 否则用户特意选的 remux / 「只录 30 分钟」会在重下时被重置。
       */
      mode: t.mode || 'remux',
      maxSeconds: t.maxSeconds || 0,
      status: t.status,
      size: t.size || 0,
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      remotePath: t.remotePath || '',
      segmentCount: t.segmentCount || segs.length || 0,
      /**
       * 合并模式：MP4 是整场一个文件，落地后所有段一起算已落地；
       * 确认前是 0（段只是在 R2 里排队，不能算已在网盘）。
       */
      segmentsUploaded:
        merged && t.mp4State === 'done'
          ? t.segmentCount || segs.length
          : segs.filter((s) => s.remotePath).length,
      merged,
      mergeError: t.mergeError || '',
      /**
       * 转码状态。
       * 非合并任务看 segments[].mp4State；合并任务的状态挂在任务本身，
       * 段是 staged/merged，不会出现 pending。
       */
      mp4State: t.mp4State || 'none',
      expectedPath: t.expectedPath || '',
      segmentsSubmitted: merged
        ? segs.filter((s) => s.r2Key).length
        : segs.filter((s) => s.mp4State === 'pending' || s.mp4State === 'done').length,
      transcodePending: merged
        ? t.mp4State === 'pending'
          ? 1
          : 0
        : segs.filter((s) => s.mp4State === 'pending').length +
          (t.mp4State === 'pending' && !segs.length ? 1 : 0),
      transcodeFailed: merged
        ? t.mp4State === 'failed'
          ? 1
          : 0
        : segs.filter((s) => s.mp4State === 'failed').length +
          (t.mp4State === 'failed' && !segs.length ? 1 : 0),
      failedSegments: (t.failedSegments || []).map((f) => ({
        index: f.index,
        filename: f.filename,
        size: f.size,
        error: f.error,
      })),
      remoteDir: (() => {
        // 合并任务在确认前没有 remotePath，用 expectedPath 兜底，
        // 否则「文件夹」按钮会凭空消失
        const first =
          segs.find((s) => s.remotePath)?.remotePath ||
          t.remotePath ||
          t.expectedPath ||
          '';
        if (!first) return '';
        const k = first.lastIndexOf('/');
        return k > 0 ? first.slice(0, k) : '';
      })(),
      /**
       * 只存前 20 条分段明细。
       *
       * 一场 3 小时直播是 288 段，每段 6 个字段 ≈ 110 字节 → 单条历史记录 32KB，
       * 200 条就是 6MB（实测 segments 占 98%）。而 history.json 每次变更都要
       * 整份重写并上传 OpenList，这些明细纯属浪费：界面上用的都是
       * segmentCount / segmentsUploaded / transcodePending 这些预聚合字段，
       * 明细只用来推断「文件夹」按钮和合并任务特征。
       */
      segments: segs.slice(0, HISTORY_SEGMENT_SAMPLE).map((s) => ({
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
