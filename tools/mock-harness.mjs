/**
 * Service Worker 冒烟测试。
 *
 * 沙箱里开不了浏览器，但可以伪造一整套 chrome.* API 把 background.js
 * 真正加载起来并跑完整流程 —— 这能抓出 node --check 抓不到的问题：
 * 未定义引用、字段拼错、逻辑分支走空、状态机卡死。
 *
 * 用法：node tools/mock-harness.mjs
 */
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';

const EXT_SRC = path.resolve(import.meta.dirname, '..', 'edge-gesture-pilot');
const TMP = path.join(os.tmpdir(), 'gx-harness');

/* ------------------------------------------------------------------ *
 * 伪造 chrome API
 * ------------------------------------------------------------------ */

function storageArea(bag) {
  return {
    async get(keys) {
      if (keys == null) return { ...bag };
      if (typeof keys === 'string') return keys in bag ? { [keys]: bag[keys] } : {};
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.filter((k) => k in bag).map((k) => [k, bag[k]]));
      }
      return Object.fromEntries(Object.keys(keys).filter((k) => k in bag).map((k) => [k, bag[k]]));
    },
    async set(obj) {
      Object.assign(bag, obj);
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete bag[k];
    },
  };
}

const L = {
  message: [],
  alarm: [],
  installed: [],
  startup: [],
  debuggerDetach: [],
  tabsUpdated: [],
  menuClicked: [],
  command: [],
  webNavCommitted: [],
};

/** 注入执行的可调开关：测试用它模拟「元素一直不出现」和「站点 CSP 拦下 eval」 */
const execHooks = { selectorFound: true, forceCspBlock: false, cdpValue: null };

/** chrome.contextMenus.create 建出来的菜单项 */
const menuItems = [];

/** 模拟里的「当前标签页」URL，测试可以临时改掉 */
let activeTabUrl = 'https://example.com/app';
const alarms = new Map();
const localBag = {};
const sessionBag = {};

/** 记录每一次 executeScript / tabs.sendMessage，方便断言 */
const calls = {
  executeScript: [],
  tabsSendMessage: [],
  notifications: [],
  debuggerCommands: [],
  offscreen: { create: 0, close: 0, lastJobs: null },
  debugger: { attach: 0, detach: 0 },
  accessLevel: null,
  oauthUrl: null,
};

/** offscreen 文档是否处于打开状态 */
let offscreenOpen = false;

const MOCK_VERSION = '0.2.0';

/** 已经注入过脚本的 frame —— 注入了才会响应消息 */
const injectedFrames = new Set();
/** 单个测试用例对某 frame 的行为覆盖 */
const frameHandlers = new Map(); // frameId -> (msg) => response

/** 内容脚本的默认应答 */
function defaultFrameHandler(msg) {
  switch (msg?.type) {
    case 'GX_RECORD_START': return { ok: true, top: true, fresh: true };
    case 'GX_RECORD_STOP': return { ok: true, count: 0, top: true };
    case 'GX_RUN_STEP': return { ok: true };
    case 'GX_RESOLVE_POINT': return { ok: true, point: { x: 10, y: 20 } };
    case 'GX_PING': return { ok: true, recording: true, top: true, url: 'https://example.com/app' };
    default: return { ok: true };
  }
}

function installChromeMock() {
  globalThis.location = {
  get href() { return activeTabUrl; },
  get origin() { try { return new URL(activeTabUrl).origin; } catch { return ''; } },
};
globalThis.document = {
  title: '模拟页面',
  querySelector: () => null,
  querySelectorAll: () => [],
};
globalThis.performance = globalThis.performance || { now: () => Date.now() };

/** Google Drive 的 fetch 模拟。没有网络，所以这里要把整个链路都摆出来 */
globalThis.fetchCalls = [];
globalThis.fetchMode = { tokenError: null };
const fetchCalls = globalThis.fetchCalls;
const fetchMode = globalThis.fetchMode;

const jsonRes = (obj, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() {
    return obj;
  },
  async text() {
    return typeof obj === 'string' ? obj : JSON.stringify(obj);
  },
});

const CLOUD_BACKUP = JSON.stringify({
  format: 'gesture-pilot-scripts',
  version: 1,
  scripts: [
    {
      id: 's_drv',
      name: '云端来的任务',
      targetUrl: 'https://drv.test/x',
      events: [{ id: 'e_d', type: 'gesture', name: '手势', steps: [{ type: 'click', locator: { kind: 'css', value: '#z' }, delay: 0 }] }],
    },
  ],
});

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = (init.method || 'GET').toUpperCase();
  fetchCalls.push({ url: u, method, body: init.body });

  if (u.includes('oauth2.googleapis.com/token')) {
    if (fetchMode.tokenError) return jsonRes({ error: fetchMode.tokenError }, 400);
    return jsonRes({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 });
  }
  if (u.includes('oauth2.googleapis.com/revoke')) return jsonRes({});

  // 找文件夹（带 mimeType 条件）
  if (u.includes('/drive/v3/files') && u.includes('mimeType')) return jsonRes({ files: [] });
  if (u.includes('/drive/v3/files') && method === 'POST') return jsonRes({ id: 'folder-1' });
  if (u.includes('/upload/drive/v3/files')) {
    return jsonRes({ id: 'file-1', name: 'backup.json', createdTime: '2026-10-12T02:00:00.000Z' });
  }
  if (u.includes('/drive/v3/files') && u.includes('orderBy')) {
    return jsonRes({ files: [{ id: 'file-1', name: 'backup.json', size: '2048', createdTime: '2026-10-12T02:00:00.000Z' }] });
  }
  if (u.includes('alt=media')) return jsonRes(CLOUD_BACKUP);
  if (method === 'DELETE') return jsonRes({});
  return jsonRes({});
};

