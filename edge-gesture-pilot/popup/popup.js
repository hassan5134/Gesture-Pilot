import { DEFAULT_SETTINGS, normalizeTrigger, parseDomainText } from '../lib/storage.js';
import { matchesDomain, describePatterns } from '../lib/domains.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/**
 * 与 service worker 通信。
 * 包装一层是为了把「后台根本没起来」这种情况变成一句人能看懂的话 ——
 * 否则抛出来的只是 "Could not establish connection"，
 * 而异常如果没人接就变成静默无响应。
 */
async function api(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    throw new Error(
      `后台服务无响应（${e?.message || e}）。` +
        `请到 edge://extensions 找到本扩展，点「错误」查看详情，或点「service worker」看控制台日志。`,
    );
  }
}

const state = {
  scripts: [],
  settings: { ...DEFAULT_SETTINGS },
  run: null,
  recording: null,
  failure: null,
  error: null,       // 刚从后台返回的即时错误，优先级高于 storage 里的历史失败
  stale: false,      // 后台 service worker 的版本与界面不一致 —— 说明该重新加载扩展
  bgVersion: null,
  triggerLog: {},    // 每个脚本上次页面触发的时间
  activeUrl: '',     // 当前标签页 URL，用来实时提示「当前页面匹不匹配」
  open: new Set(),   // 展开的脚本 id
  poll: null,
};

/** popup 自己这份 bundle 的版本 */
const LOCAL_VERSION = chrome.runtime.getManifest?.()?.version || '?';

/** 后端返回的报错串像「未定义标识符」时，基本就是后台还在跑旧代码 */
function looksLikeStaleBackend(msg) {
  return /is not defined|is not a function|Cannot read propert|Cannot access '/.test(String(msg || ''));
}

/** 任何一步失败都要在界面上说出来，绝不静默 */
function showBannerError(msg) {
  const text = msg || '';
  if (looksLikeStaleBackend(text)) {
    state.stale = true;
    renderStale();
  }
  state.error = msg ? { scriptName: '操作失败', error: text } : null;
  renderBanner();
}

window.addEventListener('unhandledrejection', (e) => {
  showBannerError(e?.reason?.message || String(e?.reason || '未捕获的异步错误'));
});

window.addEventListener('error', (e) => {
  showBannerError(e?.message || '未捕获的脚本错误');
});

/* ================= 工具 ================= */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '当前页面';
  }
}

function scheduleText(sch) {
  if (!sch?.enabled) return '未定时';
  if (sch.mode === 'daily') return `每天 ${sch.time || '09:00'}`;
  const s = Number(sch.everySec) || 0;
  if (s < 60) return `每 ${s} 秒`;
  if (s % 3600 === 0) return `每 ${s / 3600} 小时`;
  if (s % 60 === 0 && s < 3600) return `每 ${s / 60} 分钟`;
  return `每 ${Math.round(s / 60)} 分钟`;
}

const KIND = { click: '点击', drag: '拖拽', input: '输入', select: '选择', key: '按键', wheel: '滚动', wait: '等待' };

function stepDetail(step) {
  if (step.type === 'key') {
    const k = step.key || {};
    const mods = [k.ctrl && 'Ctrl', k.alt && 'Alt', k.shift && 'Shift', k.meta && 'Meta'].filter(Boolean);
    return [...mods, k.key || ''].join('+');
  }
  if (step.type === 'wheel') return `ΔY ${step.deltaY || 0}`;
  if (step.type === 'drag') return `${(step.path || []).length} 点`;
  if (step.type === 'click') return '';
  return step.value ?? '';
}

/** 触发条件的一句话摘要 */
function triggerText(s) {
  const t = s.trigger;
  if (!t?.enabled) return '';
  const bits = [];
  if (t.delaySec) bits.push(`${t.delaySec}s`);
  if (t.readySelector) bits.push('等元素');
  if (t.requireVisible) bits.push('等前台');
  const scope = describePatterns(t.domains);
  return `触发：${scope}${bits.length ? ` · ${bits.join(' + ')}` : ''}`;
}

function locatorText(step) {
  const l = step.locator;
  if (!l) return step.type === 'wheel' ? '页面' : '—';
  if (l.kind === 'css') return l.value;
  if (l.kind === 'attr') return `[${l.attr}="${l.value}"]`;
  if (l.kind === 'aria') return `「${l.value}」`;
  return JSON.stringify(l);
}

/* ================= 渲染 ================= */

function render() {
  renderHeader();
  renderStale();
  renderBanner();
  renderList();
  renderSettings();
}

