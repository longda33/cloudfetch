/**
 * 下载引擎：按链接类型分发到不同下载器。
 *
 * 设计要点：
 *  1. HTTP 直链 —— 支持 Range 分片并行下载，断点续传
 *  2. HLS (m3u8) —— 拉取分片列表，串行/有限并发下载并拼接，失败重试
 *  3. 直播流 (http-flv / rtmp) —— 单次长连接写盘，**不分段**；
 *     仅当连接中断时自动重连续写，实现"中途失败才分段"
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { detectKind, resolveFilename, humanSize } from './util/links.js';

/** 自定义可重试错误 */
class RetryableError extends Error {
  constructor(msg, retryAfter = 0) {
    super(msg);
    this.name = 'RetryableError';
    this.retryAfter = retryAfter;
  }
}
/** 不可重试（如 404、格式不支持） */
class FatalError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'FatalError';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 指数退避，带抖动 */
function backoff(attempt, base = config.retry.baseDelay, max = config.retry.maxDelay) {
  const exp = Math.min(base * Math.pow(2, attempt - 1), max);
  return Math.floor(exp * (0.7 + Math.random() * 0.6));
}

/**
 * 带重试地执行一个异步操作。
 * @param {object} opts
 * @param {string} opts.label 用于日志
 * @param {(ctx:{attempt:number})=>Promise<any>} opts.fn
 * @param {(msg:string)=>void} [opts.onRetry]
 */
