/**
 * Cloudflare R2 客户端（S3 兼容 API）。
 *
 * 为什么不装 @aws-sdk/client-s3：
 *   Unikraft 的 rootfs 是只读的，依赖必须在构建时打进去。
 *   aws-sdk 装完约 90MB，而这里只需要 4 个操作（put/get/delete/head），
 *   自己实现签名比拖一个 SDK 划算得多。
 *
 * 签名算法：AWS Signature Version 4。
 * 参考 https://developers.cloudflare.com/r2/api/s3/api/
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import { config } from './config.js';

const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** RFC3986 编码：S3 要求除 unreserved 字符外全部百分号编码 */
function uriEncode(str, encodeSlash = true) {
  let out = '';
  for (const ch of String(str)) {
    if (/[A-Za-z0-9_.~-]/.test(ch)) {
      out += ch;
    } else if (ch === '/' && !encodeSlash) {
      out += '/';
    } else {
      // 用 Buffer 处理多字节字符，避免 charCodeAt 只取半个码点
      for (const b of Buffer.from(ch, 'utf8')) {
        out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
      }
    }
  }
  return out;
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

/** 把 Date 转成 S3 要求的两种时间格式 */
function amzDates(d = new Date()) {
  const iso = d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

export class R2Error extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'R2Error';
    this.status = status;
  }
}

