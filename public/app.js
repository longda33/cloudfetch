/**
 * CloudFetch 前端逻辑
 * ------------------------------------------------------------------
 * 渲染策略：任务卡按 id 原地 patch（不整块重建），
 * 这样进度条过渡、日志滚动、按钮焦点都不会被打断。
 */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const icon = (name, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

const RUNNING = ['queued', 'downloading', 'uploading'];

const STATUS = {
  queued: { label: '排队中', tone: 'idle' },
  downloading: { label: '下载中', tone: 'run' },
  uploading: { label: '上传中', tone: 'run' },
  done: { label: '已完成', tone: 'ok' },
  failed: { label: '失败', tone: 'err' },
  canceled: { label: '已取消', tone: 'muted' },
};

const KIND = {
  http: { icon: 'file', label: '直链' },
  hls: { icon: 'film', label: 'HLS' },
  rtmp: { icon: 'radio', label: '直播' },
  dash: { icon: 'film', label: 'DASH' },
  unknown: { icon: 'link', label: '链接' },
};

const state = {
  tasks: new Map(),
  /** id → 日志行数组。日志走独立的 log 事件，不随每次进度推送 */
  logs: new Map(),
  es: null,
  authRequired: false,
  limits: {},
  histTotal: 0,
  /** 服务端统计的「今日完成」，由 /api/stats 刷新 */
  todayDone: 0,
  health: null,
};

let toastTimer;

/* ---------------- 通用工具 ---------------- */

function toast(msg, type = '') {
  const el = $('#toast');
  el.className = 'toast show ' + type;
  el.innerHTML = `${icon(type === 'err' ? 'alert' : type === 'ok' ? 'check-circle' : 'info')}<span></span>`;
  el.querySelector('span').textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast ' + type; }, 3200);
}

function fmtBytes(n) {
  if (!n || n < 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : 2) + ' ' + u[i];
}

function fmtSpeed(bps) {
  if (!bps || bps <= 0) return '—';
  return fmtBytes(bps) + '/s';
}

function fmtEta(s) {
  if (!s || s <= 0 || !isFinite(s)) return '—';
  if (s < 60) return Math.round(s) + ' 秒';
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${Math.round(s % 60)} 秒`;
  return `${Math.floor(s / 3600)} 时 ${Math.round((s % 3600) / 60)} 分`;
}

function fmtTime(ms) {
  if (!ms) return '—';
  /**
   * 固定按中国时区显示。
   *
   * 不能用 getFullYear()/getHours()：那些按**浏览器本地时区**算，
   * 用户在 UTC 环境（云主机、远程桌面、系统时区没设）看到的
   * 时间会差 8 小时，和后端日志对不上。
   *
   * Intl 的 timeZone 参数能强制指定时区，不受运行环境影响。
   */
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(new Date(ms))
    .replace(/\//g, '-');
}

function fmtDuration(sec) {
  if (!sec || sec <= 0) return '—';
  if (sec < 60) return sec + ' 秒';
  const m = Math.floor(sec / 60);
  if (m < 60) return m + ' 分' + (sec % 60 ? (sec % 60) + ' 秒' : '');
  return Math.floor(m / 60) + ' 时' + (m % 60) + ' 分';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function kindMeta(t) {
  if (t.live) return { icon: 'radio', label: '直播' };
  return KIND[t.kind] || KIND.unknown;
}

function setPill(sel, stateName, text) {
  const el = $(sel);
  if (!el) return;
  el.dataset.state = stateName;
  const t = el.querySelector('[data-role="text"]');
  if (t) t.textContent = text;
}

/* ---------------- 任务卡渲染 ---------------- */

function stageLabels(t) {
  return t.upload ? ['下载', '上传', '完成'] : ['下载', '完成'];
}

function pipelineHtml(t) {
  const labels = stageLabels(t);
  return `<div class="pipeline" data-role="pipeline">${labels.map((label, i) => `
    ${i ? `<i class="rail" data-rail="${i - 1}" data-state="idle"></i>` : ''}
    <div class="step" data-step="${i}" data-state="idle">
      <span class="step-dot"></span><span class="step-label">${label}</span>
    </div>`).join('')}</div>`;
}

/** 各阶段状态：idle / active / done / error */
function computeStages(t) {
  const n = t.upload ? 3 : 2;
  const states = new Array(n).fill('idle');

  switch (t.status) {
    case 'downloading':
      states[0] = 'active';
      break;
    case 'uploading':
      states[0] = 'done';
      if (n > 1) states[1] = 'active';
      break;
    case 'done':
      states.fill('done');
      break;
    case 'failed': {
      const failedAt = (t.uploaded > 0 && t.upload) ? 1 : 0;
      for (let i = 0; i < failedAt; i++) states[i] = 'done';
      states[failedAt] = 'error';
      break;
    }
    case 'canceled':
      if (t.downloaded > 0) states[0] = 'done';
      break;
    default:
      break; // queued：全部待命
  }
  return states;
}

function metricsHtml(t) {
  const out = [];
  const push = (label, value, cls = '') =>
    out.push(`<span class="metric ${cls}"><em>${label}</em><b>${value}</b></span>`);

  if (t.status === 'queued') push('状态', '等待并发位');

  if (t.status === 'downloading') {
    push('速度', fmtSpeed(t.speed));
    push('已下载', t.total ? `${fmtBytes(t.downloaded)} / ${fmtBytes(t.total)}` : fmtBytes(t.downloaded));
    if (t.eta > 0) push('剩余', fmtEta(t.eta));
    if (t.live && t.segmentsDone) {
      const per = t.segmentSeconds ? ` · 每段 ${Math.round(t.segmentSeconds / 60)} 分钟` : '';
      push('已录', `${t.segmentsDone} 段${per}`);
    }
    // 录制中段已经在往 R2 送，这里显示"已提交"
    if (t.live && t.segmentsSubmitted) {
      push('已提交', `${t.segmentsSubmitted} 段`, 'ok');
    }
  }

  if (t.status === 'uploading') {
    push('已上传', t.total ? `${fmtBytes(t.uploaded)} / ${fmtBytes(t.total)}` : fmtBytes(t.uploaded));
  }

  if (t.status === 'done') {
    if (t.total || t.downloaded) push('大小', fmtBytes(t.total || t.downloaded));
  }

  /**
   * 直播的分段统计统一在这里输出，避免上面几处重复。
   *
   * 口径必须区分三种状态，否则用户会以为"已完成"就是文件已经在网盘里：
   *   已落地 —— MP4 确认出现在 OpenList（segmentsUploaded）
   *   转码中 —— 已提交 Actions，等 MP4 落地
   *   失败   —— 提交失败或转码超时，可重试
   *
   * 合并任务只产出一个 MP4，所以不再按段报"已落地 N 段"，
   * 否则永远显示 0 段，看着像丢了。
   */
  if (t.live && (t.segmentCount || t.segmentsDone)) {
    const total = t.segmentCount || t.segmentsDone || 0;
    const merged = Boolean(t.mergedSubmitted || (t.mergeKeys || []).length);
    const bad = (t.failedSegments || []).length +
      (t.segments || []).filter((s) => s.mp4State === 'failed').length;

    if (t.status === 'done') {
      let s = `分段 ${total} 段`;
      if (merged) {
        if (t.remotePath) s += '，已合并为 1 个 MP4';
        else if (t.mp4State === 'pending') s += '，合并转码中';
        else if (t.mp4State === 'failed') s += '，合并失败';
        else s += '，未合并';
      } else {
        const up = t.segmentsUploaded || 0;
        const pending = (t.segments || []).filter((s) => s.mp4State === 'pending').length;
        if (total) s += `，已落地 ${up} 段`;
        if (pending) s += `，转码中 ${pending} 段`;
        if (bad) s += `，${bad} 段失败`;
      }
      push('录制', s, merged && t.mp4State === 'pending' ? 'ok' : '');
    } else if (t.status === 'uploading' || t.status === 'downloading') {
      // 进行中已在上面显示过「已提交」，这里只补总数
      push('分段', `${total} 段`);
    }
  }

  if (t.remotePath) {
    out.push(`<span class="metric remote" title="${esc(t.remotePath)}">${icon('cloud', 'ic ic-sm')}<b>${esc(t.remotePath)}</b></span>`);
  } else if (t.mp4State === 'pending' && t.expectedPath) {
    out.push(`<span class="metric" title="${esc(t.expectedPath)}">${icon('cloud', 'ic ic-sm')}<b>MP4 生成中…</b></span>`);
  }
  if (t.error) {
    out.push(`<span class="metric err">${icon('alert', 'ic ic-sm')}<b>${esc(t.error)}</b></span>`);
  }

  if (!out.length) push('状态', (STATUS[t.status] || {}).label || t.status);
  return out.join('');
}

function renderTask(t) {
  return `
  <article class="task" data-id="${t.id}" data-status="${t.status}" data-logs-open="0">
    <div class="task-top">
      <span class="task-icon" data-role="icon">${icon(kindMeta(t).icon)}</span>
      <div class="task-main">
        <h3 class="task-name" data-role="name">${esc(t.filename || '解析中…')}</h3>
        <p class="task-url">${esc(t.url)}</p>
      </div>
      <div class="task-actions">
        <button class="btn btn-ghost btn-xs" data-act="cancel" data-id="${t.id}">取消</button>
        <button class="btn btn-ghost btn-xs" data-act="retry" data-id="${t.id}">重试</button>
        <button class="btn btn-ghost btn-xs" data-act="remove" data-id="${t.id}">删除</button>
        <button class="icon-btn is-sm" data-act="toggleLogs" data-id="${t.id}"
                title="查看日志" aria-label="查看日志">${icon('terminal')}</button>
      </div>
    </div>
    ${pipelineHtml(t)}
    <div class="progress" data-role="progress">
      <div class="progress-track"><div class="progress-fill" data-role="fill"></div></div>
      <span class="progress-pct" data-role="pct">0%</span>
    </div>
    <div class="metrics" data-role="metrics"></div>
    <pre class="logs" data-role="logs" id="logs-${t.id}" hidden></pre>
  </article>`;
}

/** 原地更新一张任务卡 */
function patchTask(card, t) {
  card.dataset.status = t.status;

  $('[data-role="icon"]', card).innerHTML = icon(kindMeta(t).icon);

  const name = $('[data-role="name"]', card);
  name.textContent = t.filename || '解析中…';
  name.title = t.filename || t.url || '';

  const urlEl = $('.task-url', card);
  urlEl.textContent = t.url || '';
  urlEl.title = t.url || '';

  const running = RUNNING.includes(t.status);
  $('[data-act="cancel"]', card).hidden = !running;
  $('[data-act="retry"]', card).hidden = t.status !== 'failed';
  $('[data-act="remove"]', card).hidden = running;

  // 管线
  const stages = computeStages(t);
  $$('.step', card).forEach((el, i) => {
    const s = stages[i] || 'idle';
    el.dataset.state = s;
    const dot = $('.step-dot', el);
    dot.innerHTML = s === 'done' ? icon('check', 'ic ic-xs')
      : s === 'error' ? icon('x', 'ic ic-xs')
      : s === 'active' ? '<span class="dot-core"></span>'
      : '';
  });
  $$('.rail', card).forEach((el, i) => {
    el.dataset.state = stages[i] === 'done' ? 'done' : stages[i] === 'active' ? 'active' : 'idle';
  });

  // 进度
  const prog = $('[data-role="progress"]', card);
  const fill = $('[data-role="fill"]', card);
  const pctEl = $('[data-role="pct"]', card);
  const pct = Number(t.percent) || 0;
  const indeterminate = t.status === 'downloading' && !t.total;

  prog.classList.toggle('indeterminate', indeterminate);
  if (indeterminate) {
    fill.style.width = '';
    pctEl.textContent = t.live ? '录制中' : '计算中';
  } else {
    fill.style.width = Math.max(0, Math.min(100, pct)).toFixed(1) + '%';
    pctEl.textContent = Math.round(pct) + '%';
  }

  $('[data-role="metrics"]', card).innerHTML = metricsHtml(t);
  syncLogs(card, t);
}

/** 日志：只在内容变化时重建，且贴底时才自动跟随 */
function syncLogs(card, t) {
  const box = $('[data-role="logs"]', card);
  const all = state.logs.get(t.id) || t.logs || [];
  const logs = Array.isArray(all) ? all.slice(-60) : [];

  if (!logs.length) {
    box.hidden = true;
    box.innerHTML = '';
    box.dataset.sig = '';
    return;
  }

  box.hidden = card.dataset.logsOpen !== '1';

  const sig = `${logs.length}|${logs[logs.length - 1] || ''}`;
  if (box.dataset.sig === sig) return;

  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  const stick = !box.dataset.sig || atBottom;
  box.innerHTML = logs.map((l) => `<div>${esc(l)}</div>`).join('');
  box.dataset.sig = sig;
  if (stick) box.scrollTop = box.scrollHeight;
}

/* ---------------- 列表与概览 ---------------- */

function emptyTasksHtml() {
  return `
  <div class="empty">
    <div class="empty-icon">${icon('inbox')}</div>
    <p class="empty-title">还没有任务</p>
    <p class="empty-sub">在上面粘贴链接，按 Ctrl / ⌘ + Enter 提交</p>
  </div>`;
}

/**
 * 渲染「进行中」面板。
 *
 * 只显示未结束的任务（queued / downloading / uploading）。
 * 之前这里把 state.tasks 全渲染出来，导致已完成的卡片一直挂在
 * 进行中列表里，得手动删才消失。结束的任务应该去「历史记录」看。
 *
 * 例外：刚结束的任务先留一会儿，让用户能看到「完成」状态，
 * 过 FINISHED_LINGER_MS 后自动移出。
 */
const FINISHED_LINGER_MS = 60 * 1000;

function isActiveTask(t) {
  if (RUNNING.includes(t.status)) return true;
  // 刚结束不久的留一会儿
  return Boolean(t.finishedAt && Date.now() - t.finishedAt < FINISHED_LINGER_MS);
}

function renderAll() {
  const all = [...state.tasks.values()];
  const list = all
    .filter(isActiveTask)
    .sort((a, b) => b.createdAt - a.createdAt);
  const el = $('#taskList');

  if (!list.length) {
    el.innerHTML = emptyTasksHtml();
  } else {
    el.innerHTML = list.map(renderTask).join('');
    $$('.task', el).forEach((card) => {
      const t = state.tasks.get(card.dataset.id);
      if (t) patchTask(card, t);
    });
  }

  updateStats();
  updateTabCounts();
}

function upsertTask(t) {
  state.tasks.set(t.id, t);
  if (Array.isArray(t.logs)) state.logs.set(t.id, t.logs);
  const el = $('#taskList');

  // 结束超过保留时间的任务，不进「进行中」列表
  if (!isActiveTask(t)) {
    el.querySelector(`[data-id="${t.id}"]`)?.remove();
    if (!el.querySelector('.task')) el.innerHTML = emptyTasksHtml();
    updateStats();
    updateTabCounts();
    return;
  }

  let card = el.querySelector(`[data-id="${t.id}"]`);
  if (!card) {
    el.querySelector('.empty')?.remove();
    const tmp = document.createElement('div');
    tmp.innerHTML = renderTask(t);
    card = tmp.firstElementChild;
    el.prepend(card);
  }

  patchTask(card, t);
  updateStats();
  updateTabCounts();
}

/**
 * 判断某个时间戳是不是「今天」（按中国时区）。
 *
 * 不能用 `new Date().toDateString()` 比较：那按浏览器本地时区算，
 * 用户在 UTC 环境（云主机/远程桌面）时，"今天"会差 8 小时。
 * 统一转成 YYYY-MM-DD 字符串比较，且两边都用 Asia/Shanghai。
 */
function ymdCN(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

function isTodayCN(ms) {
  if (!ms) return false;
  return ymdCN(ms) === ymdCN(Date.now());
}

function updateStats() {
  const tasks = [...state.tasks.values()];
  const running = tasks.filter((t) => RUNNING.includes(t.status));
  const speed = running.reduce((a, t) => a + (t.speed || 0), 0);

  $('#statRunning').textContent = running.length;
  $('#statSpeed').textContent = speed > 0 ? fmtSpeed(speed) : '—';
  $('#statSpeedSub').textContent = running.length ? `${running.length} 个任务在跑` : '空闲';

  renderTodayDone();
}

/**
 * 「今日完成」必须由服务端全量统计。
 *
 * 之前用前端缓存的历史列表算，有两个坑：
 *   1) 那份列表只有当前页（20 条）且带搜索/状态筛选 ——
 *      搜一次「失败」，这个数字就归零了
 *   2) 不打开历史面板就一直是空数组，重启后首屏永远显示 0
 */
async function refreshTodayDone() {
  try {
    const r = await fetch('/api/stats');
    if (!r.ok) return;
    const d = await r.json();
    state.todayDone = d.todayDone || 0;
    renderTodayDone();
  } catch {
    /* 概览数字，失败就保持原值 */
  }
}

/** 本地兜底：服务端还没刷新时，至少把刚完成的任务算进去 */
function countDoneTodayLocal() {
  let n = 0;
  for (const t of state.tasks.values()) {
    if (t.status === 'done' && isTodayCN(t.finishedAt || t.createdAt)) n++;
  }
  return n;
}

function renderTodayDone() {
  const n = Math.max(state.todayDone || 0, countDoneTodayLocal());
  $('#statDone').textContent = n;
  $('#statDoneSub').textContent = n ? `今天 ${n} 个任务` : '今天还没有完成任务';
}

function updateTabCounts() {
  const tasks = [...state.tasks.values()];
  const running = tasks.filter((t) => RUNNING.includes(t.status)).length;
  const finished = tasks.filter((t) => !RUNNING.includes(t.status)).length;
  $('#cntActive').textContent = running;

  /**
   * 历史记录数量必须以服务端的总数为准。
   *
   * 之前写成 `state.histTotal || finished`，问题有两个：
   *   1) 登录后 state.histTotal 还是 0，只能拿内存里的 finished 兜底，
   *      而历史记录大多存在 OpenList 上、不在内存里，所以数量偏少；
   *   2) 点进历史记录后才加载，这时 histTotal 才被填上，
   *      于是「点一下数字才对」。
   *
   * 现在：histTotal 有值就用它，没值时才用 finished 兜底。
   * 并且在登录成功后主动拉一次总数，见 refreshHistoryCount()。
   */
  $('#cntHistory').textContent =
    state.histTotal > 0 ? state.histTotal : finished;
}

/**
 * 只拉历史记录的总数，不加载列表。
 *
 * 登录后立刻调一次，让「历史记录」标签上的数字在用户点进去之前就是对的。
 * per_page=1 是为了少传数据 —— 只要 d.total。
 */
async function refreshHistoryCount() {
  try {
    const r = await fetch('/api/history?page=1&pageSize=1');
    if (!r.ok) return;
    const d = await r.json();
    if (typeof d.total === 'number') {
      state.histTotal = d.total;
      updateTabCounts();
    }
  } catch {
    /* 拉不到就保持原样，不打扰用户 */
  }
}

/* ---------------- SSE ---------------- */

/** 连续失败次数。用于区分「网络抖动」和「会话过期」 */
let sseFailures = 0;

function connectSSE() {
  if (state.es) state.es.close();
  const es = new EventSource('/api/events');
  state.es = es;

  es.addEventListener('open', () => {
    sseFailures = 0;
    setPill('#chipSse', 'on', '已连接');
  });

  es.addEventListener('snapshot', (e) => {
    const d = JSON.parse(e.data);
    state.tasks.clear();
    state.logs.clear();
    for (const t of d.tasks) {
      state.tasks.set(t.id, t);
      if (Array.isArray(t.logs)) state.logs.set(t.id, t.logs);
    }
    renderAll();
  });

  es.addEventListener('task', (e) => {
    const t = JSON.parse(e.data);
    // 全量快照里带日志，增量更新不带（省带宽）
    if (Array.isArray(t.logs)) state.logs.set(t.id, t.logs);
    const wasRunning = RUNNING.includes(t.status);
    upsertTask(t);
    // 任务刚结束 → 刷新历史计数（历史面板打开时顺带刷新列表）
    if (!wasRunning && t.finishedAt) {
      refreshTodayDone();
      if (!$('#panelHistory').hidden) loadHistory();
      else updateTabCounts();
    }
  });

  es.addEventListener('removed', (e) => {
    const d = JSON.parse(e.data);
    state.tasks.delete(d.id);
    state.logs.delete(d.id);
    $(`[data-id="${d.id}"]`)?.remove();
    if (!state.tasks.size) renderAll();
    updateStats();
    updateTabCounts();
  });

  es.addEventListener('log', (e) => {
    const d = JSON.parse(e.data);
    const arr = state.logs.get(d.id) || [];
    arr.push(d.line);
    if (arr.length > 200) arr.shift();
    state.logs.set(d.id, arr);
    // 日志面板开着就实时追加，不必等下一次 task 事件
    const card = $(`[data-id="${d.id}"]`);
    if (card) syncLogs(card, { id: d.id });
  });

  es.onerror = () => {
    setPill('#chipSse', 'off', '重连中');
    sseFailures++;

    /**
     * EventSource 拿不到 HTTP 状态码，401（会话过期）和网络抖动看起来一样。
     * 连续失败 3 次就主动探一次 /api/tasks：
     *   - 401 → 会话确实过期了，关掉 SSE 弹登录框，别再每 3 秒撞一次
     *   - 其它 → 当网络问题，继续自动重连
     */
    if (sseFailures === 3) {
      fetch('/api/tasks')
        .then((r) => {
          if (r.status === 401) {
            es.close();
            showLogin();
          }
        })
        .catch(() => {});
    }

    if (es.readyState === EventSource.CLOSED) setTimeout(connectSSE, 3000);
  };
}

/* ---------------- 操作 ---------------- */

function updateLinkCount() {
  const input = $('#urlInput');
  const n = input.value.split(/\r?\n/).map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#')).length;
  const el = $('#linkCount');
  el.textContent = `${n} 个链接`;
  el.classList.toggle('show', n > 0);
}

async function addTasks() {
  const text = $('#urlInput').value.trim();
  if (!text) return toast('请先粘贴链接', 'err');

  const upload = $('#uploadToggle').checked;
  const btn = $('#btnAdd');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = '提交中…';

  try {
    /**
     * 只有一种下载模式了：直播按 5 分钟切段存 R2，结束后由 Actions
     * 合并转码。segment 恒为 true —— 普通直链/HLS 本来就不走分段
     * 逻辑（downloader 会自己判断），传 true 不影响它们。
     */
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, upload, segment: true }),
    });
    if (res.status === 401) { showLogin(); return; }

    const j = await res.json();
    if (!res.ok) throw new Error(j.error || '创建失败');

    $('#urlInput').value = '';
    updateLinkCount();

    let msg = `已添加 ${j.created.length} 个任务`;
    if (j.errors?.length) msg += `，${j.errors.length} 个失败`;
    toast(msg, 'ok');
    for (const t of j.created) upsertTask(t);
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

async function act(kind, id) {
  try {
    if (kind === 'cancel') {
      const r = await fetch(`/api/tasks/${id}/cancel`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json()).error);
      toast('已取消');
    } else if (kind === 'retry') {
      const t = state.tasks.get(id);
      if (!t) throw new Error('任务不存在');
      const r = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: t.url, upload: t.upload !== false }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '重试失败');
      for (const nt of j.created) upsertTask(nt);
      toast('已重新加入队列', 'ok');
    } else if (kind === 'remove') {
      /**
       * 删除任务。
       *
       * 如果这个任务有「转码失败的分段」，默认**不删 R2 上的源文件** ——
       * 那是重跑的唯一希望。删任务只清界面和本地磁盘。
       *
       * 但用户可能真的想清空间，所以二次询问：
       *   取消     → 什么都不做
       *   确定     → 删任务，保留失败分段的 R2 源文件（默认行为）
       *   强制清理 → 连源文件一起删（force=1）
       *
       * 出过真实事故：一场 2.4 小时直播转码超时，用户看到"失败"
       * 就点删除，29 段源文件全被清掉，修好后也没法重跑。
       */
      const t = state.tasks.get(id);
      const segs = t?.segments || [];
      /**
       * 合并任务的失败状态挂在任务上（t.mp4State === 'failed'），
       * 段本身还是 staged —— 只数 segment.mp4State === 'failed' 会得到 0，
       * 于是最关键的那类任务反而不会弹确认框。
       */
      const mergedFailed = Boolean(t?.mergedSubmitted) && t?.mp4State === 'failed';
      const failedCount = mergedFailed
        ? segs.length || 1
        : segs.filter((s) => s.mp4State === 'failed').length +
          (t?.mp4State === 'failed' && !segs.length ? 1 : 0);

      let force = false;
      if (failedCount > 0) {
        /**
         * 用原生 confirm 两段询问，不引入自定义弹窗组件。
         *
         * 第一问：确定要移除这个任务吗（说明源文件会保留）
         * 第二问：要不要连源文件一起删（危险操作，默认否）
         *
         * 这样默认路径（点两下"确定"）是**安全**的：只移除列表项，
         * R2 上的失败分段保留。真要清空间得在第二问点"确定"，
         * 而那一问的文案写明了后果。
         */
        const what = mergedFailed
          ? `这个任务的合并转码失败，${failedCount} 个源分段还在 R2 上`
          : `这个任务有 ${failedCount} 个转码失败的分段`;
        const okRemove = confirm(
          `${what}。\n\n`
          + '从列表移除后，R2 上的源文件会保留，方便以后修复了重新转码。\n\n'
          + '确定要移除吗？',
        );
        if (!okRemove) return;

        force = confirm(
          `要不要连 R2 上的 ${failedCount} 个分段源文件一起删掉？\n\n`
          + '⚠️ 删了就再也无法重跑转码，这个视频会永久丢失。\n\n'
          + '点「取消」= 保留源文件（推荐）\n'
          + '点「确定」= 彻底删除',
        );
      }

      const url = force ? `/api/tasks/${id}?force=1` : `/api/tasks/${id}`;
      const r = await fetch(url, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json()).error);
      state.tasks.delete(id);
      state.logs.delete(id);
      $(`[data-id="${id}"]`)?.remove();
      if (!state.tasks.size) renderAll();
      updateStats();
      updateTabCounts();
      toast(force ? '已删除（含 R2 源文件）' : '已移除（源文件保留）', 'ok');
    }
  } catch (e) {
    toast(e.message, 'err');
  }
}

/**
 * 配置类状态（健康检查 + 磁盘）：只读环境变量和本地 statfs，秒回。
 *
 * 启动时 await 它没问题。真正打网络的 /api/status 拆到
 * refreshServiceStatus() 里，见下面的说明。
 */
async function refreshChips() {
  try {
    const h = await (await fetch('/api/health')).json();
    state.health = h;
    state.authRequired = h.authRequired;
    state.limits = h.limits || {};

    if (state.limits.maxConcurrent != null) {
      $('#statRunningSub').textContent = `并发上限 ${state.limits.maxConcurrent}`;
    }
    // 注意：不要再写 statDoneSub。
    // 那个位置现在显示「今日完成」的文案，由 updateStats() 维护。
    // 之前这里会把「单文件上限 20.00 GB」覆盖上去，
    // 刷新 health 之后就看不到今日统计了。
  } catch { /* 静默 */ }

  try {
    const d = await (await fetch('/api/disk')).json();
    if (d.total > 0) {
      const used = ((d.total - d.free) / d.total) * 100;
      setPill('#chipDisk', used > 90 ? 'off' : 'on', `磁盘 ${d.freeText} 可用`);
      $('#statDisk').textContent = d.freeText;
      $('#statDiskSub').textContent = `已用 ${used.toFixed(0)}% · 共 ${d.totalText}`;
      const bar = $('#diskBar');
      bar.style.width = Math.min(100, used).toFixed(1) + '%';
      bar.className = used > 90 ? 'err' : used > 75 ? 'warn' : '';
    }
  } catch { /* 静默 */ }
}

/**
 * 服务连通性探测（R2 / OpenList）。
 *
 * 和 refreshChips 的分工：
 *   health = 配置了没有（读环境变量，秒回）
 *   status = **现在能不能用**（真发请求到 R2 / OpenList，可能慢到十几秒）
 *
 * 这个函数**永远不要 await 在启动路径上**：
 * 后端探测超时是 R2 8s + OpenList 20s，await 的话 R2 挂了整页要白屏 8 秒，
 * OpenList 挂了要白屏 20 秒才能看到任务列表 —— 状态灯不该拖累主界面。
 */
async function refreshServiceStatus() {
  let resp;
  try {
    resp = await fetch('/api/status');
  } catch (e) {
    setPill('#chipR2', 'off', 'R2 未知');
    setPill('#chipOpenlist', 'off', 'OpenList 未知');
    $('#chipR2').title = `状态探测失败：${e.message}`;
    $('#chipOpenlist').title = `状态探测失败：${e.message}`;
    return;
  }

  /**
   * 未登录时 /api/status 返回 401。
   * 这时显示"异常"是误导 —— 服务可能完全正常，只是没通过鉴权。
   * 回到中性态，等登录后再探测。
   */
  if (resp.status === 401) {
    setPill('#chipR2', 'idle', 'R2');
    setPill('#chipOpenlist', 'idle', 'OpenList');
    $('#chipR2').title = '登录后显示 Cloudflare R2 连通性';
    $('#chipOpenlist').title = '登录后显示 OpenList 连通性';
    return;
  }

  let s;
  try {
    s = await resp.json();
  } catch {
    return;
  }

  // R2
  if (s.r2?.configured === false) {
    // 没配置 ≠ 故障：不转码是合法的使用方式，用中性色，别吓人
    setPill('#chipR2', 'idle', 'R2 未配置');
    $('#chipR2').title = '未配置 Cloudflare R2，转码链路关闭（原始文件直接传 OpenList）';
  } else if (s.r2?.ok) {
    setPill('#chipR2', 'on', `R2 正常${s.r2.ms ? ` ${s.r2.ms}ms` : ''}`);
    $('#chipR2').title = `Cloudflare R2 连通正常（桶 ${s.r2.bucket || '-'}，${s.r2.ms || 0}ms）`;
  } else {
    setPill('#chipR2', 'off', 'R2 异常');
    $('#chipR2').title = `Cloudflare R2 不可用：${s.r2?.reason || '未知原因'}`;
  }

  // OpenList
  if (s.openlist?.configured === false) {
    setPill('#chipOpenlist', 'idle', 'OpenList 未配置');
    $('#chipOpenlist').title = '未配置 OpenList，下载的文件只保留在服务器本地';
  } else if (s.openlist?.ok) {
    setPill('#chipOpenlist', 'on', 'OpenList 正常');
    $('#chipOpenlist').title = `OpenList 连通正常（用户 ${s.openlist.user || '-'}）`;
  } else {
    setPill('#chipOpenlist', 'off', 'OpenList 异常');
    $('#chipOpenlist').title = `OpenList 不可用：${s.openlist?.reason || '未知原因'}`;
  }
}

/* ---------------- 登录 ---------------- */

function showLogin() {
  $('#loginMask').classList.add('show');
  $('#pwdInput').focus();
}

async function doLogin() {
  const password = $('#pwdInput').value;
  const btn = $('#btnLogin');
  btn.disabled = true;
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (r.ok) {
      $('#loginMask').classList.remove('show');
      $('#pwdInput').value = '';
      connectSSE();
      // 未登录时 /api/health 不下发 openlistUrl，登录后立刻补一次
      refreshChips();
      // 状态灯要等登录后才探得动（未登录是 401），这里不 await
      refreshServiceStatus();
      refreshTodayDone();
      refreshHistoryCount();
      toast('登录成功', 'ok');
    } else {
      // 429（尝试过多）和 503（未配置密码）都带上服务端的说明
      const j = await r.json().catch(() => ({}));
      toast(j.error || '密码错误', 'err');
    }
  } catch (e) {
    // 网络断了 / 服务没起来时 fetch 会 reject，之前这里是未捕获的 Promise
    toast(`无法连接服务：${e.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

function showConfigMissing() {
  $('#loginDialog').innerHTML = `
    <div class="dialog-icon warn">${icon('alert')}</div>
    <h2 id="loginTitle">未配置访问密码</h2>
    <div class="dialog-body">
      <p>为安全起见，本服务必须设置 <code>PANEL_PASSWORD</code> 才能使用 —— 它能往你的 OpenList 写入任意文件。</p>
      <p>前往 <b>GitHub 仓库 → Settings → Secrets and variables → Actions</b>，添加 Secret <code>PANEL_PASSWORD</code>，然后重新运行 <b>Deploy to Cloady</b> 工作流。</p>
      <p class="center">配置生效后刷新本页即可。</p>
    </div>`;
  $('#loginMask').classList.add('show');
}

/* ---------------- 历史记录 ---------------- */

const hist = { page: 1, pageSize: 20, q: '', status: '', pages: 1 };

function renderHistItem(h) {
  const km = h.live ? { icon: 'radio' } : kindMeta(h);

  // 转码状态先算出来：徽章、meta、重试按钮都要用
  const segs = h.segments || [];
  /**
   * 合并任务：整场一个 MP4，状态挂在任务上（h.mp4State），
   * 段只有 staged / merged 两种，不会出现 pending。
   * 不能再用「有几段 pending」去算，那样永远算出 0。
   *
   * 旧记录没有 merged 字段，按同样特征兜底推断：段全在 R2、
   * 没有任何一段落地。这样历史里的老任务也能显示「重新合并」而不是
   * 「N 段未完成」。
   */
  const merged = Boolean(h.merged) ||
    (segs.length > 0 &&
      segs.every((s) => s.mp4State === 'staged' || s.mp4State === 'merged') &&
      !h.remotePath);
  const pendingMp4 = merged
    ? h.mp4State === 'pending'
      ? 1
      : 0
    : (h.transcodePending ?? segs.filter((s) => s.mp4State === 'pending').length);
  const failedMp4 = merged
    ? h.mp4State === 'failed'
      ? 1
      : 0
    : (h.transcodeFailed ?? segs.filter((s) => s.mp4State === 'failed').length);

  const badge = {
    done: `<span class="badge done">${icon('check', 'ic ic-xs')}完成</span>`,
    failed: `<span class="badge failed">${icon('x', 'ic ic-xs')}失败</span>`,
    canceled: `<span class="badge canceled">取消</span>`,
  }[h.status] || '';

  /**
   * 转码徽章。
   * 没有它的话「完成」会被理解成"文件已经在网盘里"，
   * 而实际上 MP4 可能还在 Actions 里跑。
   */
  const tcBadge = pendingMp4
    ? `<span class="badge processing">${merged ? '合并转码中' : '转码中'}</span>`
    : failedMp4
      ? '<span class="badge failed">转码失败</span>'
      : '';

  // 直播的模式标记：分段 / 全段
  const modeTag = h.live
    ? h.segment === false
      ? '<span class="badge mode">全段</span>'
      : '<span class="badge mode">分段</span>'
    : '';

  const meta = [`<span>${fmtTime(h.createdAt)}</span>`];
  if (h.size) meta.push(`<span>大小 <b>${fmtBytes(h.size)}</b></span>`);
  if (h.duration) meta.push(`<span>耗时 <b>${fmtDuration(h.duration)}</b></span>`);

  /**
   * 待处理数量。
   *
   * 合并任务：只有"合并失败"才算待处理，数量恒为 1（一次合并）。
   * 不能按段数算 —— 段全在 R2 里、MP4 还没生成时，会显示成
   * 「N 段未完成」并弹出一个「重传 N」按钮，点下去还会拆成 N 个 MP4。
   *
   * 非合并任务：没着落的段 = 总数 - 已落地 - 转码中。
   */
  let missing = 0;
  if (merged) {
    const total = h.segmentCount || segs.length || 0;
    const staged = h.segmentsSubmitted || 0;
    let seg = `<span>分段 <b>${total}</b> 段`;
    if (h.remotePath) {
      seg += `，已合并为 <b class="ok">1 个 MP4</b>`;
    } else if (pendingMp4) {
      seg += `，<b class="ok">合并转码中</b>`;
      if (staged) seg += `（已存 R2 ${staged} 段）`;
    } else if (failedMp4) {
      missing = 1;
      seg += `，<b class="err">合并失败</b>`;
    } else if (staged) {
      /**
       * 旧记录：段都在 R2，但没有 merged 字段、也没有 mp4State，
       * 无法判断 MP4 到底生成没有。给一个「重新合并」的入口，
       * 总比显示成「已完成」然后让用户去网盘里找强。
       */
      missing = 1;
      seg += `，已存 R2 ${staged} 段（合并状态未知）`;
    }
    seg += '</span>';
    meta.push(seg);
  } else if (h.live && h.segment !== false) {
    const total = h.segmentCount || 0;
    const up = h.segmentsUploaded || 0;
    missing = Math.max(0, total - up - pendingMp4);
    let seg = `<span>分段 <b>${total}</b> 段`;
    if (total) {
      seg += `，已落地 <b class="${up === total ? 'ok' : ''}">${up}</b> 段`;
      if (pendingMp4) seg += `，<b class="ok">${pendingMp4}</b> 段转码中`;
      if (missing) seg += `，<b class="err">${missing}</b> 段未完成`;
    }
    seg += '</span>';
    meta.push(seg);
  } else if (h.mp4State === 'pending') {
    meta.push('<span class="ok">MP4 生成中，稍后自动出现在 OpenList</span>');
  } else if (h.upload && !h.remotePath && (h.size || 0) > 0) {
    missing = 1;
    meta.push('<span class="err">上传未完成</span>');
  }
  if (h.remotePath) meta.push(`<span class="ok" title="${esc(h.remotePath)}">${icon('cloud', 'ic ic-xs')} ${esc(h.remotePath)}</span>`);
  if (h.mergeError) meta.push(`<span class="err" title="${esc(h.mergeError)}">${esc(h.mergeError)}</span>`);
  if (h.error) meta.push(`<span class="err" title="${esc(h.error)}">${esc(h.error)}</span>`);

  // 目录：优先用后端算好的 remoteDir，其次从 remotePath / 预期路径推
  const dir =
    h.remoteDir ||
    folderOf(h.remotePath) ||
    folderOf(h.expectedPath) ||
    folderOf((h.segments || []).find((s) => s.remotePath)?.remotePath || '');

  const folderBtn = dir
    ? `<button class="btn btn-ghost btn-xs" data-hact="folder" data-hid="${h.id}"
         data-dir="${esc(dir)}"
         title="在 OpenList 打开 ${esc(dir)}">${icon('inbox', 'ic ic-xs')}文件夹</button>`
    : '';

  /**
   * 有"没着落"的段就显示「重传」。
   *
   * 注意不能用 missing + failedMp4：failed 的段本来就落在 missing 里
   * （它既没有 remotePath 也不在 pending），再减一次会得到 2 倍的数字，
   * 曾经显示成「重传 4」而实际只有 2 段。failedMp4 只用于徽章。
   */
  const needRetry = missing;
  const retryLabel = merged ? '重新合并' : `重传 ${needRetry}`;
  const retryUpBtn = needRetry
    ? `<button class="btn btn-warn btn-xs" data-hact="retryup" data-hid="${h.id}"
         title="${merged ? '重新提交一次整场合并转码' : `${needRetry} 段未完成，点击重试`}">${icon('refresh', 'ic ic-xs')}${retryLabel}</button>`
    : '';

  return `
  <div class="hist-item" data-hid="${h.id}" data-url="${esc(h.url)}" data-rpath="${esc(h.remotePath || '')}" data-dir="${esc(dir)}" data-segment="${h.segment === false ? '0' : '1'}">
    <span class="hist-icon">${icon(km.icon)}</span>
    <div class="hist-body">
      <div class="hist-title">
        <span title="${esc(h.filename || h.url)}">${esc(h.filename || '(未命名)')}</span>
        ${badge}${modeTag}${tcBadge}
      </div>
      <div class="hist-url" title="${esc(h.url)}">${esc(h.url)}</div>
      <div class="hist-meta">${meta.join('')}</div>
    </div>
    <div class="hist-acts">
      ${folderBtn}${retryUpBtn}
      <button class="btn btn-ghost btn-xs" data-hact="copy" data-hid="${h.id}">复制</button>
      <button class="btn btn-ghost btn-xs" data-hact="retry" data-hid="${h.id}">重下</button>
      <button class="btn btn-danger btn-xs" data-hact="del" data-hid="${h.id}">删除</button>
    </div>
  </div>`;
}

/** 从远端文件路径取出所在目录：/a/b/c.flv → /a/b */
function folderOf(remotePath) {
  if (!remotePath) return '';
  const i = remotePath.lastIndexOf('/');
  return i > 0 ? remotePath.slice(0, i) : '/';
}

async function loadHistory() {
  const el = $('#histList');
  if (!el) return;
  el.innerHTML = `<div class="empty"><p class="empty-sub">加载中…</p></div>`;

  try {
    const qs = new URLSearchParams({
      page: hist.page, pageSize: hist.pageSize, q: hist.q, status: hist.status,
    });
    const r = await fetch(`/api/history?${qs}`);
    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) throw new Error((await r.json()).error || '加载失败');

    const d = await r.json();
    hist.pages = d.pages;
    state.histTotal = d.total;
    updateStats();

    if (!d.items.length) {
      el.innerHTML = `
      <div class="empty">
        <div class="empty-icon">${icon('layers')}</div>
        <p class="empty-title">${hist.q || hist.status ? '没有匹配的记录' : '还没有历史记录'}</p>
        <p class="empty-sub">${hist.q || hist.status ? '换个关键字或状态试试' : '完成的任务会自动出现在这里'}</p>
      </div>`;
    } else {
      el.innerHTML = d.items.map(renderHistItem).join('');
    }

    const pager = $('#histPager');
    pager.hidden = d.pages <= 1;
    $('#histPageInfo').textContent = `${d.page} / ${d.pages}`;
    $('#histPrev').disabled = d.page <= 1;
    $('#histNext').disabled = d.page >= d.pages;

    updateTabCounts();
  } catch (e) {
    el.innerHTML = `<div class="empty"><p class="empty-sub">加载失败：${esc(e.message)}</p></div>`;
  }
}

function switchTab(name) {
  const isHist = name === 'history';

  /**
   * 切 tab 时保持滚动位置。
   *
   * 之前的问题：切换后整个页面跳到顶部。
   * 原因是面板一隐一显导致文档高度突变，浏览器把 scrollY 钳到了 0。
   * 这里在切换前记下位置，切换后立刻还原（用 instant 避免滚动动画）。
   */
  const keepY = window.scrollY;

  $('#panelActive').hidden = isHist;
  $('#panelHistory').hidden = !isHist;
  $('#tabActive').setAttribute('aria-selected', String(!isHist));
  $('#tabHistory').setAttribute('aria-selected', String(isHist));
  document.body.dataset.view = isHist ? 'history' : 'active';

  window.scrollTo({ top: keepY, behavior: 'instant' });

  if (isHist) loadHistory();
}

/* ---------------- 主题 ---------------- */

function applyTheme(mode, persist = true) {
  document.documentElement.dataset.theme = mode;
  const btn = $('#btnTheme');
  btn.innerHTML = icon(mode === 'light' ? 'moon' : 'sun');
  btn.title = mode === 'light' ? '切换到深色主题' : '切换到浅色主题';
  if (persist) {
    try { localStorage.setItem('cf-theme', mode); } catch { /* ignore */ }
  }
}

/* ---------------- 事件绑定 ---------------- */

$('#composer').addEventListener('submit', (e) => { e.preventDefault(); addTasks(); });
$('#urlInput').addEventListener('input', updateLinkCount);
$('#urlInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addTasks(); }
});

/**
 * 重新拉一遍任务列表。
 *
 * 「清空已结束」现在会保留「有转码失败源分段」的任务（否则源文件会变成
 * 界面上的孤儿）。所以不能像以前那样在本地把所有非运行任务删掉 ——
 * 那样会和后端不一致，下一次 SSE 快照又把它们"变回来"。
 */
async function reloadTasks() {
  try {
    const r = await fetch('/api/tasks');
    if (!r.ok) return;
    const d = await r.json();
    state.tasks.clear();
    state.logs.clear();
    for (const t of d.tasks || []) {
      state.tasks.set(t.id, t);
      if (Array.isArray(t.logs)) state.logs.set(t.id, t.logs);
    }
    renderAll();
  } catch {
    /* 拉不到就保持现状，等下一次 SSE */
  }
}

$('#btnClear').addEventListener('click', async () => {
  try {
    const r = await fetch('/api/tasks/clear', { method: 'POST' });
    if (r.status === 401) { showLogin(); return; }
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '清空失败');
    await reloadTasks();
    let msg = `已清空 ${j.removed ?? 0} 条`;
    if (j.kept) {
      msg += `；${j.kept} 条转码失败的任务因保留源文件未清理，可单独重试或删除`;
    }
    toast(msg, j.kept ? 'warn' : 'ok');
  } catch (e) {
    // 之前没有 try：会话过期时 j.removed 是 undefined，
    // 会弹出「已清空 undefined 条」，用户以为成功了
    toast(e.message, 'err');
  }
});

