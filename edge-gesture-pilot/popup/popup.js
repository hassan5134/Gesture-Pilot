import {
  DEFAULT_SETTINGS, normalizeTrigger, parseDomainText,
  defaultEvent, countSteps,
} from '../lib/storage.js';
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
  logStats: null,    // 日志条数 / 上限 / 开关状态
  drive: null,       // Google Drive 连接状态
  driveFiles: [],    // 云端备份列表
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

/** 没有录制快照时，给匹配条件一个起点，省得对着空白框发呆 */
function suggestMatch(st) {
  const h = st.el;
  if (h?.cls?.length) return `.${h.cls[0]}`;
  if (h?.attrs?.length) return `[${h.attrs[0].name}]`;
  return '';
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
        ${s.events.length} 个事件 · ${countSteps(s)} 步 · ${esc(hostOf(s.targetUrl))} · ${s.engine ? esc(s.engine) : '默认引擎'}
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
const EVENT_KIND = { gesture: '手势', js: 'JS' };
const NL = String.fromCharCode(10);

/** 取第一行做摘要（JS 事件没起名时，用代码首行当标题） */
function firstLine(s) {
  const t = String(s || '').trim();
  const i = t.search(/[\r\n]/);
  return i >= 0 ? t.slice(0, i) : t;
}

/**
 * 把录制时记下的 class / 属性拼成可点的快捷条件。
 *
 * 没有这个，用户要加「必须匹配 .green」就得自己回页面开 DevTools 抄选择器 ——
 * 那这个功能基本不会有人用。所以录制时顺手存了一份元素特征。
 */
function matchChips(st) {
  const h = st.el;
  if (!h) return '';
  const out = [];

  for (const c of (h.cls || []).slice(0, 5)) {
    out.push(
      `<button class="chip" data-match-add=".${esc(c)}" title="要求同时带 class ${esc(c)}">.${esc(c)}</button>`,
    );
  }
  for (const a of (h.attrs || []).slice(0, 6)) {
    out.push(
      `<button class="chip" data-match-add="[${esc(a.name)}]" title="${esc(a.name)} = ${esc(a.value)}">[${esc(a.name)}]</button>`,
    );
  }
  if (!out.length) return '';
  return `<span class="chips" title="点一下，加进匹配条件">${out.join('')}</span>`;
}

/** 单步编辑行：420px 宽度下用两行才排得开 */
function stepRow(st, si, total, ei) {
  const kind = KIND[st.type] || st.type;
  const editable = st.type === 'input' || st.type === 'select' || st.type === 'wait';
  const val = st.type === 'wait' ? (st.value ?? 1000) : (st.value ?? '');

  const valueCell = editable
    ? `<input class="val" type="text" data-step="${si}" data-ev="${ei}" value="${esc(val)}"
         placeholder="${st.type === 'wait' ? '毫秒' : '值'}" />`
    : `<span class="sel" title="${esc(stepDetail(st))}">${esc(stepDetail(st))}</span>`;

  // 匹配条件：录制的定位器是自动挑的，页面出现同名元素时容易点错，靠它加固
  const matchCell = st.match
    ? `<input class="match" type="text" data-match="${si}" data-ev="${ei}" value="${esc(st.match)}"
         title="必须同时满足这个 CSS 选择器，才算找到目标" />
       <button class="mini" data-clear-match="${si}" data-ev="${ei}" title="去掉匹配条件">✕</button>`
    : '';

  return `
<div class="step" data-si="${si}" data-ei="${ei}">
  <div class="step-l1">
    <span class="idx">${si + 1}</span>
    <span class="kind ${st.type}">${kind}</span>
    <span class="sel" title="${esc(locatorText(st))}">${esc(locatorText(st))}</span>
    <button class="mini" data-toggle-match="${si}" data-ev="${ei}"
      title="${st.match ? '收起匹配条件' : '加匹配条件'}">${st.match ? '⊘' : '＋⌕'}</button>
  </div>
  ${matchCell ? `<div class="step-l2 step-match">${matchCell}${matchChips(st)}</div>` : ''}
  <div class="step-l2">
    ${valueCell}
    <span class="dly">延时<input type="number" min="0" step="50" data-delay="${si}" data-ev="${ei}"
      value="${Math.max(0, Number(st.delay) || 0)}" />ms</span>
    <span class="ops">
      <button data-up="${si}" data-ev="${ei}" title="上移" ${si === 0 ? 'disabled' : ''}>↑</button>
      <button data-down="${si}" data-ev="${ei}" title="下移" ${si === total - 1 ? 'disabled' : ''}>↓</button>
      <button data-dup="${si}" data-ev="${ei}" title="复制这一步">＋</button>
      <button data-del="${si}" data-ev="${ei}" title="删除这一步">✕</button>
    </span>
  </div>
</div>`;
}

/**
 * 一个事件。
 *
 * 手势事件展开成步骤列表；JS 事件展开成代码摘要加一个「编辑代码」按钮 ——
 * popup 只有 420px 宽，正经写代码得挪到独立页面去。
 */
function eventBlock(ev, ei, total) {
  const isJs = ev.type === 'js';
  const src = String(ev.code || '');
  const badge = `<span class="ev-kind ${isJs ? 'js' : 'gesture'}">${EVENT_KIND[ev.type] || ev.type}</span>`;
  const ph = isJs ? 'JS 事件名（可留空）' : '手势事件名（可留空）';

  const w = ev.wait || {};
  let inner;

  if (isJs) {
    const lines = src ? src.split(NL).length : 0;
    inner = `
    <div class="ev-js">
      <div class="ev-js-meta">
        <span>${lines} 行 · ${src.length} 字符</span>
        <span class="dim">${ev.world === 'cdp' ? '总是走调试接口' : '自动：先注入，被站点 CSP 拦下再切调试接口'}</span>
      </div>
      <pre class="ev-code">${esc(src.slice(0, 700))}${src.length > 700 ? ' …' : ''}</pre>
      <div class="row">
        <button class="btn" data-evd="edit-code" data-ev="${ei}">编辑代码</button>
        <select data-evd="world" data-ev="${ei}" style="width:auto">
          <option value="auto" ${ev.world === 'cdp' ? '' : 'selected'}>自动选执行方式</option>
          <option value="cdp" ${ev.world === 'cdp' ? 'selected' : ''}>总是用调试接口</option>
        </select>
      </div>
    </div>`;
  } else {
    const steps = (ev.steps || []).map((st, si) => stepRow(st, si, ev.steps.length, ei)).join('');
    inner = `
    <div class="steps">
      ${steps || '<div class="step"><span class="dim">这个事件里没有步骤</span></div>'}
      <div class="steps-foot">
        <button class="btn" data-evd="add-wait" data-ev="${ei}">＋ 插入等待</button>
        <span class="dim" style="margin-left:auto;align-self:center">${ev.steps?.length || 0} 步</span>
      </div>
    </div>`;
  }

  return `
<div class="event" data-ei="${ei}">
  <div class="ev-hd">
    ${badge}
    <input class="ev-name" type="text" data-evd="name" data-ev="${ei}" value="${esc(ev.name || '')}"
      placeholder="${ph}" maxlength="60" />
    <span class="ops">
      <button data-evd="ev-up" data-ev="${ei}" title="上移" ${ei === 0 ? 'disabled' : ''}>↑</button>
      <button data-evd="ev-down" data-ev="${ei}" title="下移" ${ei === total - 1 ? 'disabled' : ''}>↓</button>
      <button data-evd="ev-del" data-ev="${ei}" title="删除这个事件">✕</button>
    </span>
  </div>
  <div class="ev-wait">
    <span class="dim">执行前等</span>
    <input type="text" data-evd="wait-url" data-ev="${ei}" value="${esc(w.url || '')}"
      placeholder="地址匹配（可留空，如 /detail 或 detail.example.com）" style="flex:1" />
    <input type="text" data-evd="wait-selector" data-ev="${ei}" value="${esc(w.selector || '')}"
      placeholder="等元素出现（CSS，可留空）" style="flex:1" />
    <input type="number" min="1" data-evd="wait-timeout" data-ev="${ei}" value="${w.timeoutSec || 20}"
      style="width:50px" title="等待超时（秒）" />
  </div>
  ${inner}
</div>`;
}

function cardBody(s) {
  const sch = s.schedule || {};
  const everySec = Number(sch.everySec) || 1800;
  const useSeconds = everySec < 60;
  const amount = useSeconds ? everySec : Math.round(everySec / 60);
  const daily = sch.mode === 'daily';
  const events = (s.events || []).map((ev, ei) => eventBlock(ev, ei, s.events.length)).join('');

  return `
<div class="card-bd">
  <div class="field" style="margin-bottom:8px">
    <label for="nm-${s.id}">任务名称</label>
    <input id="nm-${s.id}" type="text" data-name value="${esc(s.name)}" maxlength="80" placeholder="给任务起个名字" />
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

  <div class="ev-list">
    <div class="ev-list-hd">
      <span>事件组</span>
      <span class="dim">按顺序执行</span>
      <span style="margin-left:auto">
        <button class="btn" data-act="add-gesture">＋ 手势</button>
        <button class="btn" data-act="add-js">＋ JS</button>
      </span>
    </div>
    ${events || '<div class="dim" style="padding:10px 2px">还没有事件。点上面的「＋ 手势」加一段录制的操作，或「＋ JS」写代码。</div>'}
  </div>

  <div class="row" style="margin:8px 0 0">
    <button class="btn" data-act="copy">复制 JSON</button>
    <button class="btn" data-act="export">导出此任务</button>
    <button class="btn" data-act="dup">创建副本</button>
    <button class="btn" data-act="run" ${state.run?.status === 'running' ? 'disabled' : ''}>立即运行</button>
  </div>
</div>`;
}

function renderSettings() {
  const ls = state.logStats;
  const box = $('#logStat');
  if (box) {
    box.textContent = ls
      ? `${ls.count} 条${ls.limit ? ` / 上限 ${ls.limit}` : ''}`
      : '';
  }

  renderDrive();

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
    state.logStats = r.logStats || null;
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
    const drv = await api({ type: 'DRIVE_STATUS' });
    if (drv?.ok) state.drive = drv.drive;
  } catch {
    /* 云备份不可用不该影响其它功能 */
  }

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

/** 取某个事件（越界给 null，调用方不用到处判空） */
function eventAt(s, ei) {
  return s.events?.[Number(ei)] || null;
}

/** 取某个事件里的某一步 */
function stepAt(s, ei, si) {
  return eventAt(s, ei)?.steps?.[Number(si)] || null;
}

/** 通用交换，事件和步骤都用它 */
function swap(arr, i, j) {
  if (!Array.isArray(arr)) return false;
  if (i < 0 || j < 0 || i >= arr.length || j >= arr.length) return false;
  const [x] = arr.splice(i, 1);
  arr.splice(j, 0, x);
  return true;
}

/**
 * 事件级：上移 / 下移 / 删除。
 * 事件是编排的最小单位，顺序就是执行顺序 —— 调整流程全靠这几个操作。
 */
function moveEvent(s, i, dir) {
  return swap(s.events, Number(i), Number(i) + dir);
}

function deleteEvent(s, i) {
  const idx = Number(i);
  if (!Array.isArray(s.events) || idx < 0 || idx >= s.events.length) return false;
  s.events.splice(idx, 1);
  return true;
}

/** 新增一个事件，返回它的下标 */
function addEvent(s, type) {
  if (!Array.isArray(s.events)) s.events = [];
  const ev = defaultEvent(type);
  const same = s.events.filter((x) => x.type === ev.type).length + 1;
  ev.name = ev.type === 'js' ? `JS ${same}` : `手势 ${same}`;
  s.events.push(ev);
  return s.events.length - 1;
}

/** 步骤级 */
function moveStep(s, ei, si, dir) {
  const ev = eventAt(s, ei);
  return ev ? swap(ev.steps, Number(si), Number(si) + dir) : false;
}

function duplicateStep(s, ei, si) {
  const ev = eventAt(s, ei);
  const st = ev?.steps?.[Number(si)];
  if (!st) return false;
  ev.steps.splice(Number(si) + 1, 0, structuredClone(st));
  return true;
}

function deleteStep(s, ei, si) {
  const ev = eventAt(s, ei);
  const idx = Number(si);
  if (!ev?.steps || idx < 0 || idx >= ev.steps.length) return false;
  ev.steps.splice(idx, 1);
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

  // ---- 匹配条件：开关 / 清除 / 快捷 chip ----
  // 必须排在步骤级按钮之前：这几个按钮和 data-up 之类同在 .step 里
  const matchBtn = e.target.closest('[data-toggle-match]') || e.target.closest('[data-clear-match]');
  const chip = e.target.closest('[data-match-add]');
  if (matchBtn || chip) {
    e.stopPropagation();
    const host = (matchBtn || chip).closest('.step');
    const ei = Number(host?.dataset.ei);
    const si = Number(host?.dataset.si);
    const st = stepAt(s, ei, si);
    if (st) {
      if (chip) st.match = String(st.match || '') + chip.dataset.matchAdd;
      else if (matchBtn.dataset.clearMatch !== undefined) st.match = '';
      else st.match = st.match ? '' : suggestMatch(st);
      await persistScript(s);
      render();
      const box = document.querySelector(`.step[data-ei="${ei}"][data-si="${si}"] input.match`);
      try {
        box?.focus?.();
        box?.select?.();
      } catch {
        /* 忽略 */
      }
    }
    return;
  }

  // ---- 事件级操作 ----
  const evBtn = e.target.closest('[data-evd]');
  if (evBtn) {
    e.stopPropagation();
    const evAct = evBtn.dataset.evd;
    const ei = Number(evBtn.dataset.ev);
    let changed = false;

    if (evAct === 'ev-up') changed = moveEvent(s, ei, -1);
    else if (evAct === 'ev-down') changed = moveEvent(s, ei, 1);
    else if (evAct === 'ev-del') {
      // 删事件是不可逆的，要点两下
      if (evBtn.dataset.confirm !== '1') {
        evBtn.dataset.confirm = '1';
        evBtn.textContent = '确认删除';
        evBtn.classList.add('danger');
        return;
      }
      changed = deleteEvent(s, ei);
    } else if (evAct === 'add-wait') {
      const ev = eventAt(s, ei);
      if (ev) {
        ev.steps = ev.steps || [];
        ev.steps.push({ type: 'wait', value: 1000, delay: 0 });
        changed = true;
      }
    } else if (evAct === 'edit-code') {
      const ev = eventAt(s, ei);
      if (ev) {
        // popup 只有 420px 宽，正经写代码得挪到独立页面
        chrome.tabs.create({
          url: chrome.runtime.getURL(
            `editor/editor.html?task=${encodeURIComponent(s.id)}&event=${encodeURIComponent(ev.id)}`,
          ),
        });
      }
      return;
    }

    if (changed) {
      await persistScript(s);
      render();
    }
    return;
  }

  // ---- 步骤级操作 ----
  const stepBtn =
    e.target.closest('[data-up]') ||
    e.target.closest('[data-down]') ||
    e.target.closest('[data-dup]') ||
    e.target.closest('[data-del]');

  if (stepBtn) {
    e.stopPropagation();
    const d = stepBtn.dataset;
    const ei = Number(d.ev);
    let changed = false;
    if (d.up !== undefined) changed = moveStep(s, ei, Number(d.up), -1);
    else if (d.down !== undefined) changed = moveStep(s, ei, Number(d.down), 1);
    else if (d.dup !== undefined) changed = duplicateStep(s, ei, Number(d.dup));
    else if (d.del !== undefined) changed = deleteStep(s, ei, Number(d.del));
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

  if (act === 'add-gesture' || act === 'add-js') {
    e.stopPropagation();
    addEvent(s, act === 'add-js' ? 'js' : 'gesture');
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
        setTimeout(() => { const b = card.querySelector('[data-act="export"]'); if (b) b.textContent = '导出此任务'; }, 1200);
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
    const st = stepAt(s, e.target.dataset.ev, e.target.dataset.step);
    if (!st) return;
    st.value = st.type === 'wait' ? Number(e.target.value) || 0 : e.target.value;
    await persistScript(s);
    return;
  }

  // 匹配条件（加固定位用）
  if (e.target.matches('[data-match]')) {
    const st = stepAt(s, e.target.dataset.ev, e.target.dataset.match);
    if (!st) return;
    st.match = String(e.target.value || '').trim();
    await persistScript(s);
    return;
  }

  // 步骤延时（修页面抖动最常用的一项）
  if (e.target.matches('[data-delay]')) {
    const st = stepAt(s, e.target.dataset.ev, e.target.dataset.delay);
    if (!st) return;
    st.delay = Math.max(0, Number(e.target.value) || 0);
    await persistScript(s);
    return;
  }

  // ---- 事件级字段 ----
  const evKey = e.target.dataset.evd;
  if (evKey) {
    const ev = eventAt(s, e.target.dataset.ev);
    if (!ev) return;
    const raw = e.target.value;
    if (evKey === 'name') ev.name = String(raw || '').trim();
    else if (evKey === 'world') ev.world = raw === 'cdp' ? 'cdp' : 'auto';
    else if (evKey === 'wait-url') ev.wait = { ...(ev.wait || {}), url: String(raw || '').trim() };
    else if (evKey === 'wait-selector') ev.wait = { ...(ev.wait || {}), selector: String(raw || '').trim() };
    else if (evKey === 'wait-timeout') ev.wait = { ...(ev.wait || {}), timeoutSec: Math.max(1, Number(raw) || 20) };
    else return;

    await persistScript(s);
    if (evKey === 'world') render();
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
  const num = ['stepTimeout', 'retry', 'speed', 'minGapMs', 'maxGapMs', 'jitterMs', 'logLimit'].includes(key);
  const patch = { [key]: num ? Number(raw) : raw };
  const r = await api({ type: 'SETTINGS_SAVE', patch });
  if (r?.ok) state.settings = { ...DEFAULT_SETTINGS, ...r.settings };
  renderSettings();
});

/* ================= 云备份（Google Drive） ================= */

function driveMsg(text, kind) {
  const el = $('#driveMsg');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = kind === 'err' ? 'var(--red)' : kind === 'ok' ? 'var(--green)' : 'var(--ink-3)';
}

function renderDrive() {
  const d = state.drive;
  if (!d) return;

  const redir = $('#driveRedirect');
  if (redir) redir.textContent = d.redirectUri || '（读不到）';

  // 正在输入时别把用户打了一半的 client id 覆盖回去
  const box = $('#driveClient');
  if (box && document.activeElement !== box) box.value = d.clientId || '';

  const conn = $('#btnDriveConnect');
  if (conn) conn.textContent = d.connected ? '重新连接' : '连接 Google Drive';

  for (const id of ['#btnDriveBackup', '#btnDriveList']) {
    const b = $(id);
    if (b) b.disabled = !d.connected;
  }
  if (!d.connected && !$('#driveMsg')?.textContent) {
    driveMsg(d.clientId ? '填好 Client ID 后点「连接」' : '还没填 Client ID');
  }
}

/** 云操作的统一外壳：任何失败都要说出来，不能默默什么都没发生 */
async function driveAction(label, msg) {
  driveMsg(`${label}中…`);
  try {
    const r = await api(msg);
    if (!r?.ok) throw new Error(r?.error || '操作失败');
    return r;
  } catch (e) {
    driveMsg(`${label}失败：${e?.message || e}`, 'err');
    return null;
  }
}

$('#btnCopyRedirect')?.addEventListener('click', async () => {
  const t = $('#driveRedirect')?.textContent || '';
  try {
    await navigator.clipboard.writeText(t);
    driveMsg('重定向 URI 已复制，粘到 OAuth 客户端的「已获授权的重定向 URI」里', 'ok');
  } catch {
    driveMsg('复制失败，请手动选中复制', 'err');
  }
});

$('#driveClient')?.addEventListener('blur', async () => {
  const v = String($('#driveClient').value || '').trim();
  if (v === (state.drive?.clientId || '')) return;
  const r = await api({ type: 'DRIVE_SET_CLIENT', clientId: v });
  if (r?.ok) {
    state.drive = r.drive;
    renderDrive();
    driveMsg(v ? 'Client ID 已保存' : '已清空 Client ID', v ? 'ok' : '');
  }
});

$('#btnDriveConnect')?.addEventListener('click', async () => {
  const r = await driveAction('连接', { type: 'DRIVE_CONNECT' });
  if (!r) return;
  state.drive = r.drive;
  renderDrive();
  driveMsg('已连接 Google Drive', 'ok');
  await loadDriveFiles();
});

$('#btnDriveOff')?.addEventListener('click', async () => {
  if (!confirm('断开 Google Drive？只清除本地令牌，云端备份不受影响。')) return;
  await api({ type: 'DRIVE_DISCONNECT' });
  const r = await api({ type: 'DRIVE_STATUS' });
  if (r?.ok) state.drive = r.drive;
  state.driveFiles = [];
  renderDrive();
  renderDriveFiles();
  driveMsg('已断开', '');
});

$('#btnDriveBackup')?.addEventListener('click', async () => {
  const r = await driveAction('备份', { type: 'DRIVE_BACKUP' });
  if (!r) return;
  driveMsg(
    `已备份 ${r.count} 个任务${r.pruned ? `，顺手清了 ${r.pruned} 份最旧的` : ''}`,
    'ok',
  );
  await loadDriveFiles();
});

$('#btnDriveList')?.addEventListener('click', () => loadDriveFiles(true));

async function loadDriveFiles(showMsg) {
  const r = await driveAction('读取云端列表', { type: 'DRIVE_LIST' });
  if (!r) return;
  state.driveFiles = r.files || [];
  renderDriveFiles();
  if (showMsg) driveMsg(`云端有 ${state.driveFiles.length} 份备份`, 'ok');
}

function renderDriveFiles() {
  const box = $('#driveFiles');
  if (!box) return;
  const files = state.driveFiles || [];

  if (!files.length) {
    box.innerHTML = '<div class="dim" style="padding:6px 0">云端还没有备份</div>';
    return;
  }

  box.innerHTML = files
    .map((f) => {
      const when = f.createdTime
        ? new Date(f.createdTime).toLocaleString('zh-CN', { hour12: false })
        : f.name || '';
      const kb = f.size ? `${(Number(f.size) / 1024).toFixed(1)} KB` : '';
      return `<div class="drive-file">
  <span class="nm" title="${esc(f.name || '')}">${esc(when)}</span>
  <span class="dim">${esc(kb)}</span>
  <button class="btn" data-restore="${esc(f.id)}">恢复</button>
</div>`;
    })
    .join('');
}

$('#driveFiles')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-restore]');
  if (!btn) return;
  if (!confirm('从这份备份恢复？同 id 的任务会跳过，不会覆盖你现在的配置。')) return;

  const r = await driveAction('恢复', { type: 'DRIVE_RESTORE', fileId: btn.dataset.restore });
  if (!r) return;
  driveMsg(`恢复完成：新增 ${r.added} 个，跳过 ${r.skipped} 个`, 'ok');
  await refresh();
});

$('#btnOpenLogs')?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('logs/logs.html') });
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
