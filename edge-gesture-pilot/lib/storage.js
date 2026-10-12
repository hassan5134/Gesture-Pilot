/**
 * 存储层：任务（原「脚本」）CRUD、设置、运行状态。
 *
 * 结构自 v0.6.0 起是两级的：
 *   任务 Task
 *     ├─ trigger / schedule   —— 什么时候开始（整条任务一份）
 *     └─ events[]             —— 事件组，顺序串行执行
 *          ├─ type: 'gesture' —— 一段录制下来的手势步骤
 *          └─ type: 'js'      —— 一段自定义 JavaScript（类 Tampermonkey）
 *
 * 老数据只有扁平的 steps[]，没有 events。normalizeScript() 会在读取时
 * 把它包成一个手势事件，所以升级不需要迁移脚本，界面和后台也都不用写兼容分支。
 */

const K_SCRIPTS = 'gx_scripts';
const K_SETTINGS = 'gx_settings';
const K_RUN = 'gx_run';          // 当前/最近一次运行状态
const K_RECORDING = 'gx_recording';
const K_FAILURE = 'gx_last_failure';

export const DEFAULT_SETTINGS = {
  engine: 'synthetic',   // synthetic = content script 合成事件；cdp = chrome.debugger 真实输入
  stepTimeout: 8000,     // 单步等待元素出现的超时
  retry: 1,              // 单步失败重试次数
  speed: 1,              // 播放倍速：>1 更快
  minGapMs: 180,         // 步骤之间最小间隔
  maxGapMs: 15000,       // 录制间隔的封顶（防止中间去喝咖啡）
  jitterMs: 150,         // 随机抖动，避免完全固定节奏
  humanize: true,        // 鼠标轨迹自然化
  hud: true,             // 录制时的页面内实时提示层（鼠标轨迹 / 点击 / 按键）
  notifyOnFail: true,

  debug: false,          // 记录执行日志（排查问题的关键开关）
  logLimit: 1000,        // 日志环形缓冲的条数上限，超出丢最旧的
};

/* ---------------- 设置 ---------------- */

export async function getSettings() {
  const got = await chrome.storage.local.get(K_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(got[K_SETTINGS] || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [K_SETTINGS]: next });
  return next;
}

/* ---------------- 任务 ---------------- */

/**
 * 读取时就补齐结构。
 * 老任务的存储里没有 trigger / events / schedule.domains / enabled 这些字段，
 * 在这里统一补全，界面和后台就都不用到处写兼容判断。
 */
export async function listScripts() {
  const got = await chrome.storage.local.get(K_SCRIPTS);
  const list = Array.isArray(got[K_SCRIPTS]) ? got[K_SCRIPTS] : [];
  return list.map((s) => normalizeScript(s));
}

export async function getScript(id) {
  return (await listScripts()).find((s) => s.id === id) || null;
}

export async function saveScript(script) {
  const list = await listScripts();
  const i = list.findIndex((s) => s.id === script.id);
  if (i >= 0) list[i] = script;
  else list.unshift(script);
  await chrome.storage.local.set({ [K_SCRIPTS]: list });
  return script;
}

export async function deleteScript(id) {
  const list = (await listScripts()).filter((s) => s.id !== id);
  await chrome.storage.local.set({ [K_SCRIPTS]: list });
  await chrome.alarms.clear(alarmName(id));
}

export function alarmName(scriptId) {
  return `gx:script:${scriptId}`;
}

export function scriptIdFromAlarm(name) {
  return name.startsWith('gx:script:') ? name.slice('gx:script:'.length) : null;
}

