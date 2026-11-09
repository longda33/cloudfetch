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
  CRF = '18',
  PRESET = 'ultrafast',
  /**
   * 编码线程数。0 = 不传 `-threads`，交给 libx264 按自己探测的核数决定。
   *
   * 这里以前硬编码 4，理由是「GitHub runner 4 核」—— 实测标准 runner
   * 是 **2 核**。4 线程跑在 2 核上属于超订，只会多出上下文切换和
   * 帧缓冲延迟，不会有任何加速。x264 探测到的线程数和 nproc 一致，
   * 交给它比自己猜准。
   */
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

async function transcode(input, output) {
  const threads = String(THREADS);

  const probe = await probeFrameRate(input);
  if (probe.r || probe.avg) {
    log(`源视频：codec=${probe.codec} r_frame_rate=${probe.r} avg_frame_rate=${probe.avg}`);
  }
  /**
   * 假帧率告警。
   *
   * 真实内容约 20fps，而容器声称 1000fps —— 这正是历史上那次
   * 5 小时超时的直接原因。看到这条日志就说明源文件又是老样子，
   * 下面的 `-fps_mode passthrough` 会兜住它，但值得留个记录。
   */
  const claimed = Number(String(probe.r).split('/')[0]) / (Number(String(probe.r).split('/')[1]) || 1);
  if (claimed > 120) {
    log(`⚠️ 容器声称 ${probe.r} fps（明显是假帧率），已用 -fps_mode passthrough 忽略它`);
  }

  log(`转码：H.264 + AAC，CRF ${CRF}，preset ${PRESET}，threads ${threads === '0' ? '自动' : threads}`);

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-stats',
    '-i', input,
    /**
     * ★ 这一行是整个转码链路最关键的一行，不要删。
     *
     * 不加它时，ffmpeg 会走默认的 `-fps_mode auto`：对 MP4 这种
     * 「按帧率播放」的容器，auto 会解析成 CFR，并拿输入流声明的
     * r_frame_rate 当目标帧率。直播 FLV 声称 1000fps，实际只有 20fps，
     * 于是 ffmpeg 每秒补 980 个重复帧 —— 编码器做了 50 倍无用功。
     *
     * 实测（720x1280，同 3 段合并样本，4 核）：
     *   CFR 模式：frame=10000 dup=9837 speed=0.472x  ← 和线上 0.452x 一致
     *   passthrough：frame=187   dup=0     speed=15.9x
     * 同样 10 秒输出，相差 33 倍。
     *
     * passthrough 的意思是「每帧用自己的 PTS，不补不丢」，输出是 VFR
     * MP4。MP4 的 stts 表本来就支持变帧率，播放器按 PTS 走，观感与源一致。
     *
     * 注意：**不要**用 `setpts=N/(25*TB)` 之类的办法重排时间戳来「修」
     * 这个问题。源是变帧率（实测约 19.8fps），按 25fps 等距重排会让
     * 画面比声音快 1.26 倍，音画越播越不同步（实测 90s 素材：视频
     * 71.7s / 音频 90.1s，结尾差 18 秒）。
     */
    '-fps_mode', 'passthrough',
    // 视频：libx264，yuv420p 保证兼容性（手机/浏览器/电视都能播）
    '-c:v', 'libx264',
    '-preset', PRESET,
    '-crf', String(CRF),
    '-pix_fmt', 'yuv420p',
    /**
     * 强制 limited range。
     *
     * 源 FLV 若带 full range 标记（yuvj420p），直接转出来会保留
     * yuvj420p，部分电视和旧手机按 full range 解读会偏灰或偏艳。
     * 显式声明 tv 范围可以让输出稳定在标准 yuv420p。
     */
    '-color_range', 'tv',
    // 偶数宽高，否则部分播放器会花屏
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    // 音频：AAC 128k
    '-c:a', 'aac',
    '-b:a', '128k',
    // 关键帧间隔 2 秒左右，方便拖动进度条
    '-g', '50',
    '-keyint_min', '50',
    // faststart 把索引移到文件头，浏览器可以边下边播
    '-movflags', '+faststart',
  ];

  // 0 表示不干预，让 x264 自己按核数开线程
  if (threads !== '0') args.push('-threads', threads);
  args.push('-y', output);

  await run('ffmpeg', args);
  const sz = await sizeOf(output);
  if (sz === 0) fail('转码输出是 0 字节');
  log(`转码完成：${humanSize(sz)}`);
  return sz;
}

// ---------------- 2b. 合并多段 + 转码 ----------------
/**
 * 把 N 个分段合并成一个 MP4 并转码。
 *
 * 两步走：
 *   1) ffmpeg concat demuxer 把分段拼成一个 FLV（-c copy，不解码，很快）
 *   2) 再对这个 FLV 做 H.264 + AAC 转码
 *
 * 为什么不一步到位（concat + 转码同时做）：
 *   concat demuxer 配合 -c copy 只是重新封装，几乎不耗 CPU；
 *   分成两步后，如果转码失败，合并好的中间文件还在，方便排查。
 *   而且两步的日志更清晰，能看出是"拼接"还是"转码"出的问题。
 */
async function mergeAndTranscode(parts, workDir, output) {
  if (parts.length === 1) {
    // 只有一段，不用合并
    return transcode(parts[0], output);
  }

  log(`合并 ${parts.length} 个分段…`);

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

  const merged = path.join(workDir, 'merged.flv');
  await run('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'warning',
    '-stats',
    /**
     * +genpts 放在输入侧，只在这里用一次。
     *
     * 它的作用是在读包时补出缺失的 PTS。实测源分段的 PTS 是**存在**的
     * （只是间隔抖动，属于变帧率），所以这行其实不改变什么，留着是
     * 为了万一某个分段真的丢了 PTS 时不至于整场失败。
     *
     * 注意：它**不能**解决「转码慢」的问题 —— 慢的根因是输出侧在补帧，
     * 和 PTS 缺失无关。真正管用的是 transcode() 里的 `-fps_mode passthrough`。
     */
    '-fflags', '+genpts',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    /**
     * 把负时间戳平移到 0。
     *
     * concat demuxer 会按每个分段的**实际末帧 PTS** 给下一段加偏移，
     * 所以各段虽然都从 0 开始，拼起来仍然是连续的（实测 0.18 → 30.23
     * → 60.35 → 90.07，无重叠）。这里只是兜住个别分段首帧为负的情况。
     */
    '-avoid_negative_ts', 'make_zero',
    // 不解码，只重新封装
    '-c', 'copy',
    '-y',
    merged,
  ]);

  const mergedSize = await sizeOf(merged);
  if (mergedSize === 0) fail('合并输出是 0 字节');
  log(`合并完成：${humanSize(mergedSize)}`);

  // 合并完就把分段删掉，给转码腾出磁盘空间
  // （runner 有 14GB，但一场 3 小时直播的分段加起来能到 1-2GB，
  //   加上转码输出的中间文件，早点清更安全）
  for (const p of parts) {
    await fsp.rm(p, { force: true }).catch(() => {});
  }

  return transcode(merged, output);
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