/** 后台版本与界面不一致 —— 直接告诉用户怎么修，不要让他去猜 */
function renderStale() {
  const el = $('#stale');
  if (!state.stale) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.innerHTML =
    `<strong>后台跑的是旧代码</strong>：界面 v${esc(LOCAL_VERSION)}，后台 v${esc(state.bgVersion ?? '未知')}。<br />` +
    `去 <code>edge://extensions</code> 找到本扩展，点卡片上的 <strong>↻ 重新加载</strong>。` +
    `如果还不行，<strong>移除</strong>它再重新「加载解压缩的扩展」。`;
}

function renderHeader() {
  const rec = !!state.recording;
  $('.brand').classList.toggle('rec', rec);
  const btn = $('#btnRecord');
  btn.textContent = rec ? '停止并保存' : '开始录制';
  btn.classList.toggle('primary', !rec);
  btn.classList.toggle('danger', rec);
  $('#cnt').textContent = String(state.scripts.length);
  $('#ver').textContent = `v${LOCAL_VERSION}`;
  $('#ver').title = `界面 v${LOCAL_VERSION}｜后台 v${state.bgVersion ?? '未知'}`;
}

function renderBanner() {
  const el = $('#banner');
  const run = state.run;

  if (state.recording) {
    el.hidden = false;
    el.className = 'banner err';
    el.innerHTML = `<strong>正在录制</strong> · ${esc(hostOf(state.recording.url))}<br />在页面上正常操作一遍，然后点右上角「停止并保存」。`;
    return;
  }

  // 即时错误优先于其它状态：它刚刚发生，被 refresh() 覆盖掉就等于没提示
  if (state.error) {
    el.hidden = false;
    el.className = 'banner err';
    el.innerHTML =
      `<strong>${esc(state.error.scriptName)}</strong><br />${esc(state.error.error)}` +
      `<div class="banner-ver">界面 v${esc(LOCAL_VERSION)}｜后台 v${esc(state.bgVersion ?? '未知')}</div>` +
      `<div style="margin-top:8px"><button class="btn" id="btnClearFail">知道了</button></div>`;
    return;
  }

  if (run && run.status === 'running') {
    el.hidden = false;
    el.className = 'banner';
    const pct = run.total ? Math.round((run.index / run.total) * 100) : 0;
    el.innerHTML =
      `<strong>执行中</strong> · ${esc(run.scriptName || '')}<br />` +
      `第 ${run.index + 1} / ${run.total} 步 · ${esc(run.phase || '')}` +
      `<div class="bar"><i style="width:${pct}%"></i></div>`;
    return;
  }

  if (run && run.status === 'success') {
    el.hidden = false;
    el.className = 'banner ok';
    el.innerHTML = `<strong>执行完成</strong> · ${esc(run.scriptName || '')} · ${run.total} 步 · 用时 ${((run.duration || 0) / 1000).toFixed(1)} 秒`;
    return;
  }

  if (state.failure) {
    const f = state.failure;
    el.hidden = false;
    el.className = 'banner err';
    el.innerHTML =
      `<strong>执行失败</strong> · ${esc(f.scriptName || '')}<br />${esc(f.error)}` +
      (f.screenshot ? `<img src="${f.screenshot}" alt="失败时页面截图" />` : '') +
      `<div style="margin-top:8px"><button class="btn" id="btnClearFail">知道了</button></div>`;
    return;
  }

  el.hidden = true;
  el.innerHTML = '';
}

function renderList() {
  const list = $('#list');
  $('#empty').hidden = state.scripts.length > 0;

  list.innerHTML = state.scripts
    .map((s) => {
      const isOpen = state.open.has(s.id);
      const isRunning = state.run?.status === 'running' && state.run.scriptId === s.id;
      const isFailed = state.run?.status === 'failed' && state.run.scriptId === s.id;
      const cls = ['card', isRunning && 'running', isFailed && 'failed'].filter(Boolean).join(' ');

      const sched = s.schedule || {};
      const tagCls = sched.enabled ? 'tag' : 'tag off';

      return `
<div class="${cls}" data-id="${s.id}">
  <div class="card-hd" data-act="toggle">
    <div class="meta">
      <div class="name">${esc(s.name)}</div>
      <div class="sub">
        <span class="${tagCls}">${esc(scheduleText(sched))}</span>
        ${s.steps.length} 步 · ${esc(hostOf(s.targetUrl))} · ${s.engine ? esc(s.engine) : '默认引擎'}${triggerText(s) ? ` · ${esc(triggerText(s))}` : ''}
      </div>
    </div>
    <div class="acts">
      <button class="btn" data-act="run" ${isRunning ? 'disabled' : ''}>${isRunning ? '执行中' : '运行'}</button>
      <button class="btn" data-act="toggle">${isOpen ? '收起' : '详情'}</button>
      <button class="btn icon" data-act="del" title="删除">✕</button>
    </div>
  </div>
  ${isOpen ? cardBody(s) : ''}
</div>`;
    })
    .join('');
}

