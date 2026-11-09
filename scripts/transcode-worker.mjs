#!/usr/bin/env node
/**
 * GitHub Actions 里的转码执行器。
 *
 * 职责：下载 FLV → ffmpeg 转 MP4（H.264 + AAC）→ 上传 OpenList → 清理 R2。
 *
 * 为什么单独写成脚本而不是塞在 workflow 的 run: 里：
 *   1. 需要分步打印进度、算体积、处理失败重试，shell 写起来太长
 *   2. 上传 OpenList 走的是项目里已有的分片协议，直接复用 src/openlist.js
 *   3. 本地可以脱离 Actions 单独跑，方便调试
 *
 * 输入全部走环境变量，不读命令行参数 —— Actions 里环境变量更好传。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fetchRetry as fetchRetryRaw } from './lib/fetch-retry.mjs';

const {
  SOURCE_URL = '',
  R2_KEY = '',
  R2_KEYS = '',
  OUT_NAME = 'output.mp4',
  OPENLIST_DIR = '',
  /**
   * CRF / PRESET / THREADS 保留只是为了**不破坏已有的 workflow 调用**
   * （transcode.yml 还在传 crf / preset 两个 input）。
   *
   * 2026-11-09 起改成了 `-c copy` 纯封装，**不重编码**，所以这三个值
   * 已经不影响任何行为。留着是为了让旧的 `gh workflow run -f crf=18`
   * 不会因为「未知 input」而失败。
   *
   * 如果以后确认没人再传这些参数，可以连同 workflow 里的 input 一起删。
   */
  CRF = '18',
  PRESET = 'ultrafast',
  THREADS = '0',
  TASK_ID = '',
  // OpenList 凭据
  OPENLIST_URL = '',
  OPENLIST_TOKEN = '',
  // 可选：转完删掉 R2 里的源文件
  R2_DELETE_AFTER = 'true',
  // R2 凭据（合并模式必需，单文件模式只用于清理）
  R2_ACCOUNT_ID = '',
  R2_ACCESS_KEY_ID = '',
  R2_SECRET_ACCESS_KEY = '',
  R2_BUCKET = '',
  R2_ENDPOINT = '',
} = process.env;

const log = (...a) => console.log(`[transcode]`, ...a);

/** 把重试日志接到本脚本的 log 上，调用点就不用每次传 */
const fetchRetry = (url, opts, o = {}) => fetchRetryRaw(url, opts, { ...o, log });
const fail = (msg) => {
  console.error(`[transcode] 错误：${msg}`);
  process.exit(1);
};

/** 跑一个子进程，实时转发输出 */
function run(cmd, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const onData = (buf) => {
      const s = buf.toString();
      // ffmpeg 的进度行用 \r 刷新，这里只保留最后一段
      tail = (tail + s).slice(-2000);
      process.stdout.write(s);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} 退出码 ${code}\n${tail}`));
    });
  });
}

/**
 * 跑一个子进程并收集 stdout。
 *
 * 和 run() 的区别：这个不转发输出。给 ffprobe 这类「输出就是结果」的
 * 命令用，把探测结果当字符串返回。
 */
function runCapture(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { err += b.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} 退出码 ${code}：${err.slice(-500)}`));
    });
  });
}

async function sizeOf(p) {
  try {
    return (await fsp.stat(p)).size;
  } catch {
    return 0;
  }
}