$('#btnLogin').addEventListener('click', doLogin);
$('#pwdInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

$('#tabActive').addEventListener('click', () => switchTab('active'));
$('#tabHistory').addEventListener('click', () => switchTab('history'));

$('#btnTheme').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
});

// 历史：搜索（防抖）、筛选、翻页、刷新、清空
let histTimer;
$('#histSearch').addEventListener('input', (e) => {
  clearTimeout(histTimer);
  histTimer = setTimeout(() => {
    hist.q = e.target.value.trim();
    hist.page = 1;
    loadHistory();
  }, 320);
});

$('#histStatus').addEventListener('change', (e) => {
  hist.status = e.target.value;
  hist.page = 1;
  loadHistory();
});

$('#histPrev').addEventListener('click', () => {
  if (hist.page > 1) { hist.page--; loadHistory(); }
});
$('#histNext').addEventListener('click', () => {
  if (hist.page < hist.pages) { hist.page++; loadHistory(); }
});
$('#btnHistRefresh').addEventListener('click', loadHistory);

$('#btnHistClear').addEventListener('click', async () => {
  if (!confirm('确定清空全部历史记录？此操作不可恢复。')) return;
  try {
    const r = await fetch('/api/history', { method: 'DELETE' });
    if (r.status === 401) { showLogin(); return; }
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '清空失败');
    toast(`已清空 ${j.removed ?? 0} 条历史`);
    hist.page = 1;
    state.histTotal = 0;
    loadHistory();
  } catch (e) {
    toast(e.message, 'err');
  }
});