/** 触发条件编辑区 */
function triggerBlock(s) {
  const t = normalizeTrigger(s.trigger);
  const log = state.triggerLog?.[s.id];
  const matched = state.activeUrl ? matchesDomain(state.activeUrl, t.domains) : null;

  const scopeBadge = !t.enabled
    ? ''
    : matched === true
      ? '<span class="tag ok">当前页面匹配</span>'
      : matched === false
        ? '<span class="tag off">当前页面不匹配</span>'
        : '';

  const fired = log?.at
    ? `上次触发 ${new Date(log.at).toLocaleTimeString('zh-CN', { hour12: false })}`
    : '尚未触发过';

  return `
<div class="sched">
  <label class="sw"><input type="checkbox" data-trig="enabled" ${t.enabled ? 'checked' : ''} /> 打开页面时自动触发</label>

  <div class="row" style="margin:0 0 5px"><span>生效域名（留空 = 所有域名）</span></div>
  <div class="row" style="margin:0 0 7px">
    <input type="text" data-trig="domains" value="${esc(t.domains.join(', '))}"
      placeholder="example.com, *.foo.com, https://a.com/admin" style="flex:1" />
  </div>

  <div class="row">
    <span>加载后等</span>
    <input type="number" data-trig="delaySec" min="0" value="${t.delaySec}" style="width:56px" />
    <span>秒</span>
    <span style="margin-left:auto">冷却</span>
    <input type="number" data-trig="cooldownSec" min="0" value="${t.cooldownSec}" style="width:62px" />
    <span>秒</span>
  </div>

  <div class="row">
    <span>等元素</span>
    <input type="text" data-trig="readySelector" value="${esc(t.readySelector)}"
      placeholder="CSS 选择器（可选）" style="flex:1" />
  </div>

  <label class="sw"><input type="checkbox" data-trig="requireVisible" ${t.requireVisible ? 'checked' : ''} /> 等标签页切到前台再触发</label>
  <label class="sw"><input type="checkbox" data-trig="once" ${t.once ? 'checked' : ''} /> 同一次页面加载只触发一次</label>

  <div class="row" style="margin:0">${scopeBadge}<span style="margin-left:auto;color:var(--ink-3)">${esc(fired)}</span></div>
</div>`;
}

function cardBody(s) {
  const sch = s.schedule || { enabled: false, mode: 'interval', everySec: 1800, time: '09:30' };
  const everySec = Number(sch.everySec) || 1800;
  const useSeconds = everySec < 60;
  const amount = useSeconds ? everySec : Math.round(everySec / 60);

  const steps = s.steps
    .map((st, i) => {
      const editable = st.type === 'input' || st.type === 'select' || st.type === 'wait';
      return `
<div class="step">
  <span class="idx">${i + 1}</span>
  <span class="kind ${st.type}">${KIND[st.type] || st.type}</span>
  <span class="sel" title="${esc(locatorText(st))}">${esc(locatorText(st))}</span>
  ${
    editable
      ? `<input class="val" type="text" value="${esc(st.type === 'wait' ? st.value ?? 1000 : st.value ?? '')}" data-step="${i}" placeholder="值" />`
      : `<span class="sel" style="flex:none;width:104px;text-align:right">${esc(stepDetail(st))}</span>`
  }
  <button class="del" data-del="${i}" title="删除该步">✕</button>
</div>`;
    })
    .join('');

  return `
<div class="card-bd">
  <div class="sched">
    <label class="sw"><input type="checkbox" data-sched="enabled" ${sch.enabled ? 'checked' : ''} /> 定时自动执行</label>
    <div class="row">
      <select data-sched="mode" style="width:82px">
        <option value="interval" ${sch.mode !== 'daily' ? 'selected' : ''}>每隔</option>
        <option value="daily" ${sch.mode === 'daily' ? 'selected' : ''}>每天</option>
      </select>
      <input type="number" data-sched="amount" min="1" value="${amount}" style="width:70px" ${sch.mode === 'daily' ? 'disabled' : ''} />
      <select data-sched="unit" style="width:70px" ${sch.mode === 'daily' ? 'disabled' : ''}>
        <option value="60" ${!useSeconds ? 'selected' : ''}>分钟</option>
        <option value="1" ${useSeconds ? 'selected' : ''}>秒</option>
      </select>
      <input type="time" data-sched="time" value="${esc(sch.time || '09:30')}" ${sch.mode === 'daily' ? '' : 'disabled'} />
    </div>
    <div class="row" style="margin:0">
      回放引擎
      <select data-sched="engine" style="width:150px;margin-left:auto">
        <option value="" ${!s.engine ? 'selected' : ''}>跟随全局设置</option>
        <option value="synthetic" ${s.engine === 'synthetic' ? 'selected' : ''}>合成事件</option>
        <option value="cdp" ${s.engine === 'cdp' ? 'selected' : ''}>CDP 真实输入</option>
      </select>
    </div>
  </div>

  ${triggerBlock(s)}

  <div class="steps">${steps || '<div class="step">没有步骤</div>'}</div>

  <div class="row" style="margin:8px 0 0">
    <button class="btn" data-act="copy">复制 JSON</button>
    <button class="btn" data-act="dup">创建副本</button>
    <button class="btn" data-act="run" ${state.run?.status === 'running' ? 'disabled' : ''}>立即运行</button>
    <span style="margin-left:auto;color:var(--ink-3)">共 ${s.steps.length} 步</span>
  </div>
</div>`;
}

