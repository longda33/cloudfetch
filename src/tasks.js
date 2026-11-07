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
    /** @type {Map<string, object>} */
    this.tasks = new Map();
    this.queue = [];
    this.running = new Set();
    this._saveTimer = null;
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
        const arr = [...this.tasks.values()]
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, config.maxTasks);
        await fsp.writeFile(config.stateFile, JSON.stringify(arr, null, 2), 'utf8');
      } catch (e) {
        console.error(`[tasks] 保存状态失败：${e.message}`);
      }
    }, 1000);
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
          changed = true;
        }
      }
      // 超出上限时删最老的已完成任务
      if (this.tasks.size > config.maxTasks) {
        const finished = [...this.tasks.values()]
          .filter((t) => [STATUS.DONE, STATUS.FAILED, STATUS.CANCELED].includes(t.status))
          .sort((a, b) => a.createdAt - b.createdAt);
        while (this.tasks.size > config.maxTasks && finished.length) {
          this.tasks.delete(finished.shift().id);
          changed = true;
        }
      }
      if (changed) this._saveState();
    }, 5 * 60 * 1000).unref?.();
  }

  // ---------------- 任务操作 ----------------
  create({ url, filename, upload = true }) {
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

    const id = crypto.randomUUID();
    const task = {
      id,
      url,
      filename: filename || '',
      kind: detectKind(url),
      status: STATUS.QUEUED,
      upload: Boolean(upload),
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
      logs: [],
    };
    this.tasks.set(id, task);
    this.queue.push(id);
    this._saveState();
    this._emit(task);
    this._pump();
    return task;
  }

  cancel(id) {
    const t = this.tasks.get(id);
    if (!t) return false;
    if ([STATUS.DONE, STATUS.FAILED, STATUS.CANCELED].includes(t.status)) return false;

    t._abort?.abort();

    const qi = this.queue.indexOf(id);
    if (qi >= 0) this.queue.splice(qi, 1);

    t.status = STATUS.CANCELED;
    t.phase = '已取消';
    t.finishedAt = Date.now();
    t._abort = null;
    this._saveState();
    this._emit(t);
    return true;
  }

  remove(id) {
    const t = this.tasks.get(id);
    if (!t) return false;
    if (this.running.has(id)) return false;
    this.tasks.delete(id);
    this._saveState();
    this.emit('removed', { id });
    return true;
  }

  clearFinished() {
    let n = 0;
    for (const [id, t] of this.tasks) {
      if ([STATUS.DONE, STATUS.FAILED, STATUS.CANCELED].includes(t.status)) {
        this.tasks.delete(id);
        n++;
      }
    }
    if (n) this._saveState();
    return n;
  }

  list() {
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((t) => this._public(t));
  }

  get(id) {
    const t = this.tasks.get(id);
    return t ? this._public(t) : null;
  }

  _public(t) {
    // 去掉内部字段
    const { _abort, ...rest } = t;
    return rest;
  }

  _emit(t) {
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
    await fsp.mkdir(jobDir, { recursive: true });

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
    const uploadSegment = async (rec) => {
      if (!t.upload) {
        onLog(`第 ${rec.index} 段：未开启上传，保留本地`);
        return;
      }
      const ol = getOpenList();
      if (!ol.configured) {
        onLog(`第 ${rec.index} 段：OpenList 未配置，保留本地`);
        return;
      }

      const remote = buildRemotePath(rec.filename);
      onLog(`第 ${rec.index} 段开始上传 → ${remote}（${humanSize(rec.size)}）`);
      try {
        await ol.uploadFile(rec.path, remote, {
          signal: ac.signal,
          onLog,
        });
      } catch (e) {
        onLog(`第 ${rec.index} 段上传失败：${e.message}`);
        throw e;
      }

      rec.remotePath = remote;
      t.segmentsUploaded = (t.segmentsUploaded || 0) + 1;
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

    try {
      // ---------- 1. 下载 ----------
      // 注意：onSegment 必须无条件传入。
      // 之前写成 `t.live ? uploadSegment : undefined`，但 t.live 是在
      // downloadLive 内部才置 true 的，调用时还是 undefined，
      // 导致 onSegment 恒为 undefined，直播分段上传从未被触发。
      const dl = await runDownload(t, {
        url: t.url,
        dir: jobDir,
        filename: t.filename,
        signal: ac.signal,
        onProgress,
        onLog,
        onSegment: uploadSegment,
      });

      if (ac.signal.aborted) throw new Error('已取消');

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
        }));
        t.segmentCount = segs.length;

        // 未上传的段（关闭了上传或未配置 OpenList）留在本地
        const kept = segs.filter((s) => !s.deleted && !s.remotePath).length;
        onLog(
          `直播录制完成：共 ${segs.length} 段` +
            (t.upload ? `，已上传 ${t.segmentsUploaded || 0} 段` : `，全部保留本地（${kept} 段）`),
        );

        t.phase = '已完成';
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

        const remote = buildRemotePath(dl.filename);
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
      t.phase = '已完成';
      t.finishedAt = Date.now();
      t.speed = 0;
      t.eta = 0;
      this._emit(t);
      this._saveState();
    } catch (e) {
      const canceled = ac.signal.aborted || /已取消/.test(e.message);
      t.status = canceled ? STATUS.CANCELED : STATUS.FAILED;
      t.phase = canceled ? '已取消' : '失败';
      t.error = canceled ? '已取消' : e.message;
      t.finishedAt = Date.now();
      t.speed = 0;
      this._log(t, canceled ? '任务已取消' : `失败：${e.message}`);
      this._emit(t);
      this._saveState();

      // 清理残留临时文件
      try {
        await fsp.rm(jobDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    } finally {
      t._abort = null;

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
      status: t.status,
      size: t.size || 0,
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      remotePath: t.remotePath || '',
      segmentCount: t.segmentCount || segs.length || 0,
      segmentsUploaded: t.segmentsUploaded || 0,
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
