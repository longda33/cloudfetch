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

  get configured() {
    return Boolean(this.accessKeyId && this.secretAccessKey && this.bucket && this.endpoint);
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

    // 参与签名的最小头集合
    const signedHeaderMap = {
      host: this.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...headers,
    };
    const sortedKeys = Object.keys(signedHeaderMap)
      .map((k) => k.toLowerCase())
      .sort();
    const canonicalHeaders = sortedKeys
      .map((k) => `${k}:${String(signedHeaderMap[k] ?? '').trim()}\n`)
      .join('');
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

  /** 上传本地文件。大文件走单请求（R2 单次 PUT 上限 5GB） */
  async putFile(localPath, key, { contentType, onProgress, signal } = {}) {
    const st = await fsp.stat(localPath);
    const size = st.size;

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

    const res = await fetch(this._url(key), {
      method: 'PUT',
      headers,
      body: Readable.toWeb(fs.createReadStream(localPath)),
      duplex: 'half',
      signal,
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new R2Error(`R2 PUT 失败：HTTP ${res.status} ${txt.slice(0, 300)}`, res.status);
    }

    onProgress?.(size, size);
    return { size, key };
  }

  /** 下载到本地文件。返回 { size } */
  async getFile(key, destPath, { onProgress, signal } = {}) {
    const headers = this._sign({ method: 'GET', key, payloadHash: EMPTY_SHA256 });
    const res = await fetch(this._url(key), { method: 'GET', headers, signal });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new R2Error(`R2 GET 失败：HTTP ${res.status} ${txt.slice(0, 300)}`, res.status);
    }

    const total = Number(res.headers.get('content-length')) || 0;
    let written = 0;
    const ws = fs.createWriteStream(destPath);
    try {
      for await (const chunk of res.body) {
        if (!ws.write(chunk)) await new Promise((r) => ws.once('drain', r));
        written += chunk.length;
        onProgress?.(written, total);
      }
    } finally {
      await new Promise((r) => ws.end(r));
    }
    return { size: written };
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