// 历史条目操作
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-hact]');
  if (!btn) return;

  const { hact, hid } = btn.dataset;
  const item = btn.closest('.hist-item');
  const url = item?.dataset.url || '';

  if (hact === 'copy') {
    try {
      await navigator.clipboard.writeText(url);
      toast('链接已复制', 'ok');
    } catch {
      toast('复制失败，请手动选择', 'err');
    }
  } else if (hact === 'folder') {
    // 打开 OpenList 里该任务的上传文件夹
    const dir =
      item?.dataset.dir ||
      (item?.dataset.rpath ? folderOf(item.dataset.rpath) : '');
    if (!dir) return toast('这条记录没有远端目录（可能没上传）', 'err');
    const link = openlistFolderUrl(dir);
    if (!link) return toast('未配置 OpenList 地址', 'err');
    window.open(link, '_blank', 'noopener');
  } else if (hact === 'retryup') {
    // 重试上传失败的分段 / 重新提交合并
    const hid = item?.dataset.hid;
    if (!hid) return;
    /**
     * 必须禁用的是按钮本身。
     *
     * 之前写成 `item.disabled = true`，而 item 是 .hist-item 这个 div ——
     * 给 div 设 disabled 没有任何效果，请求还没回来时再点一下就会
     * 再发一次。合并任务连点两次 = 两次 workflow_dispatch，
     * 白白多跑一个 3 小时的 Actions。
     */
    btn.disabled = true;
    try {
      const r = await fetch(`/api/tasks/${hid}/retry-upload`, { method: 'POST' });
      if (r.status === 401) { showLogin(); return; }
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      /**
       * 接口是 202 fire-and-forget，返回里只有 segments（待处理数量），
       * 没有 submitted/failed —— 那是同步时代的字段。具体成败看任务日志。
       */
      toast(
        j.merged
          ? `已重新提交合并转码${j.missing ? `（含 ${j.missing} 段待补传）` : ''}，完成后 MP4 会出现在网盘`
          : `已提交 ${j.segments || 0} 段重传，进度见任务日志`,
        'ok',
      );
      loadHistory();
      // 后台任务是异步的，3 秒后再刷一次才能看到状态变化
      setTimeout(loadHistory, 3000);
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  } else if (hact === 'retry') {
    try {
      // 沿用原任务的模式重下
      const r = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, upload: true, segment: item?.dataset.segment !== '0' }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      for (const t of j.created) upsertTask(t);
      toast('已重新加入下载队列', 'ok');
      switchTab('active');
    } catch (err) {
      toast(err.message, 'err');
    }
  } else if (hact === 'del') {
    const r = await fetch(`/api/history/${hid}`, { method: 'DELETE' });
    if (r.ok) {
      toast('已删除');
      loadHistory();
    } else {
      toast('删除失败', 'err');
    }
  }
});

