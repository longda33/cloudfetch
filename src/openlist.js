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
import { humanSize } from './util/links.js';

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

  /**
   * 统一请求封装。
   *
   * 账号密码模式下 token 会过期（OpenList 默认 48 小时）。过期后所有请求
   * 都是 401，如果不重登，上传会一直失败到进程重启为止。
   */
  async request(method, apiPath, opts = {}) {
    try {
      return await this._request(method, apiPath, opts);
    } catch (e) {
      const canRelogin = this.username && this.password;
      if (canRelogin && e instanceof OpenListError && (e.status === 401 || e.status === 403)) {
        this.token = '';
        this._loginPromise = null;
        return await this._request(method, apiPath, opts);
      }
      throw e;
    }
  }

  /**
   * 发一个 OpenList API 请求。
   *
   * @param {object} [opts]
   * @param {object} [opts.body]      JSON 请求体（会自动序列化）
   * @param {Buffer} [opts.rawBody]   原始字节请求体（分片上传用）
   * @param {boolean} [opts.raw]      true = 返回 {status, ok, text, json}，
   *                                  不做错误检查，交给调用方判断
   */
  async _request(method, apiPath, { body, rawBody, raw = false, headers = {}, signal, timeout = 60000 } = {}) {
    const token = await this.ensureToken();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const isJson = body && !(body instanceof FormData);
      const res = await fetch(this.url(apiPath), {
        method,
        headers: {
          Authorization: token,
          ...(isJson ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body:
          rawBody !== undefined
            ? rawBody
            : body instanceof FormData
              ? body
              : body
                ? JSON.stringify(body)
                : undefined,
        signal: ac.signal,
      });

      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* 非 JSON 响应 */
      }

      // 分片协议要自己看 status / code，不能在这里抛
      if (raw) {
        return { status: res.status, ok: res.ok, text, json };
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
  async check({ timeout = 20000 } = {}) {
    if (!this.configured) {
      return { ok: false, reason: '未配置 OpenList 地址或令牌' };
    }
    try {
      const me = await this.request('GET', '/api/me', { timeout });
      return { ok: true, user: me?.username || me?.name || 'unknown', baseUrl: this.baseUrl };
    } catch (e) {
      /**
       * 超时在 fetch 层是 AbortError，原始文案是
       * "This operation was aborted"，显示在状态灯提示里完全看不懂。
       * 这里翻成人话（只影响状态探测，不影响上传/下载的取消逻辑）。
       */
      const aborted = e?.name === 'AbortError' || /abort/i.test(String(e?.message || ''));
      return {
        ok: false,
        reason: aborted
          ? `OpenList 连接超时（${Math.round(timeout / 1000)} 秒无响应）`
          : e.message,
      };
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
   * 分片上传（OpenList 的 resumable multipart 协议）。
   *
   * 为什么需要：单请求 PUT /api/fs/put 受 Cloudflare 请求体上限约束，
   * 实测超过约 130MB 直接被 413 挡回，请求到不了 OpenList。
   * 分片上传把文件切成 10MB 一片，每片单独 PUT，最后合并，
   * 每片体积远低于 CDN 限制，因此可以传任意大小的文件。
   *
   * 协议（参考 cf-music-dl-py，经实测验证）：
   *   POST /api/fs/multipart/init
   *       必需头：File-Path（URL 编码的完整路径）、X-File-Size、
   *               X-Chunk-Size、Last-Modified、Content-Type、Overwrite
   *       返回：{ upload_id, chunk_size, total_chunks, received }
   *   PUT  /api/fs/multipart/chunk
   *       必需头：X-Upload-Id、X-Chunk-Index
   *       体：该片的原始字节
   *   POST /api/fs/multipart/complete
   *       必需头：X-Upload-Id
   *
   * 缺任何一个头都会失败：只给 X-File-Size 会报
   * "storage not found; please add a storage first"（误导性错误）。
   *
   * @returns {Promise<{ok:boolean, reason?:string}>}
   *   ok=false 表示服务端不支持分片，调用方应回退到单请求上传。
   */
  async uploadFileMultipart(localPath, remotePath, opts = {}) {
    const { signal, onProgress, onLog } = opts;
    const st = await fsp.stat(localPath);
    const size = st.size;
    if (size <= 0) throw new OpenListError('文件为空，无需上传');

    const remoteDir = path.posix.dirname(remotePath);
    await this.ensureDir(remoteDir, signal);
    const token = await this.ensureToken();

    const CHUNK = 10 * 1024 * 1024; // 10MB，参考项目实测可用

    // ---- 1) init ----
    const initRes = await this.request('POST', '/api/fs/multipart/init', {
      raw: true,
      headers: {
        'File-Path': encodeURIComponent(remotePath),
        'X-File-Size': String(size),
        'X-Chunk-Size': String(CHUNK),
        'Content-Type': 'application/octet-stream',
        'Last-Modified': String(Math.floor(st.mtimeMs)),
        Overwrite: 'true',
      },
      signal,
      timeout: 60000,
    });

    if (initRes.status === 404 || initRes.status === 405) {
      return { ok: false, reason: `multipart 端点不存在（HTTP ${initRes.status}）` };
    }

    let initJson = null;
    try {
      initJson = JSON.parse(initRes.text);
    } catch {
      /* ignore */
    }
    if (!initJson || (initJson.code !== undefined && initJson.code !== 200)) {
      const msg = initJson?.message || initRes.text.slice(0, 160);
      // storage 不支持分片时会返回这类消息，交给调用方回退
      if (/not found|unsupported|not implement/i.test(msg)) {
        return { ok: false, reason: msg };
      }
      throw new OpenListError(`分片初始化失败：${msg}`);
    }

    const sess = initJson.data;
    if (!sess || !sess.upload_id) {
      return { ok: false, reason: '服务端未返回 upload_id（存储驱动不支持分片）' };
    }

    const uploadId = String(sess.upload_id);
    const chunkSize = Number(sess.chunk_size) || CHUNK;
    const totalChunks =
      Number(sess.total_chunks) || Math.ceil(size / chunkSize);

    // 断点续传：服务端可能已经收到部分片
    const received = new Set();
    if (Array.isArray(sess.received)) {
      for (const item of sess.received) {
        if (Array.isArray(item) && item.length === 2) {
          for (let i = Number(item[0]); i <= Number(item[1]); i++) received.add(i);
        }
      }
    }
    if (received.size) onLog?.(`续传：服务端已有 ${received.size}/${totalChunks} 片`);

    onLog?.(
      `分片上传：${humanSize(size)}，每片 ${humanSize(chunkSize)}，共 ${totalChunks} 片`,
    );

    // ---- 2) 逐片上传 ----
    const fh = await fsp.open(localPath, 'r');
    let done = received.size;
    let uploadedBytes = done * chunkSize;

    try {
      for (let idx = 0; idx < totalChunks; idx++) {
        if (signal?.aborted) throw new OpenListError('已取消');

        if (received.has(idx)) continue;

        const start = idx * chunkSize;
        const len = Math.min(chunkSize, size - start);
        /**
         * 必须用 alloc（清零）而不是 allocUnsafe：
         * 一旦下面出现短读，未写满的部分就是进程堆里的残留内存，
         * 会连同文件内容一起被上传到远端。
         */
        const buf = Buffer.alloc(len);
        let filled = 0;
        while (filled < len) {
          // fh.read 允许短读，必须循环补齐，否则这一片会长度不足、内容错位
          const { bytesRead } = await fh.read(buf, filled, len - filled, start + filled);
          if (bytesRead === 0) {
            throw new OpenListError(
              `读取本地文件不完整（第 ${idx + 1} 片 ${filled}/${len} 字节）`,
            );
          }
          filled += bytesRead;
        }

        // 单片失败重试 5 次，409/429 退避
        let lastErr;
        for (let attempt = 1; attempt <= 5; attempt++) {
          if (signal?.aborted) throw new OpenListError('已取消');
          try {
            const r = await this.request('PUT', '/api/fs/multipart/chunk', {
              raw: true,
              rawBody: buf,
              headers: {
                'X-Upload-Id': uploadId,
                'X-Chunk-Index': String(idx),
                'Content-Type': 'application/octet-stream',
              },
              signal,
              timeout: 600000,
            });
            let j = null;
            try {
              j = JSON.parse(r.text);
            } catch {
              /* ignore */
            }
            if (r.status === 409 || r.status === 429) {
              const e = new OpenListError(`HTTP ${r.status}`, r.status);
              e.retryable = true;
              throw e;
            }
            if (!r.ok || (j && j.code !== undefined && j.code !== 200)) {
              throw new OpenListError(
                `第 ${idx + 1} 片失败：HTTP ${r.status} ${(j?.message || r.text).slice(0, 120)}`,
              );
            }
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            if (attempt < 5) {
              const wait = Math.min(attempt * 2, 8) * 1000;
              onLog?.(`第 ${idx + 1} 片异常，${attempt}/5 重试：${e.message}`);
              await new Promise((r) => setTimeout(r, wait));
            }
          }
        }
        if (lastErr) throw new OpenListError(`第 ${idx + 1}/${totalChunks} 片上传失败：${lastErr.message}`);

        done++;
        uploadedBytes = Math.min(size, uploadedBytes + len);
        onProgress?.(size, uploadedBytes);
        if (done % 5 === 0 || done === totalChunks) {
          onLog?.(`分片进度：${done}/${totalChunks}（${humanSize(uploadedBytes)}）`);
        }
      }
    } finally {
      await fh.close();
    }

    // ---- 3) 合并 ----
    const compRes = await this.request('POST', '/api/fs/multipart/complete', {
      raw: true,
      headers: { 'X-Upload-Id': uploadId },
      signal,
      timeout: 600000,
    });
    let compJson = null;
    try {
      compJson = JSON.parse(compRes.text);
    } catch {
      /* ignore */
    }
    if (
      !compRes.ok ||
      (compJson && compJson.code !== undefined && compJson.code !== 200)
    ) {
      throw new OpenListError(
        `分片合并失败：${(compJson?.message || compRes.text).slice(0, 160)}`,
      );
    }

    onProgress?.(size, size);
    return { ok: true, remotePath, size };
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

    /**
     * 优先走分片上传。
     *
     * 单请求 PUT 受 Cloudflare 请求体上限约束（实测 >130MB 直接 413），
     * 而分片上传每片只有 10MB，可以传任意大小的文件。
     * 只有当服务端/存储驱动不支持分片时才回退到单请求。
     */
    try {
      const mp = await this.uploadFileMultipart(localPath, remotePath, opts);
      if (mp.ok) return { remotePath, size: total };
      onLog?.(`分片上传不可用（${mp.reason}），回退到单请求上传`);
    } catch (e) {
      if (signal?.aborted) throw e;
      /**
       * 分片传到一半才失败时，回退到单请求等于把整个文件重传一遍。
       * 文件本身又超过单请求上限（实测约 130MB）的话，回退只会换来一个 413，
       * 白白多传一次，所以这种情况直接把原因抛出去。
       */
      const SINGLE_PUT_LIMIT = 130 * 1024 * 1024;
      if (total > SINGLE_PUT_LIMIT) {
        throw new Error(
          `分片上传失败：${e.message}（文件 ${humanSize(total)} 超过单请求上限，无法回退）`,
        );
      }
      onLog?.(`分片上传失败：${e.message}，回退到单请求上传`);
    }

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

/**
 * 生成远端目标路径。
 *
 * 目录结构：<uploadDir>/<日期>/<任务名>_<短id>/<文件名>
 *
 * 为什么每个任务单独一个子目录：
 *   之前所有任务的文件都堆在同一个日期目录里，直播分段
 *   又是 0001_xxx.flv 这种名字，两个任务同时录就混在一起了，
 *   分不清哪个文件属于哪一次录制。加一层任务目录彻底隔开。
 *
 * @param {string} filename 文件名
 * @param {{ taskId?: string, baseName?: string, date?: number }} [opts]
 *        taskId  任务 id，取前 8 位做短标识
 *        baseName 任务基础名（如 live_20261107120000），拼在短 id 前面便于人眼识别
 *        date    任务创建时间。日期目录按它算，跨零点补传才不会落到第二天
 */
export function buildRemotePath(filename, opts = {}) {
  const o = config.openlist;
  let dir = o.uploadDir || '/cloudfetch';
  if (!dir.startsWith('/')) dir = '/' + dir;
  dir = dir.replace(/\/+$/, '');

  if (o.dateSubdir) {
    const d = new Date(opts.date || Date.now());
    // 用中国时区算日期，和容器 TZ 保持一致。
    // getFullYear() 之类按本地时区算，容器如果是 UTC，
    // 晚上 8 点之后录的东西会落到"前一天"的目录里。
    const ymd = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
    dir += '/' + ymd;
  }

  // 任务子目录：baseName_短id，例如 live_20261107120000_4ad6500c
  const taskId = (opts.taskId || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  if (taskId) {
    const base = (opts.baseName || '').replace(/[\\/:*?"<>|]/g, '').slice(0, 60);
    dir += '/' + (base ? `${base}_${taskId}` : taskId);
  }

  return path.posix.join(dir, filename);
}
