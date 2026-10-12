/**
 * 执行日志。
 *
 * 只在设置里打开 debug 时才记录。关着的时候所有调用在第一步就返回，
 * 开销可以忽略 —— 埋点因此可以铺得很密，不必省着用。
 *
 * 写入策略：
 *  - 攒够一批或过一小段时间再落盘，避免每条日志都读写一次整个数组；
 *  - 但每个事件跑完、每条任务结束时强制 flush，所以 service worker
 *    被回收也只会丢掉最后几十毫秒内的几条；
 *  - storage.local 里保留一个环形缓冲，超出上限丢最旧的。
 *
 * 存 storage.local 而不是 session：排查问题常常是回头再看，
 * 浏览器重启后 session 就空了。
 */

const K_LOGS = 'gx_logs';
const FLUSH_DELAY = 150;
const FLUSH_AT = 25;          // 缓冲到这么多条就立刻写
const MAX_TEXT = 600;         // 单条消息
const MAX_DATA = 1200;        // 附加数据（序列化后）
const MAX_ARRAY = 20;
const MAX_KEYS = 20;
const MAX_DEPTH = 3;

let enabled = false;
let limit = 1000;

let buffer = [];
let timer = null;
let flushing = false;

/** 由 getSettings() 的结果驱动。每次任务开始 / 设置变更时调用 */
export function configure({ debug, logLimit } = {}) {
  if (typeof debug === 'boolean') enabled = debug;
  const n = Number(logLimit);
  if (Number.isFinite(n) && n > 0) limit = Math.min(50000, Math.max(50, Math.round(n)));
  return { enabled, limit };
}

export function isEnabled() {
  return enabled;
}

/* ---------------- 序列化 ---------------- */

/** 把任意值裁剪成能安全存进 storage 的形状（防循环引用、防超大对象） */
function safe(v, depth = 0) {
  if (v == null) return v;
  const t = typeof v;
  if (t === 'string') return v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT)}…` : v;
  if (t === 'number' || t === 'boolean') return v;
  if (t === 'bigint') return `${v}n`;
  if (t === 'function') return '[function]';
  if (t === 'symbol') return String(v);
  if (depth >= MAX_DEPTH) return '…';

  if (Array.isArray(v)) {
    const out = v.slice(0, MAX_ARRAY).map((x) => safe(x, depth + 1));
    if (v.length > MAX_ARRAY) out.push(`… 共 ${v.length} 项`);
    return out;
  }

  if (v instanceof Error) return { name: v.name, message: v.message };

  try {
    const out = {};
    const keys = Object.keys(v).slice(0, MAX_KEYS);
    for (const k of keys) {
      try {
        out[k] = safe(v[k], depth + 1);
      } catch {
        out[k] = '[取值失败]';
      }
    }
    return out;
  } catch {
    return '[无法序列化]';
  }
}

/* ---------------- 写入 ---------------- */

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flush();
  }, FLUSH_DELAY);
}

async function flush() {
  if (flushing || !buffer.length) return;
  flushing = true;
  const batch = buffer;
  buffer = [];

  try {
    const got = await chrome.storage.local.get(K_LOGS);
    const all = Array.isArray(got[K_LOGS]) ? got[K_LOGS] : [];
    all.push(...batch);
    const trimmed = all.length > limit ? all.slice(all.length - limit) : all;
    await chrome.storage.local.set({ [K_LOGS]: trimmed });
  } catch {
    // 写失败不能反过来影响任务执行；这批日志塞回去下次再试
    buffer = batch.concat(buffer);
  } finally {
    flushing = false;
    if (buffer.length) schedule();
  }
}

/** 关卡节点调用：保证日志在 service worker 可能被回收之前已经落盘 */
export function flushNow() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  return flush();
}

/* ---------------- 对外接口 ---------------- */

/**
 * 造一个绑定了上下文的日志器。
 * 上下文字段会合并进每条日志，查看页据此按任务 / 事件过滤。
 */
export function loggerFor(base = {}) {
  const mk = (level) => (msg, data) => {
    if (!enabled) return;
    buffer.push({
      t: Date.now(),
      level,
      msg: String(msg ?? '').slice(0, MAX_TEXT),
      data: data === undefined ? undefined : safe(data),
      ...base,
    });
    if (buffer.length >= FLUSH_AT) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      flush();
    } else {
      schedule();
    }
  };

  return {
    info: mk('info'),
    ok: mk('ok'),
    warn: mk('warn'),
    error: mk('error'),
  };
}

/** 不做任何事，用来在 debug 关闭时短路（省掉对象分配） */
export const NOOP_LOGGER = {
  info() {}, ok() {}, warn() {}, error() {},
};

export function makeLogger(base) {
  return enabled ? loggerFor(base) : NOOP_LOGGER;
}

export async function readLogs() {
  await flushNow();
  const got = await chrome.storage.local.get(K_LOGS);
  return Array.isArray(got[K_LOGS]) ? got[K_LOGS] : [];
}

export async function clearLogs() {
  buffer = [];
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await chrome.storage.local.remove(K_LOGS);
}

/** 当前占用情况，设置页显示用 */
export async function logStats() {
  const got = await chrome.storage.local.get(K_LOGS);
  const list = Array.isArray(got[K_LOGS]) ? got[K_LOGS] : [];
  const bytes = await chrome.storage.local.getBytesInUse?.(K_LOGS).catch(() => 0);
  return { count: list.length, limit, bytes: bytes || 0, enabled };
}
