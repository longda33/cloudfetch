/**
 * 链接识别：判断一个 URL 属于哪种下载类型，以及如何命名。
 */
import path from 'node:path';

/** 常见视频/音频/文档扩展名，用于从 URL 推断文件名 */
const KNOWN_EXT = new Set([
  'mp4', 'mkv', 'flv', 'ts', 'mov', 'avi', 'webm', 'm4v', 'wmv', 'mpg', 'mpeg',
  'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus',
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz',
  'pdf', 'epub', 'mobi', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg',
  'apk', 'exe', 'dmg', 'iso', 'bin',
  'm3u8', 'mpd',
]);

/**
 * 判断链接类型
 * @returns {'hls'|'dash'|'rtmp'|'http'|'unknown'}
 */
export function detectKind(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    // 不是标准 URL，可能是 rtmp 或裸流地址
    if (/^rtmp/i.test(url)) return 'rtmp';
    return 'unknown';
  }
  const p = u.pathname.toLowerCase();
  if (p.endsWith('.m3u8') || /\/hls\//i.test(p)) return 'hls';
  if (p.endsWith('.mpd')) return 'dash';
  if (u.protocol === 'rtmp:' || u.protocol === 'rtmps:') return 'rtmp';
  if (u.protocol === 'http:' || u.protocol === 'https:') return 'http';
  return 'unknown';
}

/** 从 Content-Disposition 解析文件名 */
export function filenameFromDisposition(cd) {
  if (!cd) return null;
  // filename*=UTF-8''xxx 优先
  let m = /filename\*\s*=\s*([^;]+)/i.exec(cd);
  if (m) {
    let v = m[1].trim().replace(/^["']|["']$/g, '');
    const parts = v.split("''");
    if (parts.length === 2) {
      try {
        return decodeURIComponent(parts[1]);
      } catch {
        /* fallthrough */
      }
    }
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  m = /filename\s*=\s*["']?([^"';]+)["']?/i.exec(cd);
  if (m) {
    try {
      return decodeURIComponent(m[1].trim());
    } catch {
      return m[1].trim();
    }
  }
  return null;
}

/** 从 URL 路径推断文件名 */
export function filenameFromUrl(url, fallbackExt = '') {
  let u;
  try {
    u = new URL(url);
  } catch {
    return `download${fallbackExt ? '.' + fallbackExt : ''}`;
  }
  let base = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
  base = sanitizeFilename(base);

  if (!base) return `download${fallbackExt ? '.' + fallbackExt : ''}`;

  const ext = path.extname(base).replace('.', '').toLowerCase();
  if (ext && KNOWN_EXT.has(ext)) return base;

  // 没扩展名或扩展名不认识：补一个
  if (!ext) {
    const guess = guessExtFromKind(u.pathname);
    return base + (guess ? '.' + guess : fallbackExt ? '.' + fallbackExt : '');
  }
  return base;
}

function guessExtFromKind(p) {
  const s = p.toLowerCase();
  if (s.endsWith('.m3u8')) return 'ts';
  if (s.endsWith('.mpd')) return 'mp4';
  return '';
}

/** 清理文件名中的非法字符，防止路径穿越 */
export function sanitizeFilename(name) {
  if (!name) return '';
  let s = String(name)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  // 防止 Windows 保留名
  if (/^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i.test(s)) s = '_' + s;
  // 限长，保留扩展名
  if (s.length > 180) {
    const ext = path.extname(s);
    s = s.slice(0, 180 - ext.length) + ext;
  }
  return s || 'unnamed';
}

/** 给定 URL 与响应头，决定最终保存文件名 */
export function resolveFilename(url, headers = {}) {
  const fromCd = filenameFromDisposition(headers['content-disposition']);
  if (fromCd) {
    const s = sanitizeFilename(fromCd);
    if (s && s !== 'unnamed') return s;
  }
  const ct = (headers['content-type'] || '').toLowerCase();
  let ext = '';
  if (ct.includes('video/mp4')) ext = 'mp4';
  else if (ct.includes('video/x-flv') || ct.includes('flv')) ext = 'flv';
  else if (ct.includes('mpegurl')) ext = 'm3u8';
  else if (ct.includes('audio/mpeg')) ext = 'mp3';
  else if (ct.includes('application/zip')) ext = 'zip';
  return filenameFromUrl(url, ext);
}

/** 人类可读大小 */
export function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

/** 人类可读速率，如 2.71 MB/s */
export function fmtRate(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '—';
  return `${humanSize(bytesPerSec)}/s`;
}
