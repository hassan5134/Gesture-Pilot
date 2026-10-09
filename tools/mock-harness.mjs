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
};

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
      async executeScript({ files, func, target }) {
        calls.executeScript.push({ files, hasFunc: !!func, frameIds: target?.frameIds });
        const ids = target?.frameIds ?? [0];
        // 注入了 content script 之后，这些 frame 才开始响应消息
        if (files?.some((f) => f.startsWith('content/'))) {
          for (const id of ids) injectedFrames.add(id);
        }
        return ids.map((frameId) => ({ frameId, result: undefined }));
      },
    },

    webNavigation: {
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
      async sendCommand(t, m, p) { calls.debuggerCommands.push({ method: m, params: p }); return {}; },
      onDetach: { addListener: (f) => L.debuggerDetach.push(f) },
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
  check('脚本含 2 步（重复上报靠 sid 去重）', r3?.saved?.steps?.length === 2, `实际 ${r3?.saved?.steps?.length}`);
  check('落库的步骤里没有残留 sid',
    !r3?.saved?.steps?.some((s) => 'sid' in s),
    JSON.stringify(r3?.saved?.steps?.map((s) => Object.keys(s))));
  check('第二步 delay 由时间戳重算', r3?.saved?.steps?.[1]?.delay === 1200,
    `实际 ${r3?.saved?.steps?.[1]?.delay}`);
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
