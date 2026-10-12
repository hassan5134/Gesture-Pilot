/**
 * 自定义 JavaScript 事件的执行器。
 *
 * 有两条路，差别只在「能不能编译任意代码」这一件事上：
 *
 *  1. 轻量注入 —— chrome.scripting.executeScript(..., world: 'MAIN')
 *     快到几乎无感，页面上不留痕迹。但它要把用户代码编译成函数，
 *     这一步用 new Function，会受**站点** CSP 约束：
 *     站点只要没给 script-src 加 'unsafe-eval'，就会抛 EvalError。
 *
 *  2. CDP —— Runtime.evaluate
 *     调试协议是特权的，不受站点 CSP 限制（这也是 DevTools 控制台
 *     能随便 eval 的原因）。代价是页面顶部会挂一条「正在调试此浏览器」
 *     提示条，而且和 DevTools 互斥。
 *
 * world = 'auto' 时先走 1，只有确认是 CSP 拦下来的才降级到 2 ——
 * 用户代码自身的语法错误不该触发降级，否则报错会变得莫名其妙。
 *
 * 两条路都在页面主世界执行，所以用户代码能访问页面的 window / jQuery / React。
 */

import { attach, detach, sendCommand } from './cdp.js';

/** 这次任务里用过 CDP 的标签页，任务结束时统一释放 */
const usedTabs = new Set();

const MAX_LOG_TEXT = 2000;

/* ==================================================================
 * 路径 1：轻量注入
 * ================================================================== */

/**
 * 这个函数会被序列化后注入页面，**不能引用任何外部变量** ——
 * 引用外部作用域会让 Chrome 直接拒绝注入。
 * 它在页面主世界里跑，所以 new Function 受站点 CSP 约束。
 */
function injectedRunner(code, context) {
  const logs = [];
  const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
  const MAX_STACK = 2000;

  const fmt = (a) => {
    try {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      if (typeof a === 'function') return '[function]';
      if (typeof a === 'undefined') return 'undefined';
      const s = JSON.stringify(a);
      return typeof s === 'undefined' ? String(a) : s;
    } catch {
      return String(a);
    }
  };

  const originals = {};
  for (const lv of LEVELS) originals[lv] = console[lv];
  for (const lv of LEVELS) {
    console[lv] = (...a) => {
      logs.push({ level: lv, text: a.map(fmt).join(' ') });
      try {
        originals[lv].apply(console, a);
      } catch {
        /* 页面把 console 玩坏了，不影响我们 */
      }
    };
  }
  const restore = () => {
    for (const lv of LEVELS) console[lv] = originals[lv];
  };

  const safeOut = (v) => {
    try {
      JSON.stringify(v);
      return v;
    } catch {
      return String(v);
    }
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.min(60000, Math.max(0, Number(ms) || 0))));

  const gp = {
    url: location.href,
    title: document.title,
    task: (context && context.task) || '',
    log: (...a) => logs.push({ level: 'log', text: a.map(fmt).join(' ') }),
    sleep,
    $: (sel) => document.querySelector(sel),
    $$: (sel) => Array.from(document.querySelectorAll(sel)),
    waitFor: async (sel, timeoutMs) => {
      const deadline = Date.now() + Math.max(100, Number(timeoutMs) || 5000);
      for (;;) {
        let el = null;
        try {
          el = document.querySelector(sel);
        } catch {
          return null;
        }
        if (el) return el;
        if (Date.now() >= deadline) return null;
        await sleep(150);
      }
    },
  };

  try {
    const fn = new Function('gp', `return (async () => {${code}\n})();`);
    return fn(gp)
      .then((value) => ({ ok: true, value: safeOut(value), logs, via: 'inject' }))
      .catch((e) => ({
        ok: false,
        error: String((e && e.message) || e),
        name: String((e && e.name) || 'Error'),
        stack: String((e && e.stack) || '').slice(0, MAX_STACK),
        logs,
        via: 'inject',
      }))
      .finally(restore);
  } catch (e) {
    restore();
    return {
      ok: false,
      error: String((e && e.message) || e),
      name: String((e && e.name) || 'Error'),
      stack: String((e && e.stack) || '').slice(0, MAX_STACK),
      logs,
      via: 'inject',
    };
  }
}

/* ==================================================================
 * 路径 2：CDP
 * ================================================================== */

