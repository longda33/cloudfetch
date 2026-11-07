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
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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
    // 直播录制中也可能已经有段传完了，这里也显示已传
    if (t.live && t.segmentsUploaded) {
      push('已传', `${t.segmentsUploaded} 段`, 'ok');
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
   * 口径固定为「分段 N 段，已传 M 段」——历史记录页面用同一套，
   * 两边数字不会再对不上。
   */
  if (t.live && (t.segmentCount || t.segmentsDone)) {
    const total = t.segmentCount || t.segmentsDone || 0;
    const up = t.segmentsUploaded || 0;
    const bad = (t.failedSegments || []).length;
    if (t.status === 'done') {
      let s = `分段 ${total} 段`;
      if (total) s += `，已传 ${up} 段`;
      if (bad) s += `，${bad} 段失败`;
      push('录制', s);
    } else if (t.status === 'uploading' || t.status === 'downloading') {
      // 进行中已在上面显示过「已传」，这里只补总数
      push('分段', `${total} 段`);
    }
  }

  if (t.remotePath) {
    out.push(`<span class="metric remote" title="${esc(t.remotePath)}">${icon('cloud', 'ic ic-sm')}<b>${esc(t.remotePath)}</b></span>`);
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

function updateStats() {
  const tasks = [...state.tasks.values()];
  const running = tasks.filter((t) => RUNNING.includes(t.status));
  const done = tasks.filter((t) => t.status === 'done');
  const speed = running.reduce((a, t) => a + (t.speed || 0), 0);

  $('#statRunning').textContent = running.length;
  $('#statSpeed').textContent = speed > 0 ? fmtSpeed(speed) : '—';
  $('#statSpeedSub').textContent = running.length ? `${running.length} 个任务在跑` : '空闲';
  $('#statDone').textContent = done.length;
}

function updateTabCounts() {
  const tasks = [...state.tasks.values()];
  const running = tasks.filter((t) => RUNNING.includes(t.status)).length;
  const finished = tasks.filter((t) => !RUNNING.includes(t.status)).length;
  $('#cntActive').textContent = running;
  $('#cntHistory').textContent = state.histTotal || finished;
}

/* ---------------- SSE ---------------- */

function connectSSE() {
  if (state.es) state.es.close();
  const es = new EventSource('/api/events');
  state.es = es;

  es.addEventListener('open', () => setPill('#chipSse', 'on', '已连接'));

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

async function addTasks(segment = true) {
  const text = $('#urlInput').value.trim();
  if (!text) return toast('请先粘贴链接', 'err');

  const upload = $('#uploadToggle').checked;
  const btn = segment ? $('#btnAddSeg') : $('#btnAddWhole');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = '提交中…';

  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, upload, segment }),
    });
    if (res.status === 401) { showLogin(); return; }

    const j = await res.json();
    if (!res.ok) throw new Error(j.error || '创建失败');

    $('#urlInput').value = '';
    updateLinkCount();

    const modeName = segment ? '分段' : '全段';
    let msg = `已添加 ${j.created.length} 个${modeName}任务`;
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
      const r = await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json()).error);
      state.tasks.delete(id);
      state.logs.delete(id);
      $(`[data-id="${id}"]`)?.remove();
      if (!state.tasks.size) renderAll();
      updateStats();
      updateTabCounts();
    }
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function refreshChips() {
  try {
    const h = await (await fetch('/api/health')).json();
    state.health = h;
    state.authRequired = h.authRequired;
    state.limits = h.limits || {};

    setPill('#chipOpenlist',
      h.openlist ? 'on' : 'warn',
      h.openlist ? 'OpenList 已配置' : 'OpenList 未配置');

    if (state.limits.maxConcurrent != null) {
      $('#statRunningSub').textContent = `并发上限 ${state.limits.maxConcurrent}`;
    }
    if (state.limits.maxFileSizeText) {
      $('#statDoneSub').textContent = `单文件上限 ${state.limits.maxFileSizeText}`;
    }
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

/* ---------------- 登录 ---------------- */

function showLogin() {
  $('#loginMask').classList.add('show');
  $('#pwdInput').focus();
}

async function doLogin() {
  const password = $('#pwdInput').value;
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
    toast('登录成功', 'ok');
  } else {
    toast('密码错误', 'err');
  }
}

function showConfigMissing() {
  $('#loginDialog').innerHTML = `
    <div class="dialog-icon warn">${icon('alert')}</div>
    <h2>未配置访问密码</h2>
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
  const badge = {
    done: `<span class="badge done">${icon('check', 'ic ic-xs')}完成</span>`,
    failed: `<span class="badge failed">${icon('x', 'ic ic-xs')}失败</span>`,
    canceled: `<span class="badge canceled">取消</span>`,
  }[h.status] || '';

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
   * 待补传数量。
   *
   * 直播：缺的段 = 总数 - 已传数。不能只看 failedSegments —— 那个数组
   * 只记「上传抛异常」的段，而实际有几种情况都不会进数组：
   *   - 上传任务还在后台排队（异步上传，任务结束时可能没跑完）
   *   - 用户中途停止，后面的段压根没触发上传
   *   - 容器重启打断
   * 这些段同样需要「重传」，所以用差值兜底。
   *
   * 单文件：开了上传却没拿到 remotePath，就是没传成功。
   */
  let missing = 0;
  if (h.live && h.segment !== false) {
    const total = h.segmentCount || 0;
    const up = h.segmentsUploaded || 0;
    missing = Math.max(0, total - up);
    let seg = `<span>分段 <b>${total}</b> 段`;
    if (total) {
      seg += `，已传 <b class="${up === total ? 'ok' : ''}">${up}</b> 段`;
      if (missing) seg += `，<b class="err">${missing}</b> 段未传`;
    }
    seg += '</span>';
    meta.push(seg);
  } else if (h.upload && !h.remotePath && (h.size || 0) > 0) {
    missing = 1;
    meta.push('<span class="err">上传未完成</span>');
  }
  if (h.remotePath) meta.push(`<span class="ok" title="${esc(h.remotePath)}">${icon('cloud', 'ic ic-xs')} ${esc(h.remotePath)}</span>`);
  if (h.error) meta.push(`<span class="err" title="${esc(h.error)}">${esc(h.error)}</span>`);

  // 目录：优先用后端算好的 remoteDir，其次从 remotePath / 首段路径推
  const dir =
    h.remoteDir ||
    folderOf(h.remotePath) ||
    folderOf((h.segments || []).find((s) => s.remotePath)?.remotePath || '');

  const folderBtn = dir
    ? `<button class="btn btn-ghost btn-xs" data-hact="folder" data-hid="${h.id}"
         data-dir="${esc(dir)}"
         title="在 OpenList 打开 ${esc(dir)}">${icon('inbox', 'ic ic-xs')}文件夹</button>`
    : '';

  // 有缺段就显示「重传」，用差值而不是只看 failedSegments
  const retryUpBtn = missing
    ? `<button class="btn btn-warn btn-xs" data-hact="retryup" data-hid="${h.id}"
         title="${missing} 段未上传，点击重试">${icon('refresh', 'ic ic-xs')}重传 ${missing}</button>`
    : '';

  return `
  <div class="hist-item" data-hid="${h.id}" data-url="${esc(h.url)}" data-rpath="${esc(h.remotePath || '')}" data-dir="${esc(dir)}" data-segment="${h.segment === false ? '0' : '1'}">
    <span class="hist-icon">${icon(km.icon)}</span>
    <div class="hist-body">
      <div class="hist-title">
        <span title="${esc(h.filename || h.url)}">${esc(h.filename || '(未命名)')}</span>
        ${badge}${modeTag}
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

$('#btnClear').addEventListener('click', async () => {
  const r = await fetch('/api/tasks/clear', { method: 'POST' });
  const j = await r.json();
  for (const [id, t] of state.tasks) {
    if (!RUNNING.includes(t.status)) {
      state.tasks.delete(id);
      state.logs.delete(id);
    }
  }
  renderAll();
  toast(`已清空 ${j.removed} 条`);
});

// 全段下载：整场录成单个文件
$('#btnAddWhole').addEventListener('click', () => addTasks(false));

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
  const r = await fetch('/api/history', { method: 'DELETE' });
  const j = await r.json();
  toast(`已清空 ${j.removed} 条历史`);
  hist.page = 1;
  state.histTotal = 0;
  loadHistory();
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
    // 重试上传失败的分段
    const hid = item?.dataset.hid;
    if (!hid) return;
    item.disabled = true;
    try {
      const r = await fetch(`/api/tasks/${hid}/retry-upload`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      toast(`重传完成：成功 ${j.ok} 段${j.failed ? `，仍失败 ${j.failed} 段` : ''}`, j.failed ? 'warn' : 'ok');
      loadHistory();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      item.disabled = false;
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
})();
