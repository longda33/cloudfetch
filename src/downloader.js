/**
 * 下载引擎：按链接类型分发到不同下载器。
 *
 * 设计要点：
 *  1. HTTP 直链 —— 支持 Range 分片并行下载，断点续传
 *  2. HLS (m3u8) —— 拉取分片列表，串行/有限并发下载并拼接，失败重试；
 *     加密（EXT-X-KEY）与 fMP4（EXT-X-MAP）转交 ffmpeg
 *  3. DASH (mpd) —— 同样交给 ffmpeg（SegmentTemplate / 音视频分离 / init 段）
 *  4. 直播流 (http-flv / rtmp) —— 单次长连接写盘，**不分段**；
 *     仅当连接中断时自动重连续写，实现"中途失败才分段"
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { detectKind, resolveFilename, humanSize, fmtRate } from './util/links.js';
import { openWriter, pipeInto } from './util/writer.js';

/**
 * 跟踪所有 ffmpeg 子进程。
 * 进程退出时如果不主动杀掉，本地 `npm start` 重启一次就会留下一个孤儿进程
 * 继续往磁盘写数据。
 */
const children = new Set();

function spawnTracked(cmd, args, opts) {
  const child = spawn(cmd, args, opts);
  children.add(child);
  child.once('close', () => children.delete(child));
  child.once('error', () => children.delete(child));
  return child;
}

/** 杀掉所有在跑的子进程（供 server 优雅退出调用） */
export function killAllChildren() {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  children.clear();
}

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

/**
 * 已取消就立刻抛，不要等到网络超时。
 *
 * 为什么需要这个：`signal.addEventListener('abort', ...)` 只对"将来"的 abort 生效。
 * 如果 signal 在进入这个函数之前就已经 abort 了（比如用户在上一个网络请求
 * 还没返回时就点了取消），监听器永远不会触发，fetch 会一直等到 connectTimeout
 * 才失败 —— 表现为「点了取消，任务还卡在正在停止…几十秒」。
 */
function ensureNotAborted(signal) {
  if (signal?.aborted) throw new FatalError('已取消');
}