/**
 * 拼出要交给 Runtime.evaluate 的表达式。
 *
 * 用户代码直接内联进去，不用 new Function —— 调试协议本身就是求值，
 * 再套一层 eval 反而多一次被拦的机会。
 * 用晦涩的变量名，避免和用户代码里的名字撞车。
 */
function buildCdpExpression(code, context) {
  const ctxJson = JSON.stringify(context || {}).replace(/</g, '\\u003c');

  return `(async () => {
  const _gxLogs = [];
  const _gxCtx = ${ctxJson};
  const _gxLevels = ['log', 'info', 'warn', 'error', 'debug'];
  const _gxOrig = {};
  const _gxFmt = (a) => {
    try {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.name + ': ' + a.message;
      if (typeof a === 'function') return '[function]';
      if (typeof a === 'undefined') return 'undefined';
      const s = JSON.stringify(a);
      return typeof s === 'undefined' ? String(a) : s;
    } catch (e) { return String(a); }
  };
  for (const _lv of _gxLevels) _gxOrig[_lv] = console[_lv];
  for (const _lv of _gxLevels) {
    console[_lv] = (...a) => {
      _gxLogs.push({ level: _lv, text: a.map(_gxFmt).join(' ') });
      try { _gxOrig[_lv].apply(console, a); } catch (e) {}
    };
  }
  const _gxRestore = () => { for (const _lv of _gxLevels) console[_lv] = _gxOrig[_lv]; };
  const _gxSleep = (ms) => new Promise((r) => setTimeout(r, Math.min(60000, Math.max(0, Number(ms) || 0))));
  const gp = {
    url: location.href,
    title: document.title,
    task: _gxCtx.task || '',
    log: (...a) => _gxLogs.push({ level: 'log', text: a.map(_gxFmt).join(' ') }),
    sleep: _gxSleep,
    $: (sel) => document.querySelector(sel),
    $$: (sel) => Array.from(document.querySelectorAll(sel)),
    waitFor: async (sel, timeoutMs) => {
      const deadline = Date.now() + Math.max(100, Number(timeoutMs) || 5000);
      for (;;) {
        let el = null;
        try { el = document.querySelector(sel); } catch (e) { return null; }
        if (el) return el;
        if (Date.now() >= deadline) return null;
        await _gxSleep(150);
      }
    },
  };

  try {
    const _gxValue = await (async () => {
${code}
    })();
    let _gxSafe = _gxValue;
    try { JSON.stringify(_gxValue); } catch (e) { _gxSafe = String(_gxValue); }
    if (typeof _gxSafe === 'undefined') _gxSafe = undefined;
    return { ok: true, value: _gxSafe, logs: _gxLogs, via: 'cdp' };
  } catch (e) {
    return {
      ok: false,
      error: String((e && e.message) || e),
      name: String((e && e.name) || 'Error'),
      stack: String((e && e.stack) || '').slice(0, ${MAX_LOG_TEXT}),
      logs: _gxLogs,
      via: 'cdp',
    };
  } finally {
    _gxRestore();
  }
})()`;
}

/* ==================================================================
 * 对外接口
 * ================================================================== */

const CSP_HINT = /unsafe-eval|refused to evaluate|content security policy|evalerror/i;

/** 这个失败是不是「被站点 CSP 拦了」——只有这种才值得降级重试 */
export function isCspBlock(res) {
  if (!res || res.ok) return false;
  if (String(res.name || '') === 'EvalError') return true;
  return CSP_HINT.test(String(res.error || ''));
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: `${label}超时（${ms} ms）`, name: 'TimeoutError', timeout: true, logs: [] }),
      ms,
    );
    promise.then(finish).catch((e) =>
      finish({ ok: false, error: String((e && e.message) || e), name: String((e && e.name) || 'Error'), logs: [] }),
    );
  });
}

async function runInject(tabId, frameId, code, context) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    func: injectedRunner,
    args: [code, context || {}],
  });
  const r = results?.[0]?.result;
  if (!r) {
    return { ok: false, error: '注入执行没有返回结果（页面可能已跳走）', name: 'NoResult', logs: [], via: 'inject' };
  }
  return r;
}