async function withRetry({ label, fn, onRetry, maxAttempts = config.retry.maxAttempts, signal }) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw new FatalError('已取消');
    try {
      return await fn({ attempt });
    } catch (e) {
      lastErr = e;
      if (e instanceof FatalError || signal?.aborted) throw e;
      if (attempt >= maxAttempts) break;
      const wait = e.retryAfter ? e.retryAfter * 1000 : backoff(attempt);
      onRetry?.(`${label} 第 ${attempt} 次失败：${e.message}；${Math.round(wait / 1000)}s 后重试`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/** 探测远端信息：大小、是否支持 Range、文件名 */
async function probe(url, signal) {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), config.download.connectTimeout);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Range: 'bytes=0-0',
        'User-Agent': 'CloudFetch/1.0',
        Accept: '*/*',
      },
      signal: ac.signal,
      redirect: 'follow',
    });

    const headers = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });

    const total = (() => {
      const cr = headers['content-range'];
      if (cr) {
        const m = /\/(\d+)\s*$/.exec(cr);
        if (m) return Number(m[1]);
      }
      const cl = headers['content-length'];
      if (cl && res.status === 200) return Number(cl);
      return 0;
    })();

    const supportsRange = res.status === 206 || Boolean(headers['accept-ranges'] && headers['accept-ranges'] !== 'none');
    const filename = resolveFilename(url, headers);

    // 丢弃 body
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }

    return {
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      total,
      supportsRange,
      filename,
      contentType: headers['content-type'] || '',
      headers,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * HTTP 直链下载：分片并行 + 断点续传
 * @param {object} job 任务对象（可变，用于上报进度）
 */
async function downloadHttp(job, ctx) {
  const { url, signal } = ctx;
  const { onProgress, onLog } = ctx;

  const info = await probe(url, signal);
  if (info.status === 404) throw new FatalError('远端返回 404，文件不存在');
  if (info.status === 403) throw new FatalError('远端返回 403，无权限访问');
  if (info.status >= 400) throw new FatalError(`远端返回 ${info.status}`);

  const total = info.total;
  if (total > config.download.maxFileSize) {
    throw new FatalError(`文件 ${humanSize(total)} 超过上限 ${humanSize(config.download.maxFileSize)}`);
  }

  const finalName = ctx.filename || info.filename;
  const dest = path.join(ctx.dir, finalName);
  job.filename = finalName;
  job.total = total;
  job.supportsRange = info.supportsRange;
  onLog?.(`探测完成：${finalName}  ${total ? humanSize(total) : '未知大小'}  ${info.supportsRange ? '支持分段' : '不支持分段'}`);

  // 小文件或服务端不支持 Range：单流下载
  if (!info.supportsRange || total === 0 || total < config.download.chunkSize * 2) {
    await downloadSingleStream(url, dest, job, ctx, total);
    return { filePath: dest, filename: finalName, size: await sizeOf(dest) };
  }

  // 分片下载
  await downloadChunked(url, dest, job, ctx, total);
  return { filePath: dest, filename: finalName, size: await sizeOf(dest) };
}

/** 单流下载（无 Range），支持断点续传 */
async function downloadSingleStream(url, dest, job, ctx, expectedTotal) {
  const { signal, onProgress, onLog } = ctx;
  const partPath = dest + '.part';

  let startAt = 0;
  try {
    const st = await fsp.stat(partPath);
    startAt = st.size;
  } catch {
    startAt = 0;
  }

  const attemptTask = async () => {
    const headers = { 'User-Agent': 'CloudFetch/1.0', Accept: '*/*' };
    if (startAt > 0) headers.Range = `bytes=${startAt}-`;

    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    let idleTimer;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        onLog?.('数据流空闲超时，主动断开以触发重连');
        ac.abort();
      }, config.download.idleTimeout);
    };

    try {
      const res = await fetch(url, { headers, signal: ac.signal, redirect: 'follow' });
      if (res.status >= 400 && res.status !== 416) {
        if (res.status >= 500) throw new RetryableError(`HTTP ${res.status}`);
        throw new FatalError(`HTTP ${res.status}`);
      }
      if (res.status === 416) {
        // 已经下完了
        await fsp.rename(partPath, dest);
        return;
      }

      // 服务端忽略 Range 返回 200：只能从头写
      const appending = res.status === 206;
      const ws = fs.createWriteStream(partPath, { flags: appending ? 'a' : 'w' });
      if (!appending) startAt = 0;

      resetIdle();
      let written = startAt;

      try {
        for await (const chunk of res.body) {
          if (signal?.aborted) throw new FatalError('已取消');
          resetIdle();
          if (!ws.write(chunk)) {
            await new Promise((r) => ws.once('drain', r));
          }
          written += chunk.length;
          job.downloaded = written;
          onProgress?.(written, expectedTotal || written);
          if (written > config.download.maxFileSize) {
            throw new FatalError('超过文件大小上限');
          }
        }
      } finally {
        clearTimeout(idleTimer);
        await new Promise((r) => ws.end(r));
      }

      // 校验
      if (expectedTotal && written < expectedTotal) {
        throw new RetryableError(`连接提前结束（${humanSize(written)}/${humanSize(expectedTotal)}）`);
      }

      await fsp.rename(partPath, dest);
    } finally {
      clearTimeout(idleTimer);
      signal?.removeEventListener('abort', onAbort);
    }
  };

  await withRetry({
    label: '单流下载',
    fn: async () => {
      // 每轮重试前刷新已下载大小
      try {
        startAt = (await fsp.stat(partPath)).size;
      } catch {
        startAt = 0;
      }
      return attemptTask();
    },
    onRetry: (m) => onLog?.(m),
    signal,
  });
}

