/**
 * HTTP 服务：REST API + SSE 实时进度推送 + 静态前端
 */
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config, openlistConfigured, printConfig, transcodeConfigured } from './config.js';
import { getTaskManager } from './tasks.js';
import { getOpenList } from './openlist.js';
import { getHistoryStore } from './history.js';
import { detectKind, humanSize } from './util/links.js';
import {
  signSession,
  verifySession,
  safeEqual,
  parseCookies,
  SESSION_TTL_MS,
} from './util/auth.js';
import { killAllChildren } from './downloader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** 单次请求最多接受多少条链接，防止一次塞几千条把队列打爆 */
const MAX_URLS_PER_REQUEST = 50;

const app = express();
app.disable('x-powered-by');

/**
 * 基础安全响应头。
 *
 * CSP 说明：
 *  - script-src 'self'：主题初始化已外置成 theme.js，页面里没有内联脚本
 *  - style-src 'self'：没有内联 style 属性，动态样式走 CSSOM（不受 CSP 限制）
 *  - img-src 允许 data:：favicon 是 data URI 的 SVG
 *  - frame-ancestors 'none'：等价于 X-Frame-Options，但覆盖更全
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const mgr = getTaskManager();

// ---------------- 鉴权 ----------------
const SESSION_COOKIE = 'cf_session';

/** 请求是否已通过鉴权（用于 /api/health 这类"按登录态决定返回内容"的接口） */
function isAuthed(req) {
  if (!config.auth.password) return false;
  const cookies = parseCookies(req.headers.cookie);
  if (verifySession(config.auth.secret, cookies[SESSION_COOKIE])) return true;
  const auth = req.headers['x-panel-password'];
  return Boolean(auth && safeEqual(auth, config.auth.password));
}

/**
 * 鉴权中间件。
 *
 * 安全策略：未配置 PANEL_PASSWORD 时**拒绝所有访问**，而不是放行。
 * 这个服务能把任意文件传进用户的 OpenList，公开暴露风险太大。
 */
function requireAuth(req, res, next) {
  // 未设密码 = 拒绝，并给出明确提示
  if (!config.auth.password) {
    return res.status(503).json({
      error: '未配置访问密码',
      detail: '请设置环境变量 PANEL_PASSWORD 后重启服务',
      code: 'NO_PASSWORD_CONFIGURED',
    });
  }
  if (isAuthed(req)) return next();
  return res.status(401).json({ error: '未登录' });
}

/** 登录失败限流：同一来源 10 分钟内最多 20 次，防止在线爆破 */
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 20;
const loginHits = new Map();

function loginBlocked(ip) {
  const now = Date.now();
  if (loginHits.size > 5000) loginHits.clear(); // 防止来源过多时内存无限增长
  const rec = loginHits.get(ip);
  if (!rec || now > rec.resetAt) {
    loginHits.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  rec.count++;
  return rec.count > LOGIN_MAX_ATTEMPTS;
}

/** 只有走 HTTPS 时才加 Secure，否则本地 http 调试会登录不上 */
function isSecureReq(req) {
  if (req.secure) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https';
}

// ---------------- 公开接口 ----------------
app.get('/api/health', (req, res) => {
  const authed = isAuthed(req);
  res.json({
    ok: true,
    version: '1.0.0',
    uptime: Math.round(process.uptime()),
    node: process.version,
    openlist: openlistConfigured(),
    // 前端拼「打开文件夹」链接要用（字段名是 baseUrl，不是 url）。
    // 未登录时不下发：站点地址可能是内网域名，没必要公开暴露。
    openlistUrl: authed ? config.openlist.baseUrl || '' : '',
    openlistUploadDir: authed ? config.openlist.uploadDir || '' : '',
    // 未配密码时前端要显示"配置缺失"而不是登录框
    authRequired: Boolean(config.auth.password),
    passwordConfigured: Boolean(config.auth.password),
    limits: {
      maxConcurrent: config.download.maxConcurrent,
      maxFileSize: config.download.maxFileSize,
      maxFileSizeText: humanSize(config.download.maxFileSize),
      maxQueue: config.download.maxQueue,
    },
    // 转码链路状态。前端据此决定要不要显示 MP4 相关提示
    transcode: {
      enabled: transcodeConfigured(),
      repo: transcodeConfigured() ? config.transcode.repo : '',
      crf: config.transcode.crf,
      preset: config.transcode.preset,
    },
  });
});

app.post('/api/login', (req, res) => {
  if (!config.auth.password) {
    return res.status(503).json({
      error: '未配置访问密码',
      detail: '请设置环境变量 PANEL_PASSWORD 后重启服务',
      code: 'NO_PASSWORD_CONFIGURED',
    });
  }
  if (loginBlocked(req.ip || 'unknown')) {
    return res.status(429).json({ error: '尝试次数过多，请 10 分钟后再试' });
  }
  const { password } = req.body || {};
  if (!safeEqual(password || '', config.auth.password)) {
    return res.status(401).json({ error: '密码错误' });
  }
  const token = signSession(config.auth.secret);
  const cookie = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isSecureReq(req)) cookie.push('Secure');
  res.setHeader('Set-Cookie', cookie.join('; '));
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  res.json({ ok: true });
});

