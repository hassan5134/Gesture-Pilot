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
  renaming: null,    // 正在改名的脚本 id（列表里会切换成输入框）
  triggerLog: {},    // 每个脚本上次页面触发的时间
  activeUrl: '',     // 当前标签页 URL，用来实时提示「当前页面匹不匹配」
  open: new Set(),   // 展开的脚本 id
  poll: null,
};

/** popup 自己这份 bundle 的版本 */
const LOCAL_VERSION = chrome.runtime.getManifest?.()?.version || '?';

/** 导出文件的格式标记，导入时会校验 */
const FORMAT = 'gesture-pilot-scripts';

/** 脚本名里可能有斜杠、冒号之类不能进文件名的字符 */
function sanitizeName(name) {
  return String(name || 'script').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'script';
}

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

function scheduleDomainsText(sch) {
  const d = sch?.domains || [];
  return d.length ? `限 ${describePatterns(d)}` : '';
}

/** 把对象导出成 JSON 文件下载下来（popup 里用 blob 直下，不依赖 downloads 权限） */
function downloadJson(filename, data) {
  try {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  } catch (e) {
    showBannerError(`导出失败：${e?.message || e}`);
    return false;
  }
}

function exportFilename(prefix) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${prefix}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
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
      const off = s.enabled === false;

      const cls = ['card', isRunning && 'running', isFailed && 'failed', off && 'off']
        .filter(Boolean)
        .join(' ');

      const sched = s.schedule || {};
      const tagCls = sched.enabled && !off ? 'tag' : 'tag off';
      const trig = off ? '' : triggerText(s);

      // 点标题直接改名；正在改的这个不要重新渲染成静态文本，否则光标会跳走
      const title =
        state.renaming === s.id
          ? `<input class="rename" value="${esc(s.name)}" maxlength="80" placeholder="脚本名称" />`
          : `<span class="txt">${esc(s.name)}</span><span class="pen" title="点击改名">✎</span>`;

      return `
<div class="${cls}" data-id="${s.id}">
  <div class="card-hd" data-act="toggle">
    <input type="checkbox" class="en" data-act="enabled" ${off ? '' : 'checked'}
      title="启用 / 停用（停用后定时与页面触发都不再生效，手动仍可运行）" />
    <div class="meta">
      <div class="name" data-act="rename" title="点击改名">${title}</div>
      <div class="sub">
        <span class="${tagCls}">${off ? '已停用' : esc(scheduleText(sched))}</span>
        ${s.steps.length} 步 · ${esc(hostOf(s.targetUrl))} · ${s.engine ? esc(s.engine) : '默认引擎'}
        ${trig ? ` · ${esc(trig)}` : ''}
        ${trig || off ? '' : (scheduleDomainsText(sched) ? ` · ${esc(scheduleDomainsText(sched))}` : '')}
      </div>
    </div>
    <div class="acts">
      <button class="btn" data-act="run" ${isRunning ? 'disabled' : ''}>${isRunning ? '执行中' : '运行'}</button>
      <button class="btn" data-act="toggle">${isOpen ? '收起' : '配置'}</button>
      <button class="btn icon" data-act="del" title="删除">✕</button>
    </div>
  </div>
  ${isOpen ? cardBody(s) : ''}
</div>`;
    })
    .join('');
}

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

  // 跳过记录比触发记录新，说明上一次尝试是被拦下来的 —— 那才是用户想知道的
  const skipLog = state.triggerLog?.[`skip_${s.id}`];
  const showSkip = !!skipLog && (!log?.at || skipLog.at > log.at);

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
  <div class="row" style="margin:-1px 0 5px">
    <span style="font-size:10.5px;color:var(--ink-3);line-height:1.5">冷却只防「页面自己跳转引起的连环触发」。<strong>你手动刷新 / 重新输入地址不受它限制</strong>，每次刷新都会重新触发。</span>
  </div>

  <div class="row">
    <span>等元素</span>
    <input type="text" data-trig="readySelector" value="${esc(t.readySelector)}"
      placeholder="CSS 选择器（可选）" style="flex:1" />
  </div>

  <label class="sw"><input type="checkbox" data-trig="requireVisible" ${t.requireVisible ? 'checked' : ''} /> 等标签页切到前台再触发</label>
  <label class="sw"><input type="checkbox" data-trig="once" ${t.once ? 'checked' : ''} /> 同一次页面加载只触发一次</label>

  <div class="row" style="margin:0">${scopeBadge}<span style="margin-left:auto;color:var(--ink-3)">${esc(fired)}</span></div>
  ${showSkip ? `<div class="row" style="margin:5px 0 0;color:var(--amber);font-size:10.5px;line-height:1.5">上次被跳过：${esc(skipLog.reason)}</div>` : ''}