/** 分片并行下载 */
async function downloadChunked(url, dest, job, ctx, total) {
  const { signal, onProgress, onLog } = ctx;
  const { chunkSize, chunkConcurrency } = config.download;

  const chunkCount = Math.ceil(total / chunkSize);
  const partDir = dest + '.parts';
  await fsp.mkdir(partDir, { recursive: true });

  job.chunksTotal = chunkCount;
  onLog?.(`分片下载：${chunkCount} 片 × ${humanSize(chunkSize)}，并发 ${chunkConcurrency}`);

  let doneBytes = 0;
  const chunkSizes = new Array(chunkCount).fill(0);
  const chunkDone = new Array(chunkCount).fill(false);

  // 已有分片（断点续传）
  for (let i = 0; i < chunkCount; i++) {
    const p = path.join(partDir, `${i}.part`);
    try {
      const st = await fsp.stat(p);
      const expect = chunkEnd(i, total, chunkSize) - i * chunkSize;
      if (st.size === expect) {
        chunkSizes[i] = st.size;
        chunkDone[i] = true;
        doneBytes += st.size;
      }
    } catch {
      /* 没有就是没下 */
    }
  }
  if (doneBytes > 0) {
    onLog?.(`检测到已有分片，已续传 ${humanSize(doneBytes)}`);
    job.downloaded = doneBytes;
    onProgress?.(doneBytes, total);
  }

  const queue = [];
  for (let i = 0; i < chunkCount; i++) if (!chunkDone[i]) queue.push(i);

  let active = 0;
  let idx = 0;
  let failed = null;

  await new Promise((resolve, reject) => {
    const pump = () => {
      if (failed) return;
      if (idx >= queue.length && active === 0) return resolve();
      while (active < chunkConcurrency && idx < queue.length) {
        const ci = queue[idx++];
        active++;
        downloadOneChunk(ci).then(
          () => {
            active--;
            pump();
          },
          (e) => {
            active--;
            if (!failed) {
              failed = e;
              reject(e);
            }
          },
        );
      }
    };

    const downloadOneChunk = async (ci) => {
      const start = ci * chunkSize;
      const end = Math.min(start + chunkSize, total) - 1;
      const p = path.join(partDir, `${ci}.part`);

      await withRetry({
        label: `分片 ${ci + 1}/${chunkCount}`,
        signal,
        maxAttempts: 6,
        fn: async () => {
          let have = 0;
          try {
            have = (await fsp.stat(p)).size;
          } catch {
            have = 0;
          }
          const want = end - start + 1;
          if (have >= want) return;

          const ac = new AbortController();
          const onAbort = () => ac.abort();
          signal?.addEventListener('abort', onAbort, { once: true });

          let idle;
          const resetIdle = () => {
            clearTimeout(idle);
            idle = setTimeout(() => ac.abort(), config.download.idleTimeout);
          };

          try {
            const res = await fetch(url, {
              headers: {
                Range: `bytes=${start + have}-${end}`,
                'User-Agent': 'CloudFetch/1.0',
                Accept: '*/*',
              },
              signal: ac.signal,
            });
            if (res.status === 200) {
              // 服务端不支持 Range，降级为单流
              throw new FatalError('服务端不支持 Range，需改用单流下载');
            }
            if (res.status !== 206) {
              if (res.status >= 500) throw new RetryableError(`HTTP ${res.status}`);
              throw new FatalError(`HTTP ${res.status}`);
            }

            const ws = fs.createWriteStream(p, { flags: have > 0 ? 'a' : 'w' });
            let w = have;
            resetIdle();
            try {
              for await (const chunk of res.body) {
                if (signal?.aborted) throw new FatalError('已取消');
                resetIdle();
                if (!ws.write(chunk)) await new Promise((r) => ws.once('drain', r));
                w += chunk.length;
                doneBytes += chunk.length;
                job.downloaded = doneBytes;
                onProgress?.(doneBytes, total);
              }
            } finally {
              clearTimeout(idle);
              await new Promise((r) => ws.end(r));
            }
            if (w < want) throw new RetryableError(`分片不完整 ${w}/${want}`);
            chunkDone[ci] = true;
          } finally {
            clearTimeout(idle);
            signal?.removeEventListener('abort', onAbort);
          }
        },
        onRetry: (m) => onLog?.(m),
      });
    };

    pump();
  });

  if (failed) throw failed;

  // 合并分片
  onLog?.('合并分片...');
  const tmpOut = dest + '.merging';
  const ws = fs.createWriteStream(tmpOut);
  try {
    for (let i = 0; i < chunkCount; i++) {
      const p = path.join(partDir, `${i}.part`);
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(p);
        rs.on('error', reject);
        rs.on('end', resolve);
        rs.pipe(ws, { end: false });
      });
    }
  } finally {
    await new Promise((r) => ws.end(r));
  }

  await fsp.rename(tmpOut, dest);
  await fsp.rm(partDir, { recursive: true, force: true });
}

function chunkEnd(i, total, chunkSize) {
  return Math.min((i + 1) * chunkSize, total);
}

async function sizeOf(p) {
  try {
    return (await fsp.stat(p)).size;
  } catch {
    return 0;
  }
}

