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

const {
  SOURCE_URL = '',
  R2_KEY = '',
  OUT_NAME = 'output.mp4',
  OPENLIST_DIR = '',
  CRF = '23',
  PRESET = 'veryfast',
  TASK_ID = '',
  SEG_INDEX = '0',
  // OpenList 凭据
  OPENLIST_URL = '',
  OPENLIST_TOKEN = '',
  // 可选：转完删掉 R2 里的源文件
  R2_DELETE_AFTER = 'true',
  // R2 凭据（用于删除，可选）
  R2_ACCOUNT_ID = '',
  R2_ACCESS_KEY_ID = '',
  R2_SECRET_ACCESS_KEY = '',
  R2_BUCKET = '',
  R2_ENDPOINT = '',
} = process.env;

const log = (...a) => console.log(`[transcode]`, ...a);
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
  const res = await fetch(url, { redirect: 'follow' });
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
  log(`下载完成：${humanSize(written)}`);
  return written;
}

// ---------------- 2. 转码 ----------------
async function transcode(input, output) {
  log(`转码：H.264 + AAC，CRF ${CRF}，preset ${PRESET}`);

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-stats',
    '-i', input,
    // 视频：libx264，yuv420p 保证兼容性（手机/浏览器/电视都能播）
    '-c:v', 'libx264',
    '-preset', PRESET,
    '-crf', String(CRF),
    '-pix_fmt', 'yuv420p',
    // 偶数宽高，否则部分播放器会花屏
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    // 音频：AAC 128k
    '-c:a', 'aac',
    '-b:a', '128k',
    // 关键帧间隔 2 秒，方便拖动进度条
    '-g', '50',
    '-keyint_min', '50',
    // faststart 把索引移到文件头，浏览器可以边下边播
    '-movflags', '+faststart',
    '-y',
    output,
  ];

  await run('ffmpeg', args);
  const sz = await sizeOf(output);
  if (sz === 0) fail('转码输出是 0 字节');
  log(`转码完成：${humanSize(sz)}`);
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
    const res = await fetch(`${OPENLIST_URL.replace(/\/+$/, '')}/api/fs/put`, {
      method: 'PUT',
      headers: {
        Authorization: OPENLIST_TOKEN,
        'File-Path': encodeURIComponent(remotePath),
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(buf.length),
      },
      body: buf,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      fail(`OpenList PUT 失败：HTTP ${res.status} ${t.slice(0, 300)}`);
    }
    log('上传完成（单请求）');
    return remotePath;
  }

  // 大文件走分片协议
  const base = OPENLIST_URL.replace(/\/+$/, '');
  const auth = { Authorization: OPENLIST_TOKEN };

  const initRes = await fetch(`${base}/api/fs/multipart/init`, {
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
  if (!initRes.ok) {
    const t = await initRes.text().catch(() => '');
    fail(`multipart init 失败：HTTP ${initRes.status} ${t.slice(0, 300)}`);
  }
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
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);

      // 分片可能因为网络抖动失败，重试 3 次
      let ok = false;
      let lastErr = '';
      for (let attempt = 1; attempt <= 3; attempt++) {
        const r = await fetch(`${base}/api/fs/multipart/chunk`, {
          method: 'PUT',
          headers: {
            ...auth,
            'X-Upload-Id': uploadId,
            'X-Chunk-Index': String(i),
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(len),
          },
          body: buf,
        });
        if (r.ok) {
          ok = true;
          break;
        }
        lastErr = `HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`;
        if (r.status === 409 || r.status === 429) {
          await new Promise((res) => setTimeout(res, 1000 * attempt));
        } else {
          break;
        }
      }
      if (!ok) fail(`第 ${i + 1}/${totalChunks} 片上传失败：${lastErr}`);
      log(`  分片 ${i + 1}/${totalChunks} 完成`);
    }
  } finally {
    await fh.close();
  }

  const doneRes = await fetch(`${base}/api/fs/multipart/complete`, {
    method: 'POST',
    headers: { ...auth, 'X-Upload-Id': uploadId, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!doneRes.ok) {
    const t = await doneRes.text().catch(() => '');
    fail(`multipart complete 失败：HTTP ${doneRes.status} ${t.slice(0, 300)}`);
  }

  log('上传完成（分片）');
  return remotePath;
}

// ---------------- 4. 清理 R2 ----------------
async function deleteFromR2(key) {
  if (R2_DELETE_AFTER !== 'true' || !key) return;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
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

// ---------------- 主流程 ----------------
async function main() {
  if (!SOURCE_URL) fail('缺少 SOURCE_URL');
  if (!OPENLIST_DIR) fail('缺少 OPENLIST_DIR');

  log('参数：', {
    out: OUT_NAME,
    crf: CRF,
    preset: PRESET,
    task: TASK_ID,
    seg: SEG_INDEX,
    openlistDir: OPENLIST_DIR,
  });

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cf-transcode-'));
  // 输入保持 .flv 后缀，ffmpeg 靠后缀和探测双重判断
  const input = path.join(workDir, 'input.flv');
  const output = path.join(workDir, OUT_NAME.replace(/[^\w.\-]/g, '_') || 'output.mp4');

  try {
    const srcSize = await download(SOURCE_URL, input);
    const outSize = await transcode(input, output);

    const ratio = srcSize ? ((outSize / srcSize) * 100).toFixed(1) : '?';
    log(`体积：${humanSize(srcSize)} → ${humanSize(outSize)}（${ratio}%）`);

    const remote = await uploadToOpenList(output, OPENLIST_DIR);
    await deleteFromR2(R2_KEY);

    // 输出一段汇总，Actions 的 step summary 会抓这个
    console.log('\n=== TRANSCODE_RESULT ===');
    console.log(JSON.stringify({ ok: true, remote, srcSize, outSize, task: TASK_ID, seg: SEG_INDEX }));
    console.log('=== END ===');
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((e) => fail(e.stack || e.message));
