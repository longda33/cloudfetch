/**
 * OpenList 客户端
 *
 * 兼容 OpenList / AList v3 的 API：
 *   POST /api/auth/login          账号密码换 token
 *   POST /api/fs/mkdir            建目录
 *   PUT  /api/fs/put              流式上传（File-Path 头 + 原始 body）
 *   POST /api/fs/remove           删除
 *   POST /api/fs/get              取文件信息
 *   GET  /api/me                  校验 token
 *
 * 鉴权头：Authorization: <token>（OpenList 用裸 token，不带 Bearer 前缀）
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { config } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class OpenListError extends Error {
  constructor(msg, status) {
    super(msg);
    this.name = 'OpenListError';
    this.status = status;
  }
}

export class OpenListClient {
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || config.openlist.baseUrl).replace(/\/+$/, '');
    this.token = opts.token || config.openlist.token;
    this.username = opts.username || config.openlist.username;
    this.password = opts.password || config.openlist.password;
    this._loginPromise = null;
  }

  get configured() {
    return Boolean(this.baseUrl && (this.token || (this.username && this.password)));
  }

  url(p) {
    return `${this.baseUrl}${p.startsWith('/') ? p : '/' + p}`;
  }

  /** 确保有可用 token（支持账号密码自动登录） */
  async ensureToken() {
    if (this.token) return this.token;
    if (!this.username || !this.password) {
      throw new OpenListError('OpenList 未配置 token 或账号密码');
    }
    if (!this._loginPromise) {
      this._loginPromise = this._login().finally(() => {
        this._loginPromise = null;
      });
    }
    return this._loginPromise;
  }

  async _login() {
    const res = await fetch(this.url('/api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.username, password: this.password }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.code !== 200 || !j.data?.token) {
      throw new OpenListError(`OpenList 登录失败：${j.message || res.status}`, res.status);
    }
    this.token = j.data.token;
    return this.token;
  }

  /** 统一请求封装 */
  async request(method, apiPath, { body, headers = {}, signal, timeout = 60000 } = {}) {
    const token = await this.ensureToken();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await fetch(this.url(apiPath), {
        method,
        headers: {
          Authorization: token,
          ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });

      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* 非 JSON 响应 */
      }

      if (!res.ok) {
        throw new OpenListError(
          `OpenList ${method} ${apiPath} 失败：HTTP ${res.status} ${json?.message || text.slice(0, 200)}`,
          res.status,
        );
      }
      if (json && json.code !== undefined && json.code !== 200) {
        throw new OpenListError(
          `OpenList ${method} ${apiPath} 返回错误：${json.message || 'code=' + json.code}`,
          json.code,
        );
      }
      return json?.data ?? json;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** 校验连接与 token */
  async check() {
    if (!this.configured) {
      return { ok: false, reason: '未配置 OpenList 地址或令牌' };
    }
    try {
      const me = await this.request('GET', '/api/me', { timeout: 20000 });
      return { ok: true, user: me?.username || me?.name || 'unknown', baseUrl: this.baseUrl };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /** 递归建目录 */
  async ensureDir(dirPath, signal) {
    const parts = String(dirPath)
      .split('/')
      .filter(Boolean);
    let cur = '';
    for (const p of parts) {
      cur += '/' + p;
      try {
        await this.request('POST', '/api/fs/mkdir', { body: { path: cur }, signal, timeout: 30000 });
      } catch (e) {
        // 已存在不算错误
        if (!/exist/i.test(e.message)) throw e;
      }
    }
    return '/' + parts.join('/');
  }

  /**
   * 上传单个文件
   * @param {string} localPath 本地绝对路径
   * @param {string} remotePath OpenList 里的完整路径，如 /cloudfetch/2026-11-05/a.mp4
   * @param {object} opts { signal, onProgress(total, uploaded), onLog }
   */
  async uploadFile(localPath, remotePath, opts = {}) {
    const { signal, onProgress, onLog } = opts;
    const st = await fsp.stat(localPath);
    const total = st.size;

    const remoteDir = path.posix.dirname(remotePath);
    await this.ensureDir(remoteDir, signal);

    const token = await this.ensureToken();

    const attempt = async () => {
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal?.addEventListener('abort', onAbort, { once: true });

      let uploaded = 0;
      let lastReport = 0;

      try {
        /**
         * 用 Readable.toWeb() 把 Node 流转成 Web 流。
         *
         * 不要手写 new ReadableStream({ start }) 挂 on('data')：
         * 那样没有背压控制，大文件会把整个内容堆进内存，
         * 且 controller.enqueue 在队列满时会抛错导致请求卡死。
         * toWeb() 内部实现了正确的背压和取消传播。
         */
        const nodeStream = fs.createReadStream(localPath, { highWaterMark: 256 * 1024 });

        nodeStream.on('data', (chunk) => {
          uploaded += chunk.length;
          const now = Date.now();
          if (now - lastReport > 500) {
            lastReport = now;
            onProgress?.(total, uploaded);
          }
        });

        const body = Readable.toWeb(nodeStream);

        const res = await fetch(this.url('/api/fs/put'), {
          method: 'PUT',
          headers: {
            Authorization: token,
            'File-Path': encodeURIComponent(remotePath),
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(total),
            'As-Task': 'false',
          },
          body,
          duplex: 'half',
          signal: ac.signal,
        });

        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* ignore */
        }

        if (!res.ok || (json && json.code !== undefined && json.code !== 200)) {
          let msg = json?.message || text.slice(0, 200);
          // 413 通常是 Cloudflare 的请求体大小限制，给出可操作的提示
          if (res.status === 413) {
            msg =
              `文件 ${humanSize(total)} 超过上传通道上限（Cloudflare 请求体限制，实测约 130MB）。` +
              '请调小 LIVE_SEGMENT_SECONDS，或改用直连 OpenList 域名绕过 CDN。';
          }
          const err = new OpenListError(`上传失败：HTTP ${res.status} ${msg}`, res.status);
          // 5xx 或网络类错误可重试
          if (res.status >= 500 || res.status === 429) err.retryable = true;
          throw err;
        }
        onProgress?.(total, total);
        return { remotePath, size: total };
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    };

    let lastErr;
    const retries = config.openlist.uploadRetries;
    for (let i = 1; i <= retries; i++) {
      if (signal?.aborted) throw new OpenListError('已取消');
      try {
        return await attempt();
      } catch (e) {
        lastErr = e;
        if (!e.retryable && !/ECONN|ETIMEDOUT|socket hang up|fetch failed/i.test(e.message)) {
          throw e;
        }
        if (i >= retries) break;
        const wait = Math.min(3000 * Math.pow(2, i - 1), 60000);
        onLog?.(`上传第 ${i} 次失败：${e.message}；${Math.round(wait / 1000)}s 后重试`);
        await sleep(wait);
      }
    }
    throw lastErr;
  }

  /** 删除远端文件 */
  async remove(remotePath, signal) {
    const dir = path.posix.dirname(remotePath);
    const name = path.posix.basename(remotePath);
    return this.request('POST', '/api/fs/remove', {
      body: { dir, names: [name] },
      signal,
      timeout: 30000,
    });
  }

  /** 取文件信息（存在性校验） */
  async getFileInfo(remotePath, signal) {
    const dir = path.posix.dirname(remotePath);
    const name = path.posix.basename(remotePath);
    try {
      const data = await this.request('POST', '/api/fs/get', {
        body: { path: path.posix.join(dir, name) },
        signal,
        timeout: 30000,
      });
      return data;
    } catch {
      return null;
    }
  }
}

/** 单例 */
let _client = null;
export function getOpenList() {
  if (!_client) _client = new OpenListClient();
  return _client;
}
export function resetOpenList() {
  _client = null;
}

/** 生成远端目标路径：<uploadDir>/<日期>/<文件名> */
export function buildRemotePath(filename) {
  const o = config.openlist;
  let dir = o.uploadDir || '/cloudfetch';
  if (!dir.startsWith('/')) dir = '/' + dir;
  dir = dir.replace(/\/+$/, '');
  if (o.dateSubdir) {
    const d = new Date();
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    dir += '/' + ymd;
  }
  return path.posix.join(dir, filename);
}