/**
 * HLS 下载：解析 m3u8，下载所有分片并拼接
 * 支持主播放列表（多码率）自动选最高码率
 */
async function downloadHls(job, ctx) {
  const { url, signal, onProgress, onLog } = ctx;
  const baseName = (ctx.filename || resolveFilename(url)).replace(/\.(m3u8)$/i, '') || 'hls';
  const finalName = baseName.endsWith('.ts') ? baseName : baseName + '.ts';
  const dest = path.join(ctx.dir, finalName);
  job.filename = finalName;

  const playlist = await fetchText(url, signal);
  let mediaUrl = url;
  let mediaText = playlist;

  // 主播放列表：含 EXT-X-STREAM-INF
  if (/#EXT-X-STREAM-INF/i.test(playlist)) {
    const variants = parseVariants(playlist, url);
    if (variants.length) {
      variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
      mediaUrl = variants[0].url;
      onLog?.(`主播放列表含 ${variants.length} 个码率，选用最高 ${Math.round((variants[0].bandwidth || 0) / 1000)}kbps`);
      mediaText = await fetchText(mediaUrl, signal);
    }
  }

  if (!/#EXTINF/i.test(mediaText)) {
    throw new FatalError('不是有效的 HLS 媒体播放列表（可能是直播中或格式异常）');
  }

  const segs = parseSegments(mediaText, mediaUrl);
  if (!segs.length) throw new FatalError('播放列表里没有分片');

  onLog?.(`共 ${segs.length} 个分片，开始下载`);
  job.chunksTotal = segs.length;

  const partDir = dest + '.segs';
  await fsp.mkdir(partDir, { recursive: true });

  let doneBytes = 0;
  let doneCount = 0;
  const conc = 4;
  let cursor = 0;
  let failed = null;

  const worker = async () => {
    while (true) {
      if (failed || signal?.aborted) return;
      const i = cursor++;
      if (i >= segs.length) return;
      const seg = segs[i];
      const p = path.join(partDir, String(i).padStart(6, '0') + '.ts');

      try {
        const sz = await withRetry({
          label: `分片 ${i + 1}/${segs.length}`,
          signal,
          maxAttempts: 6,
          fn: async () => {
            try {
              const st = await fsp.stat(p);
              if (st.size > 0) return st.size;
            } catch {
              /* ignore */
            }
            return await fetchToFile(seg.url, p, signal, seg.byteRange);
          },
          onRetry: (m) => onLog?.(m),
        });
        doneBytes += sz;
        doneCount++;
        job.downloaded = doneBytes;
        job.chunksDone = doneCount;
        onProgress?.(doneBytes, 0);
      } catch (e) {
        failed = e;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(conc, segs.length) }, worker));
  if (failed) throw failed;
  if (signal?.aborted) throw new FatalError('已取消');

  onLog?.('拼接分片...');
  const tmpOut = dest + '.concat';
  const ws = fs.createWriteStream(tmpOut);
  try {
    for (let i = 0; i < segs.length; i++) {
      const p = path.join(partDir, String(i).padStart(6, '0') + '.ts');
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(p);
        rs.on('error', reject);
        rs.on('end', resolve);
        rs.pipe(ws, { end: false });
      });
    }
  } finally {
    await new Promise((r) => ws.end(r));
  }

  await fsp.rename(tmpOut, dest);
  await fsp.rm(partDir, { recursive: true, force: true });

  return { filePath: dest, filename: finalName, size: await sizeOf(dest) };
}

function parseVariants(text, baseUrl) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^#EXT-X-STREAM-INF/i.test(l)) {
      const bw = /BANDWIDTH=(\d+)/i.exec(l);
      const res = /RESOLUTION=(\d+x\d+)/i.exec(l);
      // 下一非注释行是 URL
      for (let j = i + 1; j < lines.length; j++) {
        const n = lines[j].trim();
        if (!n || n.startsWith('#')) continue;
        out.push({
          url: new URL(n, baseUrl).href,
          bandwidth: bw ? Number(bw[1]) : 0,
          resolution: res ? res[1] : '',
        });
        break;
      }
    }
  }
  return out;
}