/**
 * 拼 OpenList 的文件夹浏览地址。
 *
 * OpenList 前端是 SPA，目录路径直接接在站点根后面即可，
 * 例如 https://host/od-20200439/cloudfetch/2026-11-07
 */
function openlistFolderUrl(dir) {
  const base = (state.health?.openlistUrl || '').replace(/\/+$/, '');
  if (!base || !dir) return '';
  return `${base}${dir.startsWith('/') ? '' : '/'}${dir}`;
}

// 任务操作
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;

  const { act: kind, id } = btn.dataset;

  if (kind === 'toggleLogs') {
    const card = btn.closest('.task');
    const box = card?.querySelector('[data-role="logs"]');
    if (!card || !box) return;

    const open = card.dataset.logsOpen !== '1';
    card.dataset.logsOpen = open ? '1' : '0';
    box.hidden = !open || !box.innerHTML;
    if (open) box.scrollTop = box.scrollHeight;
    return;
  }

  act(kind, id);
});

/* ---------------- 启动 ---------------- */

(async function init() {
  try {
    applyTheme(document.documentElement.dataset.theme || 'dark', false);
    await refreshChips();

    // 未配置密码时不给登录框，直接提示去配置
    try {
      const h = await (await fetch('/api/health')).json();
      if (h.passwordConfigured === false) { showConfigMissing(); return; }
    } catch { /* 忽略，继续常规流程 */ }

    const r = await fetch('/api/tasks');
    if (r.status === 401) { showLogin(); return; }
    if (r.status === 503) { showConfigMissing(); return; }

    connectSSE();
    setInterval(refreshChips, 30000);

    /**
     * 服务状态灯单独刷新，**不 await**。
     *
     * /api/status 会真的去 HEAD R2、GET OpenList，后端超时是 8s / 20s。
     * 之前在 refreshChips 里 await 它，结果 R2 一挂整页白屏 8 秒、
     * OpenList 一挂白屏 20 秒 —— 状态灯把主界面拖死了。
     */
    refreshServiceStatus();
    setInterval(refreshServiceStatus, 30000);

    /**
     * 登录后立刻拉一次历史总数。
     *
     * 不这么做的话，「历史记录」标签上的数字要等用户点进去才正确 ——
     * 因为总数来自 /api/history，而那个请求原本只在切到历史页时才发。
     */
    refreshHistoryCount();
    // 每 60 秒刷新一次，别人在另一台设备上删了记录也能同步
    setInterval(refreshHistoryCount, 60000);

    // 概览的「今日完成」由服务端统计，启动时拉一次
    refreshTodayDone();
    setInterval(refreshTodayDone, 60000);

    /**
     * 定时把「刚结束、已过保留期」的卡片从进行中列表移走。
     *
     * 没有这个定时器的话，结束的卡片会一直挂着，
     * 直到下一次有任务更新触发重渲染才消失。
     */
    setInterval(() => {
      const el = $('#taskList');
      if (!el) return;
      let removed = false;
      $$('.task', el).forEach((card) => {
        const t = state.tasks.get(card.dataset.id);
        if (t && !isActiveTask(t)) {
          card.remove();
          removed = true;
        }
      });
      if (removed) {
        if (!el.querySelector('.task')) el.innerHTML = emptyTasksHtml();
        updateStats();
        updateTabCounts();
      }
    }, 15000);
  } catch (e) {
    // 之前这里没有兜底：/api/tasks 网络失败会让整个 init 静默中断，
    // 页面停在「连接中」，用户完全不知道发生了什么
    toast(`初始化失败：${e.message}，请刷新页面`, 'err');
    console.error('[init]', e);
  }
})();