function renderSettings() {
  for (const el of $$('[data-set]')) {
    const key = el.dataset.set;
    const v = state.settings[key];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v ?? '';
  }
}

/* ================= 数据 ================= */

async function refresh() {
  const r = await api({ type: 'SCRIPT_LIST' });
  if (r?.ok) {
    state.scripts = r.scripts || [];
    state.settings = { ...DEFAULT_SETTINGS, ...(r.settings || {}) };
    state.run = r.run || null;
    state.triggerLog = r.triggerLog || {};
    // 老版本的后台不会带 version 字段 —— 这本身就是「该重新加载」的证据
    state.bgVersion = r.version ?? null;
    state.stale = state.bgVersion !== LOCAL_VERSION;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.activeUrl = tab?.url || '';
  } catch {
    state.activeUrl = '';
  }

  const rec = await api({ type: 'RECORD_STATE' });
  state.recording = rec?.recording || null;

  try {
    state.failure = await chrome.storage.session.get('gx_last_failure').then((g) => g.gx_last_failure || null);
  } catch {
    state.failure = null;
  }

  render();
  syncPoll();
}

function syncPoll() {
  const shouldPoll = state.run?.status === 'running' || !!state.recording;
  if (shouldPoll && !state.poll) {
    state.poll = setInterval(refresh, 800);
  } else if (!shouldPoll && state.poll) {
    clearInterval(state.poll);
    state.poll = null;
  }
}

async function saveSchedule(id, patch) {
  const s = state.scripts.find((x) => x.id === id);
  if (!s) return;
  const next = { ...s, schedule: { ...(s.schedule || {}), ...patch } };
  if (typeof next.schedule.everySec === 'number') {
    next.schedule.everySec = Math.max(1, Math.round(next.schedule.everySec));
  }
  s.schedule = next.schedule;
  await api({ type: 'SCRIPT_UPDATE', script: next });
  render();
}

async function persistScript(s) {
  await api({ type: 'SCRIPT_UPDATE', script: s });
}

/* ================= 事件 ================= */

$('#btnRecord').addEventListener('click', async () => {
  const btn = $('#btnRecord');
  btn.disabled = true;
  showBannerError(null);
  try {
    if (state.recording) {
      const r = await api({ type: 'RECORD_STOP' });
      if (!r?.ok) showBannerError(r?.error || '停止失败');
    } else {
      const r = await api({ type: 'RECORD_START' });
      if (!r?.ok) showBannerError(r?.error || '无法开始录制');
    }
  } catch (e) {
    showBannerError(e?.message || String(e));
  } finally {
    btn.disabled = false;
    try {
      await refresh();
    } catch {
      /* refresh 内部已处理 */
    }
  }
});

$$('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.toggle('on', x === t));
    $$('.pane').forEach((p) => p.classList.toggle('on', p.id === `pane-${t.dataset.tab}`));
  });
});