export function newId() {
  return `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function newEventId() {
  return `e_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/* ---------------- 事件 ---------------- */

/**
 * 事件执行前的等待条件。
 *
 * url      —— 留空 = 不管当前地址。写法与「生效域名」一致（host / 通配 / URL 前缀）。
 *             用途：一条任务里跨页操作，A 事件在列表页、B 事件在详情页。
 * selector —— 留空 = 不等待元素。非空时等到元素出现才执行，等不到就跳过这个事件。
 *            用途：等 SPA 渲染完，比固定延迟可靠得多。
 */
export function defaultWait() {
  return {
    url: '',
    selector: '',
    timeoutSec: 20,
  };
}

export function normalizeWait(input) {
  const base = defaultWait();
  const w = input && typeof input === 'object' ? input : {};
  return {
    url: String(w.url || '').trim(),
    selector: String(w.selector || '').trim(),
    timeoutSec: Math.max(1, Number(w.timeoutSec) || base.timeoutSec),
  };
}

/** 事件的默认结构。type 决定用 steps 还是 code。 */
export function defaultEvent(type = 'gesture', patch = {}) {
  const e = {
    id: newEventId(),
    name: '',
    type: type === 'js' ? 'js' : 'gesture',
    enabled: true,
    wait: defaultWait(),
  };
  if (e.type === 'js') {
    e.code = '';
    // auto = 先试轻量注入，被站点 CSP 拦下再自动切 CDP
    e.world = 'auto';
  } else {
    e.steps = [];
  }
  return normalizeEvent({ ...e, ...patch });
}

export function normalizeEvent(input) {
  const e = input && typeof input === 'object' ? input : {};
  const type = e.type === 'js' ? 'js' : 'gesture';
  const out = {
    id: String(e.id || newEventId()),
    name: String(e.name || ''),
    type,
    enabled: e.enabled !== false,
    wait: normalizeWait(e.wait),
  };
  if (type === 'js') {
    out.code = String(e.code || '');
    // auto = 先试轻量注入，被站点 CSP 拦下再自动切 CDP；cdp = 直接走调试接口
    out.world = ['auto', 'cdp'].includes(e.world) ? e.world : 'auto';
  } else {
    out.steps = Array.isArray(e.steps) ? e.steps.map((s) => ({ ...s })) : [];
  }
  return out;
}

/**
 * 把任务上的事件取出来，顺带处理老数据。
 * 老结构只有扁平 steps，包成一个手势事件 —— 语义完全等价，只是多了一层壳。
 */
export function normalizeEvents(source) {
  const list = Array.isArray(source?.events) ? source.events : null;
  if (list && list.length) return list.map((e) => normalizeEvent(e));

  const steps = Array.isArray(source?.steps) ? source.steps : [];
  // 老任务名下的步骤，原样装进唯一的事件里
  return [normalizeEvent({ type: 'gesture', name: '手势', steps })];
}

/* ---------------- 触发条件 ---------------- */

/**
 * 页面加载触发的默认配置。
 * domains 为空 = 所有域名都生效；其余字段的含义见 README「触发条件」一节。
 */
export function defaultTrigger() {
  return {
    enabled: false,
    domains: [],
    delaySec: 3,
    readySelector: '',
    readyTimeoutSec: 20,
    requireVisible: false,
    once: true,
    // 冷却对所有「自动」触发路径生效：页面加载、刷新、定时。
    // 只有你手动点「运行」/ 快捷键时才豁免 —— 手动是明确的意图，
    // 不该被防重复的闸门挡着。
    cooldownSec: 10,
  };
}

export function normalizeTrigger(input) {
  const base = defaultTrigger();
  const t = input && typeof input === 'object' ? input : {};
  return {
    ...base,
    ...t,
    domains: parseDomainText(t.domains),
    delaySec: Math.max(0, Number(t.delaySec) || 0),
    readyTimeoutSec: Math.max(1, Number(t.readyTimeoutSec) || base.readyTimeoutSec),
    cooldownSec: Math.max(0, Number(t.cooldownSec) || 0),
    once: t.once !== false,
    requireVisible: !!t.requireVisible,
    readySelector: String(t.readySelector || ''),
  };
}

/* ---------------- 定时 ---------------- */

export function defaultSchedule() {
  return {
    enabled: false,
    mode: 'interval',   // interval | daily
    everySec: 1800,
    time: '09:30',
    domains: [],        // 生效域名：留空 = 不限制
  };
}

export function normalizeSchedule(input) {
  const base = defaultSchedule();
  const s = input && typeof input === 'object' ? input : {};
  const time = String(s.time || '');
  return {
    ...base,
    ...s,
    enabled: !!s.enabled,
    mode: s.mode === 'daily' ? 'daily' : 'interval',
    everySec: Math.max(1, Math.round(Number(s.everySec) || 0) || base.everySec),
    time: /^\d{1,2}:\d{2}$/.test(time) ? time : base.time,
    domains: parseDomainText(s.domains),
  };
}

/* ---------------- 任务整体规范化 ---------------- */

/**
 * 所有写入路径都过这里，保证老任务（没有 trigger / 没有 events）
 * 读出来也是完整结构，界面不用到处做兼容判断。
 */
export function normalizeScript(input) {
  const s = { ...(input || {}) };
  s.enabled = s.enabled !== false; // 默认启用
  s.schedule = normalizeSchedule(s.schedule);
  s.trigger = normalizeTrigger(s.trigger);
  s.events = normalizeEvents(s);
  // steps 已并入 events，留着会在导入导出时产生两份真相
  delete s.steps;
  return s;
}

/** 一条任务实际要跑多少步（手势步骤数，JS 事件按 1 步算） */
export function countSteps(task) {
  let n = 0;
  for (const e of task?.events || []) {
    if (e.enabled === false) continue;
    n += e.type === 'js' ? 1 : (e.steps?.length || 0);
  }
  return n;
}

/** 界面里是一个逗号分隔的文本框，这里转成数组 */
export function parseDomainText(text) {
  if (Array.isArray(text)) return text.map((s) => String(s).trim()).filter(Boolean);
  return String(text || '')
    .split(/[\s,，;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ---------------- 运行状态 ---------------- */

export async function setRunState(state) {
  await chrome.storage.session.set({ [K_RUN]: state });
}

export async function getRunState() {
  const got = await chrome.storage.session.get(K_RUN);
  return got[K_RUN] || null;
}

export async function setRecording(info) {
  if (info) await chrome.storage.session.set({ [K_RECORDING]: info });
  else await chrome.storage.session.remove(K_RECORDING);
}

export async function getRecording() {
  const got = await chrome.storage.session.get(K_RECORDING);
  return got[K_RECORDING] || null;
}

export async function setFailure(info) {
  if (info) await chrome.storage.session.set({ [K_FAILURE]: info });
  else await chrome.storage.session.remove(K_FAILURE);
}

export async function getFailure() {
  const got = await chrome.storage.session.get(K_FAILURE);
  return got[K_FAILURE] || null;
}
