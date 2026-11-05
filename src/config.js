/**
 * 配置中心：所有可调参数集中在这里，全部可用环境变量覆盖。
 * Cloady 部署时通过 PATCH app 的 vars 接口注入。
 */
import path from 'node:path';
import fs from 'node:fs';

const env = process.env;
const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d) => {
  if (v === undefined || v === '') return d;
  return /^(1|true|yes|on)$/i.test(String(v));
};

/** 临时下载目录。Cloady 免费额度存储只有 5GB，默认放 /tmp 不占持久卷 */
const DATA_DIR = env.DATA_DIR || '/tmp/cloudfetch';
const TMP_DIR = env.TMP_DIR || path.join(DATA_DIR, 'tmp');

// 确保目录存在
for (const d of [DATA_DIR, TMP_DIR]) {
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch (e) {
    console.error(`[config] 无法创建目录 ${d}: ${e.message}`);
  }
}

export const config = {
  port: num(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',

  dataDir: DATA_DIR,
  tmpDir: TMP_DIR,
  /** 任务状态持久化文件，用于重启恢复 */
  stateFile: path.join(DATA_DIR, 'tasks.json'),

  // ---------- 下载 ----------
  download: {
    /** 单个任务最大并发下载数 */
    maxConcurrent: num(env.MAX_CONCURRENT, 2),
    /** 单文件大小上限（字节），默认 20GB。超过直接拒绝，防止撑爆磁盘 */
    maxFileSize: num(env.MAX_FILE_SIZE, 20 * 1024 * 1024 * 1024),
    /** 磁盘剩余空间低于此值时拒绝新任务 */
    minFreeSpace: num(env.MIN_FREE_SPACE, 512 * 1024 * 1024),
    /** 连接超时（毫秒） */
    connectTimeout: num(env.CONNECT_TIMEOUT, 30000),
    /** 读取空闲超时（毫秒）：多久没收到数据判定卡死 */
    idleTimeout: num(env.IDLE_TIMEOUT, 60000),
    /** 分片大小，用于 HTTP 多线程下载 */
    chunkSize: num(env.CHUNK_SIZE, 8 * 1024 * 1024),
    /** 分片下载并发数 */
    chunkConcurrency: num(env.CHUNK_CONCURRENCY, 4),
    /** 进度上报间隔（毫秒） */
    progressInterval: num(env.PROGRESS_INTERVAL, 500),
    /**
     * 直播分段时长（秒）。每段独立成文件、独立上传，**不合并**。
     * 300 = 5 分钟一段（推荐，理由见 README「直播分段时长怎么选」）
     */
    liveSegmentSeconds: num(env.LIVE_SEGMENT_SECONDS, 300),
  },

  // ---------- 重试 ----------
  retry: {
    /** 最大重试次数 */
    maxAttempts: num(env.RETRY_MAX_ATTEMPTS, 8),
    /** 首次退避基数（毫秒），指数增长 */
    baseDelay: num(env.RETRY_BASE_DELAY, 2000),
    /** 最大退避（毫秒） */
    maxDelay: num(env.RETRY_MAX_DELAY, 60000),
    /** 直播流：连续多少次重连无数据才放弃 */
    liveMaxEmptyRetries: num(env.LIVE_MAX_EMPTY_RETRIES, 12),
    /** 直播流：断流后重连间隔（毫秒） */
    liveReconnectDelay: num(env.LIVE_RECONNECT_DELAY, 3000),
  },

  // ---------- OpenList ----------
  openlist: {
    /** OpenList / AList 站点地址，如 https://pan.example.com */
    baseUrl: (env.OPENLIST_URL || '').replace(/\/+$/, ''),
    /** API Token（OpenList v3 在 设置-其他-令牌 获取） */
    token: env.OPENLIST_TOKEN || '',
    /** 或用账号密码登录换 token */
    username: env.OPENLIST_USERNAME || '',
    password: env.OPENLIST_PASSWORD || '',
    /** 上传目标目录，默认 /cloudfetch */
    uploadDir: env.OPENLIST_UPLOAD_DIR || '/cloudfetch',
    /** 上传分块大小（字节），0 表示不切片直接 PUT */
    putChunkSize: num(env.OPENLIST_CHUNK_SIZE, 0),
    /** 上传并发（OpenList 并发上传线程数） */
    putConcurrency: num(env.OPENLIST_PUT_CONCURRENCY, 3),
    /** 上传失败重试次数 */
    uploadRetries: num(env.UPLOAD_RETRIES, 5),
    /** 按日期建子目录，如 2026-11-05 */
    dateSubdir: bool(env.OPENLIST_DATE_SUBDIR, true),
    /** 上传成功后是否删除本地文件 */
    deleteAfterUpload: bool(env.DELETE_AFTER_UPLOAD, true),
  },

  // ---------- 鉴权 ----------
  auth: {
    /** 访问面板需要的密码，留空则不鉴权（不建议） */
    password: env.PANEL_PASSWORD || '',
    /** 会话签名密钥 */
    secret: env.SESSION_SECRET || 'cloudfetch-default-secret-change-me',
  },

  // ---------- 其他 ----------
  /** ffmpeg 可执行文件路径 */
  ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
  /** 任务历史保留条数 */
  maxTasks: num(env.MAX_TASKS, 200),
  /** 任务完成后保留记录时长（毫秒），默认 24 小时 */
  taskRetention: num(env.TASK_RETENTION, 24 * 60 * 60 * 1000),
};

/** 检查 OpenList 是否已配置 */
export function openlistConfigured() {
  const o = config.openlist;
  if (!o.baseUrl) return false;
  return Boolean(o.token || (o.username && o.password));
}

/** 打印启动配置摘要（隐藏密钥） */
export function printConfig() {
  const mask = (s) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : '(未设置)');
  console.log('─'.repeat(58));
  console.log('  CloudFetch 配置');
  console.log('─'.repeat(58));
  console.log(`  监听端口     : ${config.port}`);
  console.log(`  数据目录     : ${config.dataDir}`);
  console.log(`  临时目录     : ${config.tmpDir}`);
  console.log(`  最大并发     : ${config.download.maxConcurrent}`);
  console.log(`  OpenList     : ${config.openlist.baseUrl || '(未配置)'}`);
  console.log(`  OpenList令牌 : ${mask(config.openlist.token)}`);
  console.log(`  上传目录     : ${config.openlist.uploadDir}`);
  console.log(`  传完删本地   : ${config.openlist.deleteAfterUpload ? '是' : '否'}`);
  console.log(`  面板密码     : ${config.auth.password ? '已设置' : '(无，公开访问)'}`);
  console.log('─'.repeat(58));
}
