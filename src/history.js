/**
 * 历史记录存储。
 *
 * 因为 Cloady 免费档没有持久卷，/tmp 和 / 在容器重建后都会清空，
 * 所以历史记录必须存到外部（OpenList）。
 *
 * 存储方式：
 *   <uploadDir>/.cloudfetch/history.json   最多保留 MAX_HISTORY 条
 *
 * 同时保留一份内存缓存，避免每次读都打 OpenList。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { getOpenList } from './openlist.js';

const HISTORY_DIR = '.cloudfetch';
const HISTORY_FILE = 'history.json';
const MAX_HISTORY = Math.max(50, config.maxTasks || 200);

export class HistoryStore {
  constructor() {
    /** @type {Array<object>} */
    this.items = [];
    this.loaded = false;
    this._loading = null;
    this._saveTimer = null;
    this._dirty = false;
  }

  /** 远端历史文件路径 */
  _remotePath() {
    let dir = config.openlist.uploadDir || '/cloudfetch';
    if (!dir.startsWith('/')) dir = '/' + dir;
    dir = dir.replace(/\/+$/, '');
    return path.posix.join(dir, HISTORY_DIR, HISTORY_FILE);
  }

  /** 本地历史文件路径（Unikraft 挂了持久卷时用它当主存储） */
  _localPath() {
    return path.join(config.dataDir, HISTORY_DIR, HISTORY_FILE);
  }

  /** 本地存储是否可用（目录能写） */
  _localUsable() {
    if (this._localOk !== undefined) return this._localOk;
    try {
      fs.mkdirSync(path.dirname(this._localPath()), { recursive: true });
      this._localOk = true;
    } catch {
      this._localOk = false;
    }
    return this._localOk;
  }

  /**
   * 加载历史记录。
   *
   * 优先读本地（/data 持久卷），读不到再退回 OpenList。
   * 为什么这个顺序：Unikraft 上 /data 是持久化的，本地读快得多，
   * 而且不依赖 OpenList 可用性。Cloady 上没有持久卷，
   * 本地读不到，自然走 OpenList 那条路。
   */
  async load() {
    if (this.loaded) return this.items;
    if (this._loading) return this._loading;

    this._loading = (async () => {
      // ---- 先试本地 ----
      if (this._localUsable()) {
        try {
          const raw = await fsp.readFile(this._localPath(), 'utf8');
          const arr = JSON.parse(raw);
          if (Array.isArray(arr) && arr.length) {
            this.items = arr.slice(0, MAX_HISTORY);
            console.log(`[history] 从本地加载 ${this.items.length} 条（${this._localPath()}）`);
            this.loaded = true;
            this._loading = null;
            return this.items;
          }
        } catch (e) {
          // ENOENT 是正常的（首次启动），不用报错
          if (e.code !== 'ENOENT') {
            console.error(`[history] 本地读取失败：${e.message}`);
          }
        }
      }

      // ---- 再试 OpenList ----
      try {
        const ol = getOpenList();
        if (!ol.configured) {
          console.log('[history] OpenList 未配置，历史记录仅存内存');
          this.loaded = true;
          return this.items;
        }

        const remote = this._remotePath();
        const info = await ol.getFileInfo(remote);
        const rawUrl = info?.raw_url || info?.url;
        if (!rawUrl) {
          console.log('[history] 远端暂无历史文件，从空开始');
          this.loaded = true;
          return this.items;
        }

        const res = await fetch(rawUrl, { signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const arr = await res.json();
        if (Array.isArray(arr)) {
          this.items = arr.slice(0, MAX_HISTORY);
          console.log(`[history] 从 OpenList 加载 ${this.items.length} 条`);
        }
      } catch (e) {
        console.error(`[history] 加载失败：${e.message}`);
      } finally {
        this.loaded = true;
        this._loading = null;
      }
      return this.items;
    })();

    return this._loading;
  }

  /** 追加或更新一条记录 */
  async upsert(rec) {
    await this.load();
    const i = this.items.findIndex((x) => x.id === rec.id);
    if (i >= 0) {
      this.items[i] = { ...this.items[i], ...rec };
    } else {
      this.items.unshift(rec);
    }
    // 只保留最近的
    if (this.items.length > MAX_HISTORY) this.items.length = MAX_HISTORY;
    this._scheduleSave();
  }

  /** 批量写入（任务结束时用） */
  async addMany(recs) {
    await this.load();
    for (const rec of recs) {
      const i = this.items.findIndex((x) => x.id === rec.id);
      if (i >= 0) this.items[i] = { ...this.items[i], ...rec };
      else this.items.unshift(rec);
    }
    if (this.items.length > MAX_HISTORY) this.items.length = MAX_HISTORY;
    this._scheduleSave();
  }

  _scheduleSave() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(async () => {
      this._saveTimer = null;
      await this.flush();
    }, 3000);
  }

  /** 立即落盘 */
  async flush() {
    if (!this._dirty) return;
    this._dirty = false;

    const payload = JSON.stringify(this.items, null, 2);

    // ---- 1) 先写本地（有持久卷时这是主存储）----
    let localOk = false;
    if (this._localUsable()) {
      const lp = this._localPath();
      try {
        await fsp.mkdir(path.dirname(lp), { recursive: true });
        // 先写临时文件再 rename，避免写一半断电留下坏 JSON
        const tmpLocal = `${lp}.tmp`;
        await fsp.writeFile(tmpLocal, payload, 'utf8');
        await fsp.rename(tmpLocal, lp);
        localOk = true;
      } catch (e) {
        console.error(`[history] 本地保存失败：${e.message}`);
      }
    }

    // ---- 2) 再备份到 OpenList（可选，失败不影响本地）----
    const ol = getOpenList();
    if (!ol.configured) {
      if (localOk) console.log(`[history] 已保存 ${this.items.length} 条到本地`);
      else this._dirty = true;
      return;
    }

    const remote = this._remotePath();
    const tmp = path.join(config.tmpDir, 'history.json');
    try {
      await fsp.mkdir(path.dirname(tmp), { recursive: true });
      await fsp.writeFile(tmp, payload, 'utf8');
      await ol.uploadFile(tmp, remote, {});
      await fsp.rm(tmp, { force: true });
      console.log(
        `[history] 已保存 ${this.items.length} 条（本地=${localOk ? '是' : '否'}，远端=${remote}）`,
      );
    } catch (e) {
      console.error(`[history] 远端备份失败：${e.message}`);
      // 本地成功了就不算整体失败，下次有变更再试
      if (!localOk) this._dirty = true;
    }
  }

  /** 查询：分页 + 关键字 + 状态筛选 */
  query({ page = 1, pageSize = 20, q = '', status = '' } = {}) {
    let list = this.items;

    if (status) {
      const want = String(status).split(',').map((s) => s.trim()).filter(Boolean);
      list = list.filter((x) => want.includes(x.status));
    }
    if (q) {
      const kw = String(q).toLowerCase();
      list = list.filter(
        (x) =>
          String(x.url || '').toLowerCase().includes(kw) ||
          String(x.filename || '').toLowerCase().includes(kw) ||
          String(x.remotePath || '').toLowerCase().includes(kw),
      );
    }

    const total = list.length;
    const ps = Math.min(Math.max(1, Number(pageSize) || 20), 100);
    const pg = Math.max(1, Number(page) || 1);
    const start = (pg - 1) * ps;

    return {
      total,
      page: pg,
      pageSize: ps,
      pages: Math.max(1, Math.ceil(total / ps)),
      items: list.slice(start, start + ps),
    };
  }

  /** 删除一条 */
  async remove(id) {
    await this.load();
    const before = this.items.length;
    this.items = this.items.filter((x) => x.id !== id);
    if (this.items.length !== before) this._scheduleSave();
    return this.items.length !== before;
  }

  /** 清空 */
  async clear() {
    await this.load();
    const n = this.items.length;
    this.items = [];
    this._scheduleSave();
    return n;
  }
}

let _store = null;
export function getHistoryStore() {
  if (!_store) _store = new HistoryStore();
  return _store;
}
