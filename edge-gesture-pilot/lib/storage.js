/**
 * 存储层：脚本 CRUD、设置、运行状态。
 * 脚本结构见 README。
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

/* ---------------- 脚本 ---------------- */

export async function listScripts() {
  const got = await chrome.storage.local.get(K_SCRIPTS);
  return Array.isArray(got[K_SCRIPTS]) ? got[K_SCRIPTS] : [];
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
    cooldownSec: 120,
  };
}

export function normalizeTrigger(input) {
  const base = defaultTrigger();
  const t = input && typeof input === 'object' ? input : {};
  return {
    ...base,
    ...t,
    domains: Array.isArray(t.domains) ? t.domains.map(String) : parseDomainText(t.domains),
    delaySec: Math.max(0, Number(t.delaySec) || 0),
    readyTimeoutSec: Math.max(1, Number(t.readyTimeoutSec) || base.readyTimeoutSec),
    cooldownSec: Math.max(0, Number(t.cooldownSec) || 0),
    once: t.once !== false,
    requireVisible: !!t.requireVisible,
    readySelector: String(t.readySelector || ''),
  };
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