const humanSize = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(2)} ${u[i]}`;
};

// ---------------- 1. 下载 ----------------
async function download(url, dest) {
  log(`下载源文件 → ${dest}`);
  /**
   * 必须带超时：预签名 URL 过期、R2 半死不活时，fetch 会一直挂着，
   * 直到 job 的 timeout-minutes(120) 才结束，白烧两小时 runner。
   */
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30 * 60 * 1000),
  });
  if (!res.ok) fail(`下载失败：HTTP ${res.status} ${res.statusText}`);

  const total = Number(res.headers.get('content-length')) || 0;
  let written = 0;
  let lastPct = -1;

  const fh = await fsp.open(dest, 'w');
  try {
    for await (const chunk of res.body) {
      await fh.write(chunk);
      written += chunk.length;
      if (total) {
        const pct = Math.floor((written / total) * 100);
        if (pct !== lastPct && pct % 10 === 0) {
          log(`  已下载 ${pct}%（${humanSize(written)} / ${humanSize(total)}）`);
          lastPct = pct;
        }
      }
    }
  } finally {
    await fh.close();
  }

  if (written === 0) fail('下载到 0 字节，源文件可能是空的');
  // 截断的文件会让 ffmpeg 转出半截视频，宁可直接失败
  if (total && written !== total) {
    fail(`下载不完整：${humanSize(written)} / ${humanSize(total)}`);
  }
  log(`下载完成：${humanSize(written)}`);
  return written;
}

/**
 * 从 R2 拉一个对象到本地。
 *
 * 用预签名 URL 走普通 HTTPS GET，不实现 S3 的 GET 签名 ——
 * 预签名只需要在 URL 上算一次，比在 headers 里签简单，也不会因为
 * 多了几个头（content-length 之类）而签名不匹配。
 *
 * 有效期给足 30 分钟：一场 3 小时直播有 36 个 5 分钟分段，
 * 逐个下载可能要十几分钟，太短会在中途过期。
 */
async function downloadFromR2(key, dest) {
  const url = presignR2Get(key, 30 * 60);
  return download(url, dest);
}

/**
 * 生成 R2 的预签名 GET URL。
 *
 * 和 src/r2.js 里的 presignGet 是同一套 SigV4 逻辑，但那个文件依赖
 * 项目的 config.js（需要 DATA_DIR 等环境变量），Actions 里不想为了
 * 一个签名把整个 config 拖进来，所以这里独立实现一份。
 */
function presignR2Get(key, expiresSec) {
  const endpoint = (R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`).replace(
    /\/+$/,
    '',
  );
  const host = new URL(endpoint).host;
  const region = 'auto';

  const enc = (s) =>
    [...String(s)]
      .map((ch) =>
        /[A-Za-z0-9_.~-]/.test(ch)
          ? ch
          : [...Buffer.from(ch, 'utf8')]
              .map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0'))
              .join(''),
      )
      .join('');
  const sha = (d) => crypto.createHash('sha256').update(d).digest('hex');
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = now.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;

  const canonicalUri = '/' + enc(R2_BUCKET) + '/' + enc(key).replace(/%2F/g, '/');
  // 查询参数必须按字典序排列，否则签名对不上
  const query =
    `X-Amz-Algorithm=AWS4-HMAC-SHA256` +
    `&X-Amz-Credential=${enc(`${R2_ACCESS_KEY_ID}/${scope}`)}` +
    `&X-Amz-Date=${now}` +
    `&X-Amz-Expires=${expiresSec}` +
    `&X-Amz-SignedHeaders=host`;

  const canonicalHeaders = `host:${host}\n`;
  const payloadHash = 'UNSIGNED-PAYLOAD';
  const canonicalRequest = [
    'GET',
    canonicalUri,
    query,
    canonicalHeaders,
    'host',
    payloadHash,
  ].join('\n');

  const stringToSign = ['AWS4-HMAC-SHA256', now, scope, sha(canonicalRequest)].join('\n');
  const kSigning = hmac(
    hmac(hmac(hmac(`AWS4${R2_SECRET_ACCESS_KEY}`, dateStamp), region), 's3'),
    'aws4_request',
  );
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return `${endpoint}${canonicalUri}?${query}&X-Amz-Signature=${signature}`;
}

// ---------------- 2. 转码 ----------------
/**
 * 探测视频流的帧率声明。
 *
 * 直播 FLV 的容器头经常没有 framerate 元数据，ffmpeg 只能退化成
 * 「一个时间刻度一帧」的猜测值，于是 r_frame_rate 变成 1000/1。
 * 这个假帧率是整场超时的根源，所以转码前先把它打出来。
 */
async function probeFrameRate(file) {
  try {
    const out = await runCapture('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate,avg_frame_rate,codec_name',
      '-of', 'default=nw=1',
      file,
    ]);
    const get = (k) => (out.match(new RegExp(`^${k}=(.*)$`, 'm')) || [, ''])[1].trim();
    return {
      codec: get('codec_name'),
      r: get('r_frame_rate'),
      avg: get('avg_frame_rate'),
    };
  } catch (e) {
    log(`ffprobe 探测失败（不影响转码）：${e.message}`);
    return { codec: '', r: '', avg: '' };
  }
}