$('#list').addEventListener('click', async (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const id = card.dataset.id;
  const s = state.scripts.find((x) => x.id === id);
  if (!s) return;

  const del = e.target.closest('[data-del]');
  if (del) {
    const i = Number(del.dataset.del);
    s.steps.splice(i, 1);
    await persistScript(s);
    render();
    return;
  }

  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;

  if (act === 'toggle') {
    if (state.open.has(id)) state.open.delete(id);
    else state.open.add(id);
    render();
    return;
  }

  if (act === 'run') {
    e.stopPropagation();
    state.failure = null;
    await chrome.storage.session.remove('gx_last_failure').catch(() => {});
    const r = await api({ type: 'SCRIPT_RUN', id });
    if (!r?.ok) state.failure = { scriptName: s.name, error: r?.error || '无法启动' };
    await refresh();
    return;
  }

  if (act === 'del') {
    e.stopPropagation();
    if (!confirm(`删除「${s.name}」？此操作不可撤销。`)) return;
    await api({ type: 'SCRIPT_DELETE', id });
    state.open.delete(id);
    await refresh();
    return;
  }

  if (act === 'dup') {
    e.stopPropagation();
    const r = await api({ type: 'SCRIPT_DUPLICATE', id });
    if (r?.ok) state.open.add(r.script.id);
    await refresh();
    return;
  }

  if (act === 'copy') {
    e.stopPropagation();
    await navigator.clipboard.writeText(JSON.stringify(s, null, 2));
    e.target.closest('[data-act]').textContent = '已复制';
    setTimeout(() => {
      const b = card.querySelector('[data-act="copy"]');
      if (b) b.textContent = '复制 JSON';
    }, 1200);
  }
});

$('#list').addEventListener('change', async (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const id = card.dataset.id;
  const s = state.scripts.find((x) => x.id === id);
  if (!s) return;

  // 步骤值编辑
  if (e.target.matches('[data-step]')) {
    const i = Number(e.target.dataset.step);
    const st = s.steps[i];
    if (!st) return;
    st.value = st.type === 'wait' ? Number(e.target.value) || 0 : e.target.value;
    await persistScript(s);
    return;
  }

  // 触发条件编辑
  const trigKey = e.target.dataset.trig;
  if (trigKey) {
    const t = normalizeTrigger(s.trigger);
    const raw = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (trigKey === 'domains') t.domains = parseDomainText(raw);
    else if (trigKey === 'delaySec' || trigKey === 'cooldownSec') t[trigKey] = Math.max(0, Number(raw) || 0);
    else if (trigKey === 'readySelector') t.readySelector = String(raw);
    else t[trigKey] = raw;

    s.trigger = t;
    const r2 = await api({ type: 'SCRIPT_UPDATE', script: s });
    if (r2?.ok && r2.script) s.trigger = r2.script.trigger;
    render();
    return;
  }

  // 调度编辑
  const key = e.target.dataset.sched;
  if (!key) return;

  const sch = s.schedule || {};
  if (key === 'enabled') {
    await saveSchedule(id, { enabled: e.target.checked });
  } else if (key === 'mode') {
    await saveSchedule(id, { mode: e.target.value });
  } else if (key === 'amount' || key === 'unit') {
    const amountEl = card.querySelector('[data-sched="amount"]');
    const unitEl = card.querySelector('[data-sched="unit"]');
    if (!amountEl || !unitEl) return;
    const everySec = Math.max(1, Number(amountEl.value) || 1) * Number(unitEl.value);
    await saveSchedule(id, { everySec });
  } else if (key === 'time') {
    await saveSchedule(id, { time: e.target.value });
  } else if (key === 'engine') {
    s.engine = e.target.value || null;
    await persistScript(s);
    render();
  }
});

$('#banner').addEventListener('click', async (e) => {
  if (e.target.id === 'btnClearFail') {
    state.failure = null;
    state.error = null;
    await chrome.storage.session.remove('gx_last_failure').catch(() => {});
    render();
  }
});

$('#pane-settings').addEventListener('change', async (e) => {
  const key = e.target.dataset.set;
  if (!key) return;
  const raw = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  const num = ['stepTimeout', 'retry', 'speed', 'minGapMs', 'maxGapMs', 'jitterMs'].includes(key);
  const patch = { [key]: num ? Number(raw) : raw };
  const r = await api({ type: 'SETTINGS_SAVE', patch });
  if (r?.ok) state.settings = { ...DEFAULT_SETTINGS, ...r.settings };
  renderSettings();
});

refresh().catch((e) => {
  const el = $('#banner');
  el.hidden = false;
  el.className = 'banner err';
  el.textContent = `初始化失败：${String(e?.message || e)}`;
});