function parseSegments(text, baseUrl) {
  const out = [];
  const lines = text.split(/\r?\n/);
  let pendingRange = null;
  let pendingDur = 0;

  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (/^#EXT-X-BYTERANGE:/i.test(l)) {
      const m = /^#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?/i.exec(l);
      if (m) pendingRange = { length: Number(m[1]), offset: m[2] ? Number(m[2]) : null };
      continue;
    }
    if (/^#EXTINF:/i.test(l)) {
      const m = /^#EXTINF:\s*([\d.]+)/i.exec(l);
      pendingDur = m ? Number(m[1]) : 0;
      continue;
    }
    if (l.startsWith('#')) continue;

    out.push({
      url: new URL(l, baseUrl).href,
      duration: pendingDur,
      byteRange: pendingRange,
    });
    pendingRange = null;
    pendingDur = 0;
  }
  return out;
}

async function fetchText(url, signal) {
  return withRetry({
    label: '获取播放列表',
    signal,
    fn: async () => {
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => ac.abort(), config.download.connectTimeout);
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'CloudFetch/1.0', Accept: '*/*' },
          signal: ac.signal,
          redirect: 'follow',
        });
        if (res.status >= 500) throw new RetryableError(`HTTP ${res.status}`);
        if (res.status >= 400) throw new FatalError(`播放列表 HTTP ${res.status}`);
        return await res.text();
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    },
  });
}

