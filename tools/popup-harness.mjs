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
    body: el('__body'),
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

  // 导出用 blob 下载，Node 里可能缺 createObjectURL
  globalThis.Blob ??= class Blob {
    constructor(parts) { this.parts = parts; }
  };
  globalThis.URL.createObjectURL ??= () => 'blob:mock';
  globalThis.URL.revokeObjectURL ??= () => {};

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

/**
 * 造一个可控的事件对象。
 * closest 用「选择器 → 返回值」的映射，测试里想命中哪个就写哪个。
 */
function fakeEvent({ closest = {}, matches = [], dataset = {}, value = '', checked = false, type = 'text' } = {}) {
  return {
    target: {
      value,
      checked,
      type,
      dataset,
      closest: (sel) => closest[sel] ?? null,
      matches: (sel) => matches.includes(sel),
    },
    stopPropagation() {},
    preventDefault() {},
  };
}

const CARD = { '.card': { dataset: { id: 's1' } } };

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
              readySelector: '', requireVisible: false, once: true, cooldownSec: 10,
            },
          }],
          settings: {},
          run: null,
          triggerLog: {
            s1: { at: Date.now() - 60000 },
            'skip_s1': { reason: '冷却中，还要等 8 秒（防页面自己跳转连环触发；手动刷新不受限）', at: Date.now() - 30000 },
          },
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
  const toggleEvent = fakeEvent({
    closest: { '.card': { dataset: { id: 's1' } }, '[data-act]': { dataset: { act: 'toggle' } } },
  });
  let toggleErr = null;
  try {
    await boundListeners.get('#list').click(toggleEvent);
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
  check('上一次被跳过时，界面上直接说明原因',
    expanded.includes('上次被跳过') && expanded.includes('冷却中'), expanded.slice(-300));
  check('说清了「手动刷新不受冷却限制」', expanded.includes('手动刷新'));

  /* ---------------- 改名 / 步骤编辑 / 备份恢复 ---------------- */

  console.log('\n\x1b[1m[9] 改名、步骤编辑、备份恢复\x1b[0m');

  const TWO_STEPS = [
    { type: 'click', locator: { kind: 'css', value: '#first' }, rel: { x: 0.5, y: 0.5 }, delay: 0 },
    { type: 'input', locator: { kind: 'css', value: '#second' }, value: 'abc', delay: 120 },
  ];
  let scripts = [{ ...makeScriptFixture(TWO_STEPS) }];

  installGlobals({
    respond: (msg) => {
      if (msg.type === 'SCRIPT_LIST') {
        return {
          ok: true, version: MOCK_VERSION, scripts: JSON.parse(JSON.stringify(scripts)),
          settings: {}, run: null, triggerLog: {},
        };
      }
      if (msg.type === 'RECORD_STATE') return { ok: true, recording: null };
      if (msg.type === 'SCRIPT_UPDATE') {
        // 后台会规范化，这里简单回显
        const saved = { ...msg.script, schedule: { domains: [], ...(msg.script.schedule || {}) }, trigger: { domains: [], ...(msg.script.trigger || {}) } };
        scripts = scripts.map((x) => (x.id === saved.id ? saved : x));
        return { ok: true, script: saved };
      }
      if (msg.type === 'SCRIPT_IMPORT') return { ok: true, added: 1, skipped: 0 };
      return { ok: true };
    },
  });
  boundListeners.clear();
  nodes.clear();
  await loadPopup();
  await sleep(300);

  const collapsed2 = nodes.get('#list')?.__state?.innerHTML || '';
  check('展开按钮文案是「配置」', collapsed2.includes('>配置</button>'), collapsed2.slice(0, 300));
  check('不再出现「详情」', !collapsed2.includes('>详情<'));
  check('卡片头有启用开关', collapsed2.includes('data-act="enabled"'));

  const listClick = boundListeners.get('#list').click;
  const listChange = boundListeners.get('#list').change;
  const listFocusOut = boundListeners.get('#list').focusout;
  check('注册了 focusout（改名收尾用）', typeof listFocusOut === 'function');

  // ---- 改名：点标题 → 出输入框 → 失焦提交 ----
  await listClick(fakeEvent({ closest: { ...CARD, '[data-act]': { dataset: { act: 'rename' } } } }));
  await sleep(80);
  let html = nodes.get('#list').__state.innerHTML;
  check('点标题后切换成改名输入框', html.includes('class="rename"'), html.slice(0, 300));

  sendMessageCalls.length = 0;
  await listFocusOut(fakeEvent({
    matches: ['input.rename'],
    closest: CARD,
    value: '订单核对流程',
  }));
  await sleep(120);
  const renameUpd = sendMessageCalls.filter((m) => m.type === 'SCRIPT_UPDATE').pop();
  check('失焦后改名提交到后台', renameUpd?.script?.name === '订单核对流程',
    JSON.stringify(renameUpd?.script?.name));

  html = nodes.get('#list').__state?.innerHTML || '';
  check('提交后退出改名态', !html.includes('class="rename"'));

  // ---- 改名：值没变就不发请求 ----
  await listClick(fakeEvent({ closest: { ...CARD, '[data-act]': { dataset: { act: 'rename' } } } }));
  await sleep(60);
  sendMessageCalls.length = 0;
  await listFocusOut(fakeEvent({ matches: ['input.rename'], closest: CARD, value: '订单核对流程' }));
  await sleep(120);
  check('值没变则不提交', sendMessageCalls.filter((m) => m.type === 'SCRIPT_UPDATE').length === 0);

  // ---- 步骤编辑控件 ----
  await listClick(fakeEvent({ closest: { ...CARD, '[data-act]': { dataset: { act: 'toggle' } } } }));
  await sleep(80);
  const body2 = nodes.get('#list')?.__state?.innerHTML || '';
  check('步骤行有延时输入框', body2.includes('data-delay="0"') && body2.includes('data-delay="1"'), body2.slice(0, 200));
  check('步骤行有上移/下移/复制/删除',
    body2.includes('data-up=') && body2.includes('data-down=') && body2.includes('data-dup=') && body2.includes('data-del='));
  check('首步上移按钮被禁用', /data-up="0"[^>]*disabled/.test(body2), body2.match(/data-up="0"[^>]*/)?.[0]);
  check('末步下移按钮被禁用', /data-down="1"[^>]*disabled/.test(body2), body2.match(/data-down="1"[^>]*/)?.[0]);
  check('定时配置里有生效域名', body2.includes('data-sched="domains"'));
  check('有「插入等待」按钮', body2.includes('data-act="add-wait"'));
  check('有「导出此脚本」按钮', body2.includes('data-act="export"'));

  // ---- 步骤下移 ----
  sendMessageCalls.length = 0;
  await listClick(fakeEvent({ closest: { ...CARD, '[data-down]': { dataset: { down: '0' } } } }));
  await sleep(120);
  let upd = sendMessageCalls.filter((m) => m.type === 'SCRIPT_UPDATE').pop();
  check('下移步骤后顺序变了',
    upd?.script?.steps?.[0]?.locator?.value === '#second',
    JSON.stringify(upd?.script?.steps?.map((x) => x.locator?.value)));

  // ---- 步骤复制 ----
  sendMessageCalls.length = 0;
  await listClick(fakeEvent({ closest: { ...CARD, '[data-dup]': { dataset: { dup: '0' } } } }));
  await sleep(120);
  upd = sendMessageCalls.filter((m) => m.type === 'SCRIPT_UPDATE').pop();
  check('复制步骤后多了一步', upd?.script?.steps?.length === 3,
    `实际 ${upd?.script?.steps?.length}`);

  // ---- 步骤删除 ----
  sendMessageCalls.length = 0;
  await listClick(fakeEvent({ closest: { ...CARD, '[data-del]': { dataset: { del: '0' } } } }));
  await sleep(120);
  upd = sendMessageCalls.filter((m) => m.type === 'SCRIPT_UPDATE').pop();
  check('删除步骤后少了一步', upd?.script?.steps?.length === 2,
    `实际 ${upd?.script?.steps?.length}`);

  // ---- 插入等待 ----
  sendMessageCalls.length = 0;
  await listClick(fakeEvent({ closest: { ...CARD, '[data-act]': { dataset: { act: 'add-wait' } } } }));
  await sleep(120);
  upd = sendMessageCalls.filter((m) => m.type === 'SCRIPT_UPDATE').pop();
  const added = upd?.script?.steps?.at(-1);
  check('插入等待步骤', added?.type === 'wait' && typeof added.value === 'number',
    JSON.stringify(added));

  // ---- 步骤延时编辑 ----
  sendMessageCalls.length = 0;
  await listChange(fakeEvent({ matches: ['[data-delay]'], closest: CARD, dataset: { delay: '0' }, value: '2500' }));
  await sleep(120);
  upd = sendMessageCalls.filter((m) => m.type === 'SCRIPT_UPDATE').pop();
  check('步骤延时被写入', upd?.script?.steps?.[0]?.delay === 2500,
    JSON.stringify(upd?.script?.steps?.[0]?.delay));

  // ---- 脚本启停 ----
  sendMessageCalls.length = 0;
  await listChange(fakeEvent({ matches: ['[data-act="enabled"]'], closest: CARD, checked: false }));
  await sleep(120);
  upd = sendMessageCalls.filter((m) => m.type === 'SCRIPT_UPDATE').pop();
  check('总开关写入 enabled=false', upd?.script?.enabled === false, JSON.stringify(upd?.script?.enabled));

  const dimmed = nodes.get('#list')?.__state?.innerHTML || '';
  check('停用后卡片标记为 off', dimmed.includes('card off'), dimmed.slice(0, 120));
  check('停用后副标题显示「已停用」', dimmed.includes('已停用'));

  // ---- 定时生效域名 ----
  sendMessageCalls.length = 0;
  await listChange(fakeEvent({
    matches: [], closest: CARD,
    dataset: { sched: 'domains' }, value: 'example.com, *.foo.com',
  }));
  await sleep(150);
  upd = sendMessageCalls.filter((m) => m.type === 'SCRIPT_UPDATE').pop();
  check('定时生效域名被解析成数组',
    JSON.stringify(upd?.script?.schedule?.domains) === JSON.stringify(['example.com', '*.foo.com']),
    JSON.stringify(upd?.script?.schedule?.domains));

  // ---- 设置页备份 / 恢复 ----
  check('注册了「导出全部」按钮', typeof boundListeners.get('#btnExportAll')?.click === 'function');
  check('注册了「导入」按钮', typeof boundListeners.get('#btnImport')?.click === 'function');
  check('注册了「从剪贴板粘贴」按钮', typeof boundListeners.get('#btnPaste')?.click === 'function');

  sendMessageCalls.length = 0;
  let exportErr = null;
  try {
    await boundListeners.get('#btnExportAll').click();
  } catch (e) {
    exportErr = e;
  }
  check('导出全部不抛异常', !exportErr, exportErr?.stack || String(exportErr));

  // 导入：正常 JSON
  el('#importText').__state.value = JSON.stringify({
    format: 'gesture-pilot-scripts',
    scripts: [{ id: 'x1', name: '导入的', steps: [{ type: 'click', locator: {}, delay: 0 }] }],
  });
  sendMessageCalls.length = 0;
  await boundListeners.get('#btnImport').click();
  await sleep(200);
  const impMsg = sendMessageCalls.find((m) => m.type === 'SCRIPT_IMPORT');
  check('导入把脚本发给了后台', impMsg?.scripts?.length === 1, JSON.stringify(impMsg));
  check('导入结果反馈给用户', /导入 1 个/.test(el('#importMsg')?.__state?.textContent || ''),
    el('#importMsg')?.__state?.textContent);

  // 导入：坏 JSON 要给出可读的报错，而不是崩掉
  el('#importText').__state.value = '{ 这不是 json';
  sendMessageCalls.length = 0;
  let impErr = null;
  try {
    await boundListeners.get('#btnImport').click();
    await sleep(120);
  } catch (e) {
    impErr = e;
  }
  check('坏 JSON 不抛异常', !impErr, impErr?.stack || String(impErr));
  check('坏 JSON 给出解析失败提示',
    /JSON 解析失败/.test(el('#importMsg')?.__state?.textContent || ''),
    el('#importMsg')?.__state?.textContent);

  // 导入：空输入
  el('#importText').__state.value = '';
  await boundListeners.get('#btnImport').click();
  await sleep(80);
  check('空输入给出提示', /请先把导出的 JSON/.test(el('#importMsg')?.__state?.textContent || ''),
    el('#importMsg')?.__state?.textContent);

  report();
}

function makeScriptFixture(steps) {
  return {
    id: 's1',
    name: '测试脚本',
    targetUrl: 'https://example.com/app',
    steps,
    engine: null,
    enabled: true,
    schedule: { enabled: false, mode: 'interval', everySec: 1800, time: '09:30', domains: [] },
    trigger: {
      enabled: false, domains: [], delaySec: 3,
      readySelector: '', requireVisible: false, once: true, cooldownSec: 10,
    },
  };
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
