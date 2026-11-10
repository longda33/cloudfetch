/**
 * R2 → OpenList 搬迁（一次性运维脚本，不属于常规流程）。
 *
 * 用途：把 R2 上积压的分段原样搬到 OpenList，**不合并、不转码**，
 * 传完删掉 R2 上的对象。
 *
 * 为什么单独写这个脚本而不是塞进 transcode-worker：
 *   转码链路是"合并成一个 MP4"，这里是"原样搬 29 个文件"，
 *   目标完全不同。混在一起会让本来就复杂的 worker 更难维护。
 *
 * 关键设计：**流式转发，不落地磁盘**。
 *   R2 拉一片 10MB → 立刻 PUT 给 OpenList → 丢掉这片 → 拉下一片。
 *   峰值内存只有 1-2 片，不占磁盘。Runner 的 14GB SSD 不是瓶颈，
 *   但分段总共 1.4GB，落地再传等于多写多读一遍，纯属浪费。
 *
 * 用法：
 *   node scripts/r2-to-openlist.mjs --prefix cloudfetch/<taskId> --dir /path/on/openlist
 *   node scripts/r2-to-openlist.mjs --prefix ... --dir ... --dry-run
 *   node scripts/r2-to-openlist.mjs --prefix ... --dir ... --keep-r2
 */

import crypto from 'node:crypto';
import path from 'node:path';

// ---------------- 配置 ----------------

const {
  R2_ACCOUNT_ID = '',
  R2_ACCESS_KEY_ID = '',
  R2_SECRET_ACCESS_KEY = '',
  R2_BUCKET = '',
  R2_ENDPOINT = '',
  OPENLIST_URL = '',
  OPENLIST_TOKEN = '',
} = process.env;

const CHUNK = 10 * 1024 * 1024; // OpenList 分片大小，与 src/openlist.js 保持一致

// ---------------- 参数解析 ----------------

function parseArgs(argv) {
  const out = { prefix: '', dir: '', dryRun: false, keepR2: false, deleteOnly: false, limit: 0 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prefix') out.prefix = argv[++i] || '';
    else if (a === '--dir') out.dir = argv[++i] || '';
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--keep-r2') out.keepR2 = true;
    else if (a === '--delete-only') out.deleteOnly = true;
    else if (a === '--limit') {
      /**
       * 必须是正整数。
       *
       * 之前写成 `Number(argv[++i]) || 0`，而 0 的语义是「不限」——
       * 用户打错成 `--limit 10x` 会得到 0，于是**处理全部对象**，
       * 而这是个会删 R2 源文件的脚本，误操作的代价太大。
       */
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v <= 0) {
        throw new Error(`--limit 需要一个正整数，收到：${argv[i]}`);
      }
      out.limit = v;
    }
    else if (a === '--help' || a === '-h') {
      console.log(
        [
          '用法: node scripts/r2-to-openlist.mjs [选项]',
          '',
          '  --prefix <str>   R2 前缀，例如 cloudfetch/<taskId>',
          '  --dir <path>     OpenList 目标目录，例如 /od-20200439/cloudfetch/2026-11-08/xxx',
          '  --limit <n>      只处理前 n 个（试跑用）',
          '  --dry-run        只列出计划，不实际传输',
          '  --keep-r2        传完不删 R2 对象',
          '  --delete-only    只删 R2（假定已经传过了）',
          '',
          '环境变量: R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET',
          '          OPENLIST_URL OPENLIST_TOKEN',
        ].join('\n'),
      );
      process.exit(0);
    }
  }
  return out;
}

// ---------------- R2（SigV4） ----------------

const R2_HOST = R2_ENDPOINT
  ? new URL(R2_ENDPOINT).host
  : `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const R2_BASE = R2_ENDPOINT ? R2_ENDPOINT.replace(/\/+$/, '') : `https://${R2_HOST}`;

const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** URI 编码，保留斜杠 */
function uriEncode(s, encodeSlash = true) {
  let out = '';
  for (const ch of String(s)) {
    if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch;
    else if (ch === '/' && !encodeSlash) out += ch;
    else out += '%' + Buffer.from(ch, 'utf8').toString('hex').toUpperCase();
  }
  return out;
}