/** 注册 abort 回调；若 signal 已经 abort 过，立即执行一次（addEventListener 不会补发） */
function onAbortOnce(signal, fn) {
  if (!signal) return;
  if (signal.aborted) {
    fn();
    return;
  }
  signal.addEventListener('abort', fn, { once: true });
}

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
  ensureNotAborted(signal);
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
      const w = openWriter(partPath, appending ? 'a' : 'w');
      if (!appending) startAt = 0;

      resetIdle();
      let written = startAt;
      let stopped = false;
      let endErr = null;

      try {
        for await (const chunk of res.body) {
          if (signal?.aborted) {
            stopped = true;
            break;
          }
          resetIdle();
          await w.write(chunk);
          written += chunk.length;
          job.downloaded = written;
          onProgress?.(written, expectedTotal || written);
          if (written > config.download.maxFileSize) {
            throw new FatalError('超过文件大小上限');
          }
        }
      } catch (e) {
        /**
         * 关键：abort 时 for-await 会直接抛 AbortError，根本走不到上面的 break。
         *
         * onAbort 监听器调用的是本函数内部的 ac.abort()，而 res.body 用的就是
         * 这个 ac，所以信号一触发，流本身就报错了。之前没接这个异常，
         * 于是「停止」被当成失败，已下载的部分被整个丢掉。
         * 这里把「因为用户停止而抛的错」转成正常收尾。
         */
        if (signal?.aborted) {
          stopped = true;
        } else {
          throw e;
        }
      } finally {
        clearTimeout(idleTimer);
        // end 的失败（如 ENOSPC 落盘失败）不能吞，否则会 rename 出一个截断的文件
        try {
          await w.end();
        } catch (e) {
          endErr = e;
        }
      }

      if (endErr && !stopped) throw endErr;

      // 用户主动停止：把已下载的部分当作完成，不做长度校验
      if (stopped) {
        if (written > 0) {
          await fsp.rename(partPath, dest);
          onLog?.(`已停止，保留已下载的 ${humanSize(written)}`);
          return;
        }
        throw new FatalError('已取消');
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
          if (have === want) return;
          /**
           * 分片文件比预期还大，说明它是上一次用不同 CHUNK_SIZE 跑出来的残留。
           * 直接当成"已下完"会让合并后的文件偏大且内容错位，必须清掉重下。
           */
          if (have > want) {
            await fsp.truncate(p, 0).catch(() => {});
            have = 0;
          }

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

            const w = openWriter(p, have > 0 ? 'a' : 'w');
            let written = have;
            let endErr = null;
            resetIdle();
            try {
              for await (const chunk of res.body) {
                if (signal?.aborted) throw new FatalError('已取消');
                resetIdle();
                await w.write(chunk);
                written += chunk.length;
                doneBytes += chunk.length;
                job.downloaded = doneBytes;
                onProgress?.(doneBytes, total);
              }
            } finally {
              clearTimeout(idle);
              try {
                await w.end();
              } catch (e) {
                endErr = e;
              }
            }
            if (endErr) throw endErr;
            if (written < want) throw new RetryableError(`分片不完整 ${written}/${want}`);
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

  // 合并分片（pump 里已经 reject 过了，这里不再重复判断 failed）
  onLog?.('合并分片...');
  const tmpOut = dest + '.merging';
  const w = openWriter(tmpOut);
  try {
    for (let i = 0; i < chunkCount; i++) {
      await pipeInto(w, path.join(partDir, `${i}.part`));
    }
  } catch (e) {
    w.destroy();
    await fsp.rm(tmpOut, { force: true }).catch(() => {});
    throw e;
  }
  await w.end();

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
 * 判断 HLS 播放列表是否必须交给 ffmpeg。
 *
 *  - EXT-X-KEY（METHOD 不是 NONE）：分片是 AES-128 加密的，
 *    直接拼接得到的是密文，文件能生成但根本播不了
 *  - EXT-X-MAP：fMP4 格式，分片是 .m4s，必须先拼 init 段才能解码
 *
 * 这两种自己实现成本高、坑多（密钥轮换、IV 推导、init 段顺序），
 * 而 ffmpeg 本来就处理得很完整。
 */
export function hlsNeedsFfmpeg(text) {
  if (/^#EXT-X-KEY:(?!.*METHOD=NONE)/im.test(text)) return true;
  if (/^#EXT-X-MAP:/im.test(text)) return true;
  return false;
}

/**
 * 用 ffmpeg 直接拉取一个流/清单到单个文件。
 *
 * 用于 DASH、加密 HLS、fMP4 —— 这些格式的解析与解密交给 ffmpeg 更稳。
 * 进度只能按已写盘大小估算（总长度未知），前端会显示为不确定态进度条。
 */
async function downloadViaFfmpeg(job, ctx, opts) {
  const { signal, onProgress, onLog } = ctx;
  const { formats, hls = false } = opts;
  const target = opts.url || ctx.url;

  const rawName = (ctx.filename || opts.baseName || 'download').replace(/\.[a-z0-9]+$/i, '');
  job.live = false;
  job.segmentSeconds = 0;

  let lastErr = null;
  for (const fmt of formats) {
    ensureNotAborted(signal);
    const outName = `${rawName}${fmt.ext}`;
    const outPath = path.join(ctx.dir, outName);
    job.filename = outName;

    onLog?.(`ffmpeg 拉流（${fmt.label}）→ ${outName}`);

    const sampler = setInterval(() => {
      fs.stat(outPath, (err, st) => {
        if (!err && st.size > 0) {
          job.downloaded = st.size;
          onProgress?.(st.size, 0);
        }
      });
    }, 1000);

    try {
      await runFfmpegPull({ url: target, outPath, signal, hls, format: fmt, onLog });
    } catch (e) {
      clearInterval(sampler);
      lastErr = e;
      await fsp.rm(outPath, { force: true }).catch(() => {});
      if (signal?.aborted) throw e;
      onLog?.(`ffmpeg 拉流失败（${e.message}），尝试下一种封装`);
      continue;
    }
    clearInterval(sampler);

    const size = await sizeOf(outPath);
    if (size <= 0) {
      lastErr = new Error('ffmpeg 未产出任何数据');
      await fsp.rm(outPath, { force: true }).catch(() => {});
      continue;
    }

    job.downloaded = size;
    onLog?.(`拉流完成：${outName}  ${humanSize(size)}`);
    return { filePath: outPath, filename: outName, size, segments: [], multiFile: false };
  }

  throw lastErr || new FatalError('ffmpeg 拉流失败');
}

/** 启动一次 ffmpeg 拉流，等到进程结束 */
function runFfmpegPull({ url, outPath, signal, hls, format, onLog }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      // 网络抖动时在进程内重连（不加 -reconnect_at_eof：点播流读完就该结束，
      // 否则 ffmpeg 会以为断流、无限重新下载）
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      // 30 秒收不到任何数据就判定卡死，避免点播任务永久挂着
      '-rw_timeout', '30000000',
    ];
    // HLS 的分片/密钥可能是非标准扩展名（.php 等），默认白名单会拒绝。
    // 注意这是 hls 解复用器的私有选项，DASH 输入不能带，否则 ffmpeg 直接报错。
    if (hls) args.push('-allowed_extensions', 'ALL');

    args.push(
      '-i', url,
      // 只取一条视频 + 一条音频：DASH 常有多条音轨，全取会让封装失败
      '-map', '0:v?',
      '-map', '0:a?',
      '-c', 'copy',
      ...format.args,
      '-y', outPath,
    );

    onLog?.(`ffmpeg 启动：${format.label}`);
    const child = spawnTracked(config.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    const kill = () => {
      try {
        child.kill('SIGINT');
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 3000).unref?.();
    };
    onAbortOnce(signal, kill);

    child.on('error', (e) => {
      signal?.removeEventListener('abort', kill);
      const hint = e.code === 'ENOENT' ? '（未安装 ffmpeg？）' : '';
      reject(new Error(`ffmpeg 启动失败：${e.message}${hint}`));
    });

    child.on('close', (code) => {
      signal?.removeEventListener('abort', kill);
      if (signal?.aborted) return reject(new FatalError('已取消'));
      if (code === 0) return resolve();
      // ffmpeg 的报错很长，取最后几行足够定位
      reject(new Error(`ffmpeg 退出码 ${code}：${stderr.trim().split('\n').slice(-3).join(' | ').slice(-300)}`));
    });
  });
}

/**
 * DASH（.mpd）下载。
 *
 * 自己解析 MPD 要处理 SegmentTemplate/SegmentList/SegmentBase、音视频分离、
 * init 段、多码率选择…… ffmpeg 的 dash 解复用器已经全部覆盖，
 * 而 ffmpeg 本来就是本项目的硬依赖（RTMP/直播录制都用它）。
 */
async function downloadDash(job, ctx) {
  ctx.onLog?.('DASH（.mpd）：交给 ffmpeg 处理（SegmentTemplate / 音视频分离 / init 段）');
  return downloadViaFfmpeg(job, ctx, {
    baseName: (ctx.filename || resolveFilename(ctx.url)).replace(/\.[a-z0-9]+$/i, '') || 'dash',
    formats: [
      { ext: '.mp4', label: 'mp4', args: ['-f', 'mp4'] },
      { ext: '.mkv', label: 'matroska', args: ['-f', 'matroska'] },
    ],
  });
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

  // 加密分片 / fMP4 自己拼不出可播放文件，交给 ffmpeg
  if (hlsNeedsFfmpeg(mediaText)) {
    onLog?.('播放列表含加密密钥或 fMP4 初始化段，改用 ffmpeg 拉流（内置解密与容器处理）');
    return downloadViaFfmpeg(job, ctx, {
      url: mediaUrl,
      baseName,
      hls: true,
      formats: [
        { ext: '.ts', label: 'mpegts', args: ['-f', 'mpegts'] },
        { ext: '.mp4', label: 'mp4', args: ['-f', 'mp4'] },
      ],
    });
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
            // 已经完整下过就直接跳过（.tmp 后缀保证这里只可能是完整文件）
            try {
              const st = await fsp.stat(p);
              if (st.size > 0) return st.size;
            } catch {
              /* ignore */
            }
            /**
             * 先写 .tmp，成功后再 rename 成正式文件名。
             *
             * 直接写 p 的话，中途失败会留下 size>0 的残片，
             * 下一次重试看到 size>0 就当成"已下完"，最终拼出一个缺片的视频
             * 而且完全没有任何报错。
             */
            const tmp = p + '.tmp';
            const sz = await fetchToFile(seg.url, tmp, signal, seg.byteRange);
            await fsp.rename(tmp, p);
            return sz;
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

  /**
   * 用户主动停止：把已下载的分片按顺序拼起来，能拼多少算多少。
   *
   * 之前这里直接 throw FatalError('已取消')，已下载的分片全被丢掉。
   * 现在改成尽量拼接——缺的分片位置留空（后面校验会按实际大小处理），
   * 至少让用户拿到已经下到的那部分内容。
   */
  const stopped = Boolean(signal?.aborted);

  onLog?.(stopped ? '已停止，拼接已下载的分片...' : '拼接分片...');
  const tmpOut = dest + '.concat';
  const w = openWriter(tmpOut);
  let concatBytes = 0;
  try {
    for (let i = 0; i < segs.length; i++) {
      const p = path.join(partDir, String(i).padStart(6, '0') + '.ts');
      // 停止时跳过还没下完的分片，不要在这里抛错
      const st = await fsp.stat(p).catch(() => null);
      const exists = Boolean(st && st.size > 0);
      if (!exists) {
        if (stopped) continue;
        throw new FatalError(`分片 ${i + 1} 缺失`);
      }
      await pipeInto(w, p);
      concatBytes += st.size;
    }
  } catch (e) {
    w.destroy();
    await fsp.rm(tmpOut, { force: true }).catch(() => {});
    throw e;
  }
  await w.end();

  if (stopped && concatBytes === 0) {
    await fsp.rm(tmpOut, { force: true });
    await fsp.rm(partDir, { recursive: true, force: true });
    throw new FatalError('已取消');
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
        // 畸形 URL 直接跳过，不要让整份播放列表解析失败
        let href;
        try {
          href = new URL(n, baseUrl).href;
        } catch {
          break;
        }
        out.push({
          url: href,
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

    // 畸形 URL 直接跳过，否则一条坏行会让整场 HLS 下载失败
    let href;
    try {
      href = new URL(l, baseUrl).href;
    } catch {
      continue;
    }

    out.push({
      url: href,
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
  ensureNotAborted(signal);
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
    const w = openWriter(dest);
    let n = 0;
    let endErr = null;
    try {
      for await (const chunk of res.body) {
        resetIdle();
        await w.write(chunk);
        n += chunk.length;
      }
    } finally {
      clearTimeout(idle);
      try {
        await w.end();
      } catch (e) {
        endErr = e;
      }
    }
    if (endErr) throw endErr;
    if (n === 0) throw new RetryableError('分片为空');
    return n;
  } finally {
    clearTimeout(idle);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * 直播流下载（http-flv / rtmp）—— 按时间分段
 *
 * 行为：
 *  - 每 LIVE_SEGMENT_SECONDS 秒切一个独立文件（默认 300 秒 = 5 分钟）
 *  - 每段都是完整可播的 FLV（自带文件头），**不合并**
 *  - 分段点对齐到关键帧，避免段首花屏
 *  - 段文件通过 onSegment 回调立即交给上层上传，上传后即可删除，不占磁盘
 *  - 连接中断时，当前段照常收尾，然后重连开新段继续录
 *
 * 为什么用 ffmpeg 而不是自己按字节切：
 *  直播流是持续不断的 tag 序列，只有 ffmpeg 能准确在关键帧边界切分并保证每段可独立播放。
 */
/**
 * 全段下载：把整个直播录成一个大文件，不切段。
 *
 * 用 ffmpeg 直接输出 flv，断流靠 -reconnect 在进程内续传；
 * 若 ffmpeg 真的退出，外层循环重启并用 -append 继续追加到同一文件。
 */
async function downloadLiveWhole(job, ctx) {
  const { url, signal, onProgress, onLog } = ctx;
  ensureNotAborted(signal);

  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const baseName = (ctx.filename || `live_${ts}`).replace(/\.[a-z0-9]+$/i, '');
  const outName = `${baseName}.flv`;
  const outPath = path.join(ctx.dir, outName);

  job.filename = outName;
  job.live = true;
  job.segmentSeconds = 0;
  job.segments = [];
  job.segmentsDone = 0;

  onLog?.('全段下载模式：整场录成单个文件，不切段；点「取消」结束录制并上传');

  let attempt = 0;
  let emptyStreak = 0;
  let lastSize = 0;

  while (true) {
    if (signal?.aborted) break;
    attempt++;

    // 已有内容 → 本次追加，不覆盖
    const existing = await sizeOf(outPath).catch(() => 0);
    const append = existing > 0;

    onLog?.(
      append
        ? `连接 #${attempt}：追加录制（已有 ${humanSize(existing)}）`
        : `连接 #${attempt}：开始录制`,
    );

    const before = existing;
    let sampler = null;

    try {
      sampler = setInterval(() => {
        fs.stat(outPath, (err, st) => {
          if (!err && st.size > 0) {
            job.downloaded = st.size;
            onProgress?.(st.size, 0);
          }
        });
      }, 1000);

      await runFfmpegWhole({
        url,
        outPath,
        append,
        signal,
        onLog,
      });
    } catch (e) {
      if (signal?.aborted) break;
      onLog?.(`连接中断：${e.message}`);
    } finally {
      if (sampler) clearInterval(sampler);
    }

    const now = await sizeOf(outPath).catch(() => 0);
    job.downloaded = now;
    lastSize = now;

    if (now > before) {
      emptyStreak = 0;
    } else {
      emptyStreak++;
      onLog?.(`本次未录到新数据（连续 ${emptyStreak}/${config.retry.liveMaxEmptyRetries}）`);
      if (emptyStreak >= config.retry.liveMaxEmptyRetries) {
        if (now === 0) throw new FatalError('连续多次未收到任何数据，直播可能已结束或地址无效');
        onLog?.('连续无数据，判定直播已结束');
        break;
      }
    }

    await sleep(config.retry.liveReconnectDelay);
  }

  if (lastSize <= 0) throw new FatalError('未录制到任何数据');

  onLog?.(`录制结束：${outName}  ${humanSize(lastSize)}`);
  return {
    filePath: outPath,
    filename: outName,
    size: lastSize,
    segments: [],
    multiFile: false,
  };
}

/**
 * 单文件录制（不分段）。
 * -append 1 让 ffmpeg 在文件末尾追加，而不是覆盖。
 */
function runFfmpegWhole(opts) {
  const { url, outPath, append, signal, onLog } = opts;

  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-probesize', '2M',
      '-analyzeduration', '2M',
      '-fflags', '+genpts',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-reconnect_at_eof', '1',
      '-i', url,
      '-c', 'copy',
      '-f', 'flv',
    ];
    if (append) args.push('-append', '1');
    args.push('-y', outPath);

    const child = spawnTracked(config.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    const kill = () => {
      try {
        child.kill('SIGINT');
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 3000).unref?.();
    };
    onAbortOnce(signal, kill);

    child.on('error', (e) => {
      signal?.removeEventListener('abort', kill);
      reject(new Error(`ffmpeg 启动失败：${e.message}`));
    });

    child.on('close', (code) => {
      signal?.removeEventListener('abort', kill);
      if (signal?.aborted) return resolve({ aborted: true });
      if (code === 0) return resolve({ aborted: false });
      if (/Connection|timed out|Server error|End of file|Invalid data|Broken pipe|error while decoding|prematurely/i.test(stderr)) {
        return resolve({ aborted: false });
      }
      reject(new Error(`ffmpeg 退出码 ${code}：${stderr.slice(-400)}`));
    });
  });
}

async function downloadLive(job, ctx) {
  const { url, signal, onProgress, onLog, onSegment } = ctx;
  ensureNotAborted(signal);

  /**
   * 全段下载（不分段）：把整个直播录成一个大文件。
   *
   * 与分段模式的区别：
   *  - 不传 -f segment，直接让 ffmpeg 输出到单个文件
   *  - 断流由 -reconnect 系列参数在进程内自动续传，文件持续追加
   *  - 外层循环仍兜底：ffmpeg 真退出就重新起一个，用 -append 追加到同一文件
   *
   * 注意：文件会一直增长，直到用户手动停止。停止时才上传，
   * 因此单个文件可能远超 Cloudflare 的上传上限，这是该模式固有的取舍。
   */
  if (ctx.segment === false) {
    return await downloadLiveWhole(job, ctx);
  }

  const segSec = Math.max(10, config.download.liveSegmentSeconds || 300);

  /**
   * 分段时长固定为用户设定值，不做体积自适应。
   *
   * 曾经为了绕开 Cloudflare 的单请求 130MB 上限而按码率缩短段长，
   * 但上传现在已改走分片协议（10MB 一片），体积不再是约束。
   * 自适应反而会把 10 分钟段误缩成几十秒，所以去掉。
   */
  const effectiveSec = segSec;

  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const baseName = (ctx.filename || `live_${ts}`).replace(/\.[a-z0-9]+$/i, '');
  job.filename = `%04d_${baseName}.flv`;
  job.live = true;
  job.segmentSeconds = segSec;
  job.segments = [];
  job.segmentsDone = 0;

  onLog?.(`直播分段录制：每段 ${segSec} 秒，按关键帧对齐，段与段之间不合并`);

  let attempt = 0;
  let emptyStreak = 0;
  let segOffset = 0; // 已产出的段数，用于续接编号
  let totalBytes = 0;
  let segStartAt = Date.now(); // 当前段的起始时间，用于反推码率

  // 每段产出后立即回调（上传/删本地由上层负责）
  // segDurSec: 本段的真实媒体时长（由 segment_list 的 CSV 解析而来）
  const handleSegment = async (filePath, segDurSec = 0) => {
    const sz = await sizeOf(filePath);
    if (sz <= 0) {
      await fsp.rm(filePath, { force: true });
      return false;
    }

    /**
     * 关键：先算出目标文件名，若它与源文件已经是同一个路径，
     * 说明 ffmpeg 的编号正好接上了，无需 rename——直接用。
     *
     * 之前的 bug：无条件 segOffset++ 再 rename，
     * 当 ffmpeg 写出的文件名恰好等于 baseName_${idx}.flv 时，
     * rename 变成「自己重命名自己」，抛错被 catch 吞掉，
     * 但 segOffset 已经加了，于是同一个文件被当成新段重复上传。
     */
    const nextIdx = segOffset + 1;
    // 序号放前面：0001_20261107_120000.flv，这样在文件管理器/网盘里按名称排序就是播放顺序
    const name = `${String(nextIdx).padStart(4, '0')}_${baseName}.flv`;
    const finalPath = path.join(ctx.dir, name);

    // 源文件已在目标位置 → 不要 rename，也不重复计数
    const samePath = path.resolve(filePath) === path.resolve(finalPath);
    if (samePath) {
      // 该文件已经被处理过（seen 集合在 runFfmpegSegments 里保证不会重复进来）
      // 这里只需确保计数与文件名一致
      segOffset = nextIdx;
    } else {
      // 目标已存在 → 说明这个文件之前处理过，跳过，避免重复
      const exists = await fsp
        .stat(finalPath)
        .then((st) => st.size > 0)
        .catch(() => false);
      if (exists) {
        onLog?.(`跳过重复分段：${name}（目标已存在）`);
        // 删掉 ffmpeg 多写的这份，避免占磁盘
        await fsp.rm(filePath, { force: true });
        return false;
      }
      try {
        await fsp.rename(filePath, finalPath);
        segOffset = nextIdx;
      } catch (e) {
        onLog?.(`分段改名失败 ${path.basename(filePath)} → ${name}：${e.message}`);
        return false;
      }
    }

    const idx = segOffset;

    totalBytes += sz;
    job.downloaded = totalBytes;
    job.segmentsDone = idx;
    onProgress?.(totalBytes, 0);
    onLog?.(`第 ${idx} 段完成：${name}  ${humanSize(sz)}`);

    /**
     * 分段时长保持用户设定的值，不再按体积自适应缩短。
     *
     * 之前加自适应是为了绕开 Cloudflare 的单请求 130MB 上限，
     * 现在上传已改走分片协议（10MB 一片），体积不再是约束，
     * 自适应反而会把 10 分钟段误缩成几十秒，所以去掉。
     * 这里只记录码率用于日志。
     */
    const elapsedSec = segDurSec > 0 ? segDurSec : Math.max(1, (Date.now() - segStartAt) / 1000);
    const bytesPerSec = sz / elapsedSec;
    if (bytesPerSec > 0 && idx === 1) {
      onLog?.(
        `实测码率约 ${fmtRate(bytesPerSec)}，按每段 ${effectiveSec}s 计，单段约 ${humanSize(bytesPerSec * effectiveSec)}`,
      );
    }

    // 下一段重新计时
    segStartAt = Date.now();

    const rec = { index: idx, filename: name, path: finalPath, size: sz };
    job.segments.push(rec);

    /**
     * 上传放到后台，不阻塞分段循环。
     *
     * 为什么必须异步：一段 60 秒的直播约 18MB，上传要十几秒。
     * 如果 await，ffmpeg 写下一段的进度会被拖住，最终导致
     * segment_list 落后、内存积压、容器被重启。
     */
    if (onSegment) {
      Promise.resolve()
        .then(() => onSegment(rec))
        .catch((e) => {
          onLog?.(`第 ${idx} 段上传失败：${e.message}（保留本地）`);
        });
    }
    return true;
  };

  while (true) {
    if (signal?.aborted) break;
    attempt++;

    onLog?.(`直播连接 #${attempt}，开始录制第 ${segOffset + 1} 段起`);
    const before = segOffset;

    let sampler = null;
    try {
      // 采样当前正在写的段，用于实时进度
      sampler = setInterval(() => {
        const cur = path.join(ctx.dir, `${String(segOffset + 1).padStart(4, '0')}_${baseName}.flv`);
        fs.stat(cur, (err, st) => {
          if (!err && st.size > 0) {
            job.downloaded = totalBytes + st.size;
            onProgress?.(job.downloaded, 0);
          }
        });
      }, 1000);

      /**
       * segmentSeconds 直接传目标值。
       *
       * 不需要跨连接累积秒数：ffmpeg 已通过 -reconnect 参数在进程内
       * 自动重连，segment 计时器不会因源站断流而重置。
       * 这个外层循环只在 ffmpeg 真正退出（重连也失败）时才兜底重启。
       */
      await runFfmpegSegments({
        url,
        dir: ctx.dir,
        baseName,
        startNumber: segOffset,
        segmentSeconds: effectiveSec,
        signal,
        onLog,
        onSegmentFile: handleSegment,
      });
    } catch (e) {
      if (signal?.aborted) break;
      onLog?.(`连接中断：${e.message}`);

      /**
       * 403 / 401 / 404 是「权限或地址问题」，不是网络抖动，重试没用。
       * 之前遇到 403 会一直重连到 liveMaxEmptyRetries 才停，
       * 期间疯狂打源站，反而更容易被拉黑。
       * 这里直接判为致命错误，让任务尽快结束并把原因写进日志。
       */
      if (/(^|\D)40[134](\D|$)|Forbidden|Unauthorized|Not Found/i.test(e.message)) {
        if (segOffset === 0) {
          throw new FatalError(`直播源拒绝访问（${e.message.slice(0, 120)}），可能是链接过期或被限流`);
        }
        onLog?.('源站拒绝访问，已录分段会正常上传，录制结束');
        break;
      }
    } finally {
      if (sampler) clearInterval(sampler);
    }

    const produced = segOffset - before;
    if (produced > 0) {
      emptyStreak = 0;
    } else {
      emptyStreak++;
      onLog?.(`本次未产出分段（连续 ${emptyStreak}/${config.retry.liveMaxEmptyRetries}）`);
      if (emptyStreak >= config.retry.liveMaxEmptyRetries) {
        if (segOffset === 0) throw new FatalError('连续多次未收到任何数据，直播可能已结束或地址无效');
        onLog?.('连续无数据，判定直播已结束');
        break;
      }
    }

    await sleep(config.retry.liveReconnectDelay);
  }

  if (segOffset === 0) throw new FatalError('未录制到任何分段');

  onLog?.(`录制结束，共 ${segOffset} 段`);
  return {
    // 直播是多文件，这里返回最后一段作为占位，真正的多文件列表在 job.segments
    filePath: job.segments.length ? job.segments[job.segments.length - 1].path : '',
    filename: `*_${baseName}.flv`,
    size: totalBytes,
    segments: job.segments.slice(),
    multiFile: true,
  };
}

/**
 * 用 ffmpeg 的 segment muxer 按时间切片。
 * -c copy 不转码，CPU 占用极低
 * -reset_timestamps 1 让每段时间戳从 0 开始，可独立播放
 * -segment_time 按秒切，ffmpeg 会自动找关键帧对齐
 */
function runFfmpegSegments(opts) {
  const { url, dir, baseName, startNumber, segmentSeconds, signal, onLog, onSegmentFile } = opts;

  return new Promise((resolve, reject) => {
    // 序号在前，与 handleSegment 的最终命名保持一致，
    // 这样大多数情况下 ffmpeg 直接写对名字，不需要 rename
    const outPattern = path.join(dir, `%04d_${baseName}.flv`);
    // segment_list 每个连接独立一份，避免重连时互相覆盖
    const listPath = path.join(dir, `.segments-${startNumber}.csv`);

    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      // 限制 ffmpeg 自身缓冲，避免在 1GB 内存容器里被 OOM kill
      '-probesize', '2M',
      '-analyzeduration', '2M',
      '-fflags', '+genpts',

      /**
       * HTTP 层自动重连 —— 这是让分段时长生效的关键。
       *
       * 实测：这个直播源每约 54 秒主动断流（Stream ends prematurely）。
       * 不加这几个参数时，ffmpeg 一断就退出，segment 计时器归零，
       * 于是每段被源站节奏切成 50-60 秒，-segment_time 600 永远不触发。
       *
       * 加上之后 ffmpeg 在同一个进程内自动重连，segment 计时器持续累加，
       * 实测 200 秒只产出 1 个连续文件，分段时长才真正按设置走。
       */
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-reconnect_at_eof', '1',

      '-i', url,
      '-c', 'copy',
      '-f', 'segment',
      '-segment_format', 'flv',
      '-segment_time', String(segmentSeconds),
      '-reset_timestamps', '1',
      '-segment_start_number', String(startNumber + 1),
      '-segment_list', listPath,
      '-segment_list_type', 'csv',
      outPattern,
    ];

    onLog?.(`ffmpeg 启动：每 ${segmentSeconds}s 一段（含自动重连）`);

    const child = spawnTracked(config.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    /**
     * 用 ffmpeg 自己维护的 segment_list 判定「哪些段已写完」。
     *
     * 为什么不用 readdir + stat 两次比对大小：
     *  ffmpeg 写文件有页缓存，stat 大小可能长时间不变但其实没写完；
     *  而且高频 readdir 在 1GB 内存的容器里会造成明显压力。
     * segment_list 是 ffmpeg 主动追加的，只有真正关闭上一段时才写入，
     * 是判断分段完成的唯一可靠信号。
     */
    const seen = new Set();
    let watchTimer = null;
    let stopped = false;
    const scan = async () => {
      if (stopped) return;
      try {
        let txt;
        try {
          txt = await fsp.readFile(listPath, 'utf8');
        } catch {
          return; // 列表还没生成
        }
        // csv 每行：文件名,起始秒,结束秒
        const lines = txt.split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          const cols = line.split(',');
          const fname = cols[0]?.trim();
          if (!fname || seen.has(fname)) continue;
          // segment_list 会在切下一段时才写入上一段，所以列表里出现的段都已写完
          const full = path.join(dir, path.basename(fname));
          const sz = await sizeOf(full);
          if (sz <= 0) continue;
          seen.add(fname);

          // 真实媒体时长 = 结束秒 - 起始秒
          let durSec = 0;
          if (cols.length >= 3) {
            const start = parseFloat(cols[1]);
            const end = parseFloat(cols[2]);
            if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
              durSec = end - start;
            }
          }

          try {
            await onSegmentFile(full, durSec);
          } catch (e) {
            onLog?.(`处理分段 ${fname} 失败：${e.message}`);
          }
        }
      } catch {
        /* 忽略 */
      }
    };

    // 扫描间隔放宽到 3 秒，进一步降低内存/IO 压力
    watchTimer = setInterval(scan, 3000);

    const cleanup = () => {
      stopped = true;
      if (watchTimer) clearInterval(watchTimer);
    };

    const kill = () => {
      try {
        child.kill('SIGINT'); // SIGINT 让 ffmpeg 优雅收尾，写完当前段
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 3000).unref?.();
    };
    onAbortOnce(signal, kill);

    child.on('error', (e) => {
      cleanup();
      signal?.removeEventListener('abort', kill);
      reject(new Error(`ffmpeg 启动失败：${e.message}`));
    });

    child.on('close', async (code) => {
      cleanup();
      signal?.removeEventListener('abort', kill);

      // 收尾：先扫一次 segment_list，再兜底扫目录
      // （ffmpeg 被 SIGINT 终止时，最后一段可能没写进 list）
      await scan();
      try {
        const files = await fsp.readdir(dir);
        const mine = files
          .filter((f) => f.endsWith(`_${baseName}.flv`) && /^\d{4}_/.test(f))
          .sort();
        for (const f of mine) {
          if (seen.has(f)) continue;
          const full = path.join(dir, f);
          const sz = await sizeOf(full);
          if (sz <= 0) continue;
          seen.add(f);
          try {
            await onSegmentFile(full);
          } catch (e) {
            onLog?.(`收尾处理 ${f} 失败：${e.message}`);
          }
        }
      } catch {
        /* 忽略 */
      }

      // 清理本轮的 segment_list
      await fsp.rm(listPath, { force: true });

      if (signal?.aborted) return resolve({ aborted: true });
      if (code === 0) return resolve({ aborted: false });
      if (/Connection|timed out|Server error|End of file|Invalid data|Broken pipe|error while decoding/i.test(stderr)) {
        return resolve({ aborted: false });
      }
      reject(new Error(`ffmpeg 退出码 ${code}：${stderr.slice(-400)}`));
    });
  });
}

/**
 * 判断一个 HTTP 地址是否其实是直播流。
 * 判据：响应头是流式视频类型，且没有 Content-Length。
 * 只要满足就按直播处理——普通视频文件一定有 Content-Length（或分块但有确定终点）。
 */
async function looksLikeLiveStream(url, signal) {
  // 放在 try 外面：这里的 catch 会把所有异常吞成 false，
  // 取消信号不能被吞掉，否则后面还会继续发起新的请求
  ensureNotAborted(signal);
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

/**
 * 统一入口
 * @param {object} job 任务对象
 * @param {object} ctx { url, dir, filename, signal, onProgress, onLog }
 */
export async function runDownload(job, ctx) {
  ensureNotAborted(ctx.signal);
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
      return await downloadDash(job, ctx);
    default:
      // 未知协议，按直播流处理（http-flv 等无扩展名地址）
      if (/^https?:/i.test(ctx.url)) {
        return await downloadLive(job, ctx);
      }
      throw new FatalError(`无法识别的链接类型：${ctx.url.slice(0, 80)}`);
  }
}

export { RetryableError, FatalError };