/**
 * 把 FLV 封装成 MP4 —— **不重编码**。
 *
 * ---- 2026-11-09 改成纯 remux ----
 *
 * 之前这里做的是 H.264 重编码（CRF 18 / ultrafast / fps_mode passthrough）。
 * 虽然 passthrough 已经把速度从 0.452x 提到 15x，但用户明确要求
 * **不要再重编码**，理由充分：
 *
 *   1. 源本来就是 H.264 + AAC，重编码只会有代际损失，不可能提升画质
 *   2. remux 是**字面零损失** —— 码流原样搬运，一帧不改
 *   3. remux 只要几秒，重编码要 20-30 分钟
 *   4. 体积不膨胀（重编码 CRF 18 会让 1.42GB 涨到 3.5GB）
 *
 * 代价（必须让用户知道）：
 *   - 源是变帧率（约 19.8fps）+ 容器声称 1000fps，remux 会**原样保留**
 *     这个假帧率。某些播放器拖进度条可能不准。
 *   - 这不能用 `-fps_mode cfr` 修 —— copy 模式下该参数无效。
 *
 * 所以这里只做三件事：
 *   - `-c copy`：码流原样搬运
 *   - `-avoid_negative_ts make_zero`：兜住个别分段首帧为负的情况
 *   - `-movflags +faststart`：索引移到文件头，浏览器可边下边播
 */
async function remuxToMp4(input, output) {
  const probe = await probeFrameRate(input);
  if (probe.r || probe.avg) {
    log(`源视频：codec=${probe.codec} r_frame_rate=${probe.r} avg_frame_rate=${probe.avg}`);
  }
  /**
   * 假帧率告警。
   *
   * 真实内容约 20fps，容器声称 1000fps。remux 会原样保留它 ——
   * 这是「不重编码」的固有代价，不是 bug。留一行日志让人知道。
   */
  const parts = String(probe.r).split('/');
  const claimed = Number(parts[0]) / (Number(parts[1]) || 1);
  if (claimed > 120) {
    log(`⚠️ 容器声称 ${probe.r} fps（假帧率）。remux 会原样保留，播放器拖进度条可能不准`);
  }

  log('封装：-c copy（不重编码，画质零损失）');

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-stats',
    '-i', input,
    // 码流原样搬运，不解码、不重编码
    '-c', 'copy',
    // 兜住负时间戳
    '-avoid_negative_ts', 'make_zero',
    // 索引移到文件头，浏览器可边下边播
    '-movflags', '+faststart',
    '-y', output,
  ];

  await run('ffmpeg', args);
  const sz = await sizeOf(output);
  if (sz === 0) fail('封装输出是 0 字节');
  log(`封装完成：${humanSize(sz)}`);
  return sz;
}

// ---------------- 2b. 合并多段 ----------------
/**
 * 把 N 个分段合并成一个 MP4。
 *
 * **一步到位**：concat demuxer 直接输出 MP4，全程 `-c copy`。
 *
 * 之前是两步（先拼 FLV，再转码成 MP4），现在不重编码了，
 * 两步没有任何好处 —— 反而多写一遍 1.4GB 磁盘、多花时间。
 *
 * 为什么 concat demuxer 而不是 filter_complex：
 *   concat demuxer 直接把多个 FLV 当同一路流拼接，不解码，
 *   内存占用恒定。filter_complex 会把所有输入同时打开，
 *   36 个分段很容易把 runner 的内存吃满。
 */
async function mergeAndTranscode(parts, workDir, output) {
  if (parts.length === 1) {
    // 只有一段，直接封装
    return remuxToMp4(parts[0], output);
  }

  log(`合并 ${parts.length} 个分段（-c copy，不解码）…`);

  /**
   * concat demuxer 需要一个列表文件，每行 `file '路径'`。
   *
   * 路径里可能有单引号，ffmpeg 的写法是把 ' 转义成 '\''。
   * 这里的分段名是我们自己生成的（part_0001.flv），不会有特殊字符，
   * 但加上转义更稳妥 —— 万一以后文件名规则变了也不会出问题。
   */
  const listPath = path.join(workDir, 'concat.txt');
  const listBody = parts
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join('\n');
  await fsp.writeFile(listPath, listBody + '\n', 'utf8');

  const probe = await probeFrameRate(parts[0]);
  if (probe.r) {
    const seg = String(probe.r).split('/');
    const claimed = Number(seg[0]) / (Number(seg[1]) || 1);
    if (claimed > 120) {
      log(`⚠️ 容器声称 ${probe.r} fps（假帧率）。remux 会原样保留，播放器拖进度条可能不准`);
    }
  }

  log('封装：concat + -c copy（不重编码，画质零损失）');

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-stats',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    // 码流原样搬运
    '-c', 'copy',
    /**
     * 把负时间戳平移到 0。
     *
     * concat demuxer 会按每个分段的**实际末帧 PTS** 给下一段加偏移，
     * 所以各段虽然都从 0 开始，拼起来仍然是连续的。这里只是兜住
     * 个别分段首帧为负的情况。
     */
    '-avoid_negative_ts', 'make_zero',
    // 索引移到文件头
    '-movflags', '+faststart',
    '-y', output,
  ];

  await run('ffmpeg', args);

  const sz = await sizeOf(output);
  if (sz === 0) fail('合并输出是 0 字节');
  log(`合并完成：${humanSize(sz)}`);

  // 输出已经生成，分段没用了，删掉腾磁盘
  for (const p of parts) {
    await fsp.rm(p, { force: true }).catch(() => {});
  }

  return sz;
}