function r2Sign({ method, key, query = '', payloadHash }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;

  /**
   * canonicalUri 必须与实际请求路径**逐字节一致**（含 bucket）。
   * 这个坑踩过：只写 /{key} 会导致 SignatureDoesNotMatch。
   *
   * 但**列桶**（key 为空）时路径只有 /{bucket}，不能多一个斜杠 ——
   * 多写一个 `/` 就签名不匹配。这是第二次踩同一个坑。
   */
  const bucketPart = '/' + uriEncode(R2_BUCKET, false);
  const canonicalUri = key
    ? bucketPart + '/' + uriEncode(key, false)
    : bucketPart;

  const canonicalHeaders = `host:${R2_HOST}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, canonicalUri, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(
    hmac(hmac(hmac(`AWS4${R2_SECRET_ACCESS_KEY}`, dateStamp), 'auto'), 's3'),
    'aws4_request',
  );
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    amzDate,
    payloadHash,
    authorization: `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function r2Url(key, query = '') {
  const p = key
    ? `/${uriEncode(R2_BUCKET, false)}/${uriEncode(key, false)}`
    : `/${uriEncode(R2_BUCKET, false)}`;
  return `${R2_BASE}${p}${query ? '?' + query : ''}`;
}

/**
 * 解析 ListObjectsV2 的 XML。
 *
 * Key 里可能有 `&amp;` `&lt;` 这类实体（文件名带 & 就会转义），
 * 不还原就会拿一个不存在的 key 去 GET，白白失败。
 */
const unescapeXml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');

/** 列出前缀下所有对象，自动翻页 */
async function r2List(prefix) {
  const out = [];
  let token = null;
  for (;;) {
    const params = ['list-type=2', 'max-keys=1000'];
    if (prefix) params.push(`prefix=${encodeURIComponent(prefix)}`);
    if (token) params.push(`continuation-token=${encodeURIComponent(token)}`);
    const query = params.join('&');

    const payloadHash = sha256hex('');
    const sig = r2Sign({ method: 'GET', key: '', query, payloadHash });

    const res = await fetch(`${R2_BASE}/${R2_BUCKET}?${query}`, {
      headers: {
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': sig.amzDate,
        Authorization: sig.authorization,
      },
    });
    if (!res.ok) {
      throw new Error(`R2 LIST 失败 HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = await res.text();
    const keys = [...body.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => unescapeXml(m[1]));
    const sizes = [...body.matchAll(/<Size>(\d+)<\/Size>/g)].map((m) => Number(m[1]));
    keys.forEach((key, i) => out.push({ key, size: sizes[i] || 0 }));

    const next = body.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    if (!next) break;
    token = next[1];
  }
  return out;
}

/** 读取 R2 对象的一段字节（Range GET），返回 Buffer */
async function r2Range(key, start, endInclusive) {
  const payloadHash = sha256hex('');
  const sig = r2Sign({ method: 'GET', key, query: '', payloadHash });

  const res = await fetch(r2Url(key), {
    headers: {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': sig.amzDate,
      Authorization: sig.authorization,
      Range: `bytes=${start}-${endInclusive}`,
    },
  });
  if (!res.ok && res.status !== 206) {
    throw new Error(`R2 GET 失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/** 删除 R2 对象 */
async function r2Delete(key) {
  const payloadHash = sha256hex('');
  const sig = r2Sign({ method: 'DELETE', key, query: '', payloadHash });

  const res = await fetch(r2Url(key), {
    method: 'DELETE',
    headers: {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': sig.amzDate,
      Authorization: sig.authorization,
    },
  });
  // 404 视为已删
  if (!res.ok && res.status !== 404) {
    throw new Error(`R2 DELETE 失败 HTTP ${res.status}`);
  }
}

// ---------------- OpenList ----------------

/**
 * OPENLIST_TOKEN 是 API Token（设置 → 其他 → 令牌），直接放在
 * Authorization 头里，**不需要登录换 token**。
 *
 * 之前这里写了个 olLogin() 去打 /api/auth/login，
 * 把 API Token 当成密码传 —— 那是错的，会 400。
 * 只有账号密码模式才需要登录，而本项目用的是 Token 模式。
 */
async function olRequest(method, apiPath, { headers = {}, body, rawBody, timeout = 120000 } = {}) {
  const h = { Authorization: OPENLIST_TOKEN, ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';

  const res = await fetch(`${OPENLIST_URL}${apiPath}`, {
    method,
    headers: h,
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  return { ok: res.ok, status: res.status, text, json };
}

/** 递归建目录（已存在不报错） */
async function olEnsureDir(dir) {
  const parts = String(dir).split('/').filter(Boolean);
  let cur = '';
  for (const p of parts) {
    cur += '/' + p;
    const r = await olRequest('POST', '/api/fs/mkdir', { body: { path: cur } });
    const msg = r.json?.message || r.text || '';
    if (!r.ok && !/exist/i.test(msg)) {
      throw new Error(`建目录失败 ${cur}: ${msg.slice(0, 160)}`);
    }
  }
}

/** 读取远端文件大小，读不到返回 null */
async function olSize(remotePath) {
  const r = await olRequest('POST', '/api/fs/get', { body: { path: remotePath } });
  const size = Number(r.json?.data?.size);
  return Number.isFinite(size) ? size : null;
}

/**
 * 流式上传：从 R2 逐片拉，逐片传给 OpenList。
 *
 * 不落地磁盘 —— 这是本脚本的核心。
 */
async function streamR2ToOpenList(r2Key, remotePath, size) {
  const remoteDir = path.posix.dirname(remotePath);
  await olEnsureDir(remoteDir);

  // ---- init ----
  const initRes = await olRequest('POST', '/api/fs/multipart/init', {
    headers: {
      'File-Path': encodeURIComponent(remotePath),
      'X-File-Size': String(size),
      'X-Chunk-Size': String(CHUNK),
      'Content-Type': 'application/octet-stream',
      'Last-Modified': String(Date.now()),
      Overwrite: 'true',
    },
  });

  if (!initRes.ok || (initRes.json?.code !== undefined && initRes.json.code !== 200)) {
    const msg = initRes.json?.message || initRes.text.slice(0, 200);
    throw new Error(`分片初始化失败：${msg}`);
  }
  const sess = initRes.json?.data;
  if (!sess?.upload_id) throw new Error('服务端未返回 upload_id（存储驱动不支持分片）');

  const uploadId = String(sess.upload_id);
  const chunkSize = Number(sess.chunk_size) || CHUNK;
  const totalChunks = Number(sess.total_chunks) || Math.ceil(size / chunkSize);

  // ---- 逐片：R2 Range GET → OpenList PUT ----
  for (let idx = 0; idx < totalChunks; idx++) {
    const start = idx * chunkSize;
    const len = Math.min(chunkSize, size - start);
    if (len <= 0) continue;

    let buf = null;
    // R2 拉取重试
    for (let a = 1; a <= 5; a++) {
      try {
        buf = await r2Range(r2Key, start, start + len - 1);
        break;
      } catch (e) {
        if (a === 5) throw new Error(`R2 读取第 ${idx + 1} 片失败：${e.message}`);
        await new Promise((r) => setTimeout(r, a * 1000));
      }
    }
    if (buf.length !== len) {
      throw new Error(`R2 读取长度不符：期望 ${len}，实际 ${buf.length}（第 ${idx + 1} 片）`);
    }

    // OpenList 上传重试
    let lastErr;
    for (let a = 1; a <= 5; a++) {
      try {
        const r = await olRequest('PUT', '/api/fs/multipart/chunk', {
          headers: {
            'X-Upload-Id': uploadId,
            'X-Chunk-Index': String(idx),
            'Content-Type': 'application/octet-stream',
          },
          rawBody: buf,
          timeout: 600000,
        });
        if (r.status === 409 || r.status === 429) {
          lastErr = new Error(`HTTP ${r.status}`);
          await new Promise((x) => setTimeout(x, a * 2000));
          continue;
        }
        if (!r.ok || (r.json?.code !== undefined && r.json.code !== 200)) {
          throw new Error(`HTTP ${r.status} ${(r.json?.message || r.text).slice(0, 120)}`);
        }
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (a === 5) break;
        await new Promise((x) => setTimeout(x, a * 2000));
      }
    }
    if (lastErr) throw new Error(`第 ${idx + 1}/${totalChunks} 片上传失败：${lastErr.message}`);

    // 及时释放
    buf = null;

    if ((idx + 1) % 5 === 0 || idx + 1 === totalChunks) {
      log(`    分片 ${idx + 1}/${totalChunks}`);
    }
  }

  // ---- complete ----
  const compRes = await olRequest('POST', '/api/fs/multipart/complete', {
    headers: { 'X-Upload-Id': uploadId },
    timeout: 600000,
  });
  if (!compRes.ok || (compRes.json?.code !== undefined && compRes.json.code !== 200)) {
    throw new Error(`分片合并失败：${(compRes.json?.message || compRes.text).slice(0, 200)}`);
  }

  /**
   * 删 R2 之前必须核对远端大小。
   *
   * 这个脚本的下一步就是 r2Delete —— 一旦传上去的东西不对（分片缺失、
   * 驱动写坏），源文件又被删掉，那就是不可恢复的数据丢失。
   * 读不到大小也按失败处理（宁可留着，也不要赌）。
   */
  const remoteSize = await olSize(remotePath);
  if (remoteSize === null) {
    throw new Error('上传完成但读不到远端大小，为安全起见不删除 R2 源文件');
  }
  if (remoteSize !== size) {
    throw new Error(`远端大小不符：应为 ${size}，实际 ${remoteSize}，不删除 R2 源文件`);
  }

  return remotePath;
}

// ---------------- 主流程 ----------------

const log = (s) => console.log(s);
const human = (n) => {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
};

async function main() {
  const args = parseArgs(process.argv);

  /**
   * 只要求「能拼出 endpoint」+ 密钥 + 桶。
   *
   * 和 src/r2.js、transcode-worker 保持一致：R2 用 accountId 拼域名，
   * MinIO / B2 这类只能给 R2_ENDPOINT，不该强制填 accountId。
   */
  const hasEndpoint = Boolean(R2_ENDPOINT || R2_ACCOUNT_ID);
  if (!hasEndpoint || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    throw new Error(
      '缺少 R2 环境变量（需要 R2_ENDPOINT 或 R2_ACCOUNT_ID，以及 KEY/SECRET/BUCKET）',
    );
  }
  if (!args.prefix) throw new Error('缺少 --prefix');
  if (!args.deleteOnly && !args.dir) throw new Error('缺少 --dir');
  if (!OPENLIST_URL || !OPENLIST_TOKEN) throw new Error('缺少 OPENLIST_URL / OPENLIST_TOKEN');

  log(`R2 桶：${R2_BUCKET} @ ${R2_HOST}`);
  log(`前缀：${args.prefix}`);
  if (args.dir) log(`目标：${args.dir}`);

  const objsAll = await r2List(args.prefix);
  if (!objsAll.length) {
    log('\n该前缀下没有对象，无需操作。');
    return;
  }
  const objs = args.limit > 0 ? objsAll.slice(0, args.limit) : objsAll;
  const total = objs.reduce((a, o) => a + o.size, 0);
  if (args.limit > 0) {
    log(`\n找到 ${objsAll.length} 个对象，本次只处理前 ${objs.length} 个（--limit）`);
  } else {
    log(`\n找到 ${objs.length} 个对象`);
  }
  log(`合计 ${human(total)}\n`);

  if (args.dryRun) {
    for (const o of objs) {
      log(`  [dry] ${o.key}  ${human(o.size)}`);
    }
    log('\n--dry-run 结束，未做任何改动。');
    return;
  }

  // ---- 只删不传 ----
  if (args.deleteOnly) {
    log('=== 仅删除 R2 对象 ===');
    let del = 0;
    for (const o of objs) {
      await r2Delete(o.key);
      del++;
      log(`  已删 ${del}/${objs.length}: ${o.key}`);
    }
    log(`\n完成：删除 ${del} 个对象，释放 ${human(total)}`);
    return;
  }

  // ---- 传输 ----
  const ok = [];
  const failed = [];

  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    /**
     * 目标文件名 = R2 key 的最后一段。
     *
     * 不能用 `key.slice(prefix.length)` —— 前缀是 `.../0029` 这种
     * 带文件名前缀的写法时，会把文件名本身也切掉（实测得到
     * `_live_...flv`，少了个 0029）。取 basename 永远正确。
     */
    const name = path.posix.basename(o.key);
    const remotePath = `${args.dir.replace(/\/+$/, '')}/${name}`;

    log(`[${i + 1}/${objs.length}] ${o.key}`);
    log(`    → ${remotePath}  (${human(o.size)})`);

    try {
      await streamR2ToOpenList(o.key, remotePath, o.size);
      ok.push({ key: o.key, remotePath, size: o.size });
      log('    完成');
    } catch (e) {
      failed.push({ key: o.key, error: e.message });
      log(`    失败：${e.message}`);
    }
  }

  // ---- 删 R2（只删成功的）----
  if (!args.keepR2 && ok.length) {
    log(`\n=== 清理 R2（只删已成功上传的 ${ok.length} 个）===`);
    let del = 0;
    let freed = 0;
    for (const o of ok) {
      try {
        await r2Delete(o.key);
        del++;
        freed += o.size;
      } catch (e) {
        log(`  删除失败 ${o.key}: ${e.message}`);
      }
    }
    log(`  已删 ${del}/${ok.length}，释放 ${human(freed)}`);
  }

  // ---- 汇总 ----
  log('\n=== 结果 ===');
  log(`  成功 ${ok.length} / ${objs.length}`);
  log(`  失败 ${failed.length}`);
  if (failed.length) {
    log('\n  失败清单（这些在 R2 上仍然保留，可重跑）：');
    for (const f of failed) log(`    ${f.key}  ← ${f.error}`);
    process.exitCode = 1;
  }

  log('\n=== TRANSFER_RESULT ===');
  log(
    JSON.stringify({
      ok: failed.length === 0,
      total: objs.length,
      succeeded: ok.length,
      failed: failed.length,
      bytes: total,
      keptR2: args.keepR2,
    }),
  );
  log('=== END ===');
}

main().catch((e) => {
  console.error(`\n失败：${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
