/**
 * Unikraft 可行性探测脚本。
 *
 * 跑四组检查，每项独立 try/catch，任何一项失败都不影响其它项，
 * 最后起一个 HTTP 服务保活（Unikraft 实例需要有活着的进程，
 * 否则会被判定为已退出）。
 *
 * 结果同时打到 stdout（Unikraft 的 log 接口能取到）和 /data/probe.json。
 */
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';

const DATA = process.env.DATA_DIR || '/data';
const PORT = Number(process.env.PORT || 8080);

const results = [];
const log = (s) => console.log(s);
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  log(`[${ok ? 'PASS' : 'FAIL'}] ${name}: ${detail}`);
};

// 先打头，避免异步的 main() 输出跑到同步检查后面
log('=== Unikraft 可行性探测开始 ===');
log(
  `host=${os.hostname()} arch=${os.arch()} cpus=${os.cpus().length} mem=${Math.round(os.totalmem() / 1048576)}MB`,
);

// ---------- 1) 运行时版本 ----------
try {
  const nodeVer = process.version;
  let ffmpegVer = '';
  let ffmpegOk = false;
  try {
    ffmpegVer = execFileSync('/usr/bin/ffmpeg', ['-version'], {
      encoding: 'utf8',
      timeout: 15000,
    }).split('\n')[0];
    ffmpegOk = true;
  } catch (e) {
    ffmpegVer = `执行失败: ${e.message}`;
  }
  // node 一定能跑（否则脚本根本没起来），关键看 ffmpeg 能不能执行
  record('runtime', ffmpegOk, `node=${nodeVer} | ${ffmpegVer}`);
} catch (e) {
  record('runtime', false, e.message);
}

// ---------- 2) 持久卷可写 ----------
try {
  fs.mkdirSync(`${DATA}/probe`, { recursive: true });
  const marker = `probe-${Date.now()}`;
  fs.writeFileSync(`${DATA}/probe/marker.txt`, marker, 'utf8');
  const back = fs.readFileSync(`${DATA}/probe/marker.txt`, 'utf8');
  const st = fs.statfsSync(DATA);
  const freeMB = Math.round((st.bfree * st.bsize) / 1024 / 1024);
  record(
    'volume',
    back === marker,
    `写入回读一致=${back === marker} 可用=${freeMB}MB 挂载点=${DATA}`,
  );
} catch (e) {
  record('volume', false, e.message);
}

// ---------- 3) 子进程（ffmpeg 依赖 fork/exec） ----------
try {
  const r = spawnSync('/bin/sh', ['-c', 'echo spawn-ok'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  if (r.error) throw r.error;
  const out = (r.stdout || '').trim();
  record('spawn', out === 'spawn-ok', `输出=${JSON.stringify(out)}`);
} catch (e) {
  record('spawn', false, e.message);
}

// ---------- 4) 出站带宽 ----------
async function netTest() {
  const url = 'https://speed.cloudflare.com/__down?bytes=20000000';
  try {
    const t0 = Date.now();
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let n = 0;
    for await (const chunk of res.body) n += chunk.length;
    const sec = (Date.now() - t0) / 1000;
    const mbps = (n * 8) / 1e6 / sec;
    record(
      'network',
      true,
      `下载 ${(n / 1048576).toFixed(1)}MB / ${sec.toFixed(2)}s = ${mbps.toFixed(1)} Mbps`,
    );
  } catch (e) {
    record('network', false, e.message);
  }
}

// ---------- 5) ffmpeg 实跑一次（真录 3 秒静音） ----------
function ffmpegRealTest() {
  const out = `${DATA}/probe/t.mp4`;
  try {
    execFileSync(
      '/usr/bin/ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
        '-t', '3', '-c:a', 'aac', '-y', out,
      ],
      { timeout: 60000, stdio: 'pipe' },
    );
    const sz = fs.statSync(out).size;
    record('ffmpeg-encode', sz > 0, `生成 ${sz} 字节`);
    fs.unlinkSync(out);
  } catch (e) {
    const msg = e.stderr ? String(e.stderr).slice(0, 200) : e.message;
    record('ffmpeg-encode', false, msg);
  }
}

// ---------- 汇总 ----------
async function main() {
  await netTest();
  ffmpegRealTest();

  const passed = results.filter((r) => r.ok).length;
  log(`=== 汇总: ${passed}/${results.length} 通过 ===`);

  try {
    fs.writeFileSync(
      `${DATA}/probe.json`,
      JSON.stringify({ when: new Date().toISOString(), results }, null, 2),
      'utf8',
    );
  } catch (e) {
    log(`写 probe.json 失败: ${e.message}`);
  }

  // 保活：Unikraft 需要有进程常驻，同时提供健康检查端点
  http
    .createServer((req, res) => {
      if (req.url === '/probe') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results }, null, 2));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        `Unikraft probe alive\n\n` +
          results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}: ${r.detail}`).join('\n') +
          '\n',
      );
    })
    .listen(PORT, '0.0.0.0', () => log(`HTTP 监听 :${PORT}`));
}

main().catch((e) => {
  log(`主流程异常: ${e.stack || e.message}`);
  // 即使异常也保活，方便登进去看日志
  http.createServer((_, res) => res.end('probe crashed\n')).listen(PORT, '0.0.0.0');
});