globalThis.chrome = {
    runtime: {
      onMessage: { addListener: (f) => L.message.push(f) },
      onInstalled: { addListener: (f) => L.installed.push(f) },
      onStartup: { addListener: (f) => L.startup.push(f) },
      getManifest: () => ({ version: MOCK_VERSION }),
      async sendMessage(msg) {
        if (msg?.type === 'GX_TIMER_SYNC') {
          calls.offscreen.lastJobs = msg.jobs;
          return { ok: true, count: (msg.jobs || []).length };
        }
        if (msg?.type === 'GX_TIMER_READY') return { ok: true };
        return {};
      },
      lastError: undefined,
    },

    alarms: {
      onAlarm: { addListener: (f) => L.alarm.push(f) },
      async create(name, info) { alarms.set(name, info); },
      async get(name) { return alarms.get(name); },
      async getAll() { return [...alarms].map(([name, i]) => ({ name, ...i })); },
      async clear(name) { return alarms.delete(name); },
    },

    storage: {
      local: storageArea(localBag),
      session: Object.assign(storageArea(sessionBag), {
        // bootstrap 会调用它，让内容脚本能读 storage.session（录制器自动续录要用）
        async setAccessLevel({ accessLevel }) {
          calls.accessLevel = accessLevel;
        },
      }),
    },

    tabs: {
      async query() {
        return [{ id: 1, url: activeTabUrl, title: '示例后台', windowId: 1 }];
      },
      async get(id) {
        return { id, url: activeTabUrl, status: 'complete', windowId: 1 };
      },
      async update() { return {}; },
      async create() { return { id: 2 }; },
      // 真实 API 同时支持 callback 与 Promise 两种形式，这里都要还原
      sendMessage(tabId, msg, opts, callback) {
        calls.tabsSendMessage.push({ tabId, type: msg?.type, frameId: opts?.frameId });
        const fid = opts?.frameId ?? 0;
        const cb = typeof callback === 'function' ? callback : null;

        const resolveResponse = () => {
          const override = frameHandlers.get(fid);
          if (override) return override(msg);
          // 没有任何接收方 —— 真实浏览器在这里报 lastError
          if (!injectedFrames.has(fid)) {
            throw new Error('Could not establish connection. Receiving end does not exist.');
          }
          return defaultFrameHandler(msg);
        };

        try {
          const resp = resolveResponse();
          if (cb) {
            setTimeout(() => cb(resp), 0);
            return undefined;
          }
          return Promise.resolve(resp);
        } catch (e) {
          if (cb) {
            // 真实行为：先挂 lastError，再以 undefined 回调
            setTimeout(() => {
              chrome.runtime.lastError = e;
              cb(undefined);
              chrome.runtime.lastError = undefined;
            }, 0);
            return undefined;
          }
          return Promise.reject(e);
        }
      },
      async captureVisibleTab() { return 'data:image/jpeg;base64,AAAA'; },
      onUpdated: { addListener: (f) => L.tabsUpdated.push(f), removeListener: () => {} },
    },

    windows: { async update() { return {}; } },

    scripting: {
      async executeScript({ files, func, args, target }) {
        calls.executeScript.push({ files, hasFunc: !!func, frameIds: target?.frameIds });
        const ids = target?.frameIds ?? [0];

        // 注入了 content script 之后，这些 frame 才开始响应消息
        if (files?.some((f) => f.startsWith('content/'))) {
          for (const id of ids) injectedFrames.add(id);
        }
        if (files) return ids.map((frameId) => ({ frameId, result: undefined }));
        if (!func) return ids.map((frameId) => ({ frameId, result: undefined }));

        const src = String(func);

        // 等元素那段是个短函数，没有 new Function
        if (!src.includes('new Function')) {
          return ids.map((frameId) => ({ frameId, result: execHooks.selectorFound }));
        }

        // JS 事件的注入执行：把函数真的跑一遍，
        // 这样连用户代码的返回值、console 捕获、异常路径都一起测到了
        if (execHooks.forceCspBlock) {
          return ids.map((frameId) => ({
            frameId,
            result: {
              ok: false,
              name: 'EvalError',
              error:
                "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script",
              logs: [],
              via: 'inject',
            },
          }));
        }

        const result = await func(args?.[0] ?? '', args?.[1] ?? {});
        return ids.map((frameId) => ({ frameId, result }));
      },
    },

    webNavigation: {
      onCommitted: { addListener: (f) => L.webNavCommitted.push(f) },
      async getAllFrames() {
        return [{ frameId: 0, url: 'https://example.com/app' }];
      },
    },

    offscreen: {
      async hasDocument() { return offscreenOpen; },
      async createDocument() { calls.offscreen.create += 1; offscreenOpen = true; },
      async closeDocument() { calls.offscreen.close += 1; offscreenOpen = false; },
    },

    notifications: {
      async create(id, opts) { calls.notifications.push(opts); return id; },
    },

    debugger: {
      async attach() { calls.debugger.attach += 1; },
      async detach() { calls.debugger.detach += 1; },
      async sendCommand(t, m, p) {
        calls.debuggerCommands.push({ method: m, params: p });
        if (m === 'Runtime.evaluate') {
          return { result: { type: 'object', value: { ok: true, value: execHooks.cdpValue, logs: [], via: 'cdp' } } };
        }
        return {};
      },
      onDetach: { addListener: (f) => L.debuggerDetach.push(f) },
    },

    identity: {
      getRedirectURL: () => 'https://mockextensionid.chromiumapp.org/',
      async launchWebAuthFlow({ url }) {
        calls.oauthUrl = url;
        const u = new URL(url);
        const state = u.searchParams.get('state');
        // 真实流程里 Google 会把 state 原样带回来，这里照着回显
        return `${u.searchParams.get('redirect_uri')}?code=TEST_CODE&state=${state}`;
      },
    },

    contextMenus: {
      onClicked: { addListener: (f) => L.menuClicked.push(f) },
      async removeAll() { menuItems.length = 0; },
      create(item) { menuItems.push(item); },
    },

    commands: {
      onCommand: { addListener: (f) => L.command.push(f) },
    },

    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {},
      async setIcon() {},
      async setTitle() {},
    },
  };

  globalThis.OffscreenCanvas = class {
    getContext() {
      return { fillRect() {}, fillText() {}, set fillStyle(_) {}, set font(_) {}, set textAlign(_) {}, set textBaseline(_) {} };
    }
    async convertToBlob() {
      return { async arrayBuffer() { return new ArrayBuffer(4); } };
    }
  };
  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
}

/* ------------------------------------------------------------------ *
 * 消息发送（模拟 popup）
 * ------------------------------------------------------------------ */

function sendToBackground(msg, sender = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) { settled = true; resolve(v); }
    };
    const kept = L.message[0](msg, sender, done);
    setTimeout(() => done({ __NO_RESPONSE: true }), 8000);
    if (kept !== true && !settled) {
      // 监听器同步返回 undefined 表示它不会回消息
      setTimeout(() => done({ __NO_RESPONSE: true }), 50);
    }
  });
}

/* ------------------------------------------------------------------ *
 * 断言
 * ------------------------------------------------------------------ */

let pass = 0;
let fail = 0;