</div>`;
}

/** 单步编辑行：420px 宽度下用两行才排得开 */
function stepRow(st, i, total) {
  const kind = KIND[st.type] || st.type;
  const editable = st.type === 'input' || st.type === 'select' || st.type === 'wait';
  const val = st.type === 'wait' ? (st.value ?? 1000) : (st.value ?? '');

  const valueCell = editable
    ? `<input class="val" type="text" data-step="${i}" value="${esc(val)}"
         placeholder="${st.type === 'wait' ? '毫秒' : '值'}" />`
    : `<span class="sel" title="${esc(stepDetail(st))}">${esc(stepDetail(st))}</span>`;

  return `
<div class="step">
  <div class="step-l1">
    <span class="idx">${i + 1}</span>
    <span class="kind ${st.type}">${kind}</span>
    <span class="sel" title="${esc(locatorText(st))}">${esc(locatorText(st))}</span>
  </div>
  <div class="step-l2">
    ${valueCell}
    <span class="dly">延时<input type="number" min="0" step="50" data-delay="${i}"
      value="${Math.max(0, Number(st.delay) || 0)}" />ms</span>
    <span class="ops">
      <button data-up="${i}" title="上移" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button data-down="${i}" title="下移" ${i === total - 1 ? 'disabled' : ''}>↓</button>
      <button data-dup="${i}" title="复制这一步">＋</button>
      <button data-del="${i}" title="删除这一步">✕</button>
    </span>
  </div>
</div>`;
}

function cardBody(s) {
  const sch = s.schedule || {};
  const everySec = Number(sch.everySec) || 1800;
  const useSeconds = everySec < 60;
  const amount = useSeconds ? everySec : Math.round(everySec / 60);
  const daily = sch.mode === 'daily';

  const steps = s.steps.map((st, i) => stepRow(st, i, s.steps.length)).join('');

  return `
<div class="card-bd">
  <div class="field" style="margin-bottom:8px">
    <label for="nm-${s.id}">脚本名称</label>
    <input id="nm-${s.id}" type="text" data-name value="${esc(s.name)}" maxlength="80" placeholder="给脚本起个名字" />
  </div>

  <div class="sched">
    <label class="sw"><input type="checkbox" data-sched="enabled" ${sch.enabled ? 'checked' : ''} /> 定时自动执行</label>
    <div class="row">
      <select data-sched="mode" style="width:76px">
        <option value="interval" ${daily ? '' : 'selected'}>每隔</option>
        <option value="daily" ${daily ? 'selected' : ''}>每天</option>
      </select>
      <input type="number" data-sched="amount" min="1" value="${amount}" style="width:62px" ${daily ? 'disabled' : ''} />
      <select data-sched="unit" style="width:64px" ${daily ? 'disabled' : ''}>
        <option value="60" ${useSeconds ? '' : 'selected'}>分钟</option>
        <option value="1" ${useSeconds ? 'selected' : ''}>秒</option>
      </select>
      <input type="time" data-sched="time" value="${esc(sch.time || '09:30')}" ${daily ? '' : 'disabled'} />
    </div>
    <div class="row" style="margin:6px 0 0">
      <span>生效域名</span>
      <input type="text" data-sched="domains" value="${esc((sch.domains || []).join(', '))}"
        placeholder="留空 = 不限" style="flex:1" />
    </div>
    <div class="row" style="margin:3px 0 0">
      <span class="dim">只约束「定时」这条路径；跑到范围外的页面会跳过并通知你</span>
    </div>
  </div>

  ${triggerBlock(s)}

  <div class="steps">
    ${steps || '<div class="step"><span class="dim">没有步骤</span></div>'}
    <div class="steps-foot">
      <button class="btn" data-act="add-wait">＋ 插入等待</button>
      <span class="dim" style="margin-left:auto;align-self:center">共 ${s.steps.length} 步</span>
    </div>
  </div>

  <div class="row" style="margin:8px 0 0">
    <button class="btn" data-act="copy">复制 JSON</button>
    <button class="btn" data-act="export">导出此脚本</button>
    <button class="btn" data-act="dup">创建副本</button>
    <button class="btn" data-act="run" ${state.run?.status === 'running' ? 'disabled' : ''}>立即运行</button>
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
  const r = await api({ type: 'SCRIPT_UPDATE', script: next });
  // 后台会做规范化（补默认值、解析域名文本），以它的结果为准
  if (r?.ok && r.script) s.schedule = r.script.schedule;
  render();
}

