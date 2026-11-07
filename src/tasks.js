/**
 * 任务管理：创建、排队、执行、状态持久化。
 * 下载 → 上传 → 删除本地，全流程在 worker 里跑，通过 EventEmitter 推送进度。
 */
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { runDownload } from './downloader.js';
import { getOpenList, buildRemotePath } from './openlist.js';
import { getHistoryStore } from './history.js';
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
          this._dropJobDir(id);
          changed = true;
        }
      }
      // 超出上限时删最老的已完成任务
      if (this.tasks.size > config.maxTasks) {
        const finished = [...this.tasks.values()]
          .filter((t) => [STATUS.DONE, STATUS.FAILED, STATUS.CANCELED].includes(t.status))
          .sort((a, b) => a.createdAt - b.createdAt);
        while (this.tasks.size > config.maxTasks && finished.length) {
          const id = finished.shift().id;
          this.tasks.delete(id);
          this._dropJobDir(id);
          changed = true;
        }
      }
      if (changed) this._saveState();
    }, 5 * 60 * 1000).unref?.();
  }

  /**
   * 删掉任务对应的本地目录。
   *
   * 只删记录不删文件的话，失败/取消的任务会一直占着磁盘，
   * 5GB 配额下几场直播就能把盘吃满。异步删除，不阻塞调用方。
   */
  _dropJobDir(id) {
    const dir = path.join(config.tmpDir, id);
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
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
    this._dropJobDir(id);
    this._saveState();
    this.emit('removed', { id });
    return true;
  }

  clearFinished() {
    let n = 0;
    for (const [id, t] of this.tasks) {
      if ([STATUS.DONE, STATUS.FAILED, STATUS.CANCELED].includes(t.status)) {
        this.tasks.delete(id);
        this._dropJobDir(id);
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

    const ol = getOpenList();
    if (!ol.configured) throw new Error('OpenList 未配置，无法上传');

    // 合并两个来源，按 index 去重
    const byIndex = new Map();
    for (const s of t.segments || []) {
      if (s.remotePath) continue; // 已传的跳过
      byIndex.set(s.index, {
        index: s.index,
        filename: s.filename,
        size: s.size,
        localPath: s.localPath || '',
        error: '未上传',
      });
    }
    for (const f of t.failedSegments || []) {
      byIndex.set(f.index, { ...(byIndex.get(f.index) || {}), ...f });
    }

    const list = [...byIndex.values()].sort((a, b) => a.index - b.index);
    if (!list.length) throw new Error('没有待重试的段');

    this._log(t, `开始重试 ${list.length} 个分段`);
    let ok = 0;
    const still = [];

    for (const item of list) {
      // 本地路径可能没记下来，按任务目录 + 文件名兜底
      const local =
        item.localPath || path.join(config.tmpDir, t.id, item.filename || '');
      const exists = await fsp
        .stat(local)
        .then((s) => s.size > 0)
        .catch(() => false);
      if (!exists) {
        still.push({ ...item, error: '本地文件已不存在，无法重试' });
        this._log(t, `第 ${item.index} 段：本地文件已不存在，跳过`);
        continue;
      }

      const remote = buildRemotePath(item.filename, {
        taskId: t.id,
        baseName: t.baseName,
        // 用任务创建时间算日期目录：跨零点补传不该落到"第二天"的目录里，
        // 否则一次录制会被拆成两个文件夹
        date: t.createdAt,
      });
      try {
        await ol.uploadFile(local, remote, { onLog: (m) => this._log(t, m) });
        const seg = (t.segments || []).find((s) => s.index === item.index);
        if (seg) seg.remotePath = remote;
        ok++;
        this._log(t, `第 ${item.index} 段重试成功 → ${remote}`);
        if (config.openlist.deleteAfterUpload) {
          await fsp.rm(local, { force: true }).catch(() => {});
          if (seg) seg.deleted = true;
        }
      } catch (e) {
        still.push({ ...item, error: e.message });
        this._log(t, `第 ${item.index} 段重试仍失败：${e.message}`);
      }
    }

    t.failedSegments = still;
    t.segmentsUploaded = (t.segments || []).filter((s) => s.remotePath).length;
    this._emit(t);
    this._saveState();

    // 同步更新历史记录里的这条
    try {
      await getHistoryStore().upsert(this._historyRecord(t));
    } catch {
      /* ignore */
    }

    return { retried: list.length, ok, failed: still.length };
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

    const doUploadSegment = async (rec) => {
      if (!t.upload) {
        onLog(`第 ${rec.index} 段：未开启上传，保留本地`);
        return;
      }
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
        await ol.uploadFile(rec.path, remote, {
          signal: ac.signal,
          onLog,
        });
      } catch (e) {
        onLog(`第 ${rec.index} 段上传失败：${e.message}`);
        // 记下来，前端可以点「重试」
        t.failedSegments = [
          ...(t.failedSegments || []).filter((x) => x.index !== rec.index),
          {
            index: rec.index,
            filename: rec.filename,
            size: rec.size,
            localPath: rec.path,
            error: e.message,
          },
        ];
        this._emit(t);
        throw e;
      }

      rec.remotePath = remote;
      t.segmentsUploaded = (t.segmentsUploaded || 0) + 1;
      // 上传成功就从失败列表里移除（可能是重试成功的）
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
          remotePath: s.remotePath || '',
          deleted: Boolean(s.deleted),
          // 本地路径要留着：上传失败时「重传」按钮需要靠它找到文件
          localPath: s.path || s.localPath || '',
        }));
        t.segmentCount = segs.length;
        // 已上传数直接按实际带 remotePath 的段数算，
        // 避免 segmentsUploaded 计数和真实状态不一致
        t.segmentsUploaded = t.segments.filter((s) => s.remotePath).length;

        // 未上传的段（关闭了上传或未配置 OpenList）留在本地
        const kept = segs.filter((s) => !s.deleted && !s.remotePath).length;
        const failed = (t.failedSegments || []).length;
        onLog(
          `直播录制结束：共 ${segs.length} 段，已上传 ${t.segmentsUploaded} 段` +
            (failed ? `，${failed} 段上传失败` : '') +
            (!t.upload ? `，全部保留本地（${kept} 段）` : ''),
        );

        // 用户主动停止的，phase 标「已停止」但状态仍是 done（内容已保存）
        t.phase = t._stopRequested ? '已停止' : '已完成';
        t.status = STATUS.DONE;
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

        const remote = buildRemotePath(dl.filename, {
          taskId: t.id,
          baseName: t.baseName,
          date: t.createdAt,
        });
        onLog(`开始上传 → ${remote}`);

        await ol.uploadFile(dl.filePath, remote, {
          signal: ac.signal,
          onProgress: (total, uploaded) => {
            t.uploaded = uploaded;
            t.percent = total ? Math.min(99.9, (uploaded / total) * 100) : 0;
            this._emit(t);
          },
          onLog,
        });

        t.remotePath = remote;
        t.percent = 100;
        onLog(`上传完成：${remote}`);
        this._emit(t);
        this._saveState();

        // ---------- 3. 删除本地 ----------
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

      t.status = STATUS.DONE;
      t.phase = t._stopRequested ? '已停止' : '已完成';
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

      // 清理残留临时文件（保留 jobDir 里还没上传的文件，别删）
      if (!t._stopRequested && !t.failedSegments?.length) {
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
      })),
      error: t.error || '',
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