function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `\n      ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SAMPLE_STEPS = [
  { type: 'click', locator: { kind: 'css', value: '#go' }, rel: { x: 0.5, y: 0.5 }, delay: 0 },
  { type: 'input', locator: { kind: 'attr', attr: 'name', value: 'kw', tag: 'input' }, value: 'hello', delay: 200 },
];

/** 造一个脚本并落库 */
async function makeScript(overrides = {}) {
  const script = {
    id: `s_${Math.random().toString(36).slice(2, 8)}`,
    name: '测试脚本',
    targetUrl: 'https://example.com/app',
    steps: SAMPLE_STEPS.map((s) => ({ ...s })),
    createdAt: Date.now(),
    engine: null,
    schedule: { enabled: false, mode: 'interval', everySec: 1800, time: '09:30' },
    ...overrides,
  };
  await sendToBackground({ type: 'SCRIPT_UPDATE', script });
  return script;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  await cp(EXT_SRC, path.join(TMP, 'edge-gesture-pilot'), { recursive: true });
  // background.js 用了 ESM import，给 Node 一个 module 上下文
  await writeFile(path.join(TMP, 'edge-gesture-pilot', 'package.json'), '{"type":"module"}');

  installChromeMock();

  console.log('\n\x1b[1m[0] 加载 background.js\x1b[0m');
  let loadError = null;
  try {
    await import(pathToFileURL(path.join(TMP, 'edge-gesture-pilot', 'background.js')).href);
  } catch (e) {
    loadError = e;
  }
  check('模块加载无异常', !loadError, loadError && (loadError.stack || String(loadError)));
  if (loadError) return report();

  await sleep(150);

  console.log('\n\x1b[1m[1] onInstalled 引导\x1b[0m');
  check('注册了 onInstalled 监听', L.installed.length === 1);
  for (const f of L.installed) {
    try {
      await f();
    } catch (e) {
      check('onInstalled 回调无异常', false, e?.stack || String(e));
    }
  }
  await sleep(200);
  check('创建了看门狗 alarm', alarms.has('gx:watchdog'), `现有 alarm: ${[...alarms.keys()]}`);
  check('放开了 storage.session 给内容脚本（录制自动续录要用）',
    calls.accessLevel === 'TRUSTED_AND_UNTRUSTED_CONTEXTS', `实际 ${calls.accessLevel}`);

  console.log('\n\x1b[1m[2] 录制前 —— 模拟「扩展安装前就打开的标签页」\x1b[0m');
  injectedFrames.clear(); // 页面上还没有内容脚本，tabs.sendMessage 会 reject
  frameHandlers.clear();
  calls.executeScript.length = 0;

  const r1 = await sendToBackground({ type: 'RECORD_START' });
  check('RECORD_START 有返回', !r1.__NO_RESPONSE, JSON.stringify(r1));
  check('返回 ok', r1?.ok === true, `实际: ${JSON.stringify(r1)}`);
  check('对空白页触发了按需注入', calls.executeScript.length > 0,
    `executeScript 调用: ${JSON.stringify(calls.executeScript)}`);
  check('注入的是 selector + hud + recorder',
    JSON.stringify(calls.executeScript[0]?.files) ===
      JSON.stringify(['content/selector.js', 'content/hud.js', 'content/recorder.js']),
    `实际: ${JSON.stringify(calls.executeScript[0]?.files)}`);
  check('写入了录制状态', !!sessionBag.gx_recording, JSON.stringify(sessionBag.gx_recording));
  check('RECORD_START 回报了 hud 开关', r1?.hud === true, JSON.stringify(r1));

  console.log('\n\x1b[1m[3] 重复点击开始录制应被拒绝\x1b[0m');
  const r2 = await sendToBackground({ type: 'RECORD_START' });
  check('第二次 RECORD_START 返回错误', r2?.ok === false && /已有录制/.test(r2.error || ''), JSON.stringify(r2));

  console.log('\n\x1b[1m[4] 停止录制并落库\x1b[0m');
  // 模拟「增量上报 + 最终全量上报」重叠的真实行为：
  // 第一条早就流式报过，stop 时又原样重报一遍，必须靠 sid 去重
  const stepA = { sid: 'F1:0', type: 'click', locator: { kind: 'css', value: '#go' }, rel: { x: 0.5, y: 0.5 }, ts: 1000, delay: 0 };
  const stepB = { sid: 'F1:1', type: 'input', locator: { kind: 'attr', attr: 'name', value: 'kw', tag: 'input' }, value: 'hello', ts: 2200, delay: 1200 };

  frameHandlers.set(0, (msg) => {
    if (msg.type === 'GX_RECORD_STOP') {
      setTimeout(() => {
        const sender = { tab: { id: 1 }, frameId: 0 };
        // 流式上报（只报了第一条）
        L.message[0]({ type: 'GX_STEPS_APPEND', top: true, url: 'https://example.com/app', steps: [stepA] }, sender, () => {});
        // 最终全量上报（两条都报，第一条重复）
        setTimeout(() => {
          L.message[0](
            { type: 'GX_STEPS_APPEND', final: true, total: 2, top: true, url: 'https://example.com/app', steps: [stepA, stepB] },
            sender,
            () => {},
          );
        }, 30);
      }, 10);
      return { ok: true, count: 2 };
    }
    return { ok: true };
  });

  const r3 = await sendToBackground({ type: 'RECORD_STOP' });
  check('RECORD_STOP 返回 ok', r3?.ok === true, JSON.stringify(r3));
  check('保存了脚本', !!r3?.saved, JSON.stringify(r3?.saved)?.slice(0, 120));
  check('任务含 1 个手势事件（录制结果自动包成事件）', r3?.saved?.events?.length === 1, JSON.stringify(r3?.saved?.events?.length));
  check('事件含 2 步（重复上报靠 sid 去重）', r3?.saved?.events?.[0]?.steps?.length === 2, `实际 ${r3?.saved?.events?.[0]?.steps?.length}`);
  check('落库的步骤里没有残留 sid',
    !r3?.saved?.events?.[0]?.steps?.some((s) => 'sid' in s),
    JSON.stringify(r3?.saved?.events?.[0]?.steps?.map((s) => Object.keys(s))));
  check('第二步 delay 由时间戳重算', r3?.saved?.events?.[0]?.steps?.[1]?.delay === 1200,
    `实际 ${r3?.saved?.events?.[0]?.steps?.[1]?.delay}`);
  check('录制状态已清空', !sessionBag.gx_recording);
  check('临时收集区已清空', !sessionBag.gx_collected);

  const scriptId = r3?.saved?.id;

  console.log('\n\x1b[1m[5] 脚本列表 / 更新 / 定时\x1b[0m');
  const list = await sendToBackground({ type: 'SCRIPT_LIST' });
  check('SCRIPT_LIST 返回 1 个脚本', list?.scripts?.length === 1, JSON.stringify(list?.scripts?.length));
  check('SCRIPT_LIST 带上后台版本（popup 靠它检测旧代码）', list?.version === MOCK_VERSION,
    `实际 ${JSON.stringify(list?.version)}`);

  const script = list.scripts[0];
  script.schedule = { enabled: true, mode: 'interval', everySec: 1800, time: '09:30' };
  const upd = await sendToBackground({ type: 'SCRIPT_UPDATE', script });
  check('SCRIPT_UPDATE 成功', upd?.ok === true, JSON.stringify(upd));
  await sleep(100);
  check('分钟级周期创建了 alarm', alarms.has(`gx:script:${scriptId}`), `现有: ${[...alarms.keys()]}`);

  // 秒级周期应改走 offscreen
  script.schedule = { enabled: true, mode: 'interval', everySec: 20, time: '09:30' };
  await sendToBackground({ type: 'SCRIPT_UPDATE', script });
  await sleep(100);
  check('秒级周期清掉了 alarm', !alarms.has(`gx:script:${scriptId}`), `现有: ${[...alarms.keys()]}`);

  console.log('\n\x1b[1m[6] 执行脚本\x1b[0m');
  await sendToBackground({ type: 'SCRIPT_UPDATE', script: { ...script, schedule: { ...script.schedule, enabled: false } } });
  frameHandlers.set(0, (msg) => {
    if (msg.type === 'GX_RUN_STEP') return { ok: true };
    if (msg.type === 'GX_RESOLVE_POINT') return { ok: true, point: { x: 10, y: 20 } };
    return { ok: true };
  });
  calls.executeScript.length = 0;

  const run = await sendToBackground({ type: 'SCRIPT_RUN', id: scriptId });
  check('SCRIPT_RUN 立即返回', run?.ok === true, JSON.stringify(run));
  await sleep(3500); // 后台是异步跑的，断言必须等它跑完

  check('注入了回放脚本', calls.executeScript.some((c) => c.files?.includes('content/replayer.js')),
    JSON.stringify(calls.executeScript));
  const finalRun = await sendToBackground({ type: 'RUN_STATE' });
  check('运行状态为 success', finalRun?.run?.status === 'success',
    `实际: ${JSON.stringify(finalRun?.run)?.slice(0, 200)}`);
  const stepCalls = calls.tabsSendMessage.filter((c) => c.type === 'GX_RUN_STEP');
  check('两步都被投递', stepCalls.length === 2, `实际 ${stepCalls.length} 次`);
  check('投递到 frameId 0', stepCalls.every((c) => c.frameId === 0), JSON.stringify(stepCalls));

  console.log('\n\x1b[1m[7] 失败路径：元素找不到\x1b[0m');
  frameHandlers.set(0, (msg) => {
    if (msg.type === 'GX_RUN_STEP') return { ok: false, error: '元素未出现：#nope' };
    return { ok: true };
  });
  calls.notifications.length = 0;
  await sendToBackground({ type: 'SCRIPT_RUN', id: scriptId });
  await sleep(4500);

  const failRun = await sendToBackground({ type: 'RUN_STATE' });
  check('运行状态为 failed', failRun?.run?.status === 'failed', `实际: ${JSON.stringify(failRun?.run)?.slice(0, 160)}`);
  check('记录了失败详情', !!sessionBag.gx_last_failure, JSON.stringify(sessionBag.gx_last_failure)?.slice(0, 140));
  check('发送了失败通知', calls.notifications.length > 0, `通知数 ${calls.notifications.length}`);

  console.log('\n\x1b[1m[8] 未知消息类型\x1b[0m');
  const unknown = await sendToBackground({ type: 'NOPE_NOT_A_REAL_TYPE' });
  check('未知类型返回错误而非静默', unknown?.ok === false, JSON.stringify(unknown));

  console.log('\n\x1b[1m[9] 删除脚本\x1b[0m');
  const del = await sendToBackground({ type: 'SCRIPT_DELETE', id: scriptId });
  check('SCRIPT_DELETE 成功', del?.ok === true, JSON.stringify(del));
  const after = await sendToBackground({ type: 'SCRIPT_LIST' });
  check('列表已清空', after?.scripts?.length === 0, `实际 ${after?.scripts?.length}`);

  console.log('\n\x1b[1m[10] 秒级周期 → offscreen 定时器（此前从未被执行过的路径）\x1b[0m');
  const offBefore = { ...calls.offscreen };
  const fast = await makeScript({
    schedule: { enabled: true, mode: 'interval', everySec: 20, time: '09:30' },
  });
  await sleep(400);
  check('秒级周期不创建 alarm', !alarms.has(`gx:script:${fast.id}`), `现有 alarm: ${[...alarms.keys()]}`);
  check('创建了 offscreen 文档', calls.offscreen.create > offBefore.create,
    `create 调用 ${calls.offscreen.create} 次`);
  check('把秒级任务同步给了 offscreen',
    Array.isArray(calls.offscreen.lastJobs) && calls.offscreen.lastJobs.some((j) => j.id === fast.id),
    JSON.stringify(calls.offscreen.lastJobs));
  check('同步的任务带正确的周期', calls.offscreen.lastJobs?.find((j) => j.id === fast.id)?.everySec === 20,
    JSON.stringify(calls.offscreen.lastJobs));

  await sendToBackground({
    type: 'SCRIPT_UPDATE',
    script: { ...fast, schedule: { ...fast.schedule, enabled: false } },
  });
  await sleep(400);
  check('取消定时后关闭了 offscreen 文档', calls.offscreen.close > 0, `close 调用 ${calls.offscreen.close} 次`);

  console.log('\n\x1b[1m[11] CDP 引擎（此前从未被执行过的路径）\x1b[0m');
  const cdpScript = await makeScript({
    engine: 'cdp',
    steps: [
      { type: 'click', locator: { kind: 'css', value: '#go' }, rel: { x: 0.5, y: 0.5 }, delay: 0 },
      { type: 'key', locator: { kind: 'css', value: '#kw' }, key: { key: 'Enter', code: 'Enter', vk: 13 }, delay: 200 },
      { type: 'input', locator: { kind: 'attr', attr: 'name', value: 'kw', tag: 'input' }, value: 'hello', delay: 200 },
      { type: 'drag', locator: { kind: 'css', value: '#slider' }, rel: { x: 0.1, y: 0.5 },
        path: [{ x: 0, y: 0 }, { x: 60, y: 10 }, { x: 150, y: 0 }], delay: 200 },
    ],
  });
  calls.debuggerCommands.length = 0;
  calls.debugger.attach = 0;
  calls.debugger.detach = 0;
  frameHandlers.delete(0); // 走默认应答：GX_RESOLVE_POINT 返回可用的坐标

  await sendToBackground({ type: 'SCRIPT_RUN', id: cdpScript.id });
  await sleep(4000);

  check('attach 了 debugger', calls.debugger.attach === 1, `实际 ${calls.debugger.attach} 次`);
  check('发送了 Input.dispatchMouseEvent',
    calls.debuggerCommands.some((c) => c.method === 'Input.dispatchMouseEvent'),
    `已有: ${[...new Set(calls.debuggerCommands.map((c) => c.method))].join(', ')}`);
  check('发送了 Input.dispatchKeyEvent（Ctrl+A 清空）',
    calls.debuggerCommands.some((c) => c.method === 'Input.dispatchKeyEvent'));
  check('发送了 Input.insertText（整段写入）',
    calls.debuggerCommands.some((c) => c.method === 'Input.insertText'));
  check('鼠标按下/抬起成对出现', (() => {
    const types = calls.debuggerCommands
      .filter((c) => c.method === 'Input.dispatchMouseEvent')
      .map((c) => c.params.type);
    return types.filter((t) => t === 'mousePressed').length === types.filter((t) => t === 'mouseReleased').length
      && types.filter((t) => t === 'mousePressed').length > 0;
  })(), JSON.stringify(calls.debuggerCommands.filter((c) => c.method === 'Input.dispatchMouseEvent').map((c) => c.params.type)));
  check('detach 了 debugger（异常路径也不能漏）', calls.debugger.detach === 1, `实际 ${calls.debugger.detach} 次`);
  check('回放时开启了页面内提示层',
    calls.tabsSendMessage.some((c) => c.type === 'GX_HUD_ON'),
    `HUD 相关消息: ${[...new Set(calls.tabsSendMessage.map((c) => c.type))].filter((t) => t.startsWith('GX_HUD')).join(', ')}`);
  check('回放结束关掉了提示层',
    calls.tabsSendMessage.some((c) => c.type === 'GX_HUD_OFF'));

  // CDP 的按键由后台直接投递，页面收不到事件 —— 必须靠消息回显
  const hudKey = calls.tabsSendMessage.filter((c) => c.type === 'GX_HUD_KEY');
  check('CDP 按键通过消息回显到页面', hudKey.length > 0, `实际 ${hudKey.length} 条`);
  const hudInput = calls.tabsSendMessage.filter((c) => c.type === 'GX_HUD_INPUT');
  check('CDP 输入通过消息回显到页面', hudInput.length > 0, `实际 ${hudInput.length} 条`);

  // ---- 拖拽：CDP 路径 ----
  const moves = calls.debuggerCommands.filter(
    (c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mouseMoved',
  );
  check('拖拽过程中的 mouseMoved 带 buttons=1（否则页面会当成普通移动）',
    moves.some((c) => c.params.buttons === 1),
    JSON.stringify(moves.map((c) => c.params.buttons)));
  const pressed = calls.debuggerCommands.filter(
    (c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed',
  );
  const released = calls.debuggerCommands.filter(
    (c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mouseReleased',
  );
  check('拖拽按下/抬起成对', pressed.length === released.length && pressed.length >= 2,
    `pressed=${pressed.length} released=${released.length}`);
  const hudPath = calls.tabsSendMessage.filter((c) => c.type === 'GX_HUD_PATH');
  check('CDP 拖拽把整条路径发给页面做轨迹动画', hudPath.length > 0, `实际 ${hudPath.length} 条`);

  const cdpRun = await sendToBackground({ type: 'RUN_STATE' });
  check('CDP 运行成功', cdpRun?.run?.status === 'success', JSON.stringify(cdpRun?.run)?.slice(0, 180));

  console.log('\n\x1b[1m[12] 回归：SW 被回收后仍必须能收到步骤（本次「一步都没录到」的根因）\x1b[0m');
  // 模拟 SW 重启：只在 storage.session 里放回录制状态，
  // 相当于一个「新生命周期」的 service worker —— 模块变量全是初始值
  sessionBag.gx_recording = {
    tabId: 1,
    url: 'https://example.com/app',
    title: '示例后台',
    startedAt: Date.now(),
  };
  delete sessionBag.gx_collected;

  L.message[0](
    {
      type: 'GX_STEPS_APPEND',
      final: true,
      top: true,
      url: 'https://example.com/app',
      steps: [{ sid: 'R1:0', type: 'click', locator: { kind: 'css', value: '#a' }, rel: { x: 0.5, y: 0.5 }, ts: 100 }],
    },
    { tab: { id: 1 }, frameId: 0 },
    () => {},
  );
  await sleep(150);
  check('新生命周期内上报的步骤被收下（不再依赖模块变量）',
    sessionBag.gx_collected?.steps?.length === 1,
    JSON.stringify(sessionBag.gx_collected));
  check('记下了上报的 frameId', JSON.stringify(sessionBag.gx_collected?.frameIds) === '[0]',
    JSON.stringify(sessionBag.gx_collected?.frameIds));

  // 不在录制中时上报必须被丢掉（避免上一次的迟到消息污染下一次）
  await sendToBackground({ type: 'RECORD_STOP' }).catch(() => {});
  await sleep(900);
  L.message[0](
    { type: 'GX_STEPS_APPEND', final: true, top: true, steps: [{ sid: 'X:0', type: 'click', locator: { kind: 'css', value: '#x' }, ts: 1 }] },
    { tab: { id: 1 }, frameId: 0 },
    () => {},
  );
  await sleep(150);
  check('停止后迟到的上报被丢弃', !sessionBag.gx_collected, JSON.stringify(sessionBag.gx_collected));

  console.log('\n\x1b[1m[13] 诊断：「有 frame 响应但 0 步」与「无 frame 响应」要说不同的话\x1b[0m');
  sessionBag.gx_recording = { tabId: 1, url: 'https://example.com/app', title: '示例后台', startedAt: Date.now() };
  delete sessionBag.gx_last_failure;
  frameHandlers.set(0, (msg) => {
    if (msg.type === 'GX_RECORD_STOP') {
      setTimeout(() => {
        L.message[0](
          { type: 'GX_STEPS_APPEND', final: true, total: 0, top: true, url: 'https://example.com/app', steps: [] },
          { tab: { id: 1 }, frameId: 0 },
          () => {},
        );
      }, 10);
      return { ok: true, count: 0 };
    }
    return { ok: true };
  });
  const rNone = await sendToBackground({ type: 'RECORD_STOP' });
  check('返回 ok 但没有保存脚本', rNone?.ok === true && !rNone?.saved, JSON.stringify(rNone));
  check('提示明确指出「有 frame 响应」',
    /个 frame 有响应/.test(sessionBag.gx_last_failure?.error || ''),
    sessionBag.gx_last_failure?.error);

  console.log('\n\x1b[1m[14] 页面加载触发：去重 / 冷却 / 忙碌保护\x1b[0m');
  const FAST = [{ type: 'click', locator: { kind: 'css', value: '#go' }, rel: { x: 0.5, y: 0.5 }, delay: 0 }];
  const fastSteps = () => FAST.map((s) => ({ ...s }));
  frameHandlers.delete(0);

  const trg = await makeScript({
    steps: fastSteps(),
    trigger: { enabled: true, domains: ['example.com'], delaySec: 0, once: true, cooldownSec: 0 },
  });

  const f1 = await sendToBackground({
    type: 'TRIGGER_FIRE', scriptId: trg.id, loadId: 'L1', url: 'https://example.com/app',
  });
  check('首次页面触发被接受', f1?.ok === true, JSON.stringify(f1));

  const f2 = await sendToBackground({
    type: 'TRIGGER_FIRE', scriptId: trg.id, loadId: 'L2', url: 'https://example.com/app',
  });
  check('正在运行时不再叠加触发',
    f2?.ok === false && /正在运行/.test(f2.skipped || ''), JSON.stringify(f2));

  await sleep(900);
  const f3 = await sendToBackground({
    type: 'TRIGGER_FIRE', scriptId: trg.id, loadId: 'L1', url: 'https://example.com/app',
  });
  check('同一次页面加载不重复触发（once 生效）',
    f3?.ok === false && /已经触发过/.test(f3.skipped || ''), JSON.stringify(f3));

  const f4 = await sendToBackground({
    type: 'TRIGGER_FIRE', scriptId: trg.id, loadId: 'L2', url: 'https://example.com/app',
  });
  check('换一次页面加载（新 loadId）可以再触发', f4?.ok === true, JSON.stringify(f4));

  await sleep(900);
  const trgCool = await makeScript({
    steps: fastSteps(),
    trigger: { enabled: true, domains: [], delaySec: 0, once: false, cooldownSec: 3600 },
  });
  const c1 = await sendToBackground({ type: 'TRIGGER_FIRE', scriptId: trgCool.id, loadId: 'X1' });
  check('冷却未生效时首次可触发', c1?.ok === true, JSON.stringify(c1));
  await sleep(900);
  const c2 = await sendToBackground({ type: 'TRIGGER_FIRE', scriptId: trgCool.id, loadId: 'X2' });
  check('冷却期内被拦下', c2?.ok === false && /冷却中/.test(c2.skipped || ''), JSON.stringify(c2));

  const trgOff = await makeScript({ steps: fastSteps(), trigger: { enabled: false } });
  const o1 = await sendToBackground({ type: 'TRIGGER_FIRE', scriptId: trgOff.id, loadId: 'Y1' });
  check('触发未启用时拒绝', o1?.ok === false && /未启用/.test(o1.skipped || ''), JSON.stringify(o1));

  const o2 = await sendToBackground({ type: 'TRIGGER_FIRE', scriptId: 's_not_exist', loadId: 'Z1' });
  check('脚本不存在时给出明确原因',
    o2?.ok === false && /不存在/.test(o2.skipped || ''), JSON.stringify(o2));

  const lst = await sendToBackground({ type: 'SCRIPT_LIST' });
  check('SCRIPT_LIST 带回触发记录（界面显示「上次触发」）',
    !!lst?.triggerLog?.[trg.id]?.at, JSON.stringify(lst?.triggerLog));

  /* ---------------------------------------------------------------- *
   * [15] 右键菜单与快捷键
   * ---------------------------------------------------------------- */

  console.log('\n\x1b[1m[15] 右键菜单与键盘快捷键\x1b[0m');
  check('菜单注册了「录制 / 停止」项', menuItems.some((i) => i.id === 'gx:record'),
    JSON.stringify(menuItems.map((i) => i.id)));
  check('菜单有「运行脚本」父项', menuItems.some((i) => i.id === 'gx:run'));
  check('脚本被挂成子项', menuItems.some((i) => i.parentId === 'gx:run' && String(i.id).startsWith('gx:run:')),
    JSON.stringify(menuItems.filter((i) => i.parentId).map((i) => i.id)));
  check('注册了 commands 监听', L.command.length === 1, `实际 ${L.command.length}`);

  // 快捷键：切换录制
  injectedFrames.clear();
  frameHandlers.clear();
  await L.command[0]('toggle-record');
  await sleep(300);
  check('Ctrl+Shift+E：开始录制', !!sessionBag.gx_recording, JSON.stringify(sessionBag.gx_recording));

  await L.command[0]('toggle-record');
  await sleep(1300);
  check('再按一次停止录制', !sessionBag.gx_recording);

  // 快捷键：运行当前页匹配的脚本
  const cur = await makeScript({
    steps: fastSteps(),
    targetUrl: 'https://example.com/app',
    trigger: { enabled: true, domains: ['example.com'] },
  });
  await sleep(200);
  await L.command[0]('run-current');
  await sleep(900);
  const cmdRun = await sendToBackground({ type: 'RUN_STATE' });
  check('Ctrl+Shift+K：运行当前页匹配的脚本',
    ['running', 'success'].includes(cmdRun?.run?.status) && cmdRun?.run?.scriptId === cur.id,
    JSON.stringify(cmdRun?.run)?.slice(0, 140));


  /* ---------------------------------------------------------------- *
   * [16] 定时触发的生效域名守卫
   * ---------------------------------------------------------------- */

  console.log('\n\x1b[1m[16] 定时触发的生效域名守卫\x1b[0m');
  frameHandlers.delete(0);
  const guarded = await makeScript({
    steps: fastSteps(),
    schedule: {
      enabled: true, mode: 'interval', everySec: 1800, time: '09:30',
      domains: ['other.com'],
    },
  });
  await sleep(150);
  check('定时域名不影响 alarm 的创建', alarms.has(`gx:script:${guarded.id}`), `现有: ${[...alarms.keys()]}`);

  await L.alarm[0]({ name: `gx:script:${guarded.id}` });
  await sleep(900);
  const gRun = await sendToBackground({ type: 'RUN_STATE' });
  check('跑到范围外的页面会被判失败', gRun?.run?.status === 'failed', JSON.stringify(gRun?.run)?.slice(0, 140));
  check('失败原因点明了生效域名',
    /生效域名/.test(sessionBag.gx_last_failure?.error || ''), sessionBag.gx_last_failure?.error);

  // 命中域名时正常执行
  const okDom = await makeScript({
    steps: fastSteps(),
    schedule: {
      enabled: true, mode: 'interval', everySec: 1800, time: '09:30',
      domains: ['example.com'],
    },
  });
  await sleep(150);
  await L.alarm[0]({ name: `gx:script:${okDom.id}` });
  await sleep(900);
  const okRun = await sendToBackground({ type: 'RUN_STATE' });
  check('命中生效域名时正常执行', okRun?.run?.status === 'success', JSON.stringify(okRun?.run)?.slice(0, 140));

  /* ---------------------------------------------------------------- *
   * [17] 脚本总开关
   * ---------------------------------------------------------------- */

  console.log('\n\x1b[1m[17] 脚本总开关（停用）\x1b[0m');
  const offS = await makeScript({
    steps: fastSteps(),
    enabled: false,
    schedule: { enabled: true, mode: 'interval', everySec: 1800, time: '09:30' },
    trigger: { enabled: true, domains: [] },
  });
  await sleep(150);
  check('停用的脚本不建定时 alarm', !alarms.has(`gx:script:${offS.id}`), `现有: ${[...alarms.keys()]}`);

  const offTrig = await sendToBackground({ type: 'TRIGGER_FIRE', scriptId: offS.id, loadId: 'OFF1' });
  check('停用的脚本不响应页面触发',
    offTrig?.ok === false && /停用/.test(offTrig.skipped || ''), JSON.stringify(offTrig));

  const offMenu = menuItems.some((i) => i.id === `gx:run:${offS.id}`);
  check('停用的脚本不出现在右键菜单里', !offMenu);

  /* ---------------------------------------------------------------- *
   * [18] 老脚本（缺字段）读出来要补全
   * ---------------------------------------------------------------- */

  console.log('\n\x1b[1m[18] 老脚本兼容：读出来自动补全结构\x1b[0m');
  localBag.gx_scripts = [
    ...(localBag.gx_scripts || []),
    {
      id: 's_legacy',
      name: '老脚本',
      targetUrl: 'https://example.com/x',
      steps: [{ type: 'click', locator: { kind: 'css', value: '#a' }, rel: { x: 0.5, y: 0.5 }, delay: 0 }],
      createdAt: 1,
      // 注意：没有 enabled / trigger / schedule.domains
    },
  ];
  const l2 = await sendToBackground({ type: 'SCRIPT_LIST' });
  const legacy = l2.scripts.find((x) => x.id === 's_legacy');
  check('补齐 enabled', legacy?.enabled === true, JSON.stringify(legacy?.enabled));
  check('补齐 schedule.domains', Array.isArray(legacy?.schedule?.domains), JSON.stringify(legacy?.schedule));
  check('补齐 trigger', !!legacy?.trigger && legacy.trigger.enabled === false, JSON.stringify(legacy?.trigger));

  /* ---------------------------------------------------------------- *
   * [19] 导入
   * ---------------------------------------------------------------- */

  console.log('\n\x1b[1m[19] 导入脚本\x1b[0m');
  const imp = await sendToBackground({
    type: 'SCRIPT_IMPORT',
    scripts: [
      { id: 's_imp1', name: '导入的 A', targetUrl: 'https://a.com', steps: [{ type: 'click', locator: { kind: 'css', value: '#x' }, delay: 0 }] },
      { id: trg.id, name: '重复 id', steps: [{ type: 'click', locator: { kind: 'css', value: '#y' }, delay: 0 }] },
      { name: '没有步骤', steps: [] },
      null,
    ],
  });
  check('导入统计正确（1 成功 3 跳过）', imp?.added === 1 && imp?.skipped === 3, JSON.stringify(imp));

  const l3 = await sendToBackground({ type: 'SCRIPT_LIST' });
  const imported = l3.scripts.find((x) => x.id === 's_imp1');
  check('导入的脚本被规范化', imported?.enabled === true && Array.isArray(imported?.schedule?.domains),
    JSON.stringify({ enabled: imported?.enabled, domains: imported?.schedule?.domains }));
  check('同 id 的现有脚本没有被覆盖',
    l3.scripts.filter((x) => x.id === trg.id).length === 1,
    `实际 ${l3.scripts.filter((x) => x.id === trg.id).length} 条`);

  const impEmpty = await sendToBackground({ type: 'SCRIPT_IMPORT', scripts: [] });
  check('空导入被拒绝', impEmpty?.ok === false, JSON.stringify(impEmpty));

  /* ---------------------------------------------------------------- *
   * [20] 快捷键「运行当前页」的两条兜底分支
   * ---------------------------------------------------------------- */

  console.log('\n\x1b[1m[20] 快捷键推送：没有可跑的脚本时不能瞎跑\x1b[0m');
  injectedFrames.clear();
  frameHandlers.clear();

  // 一个脚本都没有
  localBag.gx_scripts = [];
  check('一个脚本都没有时给出明确原因', await probeRunCurrent(/没有启用的脚本/));

  // 有脚本，但当前页面跟它没关系
  await makeScript({
    steps: fastSteps(),
    targetUrl: 'https://only-this.test/x',
    trigger: { enabled: true, domains: ['only-this.test'] },
  });
  activeTabUrl = 'https://example.com/app';
  check('当前页面没有匹配的脚本时给出明确原因', await probeRunCurrent(/没有匹配/));

  // 换到对得上的页面就应该跑起来
  activeTabUrl = 'https://only-this.test/x';
  const beforeN = calls.notifications.length;
  L.command[0]('run-current');
  await sleep(900);
  const lastRun = await sendToBackground({ type: 'RUN_STATE' });
  check('页面匹配上就应该正常执行',
    ['running', 'success'].includes(lastRun?.run?.status) && calls.notifications.length === beforeN,
    JSON.stringify(lastRun?.run)?.slice(0, 140));

  console.log('\n\x1b[1m[21] 冷却：自动路径一律受限，只手动豁免\x1b[0m');
  check('注册了导航来源监听', L.webNavCommitted.length === 1, `实际 ${L.webNavCommitted.length}`);

  sessionBag.gx_trigger_log = {};
  sessionBag.gx_nav = {};
  localBag.gx_scripts = [];
  injectedFrames.clear();
  frameHandlers.clear();
  activeTabUrl = 'https://reload.test/app';

  const rlScript = await makeScript({
    steps: fastSteps(),
    targetUrl: 'https://reload.test/app',
    trigger: { enabled: true, domains: ['reload.test'], delaySec: 0, once: true, cooldownSec: 10 },
  });
  await sleep(200);

  const RL_SENDER = () => ({ tab: { id: 1, url: activeTabUrl }, frameId: 0, url: activeTabUrl });
  const fireRl = (loadId) =>
    sendToBackground({ type: 'TRIGGER_FIRE', scriptId: rlScript.id, loadId, url: activeTabUrl }, RL_SENDER());
  const navTo = (url, transitionType) => {
    for (const f of L.webNavCommitted) {
      f({ tabId: 1, frameId: 0, url, transitionType, transitionQualifiers: [] });
    }
  };

  const rr1 = await fireRl('R1');
  check('首次进入页面就触发', rr1?.ok === true, JSON.stringify(rr1));
  await sleep(900);

  const rr2 = await fireRl('R1');
  check('同一次加载内不重复触发（once）',
    rr2?.ok === false && /已经触发过/.test(rr2.skipped || ''), JSON.stringify(rr2));

  // 用户按 F5：上一版这里会绕过冷却，这一版不再绕过 —— 冷却对所有自动路径一视同仁
  navTo(activeTabUrl, 'reload');
  await sleep(150);
  const rr3 = await fireRl('R2');
  check('冷却期内用户刷新也不放行',
    rr3?.ok === false && /冷却中/.test(rr3.skipped || ''), JSON.stringify(rr3));

  // 手动运行必须无视冷却 —— 用户明确点了「运行」，那是新的意图
  sessionBag.gx_trigger_log[rlScript.id] = { at: Date.now() };
  const man = await sendToBackground({ type: 'SCRIPT_RUN', id: rlScript.id });
  check('手动运行立刻返回', man?.ok === true, JSON.stringify(man));
  await sleep(900);
  const manRun = await sendToBackground({ type: 'RUN_STATE' });
  check('手动运行不受冷却限制', manRun?.run?.status === 'success', JSON.stringify(manRun?.run)?.slice(0, 160));

  // 定时触发也要过冷却，否则配了短周期就会把页面点烂
  sessionBag.gx_trigger_log[rlScript.id] = { at: Date.now() };
  const beforeSched = (await sendToBackground({ type: 'RUN_STATE' }))?.run?.startedAt;
  await L.alarm[0]({ name: `gx:script:${rlScript.id}` });
  await sleep(700);
  const afterSched = (await sendToBackground({ type: 'RUN_STATE' }))?.run?.startedAt;
  check('定时触发同样被冷却拦住', afterSched === beforeSched, `${beforeSched} -> ${afterSched}`);

  // 冷却过去之后，一切恢复
  sessionBag.gx_trigger_log[rlScript.id] = { at: Date.now() - 11000 };
  navTo(activeTabUrl, 'reload');
  await sleep(150);
  const rr4 = await fireRl('R3');
  check('冷却结束后刷新恢复触发', rr4?.ok === true, JSON.stringify(rr4));
  await sleep(900);

  check('跳过原因被记下来（界面直接显示，不用开控制台）',
    /冷却中/.test(sessionBag.gx_trigger_log?.[`skip_${rlScript.id}`]?.reason || ''),
    JSON.stringify(sessionBag.gx_trigger_log?.[`skip_${rlScript.id}`]));

  // 导航来源仍然记着，日志里能看出这次是刷新来的
  check('记录里标明了触发来源',
    ['reload', 'page'].includes(sessionBag.gx_trigger_log?.[rlScript.id]?.trigger),
    JSON.stringify(sessionBag.gx_trigger_log?.[rlScript.id]));

  /* ---------------------------------------------------------------- *
   * [22] 事件组：手势与 JS 混排，按顺序串起来
   * ---------------------------------------------------------------- */

  console.log('\n\x1b[1m[22] 事件组串行执行（手势 + JS 混排）\x1b[0m');
  sessionBag.gx_trigger_log = {};
  localBag.gx_scripts = [];
  localBag.gx_settings = { debug: true, logLimit: 200 };
  injectedFrames.clear();
  frameHandlers.clear();
  frameHandlers.set(0, defaultFrameHandler);
  activeTabUrl = 'https://mix.test/app';
  execHooks.selectorFound = true;
  execHooks.forceCspBlock = false;

  const mixTask = await makeScript({
    targetUrl: 'https://mix.test/app',
    events: [
      {
        id: 'ev_a', type: 'gesture', name: '第一步',
        steps: [{ type: 'click', locator: { kind: 'css', value: '#a' }, rel: { x: 0.5, y: 0.5 }, delay: 0 }],
      },
      { id: 'ev_b', type: 'js', name: '取数', code: 'return 42;' },
      {
        id: 'ev_c', type: 'gesture', name: '收尾',
        steps: [{ type: 'click', locator: { kind: 'css', value: '#b' }, rel: { x: 0.5, y: 0.5 }, delay: 0 }],
      },
    ],
  });

  check('任务读出来是 3 个事件', mixTask.events.length === 3, JSON.stringify(mixTask.events?.length));
  check('JS 事件带上了 id 和类型', mixTask.events[1].id === 'ev_b' && mixTask.events[1].type === 'js');
  check('手势事件保住了步骤', mixTask.events[0].steps?.length === 1);

  await sendToBackground({ type: 'LOG_CLEAR' });
  await sendToBackground({ type: 'SCRIPT_RUN', id: mixTask.id });
  await sleep(2600);

  const mixRun = await sendToBackground({ type: 'RUN_STATE' });
  check('事件组整体跑完', mixRun?.run?.status === 'success', JSON.stringify(mixRun?.run)?.slice(0, 170));

  const mixLogs = (await sendToBackground({ type: 'LOG_READ' }))?.logs || [];
  const order = mixLogs.filter((l) => l.eventName).map((l) => l.eventName);
  const iA = order.indexOf('第一步');
  const iB = order.indexOf('取数');
  const iC = order.indexOf('收尾');
  check('三个事件严格按定义顺序执行', iA >= 0 && iA < iB && iB < iC, JSON.stringify(order));

  check('JS 事件真的被执行了',
    mixLogs.some((l) => l.eventName === '取数' && /JS 事件完成/.test(l.msg)),
    JSON.stringify(mixLogs.filter((l) => l.eventName === '取数').map((l) => l.msg)));
  check('JS 的 return 值记进了日志',
    mixLogs.some((l) => l.eventName === '取数' && l.data && l.data.value === 42),
    JSON.stringify(mixLogs.find((l) => l.eventName === '取数' && l.data)?.data));
  check('日志按事件分了组（可按事件过滤）',
    mixLogs.some((l) => l.eventIndex === 2 && l.eventName === '收尾'));

  /* ---------------------------------------------------------------- *
   * [23] 事件级等待条件：等不到就跳过这一个，不拖垮整条任务
   * ---------------------------------------------------------------- */

  console.log('\n\x1b[1m[23] 事件级等待条件\x1b[0m');
  execHooks.selectorFound = false; // 假装元素一直不出现

  const gateTask = await makeScript({
    targetUrl: 'https://mix.test/app',
    events: [
      {
        id: 'g1', type: 'gesture', name: '等不到',
        wait: { url: '', selector: '#never', timeoutSec: 1 },
        steps: [{ type: 'click', locator: { kind: 'css', value: '#x' }, rel: { x: 0.5, y: 0.5 }, delay: 0 }],
      },
      {
        id: 'g2', type: 'gesture', name: '照跑',
        steps: [{ type: 'click', locator: { kind: 'css', value: '#y' }, rel: { x: 0.5, y: 0.5 }, delay: 0 }],
      },
    ],
  });

  await sendToBackground({ type: 'LOG_CLEAR' });
  await sendToBackground({ type: 'SCRIPT_RUN', id: gateTask.id });
  await sleep(4000);

  const gateRun = await sendToBackground({ type: 'RUN_STATE' });
  check('个别事件等不到元素不至于让整条任务失败',
    gateRun?.run?.status === 'success', JSON.stringify(gateRun?.run)?.slice(0, 170));
  check('被跳过的事件记在结果里（界面能直接看到）',
    (gateRun?.run?.skips || []).some((s) => /等不到元素/.test(s.reason)),
    JSON.stringify(gateRun?.run?.skips));
  check('等元素超时按配置的秒数走', (gateRun?.run?.skips || [])[0]?.eventName === '等不到');

  execHooks.selectorFound = true;

  /* ---------------------------------------------------------------- *
   * [24] 日志：开关与环形缓冲
   * ---------------------------------------------------------------- */

  console.log('\n\x1b[1m[24] 执行日志：开关与环形缓冲\x1b[0m');
  await sendToBackground({ type: 'SETTINGS_SAVE', patch: { debug: false } });
  const beforeLogs = (await sendToBackground({ type: 'LOG_READ' }))?.logs.length || 0;
  await sendToBackground({ type: 'SCRIPT_RUN', id: mixTask.id });
  await sleep(2600);
  const afterLogs = (await sendToBackground({ type: 'LOG_READ' }))?.logs.length || 0;
  check('关掉 debug 之后一条日志都不再产生', afterLogs === beforeLogs, `${beforeLogs} -> ${afterLogs}`);

  await sendToBackground({ type: 'SETTINGS_SAVE', patch: { debug: true, logLimit: 50 } });
  await sendToBackground({ type: 'LOG_CLEAR' });
  await sendToBackground({ type: 'SCRIPT_RUN', id: mixTask.id });
  await sleep(2600);
  const capped = await sendToBackground({ type: 'LOG_READ' });
  check('日志按上限裁剪（不会无限涨）', (capped?.logs || []).length <= 50, `实际 ${capped?.logs?.length}`);
  check('统计信息带回上限，设置页能显示', capped?.stats?.limit === 50, JSON.stringify(capped?.stats));
  check('清空之后重新开始记', (capped?.logs || []).length > 0, `实际 ${capped?.logs?.length}`);

  /* ---------------------------------------------------------------- *
   * [25] 老任务（只有扁平 steps）自动迁移
   * ---------------------------------------------------------------- */

  console.log('\n\x1b[1m[25] 老任务自动迁移成事件结构\x1b[0m');
  localBag.gx_scripts = [
    {
      id: 's_legacy2',
      name: '老任务',
      targetUrl: 'https://old.test/x',
      steps: [{ type: 'click', locator: { kind: 'css', value: '#z' }, rel: { x: 0.5, y: 0.5 }, delay: 0 }],
    },
  ];

  const listed = await sendToBackground({ type: 'SCRIPT_LIST' });
  const legacy2 = listed.scripts.find((s) => s.id === 's_legacy2');
  check('扁平的 steps 被包成一个手势事件',
    legacy2?.events?.length === 1 && legacy2.events[0].type === 'gesture',
    JSON.stringify(legacy2?.events));
  check('原有步骤原样保留', legacy2?.events?.[0]?.steps?.length === 1,
    JSON.stringify(legacy2?.events?.[0]?.steps));
  check('顶层不再保留 steps（避免两份真相）', !('steps' in legacy2), Object.keys(legacy2 || {}).join(','));
  check('老任务补齐了等待条件结构',
    legacy2?.events?.[0]?.wait && typeof legacy2.events[0].wait.timeoutSec === 'number',
    JSON.stringify(legacy2?.events?.[0]?.wait));

  /* ---------------------------------------------------------------- *
   * [26] 步骤匹配条件：后端只负责透传，校验在页面侧
   * ---------------------------------------------------------------- */

  console.log('\n\x1b[1m[26] 步骤匹配条件透传\x1b[0m');
  const matchTask = await makeScript({
    targetUrl: 'https://mix.test/app',
    events: [{
      type: 'gesture',
      name: '带条件',
      steps: [{ type: 'click', locator: { kind: 'css', value: '#m' }, rel: { x: 0.5, y: 0.5 }, delay: 0, match: '.green[href]' }],
    }],
  });
  check('匹配条件原样落库', matchTask.events[0].steps[0].match === '.green[href]',
    JSON.stringify(matchTask.events[0].steps[0].match));

  /* ---------------------------------------------------------------- *
   * [27] JS 事件：注入被站点 CSP 拦下时，自动切到调试接口
   * ---------------------------------------------------------------- */

  console.log('\n\x1b[1m[27] JS 事件：CSP 拦下后自动降级到调试接口\x1b[0m');
  execHooks.forceCspBlock = true;
  execHooks.cdpValue = '来自调试接口的返回值';
  calls.debuggerCommands.length = 0;
  calls.debugger.attach = 0;
  calls.debugger.detach = 0;

  const cspTask = await makeScript({
    targetUrl: 'https://mix.test/app',
    events: [{ id: 'c_1', type: 'js', name: 'CSP 场景', code: 'return 1;', world: 'auto' }],
  });

  await sendToBackground({ type: 'LOG_CLEAR' });
  await sendToBackground({ type: 'SCRIPT_RUN', id: cspTask.id });
  await sleep(2200);

  const cspRun = await sendToBackground({ type: 'RUN_STATE' });
  check('注入被 CSP 拦下后，任务靠调试接口照样跑成',
    cspRun?.run?.status === 'success', JSON.stringify(cspRun?.run)?.slice(0, 170));
  check('attach 了调试接口', calls.debugger.attach >= 1, `实际 ${calls.debugger.attach}`);
  check('发了 Runtime.evaluate',
    calls.debuggerCommands.some((c) => c.method === 'Runtime.evaluate'),
    JSON.stringify(calls.debuggerCommands.map((c) => c.method)));
  check('任务结束后断开调试连接（否则页面提示条一直挂着）',
    calls.debugger.detach >= 1, `实际 ${calls.debugger.detach}`);

  const cspLogs = (await sendToBackground({ type: 'LOG_READ' }))?.logs || [];
  check('日志里写明了是 CSP 导致的降级',
    cspLogs.some((l) => /CSP/.test(l.msg)), JSON.stringify(cspLogs.map((l) => l.msg).slice(0, 12)));
  check('完成日志里记下了实际走的哪条路',
    cspLogs.some((l) => /JS 事件完成/.test(l.msg) && l.data && l.data.via === 'cdp'),
    JSON.stringify(cspLogs.find((l) => /JS 事件完成/.test(l.msg))?.data));
  check('降级标记也一并记下', cspLogs.some((l) => l.data && l.data.fellBack === true));

  // 用户代码自己写错了不该触发降级 —— 否则报错信息会变得莫名其妙
  execHooks.forceCspBlock = false;
  calls.debuggerCommands.length = 0;
  calls.debugger.attach = 0;

  const errTask = await makeScript({
    targetUrl: 'https://mix.test/app',
    events: [{ id: 'c_2', type: 'js', name: '会抛错', code: 'throw new Error("用户代码自己炸了");' }],
  });

  await sendToBackground({ type: 'LOG_CLEAR' });
  await sendToBackground({ type: 'SCRIPT_RUN', id: errTask.id });
  await sleep(1800);

  const errRun = await sendToBackground({ type: 'RUN_STATE' });
  check('用户代码自身的错误不会触发降级重试',
    calls.debuggerCommands.filter((c) => c.method === 'Runtime.evaluate').length === 0,
    JSON.stringify(calls.debuggerCommands.map((c) => c.method)));
  check('任务如实失败', errRun?.run?.status === 'failed', JSON.stringify(errRun?.run)?.slice(0, 170));
  check('失败信息里带上事件位置',
    errRun?.run?.scriptId === errTask.id && /用户代码自己炸了/.test(sessionBag.gx_last_failure?.error || ''),
    JSON.stringify(sessionBag.gx_last_failure?.error));

  execHooks.cdpValue = null;

  /* ---------------------------------------------------------------- *
   * [28] Google Drive 云备份
   * ---------------------------------------------------------------- */

  console.log('\n\x1b[1m[28] Google Drive 云备份\x1b[0m');
  sessionBag.gx_trigger_log = {};
  localBag.gx_scripts = [];
  localBag.gx_settings = {};
  delete localBag.gx_drive_auth;

  const drvSt0 = await sendToBackground({ type: 'DRIVE_STATUS' });
  check('初始状态是未连接', drvSt0?.drive?.connected === false, JSON.stringify(drvSt0?.drive));
  check('带回重定向 URI（用户要填进 Google Cloud 控制台）',
    /chromiumapp\.org/.test(drvSt0?.drive?.redirectUri || ''), drvSt0?.drive?.redirectUri);

  const drvSet = await sendToBackground({
    type: 'DRIVE_SET_CLIENT',
    clientId: 'cid.apps.googleusercontent.com',
  });
  check('Client ID 保存成功',
    drvSet?.drive?.clientId === 'cid.apps.googleusercontent.com', JSON.stringify(drvSet?.drive));

  const drvConn = await sendToBackground({ type: 'DRIVE_CONNECT' });
  check('连接后状态变为已连接', drvConn?.drive?.connected === true, JSON.stringify(drvConn?.drive));
  check('授权地址带上了 PKCE 参数',
    /code_challenge=/.test(calls.oauthUrl || '') && /code_challenge_method=S256/.test(calls.oauthUrl || ''),
    String(calls.oauthUrl).slice(0, 180));
  check('要的是 offline 授权（否则拿不到 refresh token，每次都得重新登）',
    /access_type=offline/.test(calls.oauthUrl || ''));
  check('scope 只覆盖本应用创建的文件，看不到用户 Drive 里的其他东西',
    /drive\.file/.test(decodeURIComponent(calls.oauthUrl || '')),
    decodeURIComponent(calls.oauthUrl || '').slice(0, 200));

  const drvBak = await sendToBackground({ type: 'DRIVE_BACKUP' });
  check('备份成功并带回任务数', drvBak?.ok === true && typeof drvBak.count === 'number', JSON.stringify(drvBak));
  check('上传走的是 multipart 上传接口',
    globalThis.fetchCalls.some((c) => /upload\/drive\/v3/.test(c.url) && c.method === 'POST'),
    JSON.stringify(globalThis.fetchCalls.map((c) => `${c.method} ${c.url.slice(0, 60)}`).slice(0, 8)));

  const drvLst = await sendToBackground({ type: 'DRIVE_LIST' });
  check('能列出云端备份', (drvLst?.files || []).length === 1, JSON.stringify(drvLst?.files));

  const drvRst = await sendToBackground({ type: 'DRIVE_RESTORE', fileId: 'file-1' });
  check('恢复把云端的任务导了进来', drvRst?.added === 1, JSON.stringify(drvRst));

  const drvAfter = await sendToBackground({ type: 'SCRIPT_LIST' });
  check('恢复出来的任务确实在列表里',
    drvAfter.scripts.some((s) => s.id === 's_drv'),
    drvAfter.scripts.map((s) => s.id).join(','));

  await sendToBackground({ type: 'DRIVE_DISCONNECT' });
  const drvSt1 = await sendToBackground({ type: 'DRIVE_STATUS' });
  check('断开后回到未连接', drvSt1?.drive?.connected === false, JSON.stringify(drvSt1?.drive));
  check('断开只清本地令牌，没有去动云端文件',
    !globalThis.fetchCalls.some((c) => /\/files\//.test(c.url) && c.method === 'DELETE'));

  await sendToBackground({ type: 'DRIVE_SET_CLIENT', clientId: '' });
  const drvNoCid = await sendToBackground({ type: 'DRIVE_CONNECT' });
  check('没填 Client ID 时给出能照着做的提示',
    drvNoCid?.ok === false && /Client ID/.test(drvNoCid.error || ''), JSON.stringify(drvNoCid));

  // 授权被撤销后不能一直拿着废 token 重试
  localBag.gx_drive_auth = {
    clientId: 'cid.apps.googleusercontent.com',
    refreshToken: 'stale',
    accessToken: '',
    expiresAt: 0,
  };
  globalThis.fetchMode.tokenError = 'invalid_grant';
  const drvStale = await sendToBackground({ type: 'DRIVE_LIST' });
  check('授权被撤销时给出「重新连接」而不是原始报错',
    drvStale?.ok === false && /重新连接|撤销/.test(drvStale.error || ''), JSON.stringify(drvStale));
  check('失效的令牌被顺手清掉了', !localBag.gx_drive_auth?.refreshToken);
  globalThis.fetchMode.tokenError = null;

  report();
}

/** 触发「运行当前页」快捷键，检查失败通知里的说法 */
async function probeRunCurrent(pattern) {
  const before = calls.notifications.length;
  L.command[0]('run-current');
  await sleep(500);
  const last = calls.notifications[calls.notifications.length - 1];
  return calls.notifications.length > before && pattern.test(last?.message || '');
}

function report() {
  console.log('\n' + '─'.repeat(52));
  console.log(`  通过 \x1b[32m${pass}\x1b[0m  失败 \x1b[31m${fail}\x1b[0m`);
  console.log('─'.repeat(52) + '\n');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\n\x1b[31m测试脚本自身崩溃:\x1b[0m\n', e);
  process.exit(2);
});