/** 步骤级编辑：上移 / 下移 / 复制 / 删除。返回是否真的改动了 */
function moveStep(s, i, dir) {
  const j = i + dir;
  if (!Number.isInteger(i) || i < 0 || i >= s.steps.length) return false;
  if (j < 0 || j >= s.steps.length) return false;
  const [st] = s.steps.splice(i, 1);
  s.steps.splice(j, 0, st);
  return true;
}

function duplicateStep(s, i) {
  const st = s.steps[i];
  if (!st) return false;
  s.steps.splice(i + 1, 0, structuredClone(st));
  return true;
}

async function persistScript(s) {
  const r = await api({ type: 'SCRIPT_UPDATE', script: s });
  if (r?.ok && r.script) {
    // 用后台规范化后的结果覆盖本地，避免界面显示出存储里并不存在的字段
    Object.assign(s, r.script);
  }
  return r;
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

  // ---- 步骤级操作（必须放在 data-act 之前判断，它们不在 [data-act] 上）----
  const stepBtn =
    e.target.closest('[data-up]') ||
    e.target.closest('[data-down]') ||
    e.target.closest('[data-dup]') ||
    e.target.closest('[data-del]');

  if (stepBtn) {
    e.stopPropagation();
    const d = stepBtn.dataset;
    let changed = false;
    if (d.up !== undefined) changed = moveStep(s, Number(d.up), -1);
    else if (d.down !== undefined) changed = moveStep(s, Number(d.down), 1);
    else if (d.dup !== undefined) changed = duplicateStep(s, Number(d.dup));
    else if (d.del !== undefined) {
      const i = Number(d.del);
      if (i >= 0 && i < s.steps.length) {
        s.steps.splice(i, 1);
        changed = true;
      }
    }
    if (changed) {
      await persistScript(s);
      render();
    }
    return;
  }

  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;

  if (act === 'enabled') return; // 复选框交给 change 事件处理

  if (act === 'rename') {
    e.stopPropagation();
    // 已经在改名就别再重渲染，否则输入框会被重建、光标跳走
    if (state.renaming !== id) {
      state.renaming = id;
      render();
      const input = document.querySelector(`.card[data-id="${id}"] input.rename`);
      try {
        input?.focus?.();
        input?.select?.();
      } catch {
        /* 忽略 */
      }
    }
    return;
  }

  if (act === 'add-wait') {
    e.stopPropagation();
    s.steps.push({ type: 'wait', value: 1000, delay: 0 });
    await persistScript(s);
    render();
    return;
  }

  if (act === 'export') {
    e.stopPropagation();
    if (downloadJson(exportFilename(sanitizeName(s.name)), { format: FORMAT, version: 1, exportedAt: new Date().toISOString(), scripts: [s] })) {
      const btn = card.querySelector('[data-act="export"]');
      if (btn) {
        btn.textContent = '已导出';
        setTimeout(() => { const b = card.querySelector('[data-act="export"]'); if (b) b.textContent = '导出此脚本'; }, 1200);
      }
    }
    return;
  }

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

  // 脚本启停总开关
  if (e.target.matches('[data-act="enabled"]')) {
    s.enabled = !!e.target.checked;
    await persistScript(s);
    render();
    return;
  }

  // 配置区里的名称输入框
  if (e.target.matches('[data-name]')) {
    const next = String(e.target.value || '').trim();
    if (next && next !== s.name) {
      s.name = next;
      await persistScript(s);
      render();
    }
    return;
  }

  // 步骤值编辑
  if (e.target.matches('[data-step]')) {
    const i = Number(e.target.dataset.step);
    const st = s.steps[i];
    if (!st) return;
    st.value = st.type === 'wait' ? Number(e.target.value) || 0 : e.target.value;
    await persistScript(s);
    return;
  }

  // 步骤延时（修页面抖动最常用的一项）
  if (e.target.matches('[data-delay]')) {
    const i = Number(e.target.dataset.delay);
    const st = s.steps[i];
    if (!st) return;
    st.delay = Math.max(0, Number(e.target.value) || 0);
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
  } else if (key === 'domains') {
    await saveSchedule(id, { domains: parseDomainText(e.target.value) });
  } else if (key === 'engine') {
    s.engine = e.target.value || null;
    await persistScript(s);
    render();
  }
});