async function runCdp(tabId, frameId, code, context, timeoutMs) {
  if (frameId !== 0) {
    throw new Error('调试接口执行只支持页面主框架，请把该事件的作用范围设为主框架');
  }
  await attach(tabId);
  usedTabs.add(tabId);

  const res = await sendCommand(tabId, 'Runtime.evaluate', {
    expression: buildCdpExpression(code, context),
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });

  if (res?.exceptionDetails) {
    const ex = res.exceptionDetails;
    return {
      ok: false,
      error: ex.exception?.description || ex.text || '调试接口执行失败',
      name: ex.exception?.className || 'Error',
      logs: [],
      via: 'cdp',
    };
  }

  const value = res?.result?.value;
  if (value && typeof value === 'object' && 'ok' in value) return { ...value, via: 'cdp' };

  // returnByValue 遇到不可序列化的返回值时会是 undefined，但代码其实跑成功了
  return { ok: true, value, logs: [], via: 'cdp' };
}

/**
 * 执行一个 JS 事件。
 *
 * @param {object} o
 * @param {number} o.tabId
 * @param {number} o.frameId
 * @param {string} o.code      用户代码
 * @param {'auto'|'cdp'} o.world
 * @param {number} o.timeoutMs
 * @param {object} o.context   { task, event }
 * @param {object} o.log       日志器（可选）
 * @returns {Promise<{ok, value?, error?, logs, via, fellBack?}>}
 */
export async function runUserCode({ tabId, frameId = 0, code, world = 'auto', timeoutMs = 30000, context = {}, log = null }) {
  const budget = Math.max(1000, Number(timeoutMs) || 30000);
  const src = String(code || '').trim();

  if (!src) return { ok: false, error: '事件里没有代码', name: 'EmptyCode', logs: [], via: 'none' };

  // 指定 always-CDP 时跳过尝试，省下那一次必然失败的注入
  if (world === 'cdp') {
    try {
      const r = await withTimeout(runCdp(tabId, frameId, src, context, budget), budget, '调试接口执行');
      return attachLogs(r, log);
    } catch (e) {
      return attachLogs(
        { ok: false, error: String(e?.message || e), name: 'CdpError', logs: [], via: 'cdp' },
        log,
      );
    }
  }

  let first;
  try {
    first = await withTimeout(runInject(tabId, frameId, src, context), budget, '注入执行');
  } catch (e) {
    first = { ok: false, error: String(e?.message || e), name: 'InjectError', logs: [], via: 'inject' };
  }

  if (first.ok || !isCspBlock(first)) return attachLogs(first, log);

  // 只有确认是站点 CSP 挡的才降级 —— 用户代码自己写错了不该重跑一遍
  log?.warn('注入执行被站点 CSP 拦下，改用调试接口重试', { error: first.error });
  try {
    const second = await withTimeout(runCdp(tabId, frameId, src, context, budget), budget, '调试接口执行');
    return attachLogs({ ...second, fellBack: true, injectError: first.error }, log);
  } catch (e) {
    return attachLogs(
      {
        ok: false,
        error: `${String(e?.message || e)}（注入被 CSP 拦下后，调试接口也失败了）`,
        name: 'CdpError',
        logs: first.logs || [],
        via: 'cdp',
        fellBack: true,
      },
      log,
    );
  }
}

/** 把用户代码里的 console 输出转进执行日志 */
function attachLogs(res, log) {
  if (log && Array.isArray(res?.logs)) {
    for (const l of res.logs.slice(0, 50)) {
      const text = String(l.text || '').slice(0, MAX_LOG_TEXT);
      if (l.level === 'error') log.error(`[页面] ${text}`);
      else if (l.level === 'warn') log.warn(`[页面] ${text}`);
      else log.info(`[页面] ${text}`);
    }
    if (res.logs.length > 50) log.info(`（页面还有 ${res.logs.length - 50} 条输出未记录）`);
  }
  return res;
}

/** 任务结束时调用：把这次用过的调试连接断掉，页面上的提示条才会消失 */
export async function releaseCdp(tabId) {
  if (!usedTabs.has(tabId)) return false;
  usedTabs.delete(tabId);
  await detach(tabId);
  return true;
}

export async function releaseAllCdp() {
  const ids = [...usedTabs];
  usedTabs.clear();
  for (const t of ids) await detach(t);
  return ids.length;
}

/** 供测试与自检使用 */
export const _internals = { buildCdpExpression, isCspBlock };
