/**
 * HTTP 服务：REST API + SSE 实时进度推送 + 静态前端
 */
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { config, openlistConfigured } from './config.js';
import { getTaskManager, STATUS } from './tasks.js';
import { getOpenList } from './openlist.js';
import { getHistoryStore } from './history.js';
import { detectKind, humanSize } from './util/links.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const mgr = getTaskManager();

// ---------------- 鉴权 ----------------
const SESSION_COOKIE = 'cf_session';

function signSession() {
  const payload = String(Date.now());
  const h = crypto.createHmac('sha256', config.auth.secret).update(payload).digest('hex');
  return `${payload}.${h}`;
}
function verifySession(v) {
  if (!v) return false;
  const [payload, sig] = String(v).split('.');
  if (!payload || !sig) return false;
  const expect = crypto.createHmac('sha256', config.auth.secret).update(payload).digest('hex');
  if (sig.length !== expect.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
}
function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
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
  const cookies = parseCookies(req.headers.cookie);
  if (verifySession(cookies[SESSION_COOKIE])) return next();
  // 允许通过 header 传密码（方便脚本/CI 调用）
  const auth = req.headers['x-panel-password'];
  if (auth && safeEqual(auth, config.auth.password)) return next();
  return res.status(401).json({ error: '未登录' });
}

/** 常量时间比较，避免时序侧信道 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // 长度不同也要走一次比较，避免通过耗时判断长度
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

// ---------------- 公开接口 ----------------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: '1.0.0',
    uptime: Math.round(process.uptime()),
    node: process.version,
    openlist: openlistConfigured(),
    // 前端拼「打开文件夹」链接要用（字段名是 baseUrl，不是 url）
    openlistUrl: config.openlist.baseUrl || '',
    openlistUploadDir: config.openlist.uploadDir || '',
    // 未配密码时前端要显示"配置缺失"而不是登录框
    authRequired: Boolean(config.auth.password),
    passwordConfigured: Boolean(config.auth.password),
    limits: {
      maxConcurrent: config.download.maxConcurrent,
      maxFileSize: config.download.maxFileSize,
      maxFileSizeText: humanSize(config.download.maxFileSize),
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
  const { password } = req.body || {};
  if (!safeEqual(password || '', config.auth.password)) {
    return res.status(401).json({ error: '密码错误' });
  }
  const token = signSession();
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
  );
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
app.post('/api/tasks/:id/retry-upload', async (req, res) => {
  try {
    const r = await mgr.retryFailedSegments(req.params.id);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** 删除记录 */
app.delete('/api/tasks/:id', (req, res) => {
  const ok = mgr.remove(req.params.id);
  if (!ok) return res.status(400).json({ error: '无法删除（任务进行中）' });
  res.json({ ok: true });});

/** 清空已结束 */
app.post('/api/tasks/clear', (req, res) => {
  const n = mgr.clearFinished();
  res.json({ ok: true, removed: n });
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

/** SSE 实时推送 */
app.get('/api/events', requireAuth, (req, res) => {
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
app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: '1h' }));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---------------- 启动 ----------------
const server = app.listen(config.port, config.host, () => {
  console.log(`[server] 监听 http://${config.host}:${config.port}`);
});

// 优雅退出
function shutdown(sig) {
  console.log(`\n[server] 收到 ${sig}，正在关闭...`);
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