/**
 * 标题改名输入框的收尾。
 * 用 focusout 而不是 change：change 只在值真的变了才触发，
 * 用户点开改名又直接点别处时 change 不会来，改名态就会一直卡着。
 */
$('#list').addEventListener('focusout', async (e) => {
  if (!e.target.matches?.('input.rename')) return;
  const card = e.target.closest('.card');
  const id = card?.dataset?.id;
  const s = id ? state.scripts.find((x) => x.id === id) : null;
  const next = String(e.target.value || '').trim();

  state.renaming = null;
  if (s && next && next !== s.name) {
    s.name = next;
    await persistScript(s);
  }
  render();
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

/* ================= 备份与恢复 ================= */

function importMsg(text, kind) {
  const el = $('#importMsg');
  if (!el) return;
  el.textContent = text;
  el.style.color = kind === 'err' ? 'var(--red)' : kind === 'ok' ? 'var(--green)' : 'var(--ink-3)';
}

/** 兼容两种导出格式：整包 {scripts:[...]} 和单个脚本对象 */
function extractScripts(parsed) {
  if (!parsed) return null;
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.scripts)) return parsed.scripts;
  if (Array.isArray(parsed.steps)) return [parsed];
  return null;
}

$('#btnExportAll')?.addEventListener('click', () => {
  if (!state.scripts.length) {
    showBannerError('还没有任何脚本可以导出');
    return;
  }
  downloadJson(exportFilename('gesture-pilot-all'), {
    format: FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    count: state.scripts.length,
    scripts: state.scripts,
  });
});

$('#btnPaste')?.addEventListener('click', async () => {
  const ta = $('#importText');
  try {
    const text = await navigator.clipboard.readText();
    if (!text) {
      importMsg('剪贴板是空的', 'err');
      return;
    }
    ta.value = text;
    importMsg(`已粘贴 ${text.length} 个字符，点「导入」生效`, 'ok');
  } catch {
    // 剪贴板读取可能被拒，退回手动粘贴
    importMsg('读不到剪贴板，请手动粘贴到下面的框里', 'err');
  }
});

$('#btnImport')?.addEventListener('click', async () => {
  const text = String($('#importText')?.value || '').trim();
  if (!text) {
    importMsg('请先把导出的 JSON 粘贴进来', 'err');
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    importMsg(`JSON 解析失败：${err?.message || err}`, 'err');
    return;
  }

  const scripts = extractScripts(parsed);
  if (!scripts || !scripts.length) {
    importMsg('没找到脚本数据（需要是本扩展导出的 JSON）', 'err');
    return;
  }

  const r = await api({ type: 'SCRIPT_IMPORT', scripts });
  if (!r?.ok) {
    importMsg(r?.error || '导入失败', 'err');
    return;
  }
  $('#importText').value = '';
  importMsg(
    r.skipped ? `导入 ${r.added} 个，跳过 ${r.skipped} 个（已存在或结构不完整）` : `导入 ${r.added} 个脚本`,
    'ok',
  );
  await refresh();
});

refresh().catch((e) => {
  const el = $('#banner');
  el.hidden = false;
  el.className = 'banner err';
  el.textContent = `初始化失败：${String(e?.message || e)}`;
});