// ---------------- 3. 上传 OpenList ----------------
async function uploadToOpenList(localPath, remoteDir) {
  if (!OPENLIST_URL || !OPENLIST_TOKEN) fail('缺少 OPENLIST_URL / OPENLIST_TOKEN');
  if (!remoteDir) fail('缺少 OPENLIST_DIR');

  const filename = path.basename(localPath);
  const remotePath = `${remoteDir.replace(/\/+$/, '')}/${filename}`;
  log(`上传 OpenList → ${remotePath}`);

  const total = await sizeOf(localPath);
  const CHUNK = 10 * 1024 * 1024;

  // 小文件直接单请求，省掉 multipart 的三次往返
  if (total <= CHUNK) {
    const buf = await fsp.readFile(localPath);
    await fetchRetry(`${OPENLIST_URL.replace(/\/+$/, '')}/api/fs/put`, {
      method: 'PUT',
      headers: {
        Authorization: OPENLIST_TOKEN,
        'File-Path': encodeURIComponent(remotePath),
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(buf.length),
      },
      body: buf,
    });
    // fetchRetry 只返回 2xx，走到这里就是成功
    log('上传完成（单请求）');
    return remotePath;
  }

  // 大文件走分片协议
  const base = OPENLIST_URL.replace(/\/+$/, '');
  const auth = { Authorization: OPENLIST_TOKEN };

  const initRes = await fetchRetry(`${base}/api/fs/multipart/init`, {
    method: 'POST',
    headers: {
      ...auth,
      'File-Path': encodeURIComponent(remotePath),
      'X-File-Size': String(total),
      'X-Chunk-Size': String(CHUNK),
      'Last-Modified': new Date().toISOString(),
      'Content-Type': 'application/octet-stream',
      Overwrite: 'true',
    },
  });
  // fetchRetry 只返回 2xx，失败会抛（4xx 不重试，5xx/429/网络错误重试）
  const init = await initRes.json();
  const uploadId = init?.data?.upload_id || init?.upload_id;
  const chunkSize = init?.data?.chunk_size || CHUNK;
  const totalChunks = init?.data?.total_chunks || Math.ceil(total / chunkSize);
  if (!uploadId) fail(`multipart init 未返回 upload_id：${JSON.stringify(init).slice(0, 300)}`);

  log(`分片上传：${humanSize(total)}，每片 ${humanSize(chunkSize)}，共 ${totalChunks} 片`);

  const fh = await fsp.open(localPath, 'r');
  try {
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const len = Math.min(chunkSize, total - start);
      /**
       * 必须循环读满：fh.read 允许短读，之前只调一次，
       * 短读时 Buffer 尾部是零填充，会把坏数据传到 OpenList，
       * 而且分片长度和 Content-Length 对不上。
       */
      const buf = Buffer.alloc(len);
      let filled = 0;
      while (filled < len) {
        const { bytesRead } = await fh.read(buf, filled, len - filled, start + filled);
        if (bytesRead === 0) fail(`读取本地文件不完整：第 ${i + 1} 片 ${filled}/${len} 字节`);
        filled += bytesRead;
      }

      /**
       * 分片重试。
       *
       * 之前只对 409/429 重试，其它 5xx 直接 break —— 一个 502 就能让
       * 已经跑了 2-4 小时的转码整场失败，而重跑又要几小时。
       * 现在交给 fetchRetry：网络错误 / 409 / 429 / 5xx 都退避重试，
       * 只有真正的 4xx 参数错误才立刻失败。
       */
      try {
        await fetchRetry(
          `${base}/api/fs/multipart/chunk`,
          {
            method: 'PUT',
            headers: {
              ...auth,
              'X-Upload-Id': uploadId,
              'X-Chunk-Index': String(i),
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(len),
            },
            body: buf,
          },
          { attempts: 5, label: `第 ${i + 1}/${totalChunks} 片` },
        );
      } catch (e) {
        fail(`第 ${i + 1}/${totalChunks} 片上传失败：${e.message}`);
      }
      log(`  分片 ${i + 1}/${totalChunks} 完成`);
    }
  } finally {
    await fh.close();
  }

  await fetchRetry(
    `${base}/api/fs/multipart/complete`,
    {
      method: 'POST',
      headers: { ...auth, 'X-Upload-Id': uploadId, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
    { attempts: 4, label: 'multipart complete' },
  );

  log('上传完成（分片）');
  return remotePath;
}

// ---------------- 4. 清理 R2 ----------------
async function deleteFromR2(key) {
  if (R2_DELETE_AFTER !== 'true' || !key) return;
  /**
   * 只需要 endpoint + 凭据，不强制 accountId。
   * R2 可以按 accountId 拼 endpoint，MinIO / B2 只能给 endpoint，
   * 之前这里要求 accountId，导致自建对象存储的源文件永远清不掉。
   */
  const hasEndpoint = Boolean(R2_ENDPOINT || R2_ACCOUNT_ID);
  if (!hasEndpoint || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    log('未配置 R2 凭据，跳过清理（源文件保留在 R2）');
    return;
  }

  // 延迟加载，避免没配 R2 时因为缺 config 报错
  const crypto = await import('node:crypto');
  const endpoint = (R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`).replace(/\/+$/, '');
  const host = new URL(endpoint).host;
  const region = 'auto';

  const enc = (s) =>
    [...String(s)]
      .map((ch) =>
        /[A-Za-z0-9_.~-]/.test(ch)
          ? ch
          : [...Buffer.from(ch, 'utf8')]
              .map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0'))
              .join(''),
      )
      .join('');
  const sha = (d) => crypto.createHash('sha256').update(d).digest('hex');
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = now.slice(0, 8);
  const payloadHash = sha('');
  const canonicalUri = '/' + enc(R2_BUCKET) + '/' + enc(key).replace(/%2F/g, '/');

  const canonicalHeaders =
    `host:${host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${now}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['DELETE', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', now, scope, sha(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${R2_SECRET_ACCESS_KEY}`, dateStamp), region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const res = await fetch(`${endpoint}${canonicalUri}`, {
    method: 'DELETE',
    headers: {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': now,
      Authorization: `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
  if (res.ok || res.status === 404) log(`已清理 R2 源文件：${key}`);
  else log(`清理 R2 失败：HTTP ${res.status}（不影响转码结果）`);
}

/**
 * 输出文件名消毒。
 *
 * 不能只允许 \w：那样中文名会被打成「____.mp4」，而主程序的
 * sanitizeFilename 是保留中文的，两边对不上，网盘里全是下划线。
 * 这里先取 basename 防路径穿越，再只去掉各系统真正非法的字符。
 */
function safeOutName(name) {
  const base = path.basename(String(name || 'output.mp4'));
  const cleaned = base
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || 'output.mp4';
}

// ---------------- 主流程 ----------------
async function main() {
  if (!OPENLIST_DIR) fail('缺少 OPENLIST_DIR');

  /**
   * 两种输入模式：
   *   1) R2_KEYS —— 多个对象键，按顺序合并（直播分段走这条）
   *   2) SOURCE_URL —— 单个预签名 URL（普通下载任务走这条）
   *
   * 直播改成「录完再合并」之后，一次调用要处理 N 个 5 分钟分段，
   * 所以 keys 优先，source_url 作为单文件兜底。
   */
  const keys = String(R2_KEYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!keys.length && !SOURCE_URL) fail('缺少 R2_KEYS 或 SOURCE_URL');
  if (keys.length) {
    // 合并模式要用预签名 URL 逐段下载，缺任何一项都签不出有效地址
    if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
      fail('多段合并需要 R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET');
    }
    if (!R2_ENDPOINT && !R2_ACCOUNT_ID) {
      fail('多段合并需要 R2 凭据（R2_ENDPOINT 与 R2_ACCOUNT_ID 都为空）');
    }
  }

  log('参数：', {
    out: OUT_NAME,
    crf: CRF,
    preset: PRESET,
    task: TASK_ID,
    mode: keys.length ? `合并 ${keys.length} 段` : '单文件',
    openlistDir: OPENLIST_DIR,
  });

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cf-transcode-'));
  const output = path.join(workDir, safeOutName(OUT_NAME));
  const parts = [];

  try {
    // ---------- 1. 把源文件都拉到本地 ----------
    let srcSize = 0;
    if (keys.length) {
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const ext = path.extname(key).toLowerCase() || '.flv';
        const dest = path.join(workDir, `part_${String(i + 1).padStart(4, '0')}${ext}`);
        log(`[${i + 1}/${keys.length}] 从 R2 拉取：${key}`);
        const sz = await downloadFromR2(key, dest);
        srcSize += sz;
        parts.push(dest);
      }
      log(`全部拉取完成：${keys.length} 段，合计 ${humanSize(srcSize)}`);
    } else {
      const ext = path.extname(R2_KEY || '').toLowerCase() || '.flv';
      const input = path.join(workDir, `input${ext}`);
      srcSize = await download(SOURCE_URL, input);
      parts.push(input);
    }

    // ---------- 2. 合并 + 转码 ----------
    /**
     * 为什么用 concat demuxer 而不是 filter_complex：
     *
     * concat demuxer 直接把多个 FLV 当同一路流拼接，不需要解码再编码，
     * 内存占用恒定（不随总时长增长）。filter_complex 会把所有输入
     * 同时打开，一场 3 小时直播有 36 个分段，很容易把 runner 的内存吃满。
     *
     * 前提是所有分段的编码参数一致 —— 这是成立的，因为都是同一个
     * ffmpeg 进程用 -c copy 切出来的。
     */
    const outSize = await mergeAndTranscode(parts, workDir, output);

    const ratio = srcSize ? ((outSize / srcSize) * 100).toFixed(1) : '?';
    log(`体积：${humanSize(srcSize)} → ${humanSize(outSize)}（${ratio}%）`);

    // ---------- 3. 上传 OpenList ----------
    const remote = await uploadToOpenList(output, OPENLIST_DIR);

    // ---------- 4. 清理 R2 ----------
    /**
     * 合并模式逐段删；单文件模式删 R2_KEY。
     *
     * 之前只遍历 keys，而单文件走的是 SOURCE_URL、keys 为空，
     * 于是每个单文件任务的源文件都留在 R2 里再也没人清 ——
     * 免费额度 10GB 用满后所有上传都报 403，且完全看不出是空间问题。
     */
    if (keys.length) {
      for (const key of keys) {
        await deleteFromR2(key);
      }
    } else {
      await deleteFromR2(R2_KEY);
    }

    // 输出一段汇总，Actions 的 step summary 会抓这个
    console.log('\n=== TRANSCODE_RESULT ===');
    console.log(
      JSON.stringify({
        ok: true,
        remote,
        srcSize,
        outSize,
        task: TASK_ID,
        segments: keys.length || 1,
      }),
    );
    console.log('=== END ===');
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((e) => {
  /**
   * 失败时把「怎么重跑」打出来。
   *
   * 这里**不删 R2 上的分段** —— 删除逻辑只在上面的成功路径里。
   * 这是有意的：转码失败（超时、OOM、ffmpeg 崩）时，
   * R2 上的源分段是重跑的唯一依据，删了就永久丢失。
   *
   * 曾经踩过：一场 2.4 小时直播转码超时被取消，分段还在 R2，
   * 但主程序清理任务时把它们删了，于是没法重跑，直播彻底丢失。
   * 主程序那边已经加了保护（_disposeTask 不再删 failed 分段），
   * 这里再从 Actions 侧保证一次。
   */
  const keys = (process.env.R2_KEYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  console.log('\n=== TRANSCODE_RESULT ===');
  console.log(
    JSON.stringify({
      ok: false,
      error: String(e.message || e).slice(0, 500),
      task: process.env.TASK_ID || '',
      segments: keys.length || 1,
      // 关键：告诉主程序源文件还在，可以重跑
      sourcesKept: true,
      rerunKeys: keys.join(','),
    }),
  );
  console.log('=== END ===');

  console.log('\n源分段仍保留在 R2，可修复后重新触发：');
  if (keys.length) {
    console.log(`  分段数：${keys.length}`);
    console.log(`  重新触发时把 r2_keys 设成上面那串（已在上面的 rerunKeys 里）`);
  } else {
    console.log(`  单文件模式：${process.env.R2_KEY || '(未设置 R2_KEY)'}`);
  }

  process.exit(1);
});