async function fetchToFile(url, dest, signal, byteRange) {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  let idle;
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ac.abort(), config.download.idleTimeout);
  };

  try {
    const headers = { 'User-Agent': 'CloudFetch/1.0', Accept: '*/*' };
    if (byteRange && byteRange.length) {
      const s = byteRange.offset ?? 0;
      headers.Range = `bytes=${s}-${s + byteRange.length - 1}`;
    }
    const res = await fetch(url, { headers, signal: ac.signal, redirect: 'follow' });
    if (res.status >= 500) throw new RetryableError(`HTTP ${res.status}`);
    if (res.status >= 400) throw new FatalError(`分片 HTTP ${res.status}`);

    resetIdle();
    const ws = fs.createWriteStream(dest);
    let n = 0;
    try {
      for await (const chunk of res.body) {
        resetIdle();
        if (!ws.write(chunk)) await new Promise((r) => ws.once('drain', r));
        n += chunk.length;
      }
    } finally {
      clearTimeout(idle);
      await new Promise((r) => ws.end(r));
    }
    if (n === 0) throw new RetryableError('分片为空');
    return n;
  } finally {
    clearTimeout(idle);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * 直播流下载（http-flv / rtmp）
 *
 * 关键行为：**不分段**。一次连接写一个文件，直到流结束或取消。
 * 只有连接意外中断时，才把已下内容另存为分片并重连续写新文件，
 * 最后由 mergeLiveParts 合并——这样既保证正常情况是单个完整文件，
 * 又能在源不稳定时避免整段丢失。
 */
async function downloadLive(job, ctx) {
  const { url, signal, onProgress, onLog } = ctx;
  const kind = detectKind(url);
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const baseName = (ctx.filename || `live_${ts}`).replace(/\.[a-z0-9]+$/i, '');
  const ext = kind === 'rtmp' ? 'flv' : guessLiveExt(url);
  const finalName = `${baseName}.${ext}`;
  const dest = path.join(ctx.dir, finalName);
  job.filename = finalName;
  job.live = true;

  const parts = [];
  let attempt = 0;
  let emptyStreak = 0;
  let partIndex = 0;

  // 已完成分段的总字节数（用于进度展示）。
  // 不能用增量累加，否则重试/重连会把同一批数据重复计入。
  // 每轮结束后以 parts 里各文件的真实大小为准重算。
  const recount = async () => {
    let sum = 0;
    for (const p of parts) sum += await sizeOf(p);
    job.downloaded = sum;
    onProgress?.(sum, 0);
    return sum;
  };

  while (true) {
    if (signal?.aborted) break;
    attempt++;

    const partPath = parts.length === 0 ? dest + '.live0' : dest + `.live${partIndex}`;
    partIndex++;
    onLog?.(`直播连接 #${attempt} → ${path.basename(partPath)}`);

    // 本轮起点：已完成分段总大小
    let baseBytes = 0;
    for (const p of parts) baseBytes += await sizeOf(p);

    // 进度以「磁盘上已落盘的字节」为准，避免写流缓冲区导致的虚高。
    // 每 500ms 采样一次当前分段文件大小。
    let sampler = null;
    try {
      sampler = setInterval(() => {
        fs.stat(partPath, (err, st) => {
          if (!err && st.size > 0) {
            job.downloaded = baseBytes + st.size;
            onProgress?.(job.downloaded, 0);
          }
        });
      }, 500);

      await streamOnce(url, partPath, signal, () => {}, onLog);
    } catch (e) {
      if (signal?.aborted) break;
      onLog?.(`连接中断：${e.message}`);
    } finally {
      if (sampler) clearInterval(sampler);
    }

    const sz = await sizeOf(partPath);
    if (sz > 0) {
      parts.push(partPath);
      emptyStreak = 0;
      onLog?.(`本次收到 ${humanSize(sz)}`);
      await recount();
    } else {
      await fsp.rm(partPath, { force: true });
      emptyStreak++;
      onLog?.(`本次无数据（连续 ${emptyStreak}/${config.retry.liveMaxEmptyRetries}）`);
      if (emptyStreak >= config.retry.liveMaxEmptyRetries) {
        if (parts.length === 0) throw new FatalError('连续多次未收到任何数据，直播可能已结束或地址无效');
        onLog?.('连续无数据，判定直播已结束');
        break;
      }
    }

    // 直播是无限流：正常读到结束说明源已关闭，稍等再试；已有数据且再次无数据则收尾
    if (parts.length > 0 && sz === 0 && emptyStreak >= 2) break;

    await sleep(config.retry.liveReconnectDelay);
  }

  if (parts.length === 0) throw new FatalError('未下载到任何数据');

  // 合并所有分段（含正常结束的单段）
  if (parts.length === 1) {
    await fsp.rename(parts[0], dest);
  } else {
    onLog?.(`合并 ${parts.length} 个分段...`);
    await mergeFiles(parts, dest);
    for (const p of parts) await fsp.rm(p, { force: true });
  }

  return { filePath: dest, filename: finalName, size: await sizeOf(dest), parts: parts.length };
}

function guessLiveExt(url) {
  const s = url.toLowerCase();
  if (s.includes('.m3u8')) return 'ts';
  return 'flv';
}

/**
 * 判断一个 HTTP 地址是否其实是直播流。
 * 判据：响应头是流式视频类型，且没有 Content-Length。
 * 只要满足就按直播处理——普通视频文件一定有 Content-Length（或分块但有确定终点）。
 */
async function looksLikeLiveStream(url, signal) {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), 15000);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'CloudFetch/1.0', Accept: '*/*' },
      signal: ac.signal,
      redirect: 'follow',
    });

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const cl = res.headers.get('content-length');
    const te = (res.headers.get('transfer-encoding') || '').toLowerCase();

    // 立刻释放连接，不读 body
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }

    if (res.status >= 400) return false;

    const streamish =
      ct.includes('video/x-flv') ||
      ct.includes('flv') ||
      ct.includes('mp2t') ||
      ct.includes('mpegts') ||
      ct.includes('event-stream') ||
      ct.includes('octet-stream-live');

    // 流式类型 + 无长度 = 直播
    if (streamish && !cl) return true;
    // 有 chunked 且无长度，且是视频类型，也当直播
    if (streamish && te.includes('chunked') && !cl) return true;

    return false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** 单次直播连接，写入指定文件，返回收到字节数 */
function streamOnce(url, destPath, signal, onBytes, onLog) {
  return new Promise((resolve, reject) => {
    if (detectKind(url) === 'rtmp') {
      return rtmpOnce(url, destPath, signal, onBytes, resolve, reject, onLog);
    }
    httpFlvOnce(url, destPath, signal, onBytes, resolve, reject, onLog);
  });
}

