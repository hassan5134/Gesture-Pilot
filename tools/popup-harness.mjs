/**
 * popup 冒烟测试。
 *
 * popup.js 在加载阶段就会绑定事件、发起首次刷新。任何未捕获异常
 * 都会让整个面板「点了没反应」—— 这正是本次要复现并防住的问题。
 * 这里用一套可断言的 DOM 垫片把 popup.js 真正 import 进来。
 *
 * 用法：node tools/popup-harness.mjs
 */
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';

const EXT = path.resolve(import.meta.dirname, '..', 'edge-gesture-pilot');
const TMP = path.join(os.tmpdir(), 'gx-popup-harness');

let pass = 0;
let fail = 0;

function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `\n      ${detail}` : ''}`); }
}

/* ------------------------------------------------------------------ *
 * 可断言的 DOM 垫片
 * ------------------------------------------------------------------ */

/** querySelector 选择器 -> 桩元素，记录绑定的事件与写入的属性 */
const nodes = new Map();
const boundListeners = new Map(); // selector -> { event: handler }

function makeStub(selector) {
  const state = { innerHTML: '', hidden: false, textContent: '', value: '', checked: false, disabled: false };
  const handler = {
    get(_, prop) {
      if (prop === '__state') return state;
      if (prop === 'classList') return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (prop === 'style') return {};
      if (prop === 'dataset') return {};
      if (prop === 'addEventListener') {
        return (event, fn) => {
          if (!boundListeners.has(selector)) boundListeners.set(selector, {});
          boundListeners.get(selector)[event] = fn;
        };
      }
      if (prop === 'querySelector') return (s) => makeStub(`${selector} ${s}`);
      if (prop === 'querySelectorAll') return () => [];
      if (prop === 'then') return undefined; // 避免被当成 thenable
      if (prop in state) return state[prop];
      return () => {};
    },
    set(_, prop, v) {
      state[prop] = v;
      return true;
    },
  };
  return new Proxy(function () {}, handler);
}

function el(selector) {
  if (!nodes.has(selector)) nodes.set(selector, makeStub(selector));
  return nodes.get(selector);
}

/* ------------------------------------------------------------------ *
 * 环境装配
 * ------------------------------------------------------------------ */

const sendMessageCalls = [];
const MOCK_VERSION = '0.2.0';

function installGlobals({ respond } = {}) {
  globalThis.document = {
    querySelector: (s) => el(s),
    // 真实页面里 $$('.tab') 会拿到若干个按钮，这里给出两个以便验证绑定
    querySelectorAll: (s) => {
      if (s === '.tab') return [el('.tab#scripts'), el('.tab#settings')];
      if (s === '.pane') return [el('.pane#scripts'), el('.pane#settings')];
      if (s === '[data-set]') return [];
      return [];
    },
    createElement: () => el('__created'),
  };

  globalThis.window = globalThis;
  globalThis.addEventListener ??= () => {};
  globalThis.confirm = () => true;
  // Node 22 的 navigator 是只读 getter，必须用 defineProperty 覆盖
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => {} } },
    configurable: true,
    writable: true,
  });

  globalThis.chrome = {
    tabs: {
      query: async () => [{ url: 'https://example.com/app' }],
    },
    runtime: {
      getManifest: () => ({ version: MOCK_VERSION }),
      async sendMessage(msg) {
        sendMessageCalls.push(msg);
        return respond ? respond(msg) : { ok: true };
      },
    },
    storage: {
      session: {
        // popup 直接读运行状态与失败留证
        async get() { return {}; },
        async remove() {},
      },
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function loadPopup() {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  await cp(EXT, path.join(TMP, 'edge-gesture-pilot'), { recursive: true });
  await writeFile(path.join(TMP, 'edge-gesture-pilot', 'package.json'), '{"type":"module"}');
  const url = pathToFileURL(path.join(TMP, 'edge-gesture-pilot', 'popup', 'popup.js')).href;
  return import(`${url}?t=${Date.now()}`);
}

async function main() {
  console.log('\n\x1b[1m[1] popup.js 加载\x1b[0m');

  installGlobals({
    respond: (msg) => {
      if (msg.type === 'SCRIPT_LIST') {
        return { ok: true, scripts: [], settings: {}, run: null };
      }
      if (msg.type === 'RECORD_STATE') return { ok: true, recording: null };
      return { ok: true };
    },
  });

  let loadError = null;
  try {
    await loadPopup();
    await sleep(300);
  } catch (e) {
    loadError = e;
  }

  check('模块加载无异常（加载期抛错 = 点了没反应）', !loadError, loadError?.stack || String(loadError));
  if (loadError) return report();

  console.log('\n\x1b[1m[2] 事件绑定\x1b[0m');
  check('录制按钮绑定了 click', !!boundListeners.get('#btnRecord')?.click,
    `已绑定: ${[...boundListeners.keys()].join(', ')}`);
  check('脚本列表绑定了 click', !!boundListeners.get('#list')?.click);
  check('脚本列表绑定了 change', !!boundListeners.get('#list')?.change);
  check('横幅绑定了 click', !!boundListeners.get('#banner')?.click);
  check('设置面板绑定了 change', !!boundListeners.get('#pane-settings')?.change);
  check('标签页切换绑定了 click', !!boundListeners.get('.tab#scripts')?.click && !!boundListeners.get('.tab#settings')?.click,
    `已绑定: ${[...boundListeners.keys()].join(', ')}`);

  // 标签页切换不能抛异常
  let tabError = null;
  try {
    boundListeners.get('.tab#settings').click({ target: el('.tab#settings') });
  } catch (e) {
    tabError = e;
  }
  check('点击标签页无异常', !tabError, tabError?.stack || String(tabError));

  check('首屏发起了 SCRIPT_LIST', sendMessageCalls.some((m) => m.type === 'SCRIPT_LIST'),
    JSON.stringify(sendMessageCalls.map((m) => m.type)));

  console.log('\n\x1b[1m[3] 点击「开始录制」—— 后台正常\x1b[0m');
  sendMessageCalls.length = 0;
  let clickError = null;
  try {
    await boundListeners.get('#btnRecord').click({ target: el('#btnRecord') });
    await sleep(200);
  } catch (e) {
    clickError = e;
  }
  check('点击处理无未捕获异常', !clickError, clickError?.stack || String(clickError));
  check('向后台发送了 RECORD_START', sendMessageCalls.some((m) => m.type === 'RECORD_START'),
    JSON.stringify(sendMessageCalls.map((m) => m.type)));

  console.log('\n\x1b[1m[4] 后台报错时必须显示出来（本轮修复的重点）\x1b[0m');
  // 重装为「后台返回错误」的场景
  installGlobals({
    respond: (msg) => {
      if (msg.type === 'SCRIPT_LIST') return { ok: true, scripts: [], settings: {}, run: null };
      if (msg.type === 'RECORD_STATE') return { ok: true, recording: null };
      if (msg.type === 'RECORD_START') return { ok: false, error: '页面脚本已注入但没有响应，请刷新该页面后重试。' };
      return { ok: true };
    },
  });
  boundListeners.clear();
  nodes.clear();
  await loadPopup();
  await sleep(300);

  sendMessageCalls.length = 0;
  clickError = null;
  try {
    await boundListeners.get('#btnRecord').click({ target: el('#btnRecord') });
    await sleep(250);
  } catch (e) {
    clickError = e;
  }
  check('后台返回错误时点击仍不抛异常', !clickError, clickError?.stack || String(clickError));

  const banner = nodes.get('#banner')?.__state;
  check('错误被写进了横幅（不再静默）', !!banner && banner.innerHTML.includes('没有响应'),
    `横幅内容: ${JSON.stringify(banner?.innerHTML)?.slice(0, 160)}`);
  check('横幅可见', banner?.hidden === false, `hidden=${banner?.hidden}`);

  console.log('\n\x1b[1m[5] 后台完全无响应时也要报错\x1b[0m');
  installGlobals({
    respond: () => { throw new Error('Could not establish connection. Receiving end does not exist.'); },
  });
  boundListeners.clear();
  nodes.clear();
  await loadPopup();
  await sleep(300);

  clickError = null;
  try {
    await boundListeners.get('#btnRecord').click({ target: el('#btnRecord') });
    await sleep(250);
  } catch (e) {
    clickError = e;
  }
  check('后台不可用时点击不抛异常', !clickError, clickError?.stack || String(clickError));

  const banner2 = nodes.get('#banner')?.__state;
  check('给出了可操作的提示', !!banner2 && /edge:\/\/extensions/.test(banner2.innerHTML),
    `横幅内容: ${JSON.stringify(banner2?.innerHTML)?.slice(0, 200)}`);

  /* ---------------- 版本自检（回归「broadcast is not defined」现场） ---------------- */

  console.log('\n\x1b[1m[6] 后台是旧代码时必须提示重新加载\x1b[0m');
  // 完全复现用户现场：后台跑旧代码（响应里没有 version 字段），
  // 界面是新代码，RECORD_START 抛「broadcast is not defined」
  installGlobals({
    respond: (msg) => {
      if (msg.type === 'SCRIPT_LIST') return { ok: true, scripts: [], settings: {}, run: null }; // 旧后台不带 version
      if (msg.type === 'RECORD_STATE') return { ok: true, recording: null };
      if (msg.type === 'RECORD_START') return { ok: false, error: 'broadcast is not defined' };
      return { ok: true };
    },
  });
  boundListeners.clear();
  nodes.clear();
  await loadPopup();
  await sleep(300);

  const stale0 = nodes.get('#stale')?.__state;
  check('刷新时就发现版本对不上（不用等用户点按钮）', !stale0?.hidden,
    `hidden=${stale0?.hidden} innerHTML=${JSON.stringify(stale0?.innerHTML)?.slice(0, 120)}`);
  check('提示里写清了两个版本号', /v0\.2\.0/.test(stale0?.innerHTML || '') && /未知/.test(stale0?.innerHTML || ''),
    `innerHTML: ${JSON.stringify(stale0?.innerHTML)?.slice(0, 200)}`);
  check('提示里给了 edge://extensions 指引', /edge:\/\/extensions/.test(stale0?.innerHTML || ''));

  await boundListeners.get('#btnRecord').click({ target: el('#btnRecord') });
  await sleep(250);
  const stale1 = nodes.get('#stale')?.__state;
  check('「is not defined」错误也会触发重新加载提示', !stale1?.hidden);
  check('界面标题栏显示了自身版本', nodes.get('#ver')?.__state?.textContent === `v${MOCK_VERSION}`,
    `实际 ${JSON.stringify(nodes.get('#ver')?.__state?.textContent)}`);

  console.log('\n\x1b[1m[7] 版本一致时不该误报\x1b[0m');
  installGlobals({
    respond: (msg) => {
      if (msg.type === 'SCRIPT_LIST') {
        return { ok: true, version: MOCK_VERSION, scripts: [], settings: {}, run: null };
      }
      if (msg.type === 'RECORD_STATE') return { ok: true, recording: null };
      return { ok: true };
    },
  });
  boundListeners.clear();
  nodes.clear();
  await loadPopup();
  await sleep(300);

  const stale2 = nodes.get('#stale')?.__state;
  check('版本一致时隐藏警告', stale2?.hidden === true,
    `hidden=${stale2?.hidden} innerHTML=${JSON.stringify(stale2?.innerHTML)?.slice(0, 120)}`);

  /* ---------------- 触发条件界面 ---------------- */

  console.log('\n\x1b[1m[8] 触发条件界面\x1b[0m');
  installGlobals({
    respond: (msg) => {
      if (msg.type === 'SCRIPT_LIST') {
        return {
          ok: true,
          version: MOCK_VERSION,
          scripts: [{
            id: 's1',
            name: '测试脚本',
            targetUrl: 'https://example.com/app',
            steps: [{ type: 'click', locator: { kind: 'css', value: '#go' }, rel: { x: 0.5, y: 0.5 }, delay: 0 }],
            engine: null,
            schedule: { enabled: false, mode: 'interval', everySec: 1800, time: '09:30' },
            trigger: {
              enabled: true, domains: ['example.com'], delaySec: 5,
              readySelector: '', requireVisible: false, once: true, cooldownSec: 120,
            },
          }],
          settings: {},
          run: null,
          triggerLog: { s1: { at: Date.now() - 60000 } },
        };
      }
      if (msg.type === 'RECORD_STATE') return { ok: true, recording: null };
      return { ok: true };
    },
  });
  boundListeners.clear();
  nodes.clear();
  await loadPopup();
  await sleep(300);

  const collapsed = nodes.get('#list')?.__state?.innerHTML || '';
  check('卡片刻画了触发摘要', collapsed.includes('触发：'), collapsed.slice(0, 160));
  check('摘要里带上了生效域名', collapsed.includes('example.com'));
  check('折叠时不渲染触发配置区', !collapsed.includes('生效域名'));

  // 展开卡片
  const fakeEvent = {
    target: {
      closest(sel) {
        if (sel === '.card') return { dataset: { id: 's1' } };
        if (sel === '[data-act]') return { dataset: { act: 'toggle' } };
        return null;
      },
    },
    stopPropagation() {},
  };
  let toggleErr = null;
  try {
    await boundListeners.get('#list').click(fakeEvent);
    await sleep(120);
  } catch (e) {
    toggleErr = e;
  }
  check('展开卡片不抛异常', !toggleErr, toggleErr?.stack || String(toggleErr));

  const expanded = nodes.get('#list')?.__state?.innerHTML || '';
  check('展开后出现触发配置区',
    expanded.includes('生效域名') && expanded.includes('打开页面时自动触发'), expanded.slice(0, 200));
  check('域名输入框预填了已有规则', expanded.includes('value="example.com"'));
  check('延迟与冷却预填了数值', expanded.includes('data-trig="delaySec"') && expanded.includes('data-trig="cooldownSec"'));
  check('当前页面匹配时给出绿色徽标', expanded.includes('当前页面匹配'), expanded.slice(0, 300));
  check('显示了上次触发时间', expanded.includes('上次触发'), expanded.slice(-300));

  report();
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