// ---------------- 受保护接口 ----------------
app.use('/api', requireAuth);

/** 任务列表 */
app.get('/api/tasks', (req, res) => {
  res.json({ tasks: mgr.list() });
});

/** 单个任务 */
app.get('/api/tasks/:id', (req, res) => {
  const t = mgr.get(req.params.id);
  if (!t) return res.status(404).json({ error: '任务不存在' });
  res.json(t);
});

/** 新建任务（支持单个或批量） */
app.post('/api/tasks', (req, res) => {
  const body = req.body || {};
  const upload = body.upload !== false;
  // segment=false 表示「全段下载」：直播整场录成单个文件，不切段
  const segment = body.segment !== false;

  // 批量：{ urls: [...] } 或 { text: "多行链接" }
  let urls = [];
  if (Array.isArray(body.urls)) {
    urls = body.urls;
  } else if (typeof body.text === 'string') {
    urls = body.text
      .split(/[\r\n]+/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'));
  } else if (body.url) {
    urls = [body.url];
  }

  if (!urls.length) return res.status(400).json({ error: '没有提供链接' });
  // 一次请求塞太多链接会瞬间占满队列并起一堆并发连接，直接拒绝
  if (urls.length > MAX_URLS_PER_REQUEST) {
    return res.status(413).json({
      error: `一次最多提交 ${MAX_URLS_PER_REQUEST} 个链接（收到 ${urls.length} 个）`,
      code: 'TOO_MANY_URLS',
    });
  }

  const created = [];
  const errors = [];
  for (const u of urls) {
    try {
      const t = mgr.create({ url: u, filename: body.filename, upload, segment });
      created.push(mgr.get(t.id));
    } catch (e) {
      errors.push({ url: u, error: e.message });
    }
  }

  if (!created.length) {
    return res.status(400).json({ error: errors[0]?.error || '创建失败', errors });
  }
  res.status(201).json({ created, errors });
});

/** 取消 */
app.post('/api/tasks/:id/cancel', (req, res) => {
  const ok = mgr.cancel(req.params.id);
  if (!ok) return res.status(400).json({ error: '无法取消（任务不存在或已结束）' });
  res.json({ ok: true });
});

/** 重试上传失败的分段 */
/**
 * 重传失败的分段。
 *
 * 立刻返回 202，不在这里等上传完成。
 *
 * 原因：一段 300MB 的直播分段传到 R2 要 1-3 分钟，而 Unikraft 的
 * 网关有 60 秒硬超时 —— 之前同步等待，用户看到的是 504 Gateway
 * Time-out，但后台其实传成功了，界面和事实完全对不上。
 *
 * 现在改成 fire-and-forget：接口秒回，进度靠 SSE 推（_log 和
 * _emit 会推送每次分段的结果）。前端只要监听任务更新就行。
 */
app.post('/api/tasks/:id/retry-upload', async (req, res) => {
  try {
    // 先做同步校验：任务不存在 / 正在跑 / 没有失败分段，这些能立刻判断
    const check = mgr.canRetryUpload(req.params.id);
    if (!check.ok) return res.status(400).json({ error: check.error });

    // 后台跑，不 await
    mgr.retryFailedSegments(req.params.id).catch((e) => {
      // 这里只记日志：任务对象可能已经被用户删了，没有地方回写状态
      console.error(`[retry-upload] ${req.params.id} 失败：${e.message}`);
    });

    res.status(202).json({ ok: true, accepted: true, segments: check.count });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** 删除记录（同时清掉磁盘目录） */
app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const ok = await mgr.remove(req.params.id);
    if (!ok) return res.status(400).json({ error: '无法删除（任务进行中）' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 清空已结束（同时清掉磁盘目录） */
app.post('/api/tasks/clear', async (req, res) => {
  try {
    const n = await mgr.clearFinished();
    res.json({ ok: true, removed: n });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 探测链接类型（不下载） */
app.post('/api/probe', (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: '缺少 url' });
  res.json({ url, kind: detectKind(url) });
});

// ---------------- 历史记录 ----------------
/** 查询历史：分页 + 关键字 + 状态筛选 */
app.get('/api/history', async (req, res) => {
  try {
    const { page, pageSize, q, status } = req.query;
    const hs = getHistoryStore();
    await hs.load();
    res.json(hs.query({ page, pageSize, q, status }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 删除单条历史 */
app.delete('/api/history/:id', async (req, res) => {
  try {
    const hs = getHistoryStore();
    await hs.load();
    const ok = await hs.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: '记录不存在' });
    // 立即落盘：只靠 3 秒防抖的话，进程在这期间退出就白删了
    await hs.flush();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 清空历史 */
app.delete('/api/history', async (req, res) => {
  try {
    const hs = getHistoryStore();
    await hs.load();
    const n = await hs.clear();
    await hs.flush();
    res.json({ ok: true, removed: n });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** OpenList 连接测试 */
app.get('/api/openlist/check', async (req, res) => {
  const ol = getOpenList();
  const r = await ol.check();
  res.json({
    ...r,
    uploadDir: config.openlist.uploadDir,
    dateSubdir: config.openlist.dateSubdir,
    deleteAfterUpload: config.openlist.deleteAfterUpload,
  });
});

/** 磁盘空间 */
app.get('/api/disk', async (req, res) => {
  try {
    const s = await fs.promises.statfs(config.tmpDir);
    const free = s.bfree * s.bsize;
    const total = s.blocks * s.bsize;
    res.json({ free, total, freeText: humanSize(free), totalText: humanSize(total) });
  } catch (e) {
    res.json({ free: 0, total: 0, error: e.message });
  }
});

/** SSE 实时推送（requireAuth 已由上面的 app.use('/api', ...) 统一挂载） */
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  // 首帧推送全量
  res.write(`event: snapshot\ndata: ${JSON.stringify({ tasks: mgr.list() })}\n\n`);

  const onUpdate = (t) => {
    try {
      res.write(`event: task\ndata: ${JSON.stringify(t)}\n\n`);
    } catch {
      /* ignore */
    }
  };
  const onLog = (d) => {
    try {
      res.write(`event: log\ndata: ${JSON.stringify(d)}\n\n`);
    } catch {
      /* ignore */
    }
  };
  const onRemoved = (d) => {
    try {
      res.write(`event: removed\ndata: ${JSON.stringify(d)}\n\n`);
    } catch {
      /* ignore */
    }
  };

  mgr.on('update', onUpdate);
  mgr.on('log', onLog);
  mgr.on('removed', onRemoved);

  // 心跳防代理断流
  const hb = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(hb);
    mgr.off('update', onUpdate);
    mgr.off('log', onLog);
    mgr.off('removed', onRemoved);
  });
});

// ---------------- 静态文件 ----------------

/**
 * 静态资源版本号：按文件 mtime 自动生成。
 *
 * 之前 index.html 里写死 `app.js?v=2`，每次改前端都得手动改这个数字，
 * 忘了改就会出现「服务端已是新代码、浏览器还在跑旧缓存」。
 * 加上 express.static 的 maxAge 1h，用户最长一小时看不到更新。
 *
 * 现在 index.html 用 {{V}} 占位，这里替换成真实的 mtime 指纹，
 * 文件一改版本号就变，浏览器必然重新拉取。
 */
function assetVersion(name) {
  try {
    return String(Math.floor(fs.statSync(path.join(PUBLIC_DIR, name)).mtimeMs));
  } catch {
    return String(Date.now());
  }
}

const INDEX_TPL = (() => {
  try {
    return fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  } catch {
    return '';
  }
})();

function renderIndex() {
  // 同一次响应里 app.js / styles.css / theme.js 用各自 mtime，互不影响
  const v = assetVersion('app.js');
  const vc = assetVersion('styles.css');
  const vt = assetVersion('theme.js');
  return INDEX_TPL.replace(/\{\{V_JS\}\}/g, v)
    .replace(/\{\{V_CSS\}\}/g, vc)
    .replace(/\{\{V_THEME\}\}/g, vt);
}

/**
 * 静态资源。
 *
 * index 参数设为 false：不让 static 自动返回 index.html。
 * 否则访问 / 时 static 会直接吐原始文件，下面的 app.get('*')
 * 根本没机会执行，{{V_JS}} 占位符也就替换不掉。
 */
app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    extensions: ['html'],
    maxAge: '1h',
  }),
);

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(renderIndex());
});

// ---------------- 启动 ----------------
printConfig();

export const server = app.listen(config.port, config.host, () => {
  console.log(`[server] 监听 http://${config.host}:${config.port}`);
});

/**
 * 优雅退出。
 *
 * 光 close(server) 不够：正在跑的下载/录制还在写盘，ffmpeg 子进程会变成孤儿
 * 继续往下写，本地 `npm start` 重启一次就多一个。这里主动 abort 任务并杀掉子进程。
 */
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] 收到 ${sig}，正在关闭...`);
  try {
    mgr.shutdown();
  } catch (e) {
    console.error('[server] 停止任务失败：', e.message);
  }
  try {
    killAllChildren();
  } catch {
    /* ignore */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e);
});
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e);
});