export class R2Client {
  constructor({ accountId, accessKeyId, secretAccessKey, bucket, endpoint }) {
    this.accountId = accountId;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.bucket = bucket;
    // 自定义 endpoint 优先（兼容 MinIO / B2 等其它 S3 服务）
    this.endpoint = (endpoint || `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, '');
    this.host = new URL(this.endpoint).host;
    this.region = 'auto'; // R2 固定用 auto
  }

  /**
   * 是否具备可用的配置。
   *
   * 之前 ping() 里写了 `if (!this.configured)`，但类上**根本没有这个属性**
   * —— 只有 OpenList 客户端有同名 getter，R2 这边漏了。
   * 于是 this.configured 恒为 undefined，`!undefined` 为 true，
   * ping() 永远返回「未配置」，即使环境变量全都填好了。
   *
   * 线上表现：右上角 R2 一直显示异常，但录制上传一切正常
   * （那些路径不经过 ping）。
   */
  get configured() {
    return Boolean(this.accountId && this.accessKeyId && this.secretAccessKey && this.bucket);
  }

  /** 计算 SigV4 签名，返回可直接用于 fetch 的 headers */
  _sign({ method, key, query = '', payloadHash, headers = {} }) {
    const { amzDate, dateStamp } = amzDates();

    /**
     * canonicalUri 必须和实际请求路径**逐字节一致**。
     *
     * 之前这里只写 `/${key}`，而 _url() 拼的是 `/${bucket}/${key}`，
     * 两边不一致 → R2 报 SignatureDoesNotMatch。
     * 实际报错信息里 R2 会回显它自己算的 StringToSign，但
     * canonical request 的哈希对不上时是看不出差异的，
     * 只能靠比对请求路径发现。
     */
    const canonicalUri = '/' + uriEncode(this.bucket, false) + '/' + uriEncode(key, false);
    const canonicalQuery = query;

    /**
     * 参与签名的最小头集合。
     *
     * 统一转小写：SigV4 的 canonicalHeaders 用小写键，之前只在取 key 时
     * 转小写、却用原大小写建对象，调用方一旦传 `Content-Type`（大写 C）
     * 就会取到 undefined → 空值参与签名 → SignatureDoesNotMatch，
     * 而且报错完全指不出是头名大小写的问题。
     */
    const signedHeaderMap = {};
    const rawHeaders = {
      host: this.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...headers,
    };
    for (const [k, v] of Object.entries(rawHeaders)) {
      signedHeaderMap[k.toLowerCase()] = String(v ?? '').trim();
    }
    const sortedKeys = Object.keys(signedHeaderMap).sort();
    const canonicalHeaders = sortedKeys.map((k) => `${k}:${signedHeaderMap[k]}\n`).join('');
    const signedHeaders = sortedKeys.join(';');

    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const kDate = hmac(`AWS4${this.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    return {
      ...signedHeaderMap,
      authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  }

  _url(key, query = '') {
    return `${this.endpoint}/${this.bucket}/${uriEncode(key, false)}${query ? '?' + query : ''}`;
  }

  /**
   * 上传本地文件（R2 单次 PUT 上限 5GB）。
   *
   * 带超时和重试：R2 这条链路没有 OpenList 那套 uploadRetries，
   * 一次网络抖动就会让整段进 failedSegments、本地文件被迫留着。
   * 5xx / 429 / 网络错误重试，4xx（签名错、桶不存在）重试没意义，直接抛。
   */
  async putFile(localPath, key, { contentType, onProgress, signal } = {}) {
    const st = await fsp.stat(localPath);
    const size = st.size;
    const attempts = Math.max(1, config.r2.uploadRetries);

    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      if (signal?.aborted) throw new R2Error('已取消', 0);
      try {
        await this._putOnce(localPath, key, size, contentType, signal);
        onProgress?.(size, size);
        return { size, key };
      } catch (e) {
        lastErr = e;
        if (signal?.aborted) throw e;
        const retryable = !e.status || e.status === 429 || e.status >= 500;
        if (!retryable || i >= attempts) break;
        await sleep(1000 * Math.pow(2, i - 1));
      }
    }
    throw lastErr;
  }

  /** 单次上传尝试 */
  async _putOnce(localPath, key, size, contentType, signal) {
    /**
     * 大文件不整块读进内存。
     *
     * Unikraft 实例只有 4GB 内存，一段 30 分钟直播约 500MB，
     * readFile 整块读会白白吃掉 500MB 峰值。这里用流式 body。
     *
     * 代价：SigV4 需要 payload 的 SHA256。AWS 支持 UNSIGNED-PAYLOAD，
     * R2 也认，所以不用预读一遍算哈希。
     */
    const headers = this._sign({
      method: 'PUT',
      key,
      payloadHash: 'UNSIGNED-PAYLOAD',
      headers: {
        'content-length': String(size),
        'content-type': contentType || 'application/octet-stream',
      },
    });

    // 单次尝试也要有超时：R2 半死不活时 fetch 会一直挂着
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.r2.timeoutMs);
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    const stream = fs.createReadStream(localPath);
    try {
      const res = await fetch(this._url(key), {
        method: 'PUT',
        headers,
        body: Readable.toWeb(stream),
        duplex: 'half',
        signal: ac.signal,
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new R2Error(`R2 PUT 失败：HTTP ${res.status} ${txt.slice(0, 300)}`, res.status);
      }
      // 读完响应体，避免连接被复用池丢弃
      await res.arrayBuffer().catch(() => {});
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // 失败/超时时必须销毁读流，否则 fd 泄漏
      stream.destroy();
    }
  }

  async deleteObject(key) {
    const headers = this._sign({ method: 'DELETE', key, payloadHash: EMPTY_SHA256 });
    const res = await fetch(this._url(key), { method: 'DELETE', headers });
    // S3 的 DELETE 是幂等的，404 也算成功
    if (!res.ok && res.status !== 404) {
      const txt = await res.text().catch(() => '');
      throw new R2Error(`R2 DELETE 失败：HTTP ${res.status} ${txt.slice(0, 300)}`, res.status);
    }
    return true;
  }

  /** 检查对象是否存在，返回字节数或 null */
  async headObject(key) {
    const headers = this._sign({ method: 'HEAD', key, payloadHash: EMPTY_SHA256 });
    const res = await fetch(this._url(key), { method: 'HEAD', headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new R2Error(`R2 HEAD 失败：HTTP ${res.status}`, res.status);
    return Number(res.headers.get('content-length')) || 0;
  }

  /**
   * 探测 R2 是否可用（给前端的「服务状态」用）。
   *
   * 用 HEAD 一个肯定不存在的键：
   *   - 返回 404  → 连通且鉴权通过（对象不存在是正常结果）
   *   - 返回 403  → 密钥错或没权限
   *   - 网络错误  → 连不上
   *
   * 为什么不用 PUT/DELETE 探测：那会产生真实的写入和删除，
   * 一个健康检查接口不应该有副作用。
   *
   * 为什么不列桶：ListBucket 需要额外权限，而用户按最小权限原则
   * 只给了 Object Read & Write，列桶会 403，误判成"异常"。
   */
  async ping({ prefix = 'cloudfetch' } = {}) {
    if (!this.configured) {
      return { ok: false, reason: '未配置 R2（缺 accountId / 密钥 / bucket）' };
    }
    const started = Date.now();
    try {
      const probeKey = `${String(prefix).replace(/\/+$/, '')}/.healthcheck`;
      const headers = this._sign({ method: 'HEAD', key: probeKey, payloadHash: EMPTY_SHA256 });
      const res = await fetch(this._url(probeKey), {
        method: 'HEAD',
        headers,
        signal: AbortSignal.timeout(8000),
      });
      const ms = Date.now() - started;

      // 404 是**期望结果**：说明签名通过、桶可达，只是这个对象不存在
      if (res.status === 404) return { ok: true, ms, bucket: this.bucket };
      if (res.status === 403) {
        return { ok: false, reason: 'R2 鉴权失败（密钥错误或权限不足）', ms };
      }
      if (!res.ok) return { ok: false, reason: `R2 HTTP ${res.status}`, ms };
      return { ok: true, ms, bucket: this.bucket };
    } catch (e) {
      const reason =
        e?.name === 'TimeoutError' || e?.name === 'AbortError'
          ? 'R2 连接超时'
          : `R2 连接失败：${e.message}`;
      return { ok: false, reason };
    }
  }

  /**
   * 生成预签名 GET URL。
   *
   * 给 GitHub Actions 用：Actions 里不存 R2 密钥，
   * 只拿一个有时效的 URL 下载，泄漏风险最小。
   */
  presignGet(key, expiresSec = 3600) {
    const { amzDate, dateStamp } = amzDates();
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const credential = `${this.accessKeyId}/${scope}`;

    const query = [
      `X-Amz-Algorithm=${encodeURIComponent('AWS4-HMAC-SHA256')}`,
      `X-Amz-Credential=${encodeURIComponent(credential)}`,
      `X-Amz-Date=${amzDate}`,
      `X-Amz-Expires=${expiresSec}`,
      `X-Amz-SignedHeaders=host`,
    ].join('&');

    const canonicalUri = '/' + uriEncode(this.bucket, false) + '/' + uriEncode(key, false);
    const canonicalRequest = [
      'GET',
      canonicalUri,
      query,
      `host:${this.host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const kDate = hmac(`AWS4${this.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    return `${this.endpoint}${canonicalUri}?${query}&X-Amz-Signature=${signature}`;
  }
}

/** 单例 */
let _r2 = null;
export function getR2() {
  if (!_r2) {
    _r2 = new R2Client({
      accountId: config.r2.accountId,
      accessKeyId: config.r2.accessKeyId,
      secretAccessKey: config.r2.secretAccessKey,
      bucket: config.r2.bucket,
      endpoint: config.r2.endpoint,
    });
  }
  return _r2;
}

export function resetR2() {
  _r2 = null;
}

/**
 * 测试专用：把单例替换成假对象。
 *
 * 为什么需要这个：getR2() 返回模块级缓存的 _r2，
 * 测试里没法用 monkey-patch 覆盖 ESM 的具名导出（赋值会报
 * "Cannot assign to read only property"）。留一个显式注入点
 * 比在每个测试里 hack 模块对象干净。
 *
 * 生产代码**不要调用**。
 *
 * @param {object|null} fake 传 null 等同于 resetR2()
 */
export function __setR2ForTest(fake) {
  _r2 = fake;
}