async function httpFlvOnce(url, destPath, signal, onBytes, resolve, reject, onLog) {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  let idle;
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      onLog?.('直播流空闲超时，重连');
      ac.abort();
    }, config.download.idleTimeout);
  };

  let got = 0;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'CloudFetch/1.0', Accept: '*/*' },
      signal: ac.signal,
      redirect: 'follow',
    });
    if (res.status >= 400) {
      throw new Error(`HTTP ${res.status}`);
    }

    resetIdle();
    const ws = fs.createWriteStream(destPath);
    try {
      for await (const chunk of res.body) {
        if (signal?.aborted) break;
        resetIdle();
        if (!ws.write(chunk)) await new Promise((r) => ws.once('drain', r));
        got += chunk.length;
        onBytes(chunk.length);
      }
    } finally {
      clearTimeout(idle);
      await new Promise((r) => ws.end(r));
    }
    resolve(got);
  } catch (e) {
    reject(e);
  } finally {
    clearTimeout(idle);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** rtmp 走 ffmpeg */
function rtmpOnce(url, destPath, signal, onBytes, resolve, reject, onLog) {
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-i', url,
    '-c', 'copy',
    '-f', 'flv',
    '-y', destPath,
  ];
  const child = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });

  let got = 0;
  const timer = setInterval(() => {
    // 通过文件大小估算进度
    fs.stat(destPath, (err, st) => {
      if (!err && st.size > got) {
        const delta = st.size - got;
        got = st.size;
        onBytes(delta);
      }
    });
  }, 1000);

  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  const kill = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  };
  signal?.addEventListener('abort', kill, { once: true });

  child.on('error', (e) => {
    clearInterval(timer);
    signal?.removeEventListener('abort', kill);
    reject(new Error(`ffmpeg 启动失败：${e.message}（是否未安装 ffmpeg？）`));
  });

  child.on('close', (code) => {
    clearInterval(timer);
    signal?.removeEventListener('abort', kill);
    if (signal?.aborted) return resolve(got);
    if (code === 0) return resolve(got);
    onLog?.(`ffmpeg 退出码 ${code}`);
    if (got > 0) return resolve(got);
    reject(new Error(`ffmpeg 异常退出（${code}）${stderr.slice(-300)}`));
  });
}

/** 二进制拼接文件 */
async function mergeFiles(files, dest) {
  const ws = fs.createWriteStream(dest);
  try {
    for (const f of files) {
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(f);
        rs.on('error', reject);
        rs.on('end', resolve);
        rs.pipe(ws, { end: false });
      });
    }
  } finally {
    await new Promise((r) => ws.end(r));
  }
}

/**
 * 统一入口
 * @param {object} job 任务对象
 * @param {object} ctx { url, dir, filename, signal, onProgress, onLog }
 */
export async function runDownload(job, ctx) {
  const kind = detectKind(ctx.url);
  job.kind = kind;

  // HTTP 地址可能其实是直播流（http-flv）。特征：
  //   Content-Type 为 video/x-flv、video/mp2t 等流式类型
  //   且没有 Content-Length（无限流）
  // 这类必须走直播逻辑（单文件长连接 + 断流重连），
  // 否则会被当普通文件，进度按已下载量当总量，且不会重连。
  if (kind === 'http') {
    const live = await looksLikeLiveStream(ctx.url, ctx.signal);
    if (live) {
      job.kind = 'live';
      ctx.onLog?.('检测到直播流（FLV/TS 流式响应且无固定长度），切换为直播模式');
      return await downloadLive(job, ctx);
    }
  }

  switch (kind) {
    case 'http':
      return await downloadHttp(job, ctx);
    case 'hls':
      return await downloadHls(job, ctx);
    case 'rtmp':
      return await downloadLive(job, ctx);
    case 'dash':
      throw new FatalError('暂不支持 DASH (.mpd) 格式');
    default:
      // 未知协议，按直播流处理（http-flv 等无扩展名地址）
      if (/^https?:/i.test(ctx.url)) {
        return await downloadLive(job, ctx);
      }
      throw new FatalError(`无法识别的链接类型：${ctx.url.slice(0, 80)}`);
  }
}

export { RetryableError, FatalError };
