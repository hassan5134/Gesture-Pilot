/**
 * 内容脚本加载冒烟测试。
 *
 * content/selector.js、hud.js、recorder.js 会注入到每个页面，
 * 一旦有未定义引用，就是「整个功能静默失效」。
 * 这里用 node:vm 配一套精简 DOM 垫片把它们真正执行一遍。
 *
 * 垫片刻意做厚了一点：HUD 会用到 Shadow DOM、canvas、rAF，
 * 只有真的跑起来才能发现绘制代码里的异常。
 *
 * 用法：node tools/content-harness.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// 与 content/trigger.js 里那份实现互相对拍
import { matchesDomain as refMatches, parsePatterns as refParse } from '../edge-gesture-pilot/lib/domains.js';

const EXT = path.resolve(import.meta.dirname, '..', 'edge-gesture-pilot');

let pass = 0;
let fail = 0;

function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `\n      ${detail}` : ''}`); }
}

/* ------------------------------------------------------------------ *
 * DOM 垫片
 * ------------------------------------------------------------------ */

function makeCtx2d() {
  // 任何未定义的方法都当无操作，任何属性都可读写 —— 只关心「会不会抛异常」
  return new Proxy(
    {},
    {
      get(t, p) {
        if (p in t) return t[p];
        return () => {};
      },
      set(t, p, v) {
        t[p] = v;
        return true;
      },
    },
  );
}

function matches(el, sel) {
  if (!el || !sel) return false;
  return String(sel)
    .split(',')
    .some((part) => {
      const s = part.trim();
      if (s.startsWith('.')) {
        return s
          .slice(1)
          .split('.')
          .every((c) => el.__classes.has(c));
      }
      if (s.startsWith('#')) return el.id === s.slice(1);
      if (s.startsWith('[')) return false;
      const first = s.split(/[ .#:[>]/)[0];
      return first && el.tagName === first.toUpperCase();
    });
}

function makeElement(tag = 'div') {
  const el = {
    nodeType: 1,
    isConnected: true,
    tagName: tag.toUpperCase(),
    id: '',
    value: '',
    innerHTML: '',
    textContent: '',
    innerText: '',
    selectedOptions: [],
    parentNode: null,
    parentElement: null,
    previousElementSibling: null,
    __children: [],
    __classes: new Set(),
    __handlers: {},
    __shadow: null,
    __attrs: {},
    style: {},

    get className() {
      return [...el.__classes].join(' ');
    },
    set className(v) {
      el.__classes = new Set(String(v).split(/\s+/).filter(Boolean));
    },

    classList: {
      add(...cs) { cs.forEach((c) => c && el.__classes.add(c)); },
      remove(...cs) { cs.forEach((c) => el.__classes.delete(c)); },
      toggle(c, force) {
        const has = el.__classes.has(c);
        const want = force === undefined ? !has : !!force;
        if (want) el.__classes.add(c);
        else el.__classes.delete(c);
        return want;
      },
      contains: (c) => el.__classes.has(c),
    },

    getAttribute(n) { return el.__attrs[n] ?? null; },
    setAttribute(n, v) { el.__attrs[n] = String(v); },
    hasAttribute: (n) => n in el.__attrs,
    removeAttribute(n) { delete el.__attrs[n]; },

    appendChild(c) { el.__children.push(c); c.parentNode = el; return c; },
    removeChild(c) { el.__children = el.__children.filter((x) => x !== c); return c; },
    replaceChildren(...cs) { el.__children = cs; },
    remove() { if (el.parentNode) el.parentNode.removeChild(el); el.isConnected = false; },

    querySelector(sel) {
      const hit = el.__children.find((c) => matches(c, sel));
      if (hit) return hit;
      // 垫片不做 HTML 解析，匹配不到就自动造一个，保证调用链能继续
      el.__stubs ||= new Map();
      if (!el.__stubs.has(sel)) el.__stubs.set(sel, makeElement('span'));
      return el.__stubs.get(sel);
    },
    querySelectorAll(sel) {
      return el.__children.filter((c) => matches(c, sel));
    },

    attachShadow() {
      el.__shadow = makeElement('shadow-root');
      return el.__shadow;
    },
    get shadowRoot() { return el.__shadow; },

    addEventListener(t, fn) { (el.__handlers[t] ||= []).push(fn); },
    removeEventListener(t) { delete el.__handlers[t]; },
    dispatchEvent() { return true; },

    getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 24, right: 110, bottom: 44 }),
    focus() {},
    blur() {},
    click() {},
    contains: () => false,
    closest: () => null,
    matches: () => false,
    scrollIntoView() {},

    getContext: () => makeCtx2d(),
    get width() { return el.__w ?? 0; },
    set width(v) { el.__w = v; },
    get height() { return el.__h ?? 0; },
    set height(v) { el.__h = v; },
  };
  return el;
}

function makeContext({ isTop = true, href = 'https://example.com/app', width = 1280, height = 800 } = {}) {
  const documentEl = makeElement('html');
  const bodyEl = makeElement('body');
  const ctxErrors = [];
  const byId = new Map();

  const realAppend = documentEl.appendChild;
  documentEl.appendChild = (c) => {
    realAppend(c);
    if (c.id) byId.set(c.id, c);
    return c;
  };

  const document = {
    nodeType: 9,
    documentElement: documentEl,
    body: bodyEl,
    activeElement: bodyEl,
    scrollingElement: documentEl,
    visibilityState: 'visible',
    getElementById: (id) => byId.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (t) => makeElement(t),
    addEventListener() {},
    removeEventListener() {},
  };

  const listeners = [];
  const chromeMock = {
    runtime: {
      onMessage: { addListener: (f) => listeners.push(f) },
      sendMessage: async () => ({ ok: true }),
      lastError: undefined,
    },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      session: { get: async () => ({}), set: async () => {} },
    },
  };

  // rAF 真的执行回调，但设个预算防止 hasWork 恒真时无限循环
  let rafBudget = 400;
  let rafSeq = 0;
  const rafTimers = new Map();

  const win = {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: 1,
    document,
    chrome: chromeMock,
    location: {
      href,
      get origin() {
        try {
          return new URL(href).origin;
        } catch {
          return 'null';
        }
      },
    },
    top: null,
    parent: null,
    frameElement: null,
    addEventListener() {},
    removeEventListener() {},
    scrollBy() {},
    scrollTo() {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    requestAnimationFrame(fn) {
      if (rafBudget-- <= 0) return 0;
      const id = ++rafSeq;
      const t = setTimeout(() => {
        rafTimers.delete(id);
        try {
          fn(performance.now());
        } catch (e) {
          ctxErrors.push(e);
        }
      }, 0);
      rafTimers.set(id, t);
      return id;
    },
    cancelAnimationFrame(id) {
      const t = rafTimers.get(id);
      if (t) {
        clearTimeout(t);
        rafTimers.delete(id);
      }
    },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    CSS: { escape: (s) => String(s).replace(/[^\w-]/g, '\\$&') },
    MouseEvent: class MouseEvent { constructor(type, init = {}) { Object.assign(this, init, { type }); } },
    KeyboardEvent: class KeyboardEvent { constructor(type, init = {}) { Object.assign(this, init, { type }); } },
    InputEvent: class InputEvent { constructor(type, init = {}) { Object.assign(this, init, { type }); } },
    WheelEvent: class WheelEvent { constructor(type, init = {}) { Object.assign(this, init, { type }); } },
    Event: class Event { constructor(type, init = {}) { Object.assign(this, init, { type }); } },
    HTMLInputElement: class HTMLInputElement {},
    HTMLTextAreaElement: class HTMLTextAreaElement {},
    WeakSet,
    WeakMap,
    Map,
    Set,
    Math,
    JSON,
    Date,
    Number,
    String,
    Object,
    Array,
    Promise,
    Error,
    Symbol,
    isFinite,
    parseInt,
    parseFloat,
    // 内容脚本要用 URL 解析域名，沙箱里必须提供（漏了它 matchesDomain 会全部返回 false）
    URL,
    URLSearchParams,
    performance,
    console,
  };

  win.window = win;
  win.self = win;
  win.globalThis = win;
  win.top = win;
  win.parent = win;

  const ctx = vm.createContext(win);
  return { ctx, win, listeners, documentEl, ctxErrors };
}

function run(code, ctx, filename) {
  return vm.runInContext(code, ctx, { filename });
}

const src = (f) => readFileSync(path.join(EXT, f), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * [1] selector.js
 * ------------------------------------------------------------------ */

console.log('\n\x1b[1m[1] content/selector.js\x1b[0m');
{
  const { ctx, win } = makeContext();
  let err = null;
  try {
    run(src('content/selector.js'), ctx, 'selector.js');
  } catch (e) {
    err = e;
  }
  check('加载无异常', !err, err?.stack);
  check('挂载了 window.GX', !!win.GX, `实际: ${typeof win.GX}`);

  if (win.GX) {
    const G = win.GX;
    for (const fn of [
      'buildLocator', 'resolve', 'waitFor', 'clientPointAt', 'localPointAt',
      'setNativeValue', 'mousePath', 'describeLocator', 'readValue', 'isVisible',
    ]) {
      check(`  GX.${fn} 存在且为函数`, typeof G[fn] === 'function', `实际: ${typeof G[fn]}`);
    }

    const fake = makeElement('button');
    fake.id = 'submit-order';
    fake.getAttribute = (n) => (n === 'data-testid' ? 'order-submit' : null);
    const loc1 = G.buildLocator(fake);
    check('  优先取 data-testid', loc1.kind === 'attr' && loc1.attr === 'data-testid', JSON.stringify(loc1));

    const fake2 = makeElement('button');
    fake2.id = 'btn-1697123456789';
    fake2.getAttribute = () => null;
    const loc2 = G.buildLocator(fake2);
    check('  易变 id 被识别并降级为 CSS 路径', loc2.kind === 'css' && loc2.value.includes('nth-of-type'), JSON.stringify(loc2));

    const pts = G.mousePath({ x: 0, y: 0 }, { x: 400, y: 300 });
    check('  mousePath 产出多个中间点', pts.length >= 4, `点数 ${pts.length}`);
    check('  mousePath 终点收敛到目标附近',
      Math.hypot(pts.at(-1).x - 400, pts.at(-1).y - 300) < 8,
      `末点 (${pts.at(-1).x.toFixed(1)}, ${pts.at(-1).y.toFixed(1)})`);

    const pt = G.clientPointAt(makeElement('div'), { x: 0.5, y: 0.5 });
    check('  clientPointAt 返回中心点', pt && pt.x === 60 && pt.y === 32, JSON.stringify(pt));

    const lp = G.localPointAt(makeElement('div'), { x: 0.5, y: 0.5 });
    check('  localPointAt 返回本 frame 坐标', lp && lp.x === 60 && lp.y === 32, JSON.stringify(lp));

    const dispatched = [];
    const input = makeElement('input');
    input.tagName = 'INPUT';
    input.focus = () => {};
    input.dispatchEvent = (ev) => { dispatched.push(ev.type); return true; };
    Object.setPrototypeOf(input, Object.prototype);
    try {
      G.setNativeValue(input, 'hello world');
      check('  setNativeValue 派发了 input + change',
        dispatched.includes('input') && dispatched.includes('change'), JSON.stringify(dispatched));
    } catch (e) {
      check('  setNativeValue 不抛异常', false, e?.stack);
    }
  }
}

/* ------------------------------------------------------------------ *
 * [2] hud.js
 * ------------------------------------------------------------------ */

console.log('\n\x1b[1m[2] content/hud.js\x1b[0m');
{
  const { ctx, win, ctxErrors } = makeContext();
  let err = null;
  try {
    run(src('content/hud.js'), ctx, 'hud.js');
  } catch (e) {
    err = e;
  }
  check('加载无异常', !err, err?.stack);
  check('挂载了 window.GX_HUD', !!win.GX_HUD);

  if (win.GX_HUD) {
    const H = win.GX_HUD;
    for (const fn of ['enable', 'disable', 'move', 'down', 'up', 'key', 'input', 'animPath', 'replayClick', 'setStepCount', 'destroy']) {
      check(`  GX_HUD.${fn} 存在且为函数`, typeof H[fn] === 'function', `实际: ${typeof H[fn]}`);
    }

    check('  初始未启用', H.isOn() === false);

    let on = null;
    let enErr = null;
    try { on = H.enable('录制中'); } catch (e) { enErr = e; }
    check('  enable 不抛异常', !enErr, enErr?.stack);
    check('  enable 返回 true', on === true, `实际 ${on}`);
    check('  启用后 isOn 为真', H.isOn() === true);
    check('  构建了 HUD 节点', H.isBuilt() === true);

    let feedErr = null;
    try {
      H.move(100, 120);
      H.move(130, 140);
      H.down(130, 140, 0, 'button', '提交');
      H.move(180, 200);
      H.up(180, 200);
      H.drag(10, 10, 90, 90);
      H.down(50, 50, 2, 'div', '');
      H.key({ key: 'Control', ctrl: true }, true);
      H.key({ key: 's', ctrl: true }, true);
      H.key({ key: 's', ctrl: true }, false);
      H.key({ key: 'Control' }, false);
      H.key({ key: 'a' }, true);
      H.key({ key: 'a' }, false);
      H.key({ key: 'Enter' }, true);
      H.key({ key: 'Enter' }, false);
      H.key({ key: 'ArrowLeft' }, true);
      H.key({ key: ' ' }, true);
      H.setStepCount(7);
      H.replayClick(300, 200, '回放');
      H.leave();
    } catch (e) {
      feedErr = e;
    }
    check('  喂入各类事件不抛异常', !feedErr, feedErr?.stack);

    // ---- 键盘回显：回放时只发一条 key 步骤，修饰键必须从 step.key 的标志里补出来 ----
    H.key({ key: 's', code: 'KeyS', ctrl: true }, true);
    let pills = H._pills();
    check('  组合键回显出 Ctrl + 主键', pills.includes('Ctrl') && pills.includes('s'), JSON.stringify(pills));

    H.key({ key: 'Enter', code: 'Enter' }, true);
    pills = H._pills();
    check('  功能键回显（Enter）', pills.includes('Enter'), JSON.stringify(pills));

    H.key({ key: 'ArrowLeft', code: 'ArrowLeft' }, true);
    check('  方向键回显成箭头', H._pills().includes('←'), JSON.stringify(H._pills()));

    // ---- 输入回显 ----
    const joined = () => H._pills().join(' │ ');

    H.input('hello 世界', '输入');
    check('  输入回显带标签与内容',
      joined().includes('输入') && joined().includes('hello 世界'), joined());

    H.input('', '输入');
    check('  空值回显为「（清空）」', joined().includes('（清空）'), joined());

    H.input('x'.repeat(80), '输入');
    const longPill = H._pills().find((t) => t.startsWith('输入 xxx'));
    check('  超长输入被截断', !!longPill && longPill.length <= 40, `${longPill?.length} 字符`);

    // ---- 合成的修饰键必须自行淡出，否则回放时会在页面底部越堆越多 ----
    H.key({ key: 'Ctrl' }, false);
    H.key({ key: 'a', code: 'KeyA', ctrl: true }, true);
    H.key({ key: 'b', code: 'KeyB', ctrl: true }, true);
    H.key({ key: 'c', code: 'KeyC', ctrl: true }, true);
    const modCount = H._pills().filter((t) => t === 'Ctrl').length;
    check('  连发多个组合键会各自成组', modCount >= 1, `Ctrl 胶囊 ${modCount} 颗`);

    await sleep(1800); // 等淡出动画走完
    const leftover = H._pills().filter((t) => t === 'Ctrl').length;
    check('  合成出来的修饰键会自行淡出（不会累积）', leftover === 0, `淡出后仍剩 ${leftover} 颗`);

    // ---- 路径动画：让重放的轨迹和录制时看起来一致 ----
    const path = [
      { x: 100, y: 100 },
      { x: 140, y: 110 },
      { x: 200, y: 150 },
      { x: 260, y: 210 },
    ];
    H.animPath(path, 300, false);
    check('  animPath 启动后处于播放中', H._animating() === true);
    check('  animPath 立刻把起点写进了轨迹', H._trailLen() > 0, `轨迹 ${H._trailLen()} 点`);
    await sleep(450);
    check('  动画播完后自动结束', H._animating() === false);

    // 非法输入不能炸
    let animErr = null;
    try {
      H.animPath(null, 100, true);
      H.animPath([], 100, true);
      H.animPath([{ x: 'a', y: 'b' }], 100, true);
      H.animPath([{ x: 1, y: 2 }], 0, true);
    } catch (e) {
      animErr = e;
    }
    check('  animPath 对非法输入安全', !animErr, animErr?.stack);

    await sleep(90); // 让 rAF 真正跑几帧，覆盖 canvas 绘制代码
    check('  canvas 绘制过程无异常', ctxErrors.length === 0,
      (ctxErrors[0]?.stack || String(ctxErrors[0])));

    let offErr = null;
    try { H.disable(); } catch (e) { offErr = e; }
    check('  disable 不抛异常', !offErr, offErr?.stack);
    check('  停用后 isOn 为假', H.isOn() === false);

    let afterErr = null;
    try { H.move(1, 1); H.key({ key: 'a' }, true); H.down(1, 1, 0, '', ''); } catch (e) { afterErr = e; }
    check('  停用后事件被安全忽略', !afterErr, afterErr?.stack);

    let deErr = null;
    try { H.destroy(); } catch (e) { deErr = e; }
    check('  destroy 不抛异常', !deErr, deErr?.stack);
  }
}

console.log('\n\x1b[1m[3] HUD 在小尺寸 frame 里应自动放弃\x1b[0m');
{
  // 很多站点挂着 1x1 / 10x10 的统计 iframe，在里面画 HUD 没有意义
  const { ctx, win } = makeContext({ width: 60, height: 40 });
  run(src('content/hud.js'), ctx, 'hud.js');
  let r = null;
  try { r = win.GX_HUD.enable(); } catch { /* 忽略 */ }
  check('小 frame 里 enable 返回 false（不构建）', r === false, `实际 ${r}`);
  check('小 frame 里 isBuilt 为假', win.GX_HUD.isBuilt() === false);
  let e2 = null;
  try { win.GX_HUD.move(1, 1); win.GX_HUD.key({ key: 'a' }, true); } catch (e) { e2 = e; }
  check('小 frame 里喂事件也安全', !e2, e2?.stack);
}

/* ------------------------------------------------------------------ *
 * [4] recorder.js
 * ------------------------------------------------------------------ */

console.log('\n\x1b[1m[4] content/recorder.js\x1b[0m');
{
  const { ctx, win, listeners } = makeContext();
  run(src('content/selector.js'), ctx, 'selector.js');
  run(src('content/hud.js'), ctx, 'hud.js');
  let err = null;
  try {
    run(src('content/recorder.js'), ctx, 'recorder.js');
  } catch (e) {
    err = e;
  }
  check('加载无异常', !err, err?.stack);
  check('挂载了 window.GX_RECORDER', !!win.GX_RECORDER);
  check('注册了 onMessage 监听', listeners.length === 1, `监听器数 ${listeners.length}`);

  if (win.GX_RECORDER) {
    check('  暴露 start / stop / isActive',
      typeof win.GX_RECORDER.start === 'function' &&
      typeof win.GX_RECORDER.stop === 'function' &&
      typeof win.GX_RECORDER.isActive === 'function');
    check('  初始未在录制', win.GX_RECORDER.isActive() === false);

    let resp = null;
    listeners[0]({ type: 'GX_RECORD_START', hud: true }, {}, (r) => { resp = r; });
    check('  GX_RECORD_START 有响应', !!resp, JSON.stringify(resp));
    check('  GX_RECORD_START 返回 ok', resp?.ok === true, JSON.stringify(resp));
    check('  回报 HUD 已就绪', resp?.hud === true, JSON.stringify(resp));
    check('  状态切为录制中', win.GX_RECORDER.isActive() === true);
    check('  录制开始时 HUD 已亮起', win.GX_HUD.isOn() === true);

    resp = null;
    listeners[0]({ type: 'GX_RECORD_STOP' }, {}, (r) => { resp = r; });
    check('  GX_RECORD_STOP 有响应', resp?.ok === true, JSON.stringify(resp));
    check('  状态切回未录制', win.GX_RECORDER.isActive() === false);
    check('  录制结束时 HUD 已熄灭', win.GX_HUD.isOn() === false);

    resp = null;
    listeners[0]({ type: 'GX_PING' }, {}, (r) => { resp = r; });
    check('  GX_PING 返回状态', resp?.ok === true && 'recording' in resp, JSON.stringify(resp));
  }
}

/* ------------------------------------------------------------------ *
 * [5] 步骤生成 + 增量上报
 * ------------------------------------------------------------------ */

console.log('\n\x1b[1m[5] 录制真的能产出步骤（本次「一步都没录到」的回归）\x1b[0m');
{
  const { ctx, win, listeners } = makeContext();
  const sent = [];
  run(src('content/selector.js'), ctx, 'selector.js');
  run(src('content/hud.js'), ctx, 'hud.js');

  ctx.chrome.runtime.sendMessage = async (msg) => {
    sent.push(msg);
    return { ok: true };
  };

  // 录制器把监听器挂在 window 上，垫片里 window.addEventListener 是空操作 ——
  // 这里换成真实收集，才能把事件喂进去
  const handlers = {};
  win.addEventListener = (t, fn) => { (handlers[t] ||= []).push(fn); };
  win.removeEventListener = (t) => { delete handlers[t]; };

  run(src('content/recorder.js'), ctx, 'recorder.js');

  const fire = (type, props = {}) => {
    const target = props.target || makeElement('div');
    const ev = Object.assign(
      { type, target, composedPath: () => [target] },
      props,
      { target },
    );
    (handlers[type] || []).forEach((fn) => fn(ev));
  };

  listeners[0]({ type: 'GX_RECORD_START', hud: false }, {}, () => {});

  const btn = makeElement('button');
  btn.id = 'submit';

  fire('mousedown', { target: btn, clientX: 60, clientY: 32, button: 0 });
  fire('mouseup', { target: btn, clientX: 61, clientY: 33, button: 0 });

  check('  点击产生了 1 步', win.GX_RECORDER.peek().length === 1,
    JSON.stringify(win.GX_RECORDER.peek()));
  check('  步骤带唯一 sid', typeof win.GX_RECORDER.peek()[0]?.sid === 'string',
    JSON.stringify(win.GX_RECORDER.peek()[0]));

  const input = makeElement('input');
  input.tagName = 'INPUT';
  input.id = 'kw';
  input.value = 'hello';
  fire('input', { target: input });
  check('  打字过程中不立即产步（要等聚合）', win.GX_RECORDER.peek().length === 1,
    JSON.stringify(win.GX_RECORDER.peek().map((s) => s.type)));
  fire('focusout', { target: input });
  check('  失焦后聚合出 input 步', win.GX_RECORDER.peek().some((s) => s.type === 'input'),
    JSON.stringify(win.GX_RECORDER.peek().map((s) => s.type)));

  fire('keydown', { target: makeElement('body'), key: 's', code: 'KeyS', keyCode: 83, ctrlKey: true });
  check('  Ctrl+S 产生 key 步', win.GX_RECORDER.peek().some((s) => s.type === 'key'),
    JSON.stringify(win.GX_RECORDER.peek().map((s) => s.type)));

  const before = win.GX_RECORDER.peek().length;
  fire('mousedown', { target: btn, clientX: 10, clientY: 10, button: 0 });
  // 拖拽过程中必须有 mousemove，否则采集不到路径
  fire('mousemove', { target: btn, clientX: 40, clientY: 30 });
  fire('mousemove', { target: btn, clientX: 70, clientY: 60 });
  fire('mouseup', { target: btn, clientX: 90, clientY: 90, button: 0 });

  const after = win.GX_RECORDER.peek();
  const dragStep = after[after.length - 1];
  check('  拖拽录成了 drag 步骤（不再是直接跳过）',
    after.length === before + 1 && dragStep?.type === 'drag',
    `步数 ${before} -> ${after.length}，末步类型 ${dragStep?.type}`);
  check('  drag 步骤带路径点', Array.isArray(dragStep?.path) && dragStep.path.length >= 2,
    JSON.stringify(dragStep?.path));
  check('  路径首点是原点（坐标以起点为参照）',
    dragStep?.path?.[0]?.x === 0 && dragStep?.path?.[0]?.y === 0,
    JSON.stringify(dragStep?.path?.[0]));
  check('  路径末点等于抬起位置',
    dragStep?.path?.at(-1)?.x === 80 && dragStep?.path?.at(-1)?.y === 80,
    JSON.stringify(dragStep?.path?.at(-1)));
  check('  drag 步骤记录了起始元素与相对落点',
    !!dragStep?.locator && !!dragStep?.rel,
    JSON.stringify({ locator: dragStep?.locator, rel: dragStep?.rel }));

  await sleep(350); // 等增量上报的防抖触发
  const streamed = sent.filter((m) => m.type === 'GX_STEPS_APPEND' && !m.final);
  check('  步骤增量上报给了后台', streamed.length > 0,
    `上行消息: ${sent.map((m) => m.type).join(', ')}`);
  check('  增量上报的条数与本地一致',
    streamed.reduce((n, m) => n + m.steps.length, 0) === win.GX_RECORDER.peek().length,
    `${streamed.reduce((n, m) => n + m.steps.length, 0)} vs ${win.GX_RECORDER.peek().length}`);

  sent.length = 0;
  listeners[0]({ type: 'GX_RECORD_STOP' }, {}, () => {});
  await sleep(40);
  const finalMsg = sent.find((m) => m.type === 'GX_STEPS_APPEND' && m.final);
  check('  停止时发出了全量上报', !!finalMsg, JSON.stringify(sent.map((m) => m.type)));
  check('  全量上报带上 final 标记', finalMsg?.final === true);
  check('  全量上报条数正确', finalMsg?.steps?.length === 4, `实际 ${finalMsg?.steps?.length}`);
  check('  全量上报的 sid 与增量上报一致（后台据此去重）',
    finalMsg?.steps?.[0]?.sid === streamed[0]?.steps?.[0]?.sid,
    `${finalMsg?.steps?.[0]?.sid} vs ${streamed[0]?.steps?.[0]?.sid}`);
}

/* ------------------------------------------------------------------ *
 * [6] 零步骤也要上报
 * ------------------------------------------------------------------ */

console.log('\n\x1b[1m[6] 零步骤也要上报（后台靠这个区分「没操作」和「通道不通」）\x1b[0m');
{
  const { ctx, win, listeners } = makeContext();
  const sent = [];
  run(src('content/selector.js'), ctx, 'selector.js');
  run(src('content/hud.js'), ctx, 'hud.js');
  ctx.chrome.runtime.sendMessage = async (msg) => { sent.push(msg); return { ok: true }; };
  run(src('content/recorder.js'), ctx, 'recorder.js');

  const handlers = {};
  win.addEventListener = (t, fn) => { (handlers[t] ||= []).push(fn); };
  win.removeEventListener = (t) => { delete handlers[t]; };

  listeners[0]({ type: 'GX_RECORD_START', hud: false }, {}, () => {});
  listeners[0]({ type: 'GX_RECORD_STOP' }, {}, () => {});
  await sleep(40);

  const finalMsg = sent.find((m) => m.type === 'GX_STEPS_APPEND' && m.final);
  check('  零步骤时仍然发出最终上报', !!finalMsg, JSON.stringify(sent));
  check('  total 字段为 0', finalMsg?.total === 0, JSON.stringify(finalMsg));
  check('  steps 为空数组', Array.isArray(finalMsg?.steps) && finalMsg.steps.length === 0);
}

/* ------------------------------------------------------------------ *
 * [7] replayer.js
 * ------------------------------------------------------------------ */

console.log('\n\x1b[1m[7] content/replayer.js\x1b[0m');
{
  const { ctx, win, listeners } = makeContext();
  run(src('content/selector.js'), ctx, 'selector.js');
  run(src('content/hud.js'), ctx, 'hud.js');
  let err = null;
  try {
    run(src('content/replayer.js'), ctx, 'replayer.js');
  } catch (e) {
    err = e;
  }
  check('加载无异常', !err, err?.stack);
  check('挂载了 window.GX_REPLAY', !!win.GX_REPLAY);
  check('注册了 onMessage 监听', listeners.length === 1, `监听器数 ${listeners.length}`);

  if (win.GX_REPLAY) {
    check('  暴露 runStep / reset',
      typeof win.GX_REPLAY.runStep === 'function' && typeof win.GX_REPLAY.reset === 'function');
  }

  let resp = null;
  listeners[0]({ type: 'GX_HUD_ON', label: '回放中' }, {}, (r) => { resp = r; });
  check('  GX_HUD_ON 有响应且 HUD 可用', resp?.ok === true && resp?.hud === true, JSON.stringify(resp));
  check('  HUD 已亮起', win.GX_HUD.isOn() === true);

  // ---- 本次修复的核心：回放时键盘必须回显 ----
  const k1 = await win.GX_REPLAY.runStep({ type: 'key', key: { key: 'Enter', code: 'Enter', vk: 13 } }, {});
  check('  key 步骤执行成功', k1?.ok === true, JSON.stringify(k1));
  check('  key 步骤在提示层留下回显', win.GX_HUD._pills().includes('Enter'),
    JSON.stringify(win.GX_HUD._pills()));

  const k2 = await win.GX_REPLAY.runStep(
    { type: 'key', key: { key: 's', code: 'KeyS', vk: 83, ctrl: true } },
    {},
  );
  check('  Ctrl+S 步骤执行成功', k2?.ok === true, JSON.stringify(k2));
  const comboPills = win.GX_HUD._pills();
  check('  Ctrl+S 回显出 Ctrl 与主键', comboPills.includes('Ctrl') && comboPills.includes('s'),
    JSON.stringify(comboPills));

  // input 步骤需要能解析到元素，给 document.querySelector 打个桩
  const kw = makeElement('input');
  ctx.document.querySelector = (sel) => (String(sel).includes('kw') ? kw : null);
  const k3 = await win.GX_REPLAY.runStep(
    { type: 'input', locator: { kind: 'css', value: '#kw' }, value: 'hello 世界' },
    { stepTimeout: 300 },
  );
  check('  input 步骤执行成功', k3?.ok === true, JSON.stringify(k3));
  check('  input 步骤显示出写入内容', win.GX_HUD._pills().join(' ').includes('hello 世界'),
    JSON.stringify(win.GX_HUD._pills()));

  // ---- 拖拽回放 ----
  const slider = makeElement('div');
  const seenEvents = [];
  slider.dispatchEvent = (ev) => { seenEvents.push({ type: ev.type, buttons: ev.buttons, x: ev.clientX }); return true; };
  ctx.document.querySelector = (sel) => (String(sel).includes('slider') ? slider : null);

  const d1 = await win.GX_REPLAY.runStep(
    {
      type: 'drag',
      locator: { kind: 'css', value: '#slider' },
      rel: { x: 0.1, y: 0.5 },
      path: [{ x: 0, y: 0 }, { x: 30, y: 5 }, { x: 120, y: 0 }],
    },
    { stepTimeout: 300 },
  );
  check('  drag 步骤执行成功', d1?.ok === true, JSON.stringify(d1));

  const types = seenEvents.map((e) => e.type);
  check('  拖拽派发了 mousedown → mousemove… → mouseup',
    types.includes('mousedown') && types.includes('mousemove') && types.includes('mouseup'),
    JSON.stringify(types));
  check('  拖拽过程中的 mousemove 带 buttons=1（否则页面会当成普通移动）',
    seenEvents.some((e) => e.type === 'mousemove' && e.buttons === 1),
    JSON.stringify(seenEvents));
  check('  mousedown / mouseup 顺序正确',
    types.indexOf('mousedown') < types.lastIndexOf('mouseup'),
    JSON.stringify(types));
  check('  拖拽终点落在起点 + 120px 处',
    seenEvents.filter((e) => e.type === 'mouseup').at(-1)?.x ===
      seenEvents.find((e) => e.type === 'mousedown').x + 120,
    JSON.stringify(seenEvents.filter((e) => e.type === 'mouseup' || e.type === 'mousedown')));
  check('  拖拽时提示层播放路径动画（与录制观感一致）', win.GX_HUD._animating() === true);
  await sleep(320);
  check('  路径动画播完后收尾', win.GX_HUD._animating() === false);

  // 没有 path 的 drag 步骤也不能崩
  const d2 = await win.GX_REPLAY.runStep(
    { type: 'drag', locator: { kind: 'css', value: '#slider' }, rel: { x: 0.5, y: 0.5 } },
    { stepTimeout: 300 },
  );
  check('  drag 缺少 path 时安全降级', d2?.ok === true, JSON.stringify(d2));

  // ---- CDP 模式下按键由后台投递，页面只能靠消息回显 ----
  resp = null;
  listeners[0]({ type: 'GX_HUD_KEY', info: { key: 'Tab', code: 'Tab' }, down: true }, {}, (r) => { resp = r; });
  check('  GX_HUD_KEY 消息有响应', resp?.ok === true, JSON.stringify(resp));
  check('  GX_HUD_KEY 触发了回显', win.GX_HUD._pills().includes('Tab'), JSON.stringify(win.GX_HUD._pills()));

  resp = null;
  listeners[0]({ type: 'GX_HUD_INPUT', text: 'CDP 写入', label: '输入' }, {}, (r) => { resp = r; });
  check('  GX_HUD_INPUT 消息有响应', resp?.ok === true, JSON.stringify(resp));
  check('  GX_HUD_INPUT 触发了回显', win.GX_HUD._pills().join(' ').includes('CDP 写入'),
    JSON.stringify(win.GX_HUD._pills()));

  resp = null;
  listeners[0]({ type: 'GX_HUD_TICK', count: 5 }, {}, (r) => { resp = r; });
  check('  GX_HUD_TICK 不抛异常', resp?.ok === true);

  resp = null;
  listeners[0]({ type: 'GX_HUD_OFF' }, {}, (r) => { resp = r; });
  check('  GX_HUD_OFF 不抛异常', resp?.ok === true);
  check('  HUD 已熄灭', win.GX_HUD.isOn() === false);
  check('  熄灭后按键区已清空', win.GX_HUD._pills().length === 0, JSON.stringify(win.GX_HUD._pills()));
}

/* ------------------------------------------------------------------ *
 * [8] 共存与幂等
 * ------------------------------------------------------------------ */

console.log('\n\x1b[1m[8] 四个脚本共存（真实页面的加载顺序）\x1b[0m');
{
  const { ctx, win, listeners } = makeContext();
  const load = () => {
    run(src('content/selector.js'), ctx, 'selector.js');
    run(src('content/hud.js'), ctx, 'hud.js');
    run(src('content/recorder.js'), ctx, 'recorder.js');
    run(src('content/replayer.js'), ctx, 'replayer.js');
  };
  load();
  check('selector + hud + recorder + replayer 都能共存',
    !!(win.GX && win.GX_HUD && win.GX_RECORDER && win.GX_REPLAY));
  check('共注册 2 个 onMessage 监听（recorder + replayer）', listeners.length === 2, `实际 ${listeners.length}`);

  // 按需注入会对已注入的 frame 再跑一遍，必须幂等
  const before = listeners.length;
  const hudBefore = win.GX_HUD;
  load();
  check('重复注入是幂等的（监听器没有增加）', listeners.length === before,
    `注入前 ${before} → 注入后 ${listeners.length}`);
  check('重复注入不会替换掉已有的 GX_HUD 实例', win.GX_HUD === hudBefore);
}

/* ------------------------------------------------------------------ *
 * [9] 域名匹配：两份实现对拍
 * ------------------------------------------------------------------ */

console.log('\n\x1b[1m[9] 域名匹配规则（lib/domains.js ↔ content/trigger.js 对拍）\x1b[0m');
{
  const { ctx, win } = makeContext({ href: 'https://app.example.com/orders' });
  run(src('content/trigger.js'), ctx, 'trigger.js');
  const impl = win.GX_TRIGGER;

  check('trigger.js 加载并挂载 GX_TRIGGER', !!impl);
  if (impl) {
    check('  暴露 matchesDomain / parsePatterns / evaluate',
      typeof impl.matchesDomain === 'function' &&
      typeof impl.parsePatterns === 'function' &&
      typeof impl.evaluate === 'function');

    const CASES = [
      ['https://example.com/a', [], true, '空列表 = 全部生效'],
      ['https://example.com/a', ['example.com'], true, '自身命中'],
      ['https://a.example.com/x', ['example.com'], true, '子域命中'],
      ['https://a.b.example.com/x', ['example.com'], true, '多级子域命中'],
      ['https://notexample.com/x', ['example.com'], false, '前缀相似不命中'],
      ['https://evil-example.com/x', ['example.com'], false, '连字符后缀不命中'],
      ['https://example.com.evil.com/x', ['example.com'], false, '后缀被伪装不命中'],
      ['https://a.example.com/x', ['*.example.com'], true, '通配子域命中'],
      ['https://example.com/x', ['*.example.com'], false, '通配不含自身'],
      ['https://example.com:8443/x', ['example.com:8443'], true, '带端口命中'],
      ['https://example.com/x', ['example.com:8443'], false, '端口不同不命中'],
      ['https://a.com/admin/users', ['https://a.com/admin'], true, 'URL 前缀命中'],
      ['https://a.com/other', ['https://a.com/admin'], false, 'URL 前缀不匹配'],
      ['https://a.com/x', ['a.com', 'b.com'], true, '多规则任一命中'],
      ['https://c.com/x', ['a.com', 'b.com'], false, '多规则都不命中'],
      ['https://a.com/x', 'a.com, b.com', true, '逗号分隔（文本形式）'],
      ['https://a.com/x', 'a.com，b.com', true, '中文逗号分隔（文本形式）'],
      ['https://a.com/x', 'a.com；b.com', true, '中文分号分隔（文本形式）'],
      ['https://b.com/x', 'a.com, b.com', true, '逗号分隔里命中的那一个'],
      ['https://EXAMPLE.com/x', ['example.com'], true, '大小写不敏感'],
      ['https://a.com/x', ['  a.com  '], true, '两侧空白被忽略'],
      ['chrome://extensions', ['a.com'], false, '非 http 协议不误命中'],
      ['not a url', ['a.com'], false, '非法 URL 不抛异常'],
    ];

    const bad = [];
    for (const [url, pats, want, label] of CASES) {
      const a = refMatches(url, pats);
      const b = impl.matchesDomain(url, pats);
      if (a !== b || a !== want) {
        bad.push(`${label}: ${url} | ${JSON.stringify(pats)} → domains=${a} trigger=${b} 期望=${want}`);
      }
    }
    check(`  ${CASES.length} 组用例两份实现一致且符合预期`, bad.length === 0, bad.join('\n      '));

    const parseCases = [
      ['a.com, b.com', 2],
      ['a.com，b.com；c.com d.com', 4],
      ['', 0],
      [['a.com', ' b.com '], 2],
    ];
    const parseBad = parseCases.filter(([inp, n]) => refParse(inp).length !== n || impl.parsePatterns(inp).length !== n);
    check('  parsePatterns 两份实现一致', parseBad.length === 0, JSON.stringify(parseBad));
  }
}

/* ------------------------------------------------------------------ *
 * [10] 触发行为
 * ------------------------------------------------------------------ */

console.log('\n\x1b[1m[10] content/trigger.js 的触发行为\x1b[0m');
{
  const sent = [];
  const { ctx, win } = makeContext({ href: 'https://app.example.com/orders' });
  ctx.chrome.storage.local.get = async (k) => ({
    [k]: [
      { id: 's_match', name: '命中', trigger: { enabled: true, domains: ['example.com'], delaySec: 0, once: true, cooldownSec: 0 } },
      { id: 's_miss', name: '不命中', trigger: { enabled: true, domains: ['other.com'], delaySec: 0 } },
      { id: 's_off', name: '未启用', trigger: { enabled: false, domains: [] } },
      { id: 's_none', name: '没配触发', trigger: undefined },
    ],
  });
  ctx.chrome.runtime.sendMessage = async (m) => { sent.push(m); return { ok: true }; };

  run(src('content/trigger.js'), ctx, 'trigger.js');
  await sleep(300);

  const ids = sent.map((m) => m.scriptId);
  check('  命中域名的脚本被触发', ids.includes('s_match'), JSON.stringify(ids));
  check('  域名不匹配的脚本不触发', !ids.includes('s_miss'), JSON.stringify(ids));
  check('  未启用的脚本不触发', !ids.includes('s_off'), JSON.stringify(ids));
  check('  没配触发的脚本不触发（旧脚本兼容）', !ids.includes('s_none'), JSON.stringify(ids));
  check('  上行带 loadId（同一次加载去重用）',
    typeof sent[0]?.loadId === 'string' && sent[0].loadId.length > 0, JSON.stringify(sent[0]));
  check('  上行带当前 URL', typeof sent[0]?.url === 'string' && sent[0].url.includes('example.com'));
}

console.log('\n\x1b[1m[11] 触发条件：等元素 / 等前台\x1b[0m');
{
  // 元素出现后才触发
  const s1 = [];
  const c1 = makeContext({ href: 'https://a.com/x' });
  let present = false;
  c1.ctx.document.querySelector = (sel) => (sel === '#ready' && present ? makeElement('div') : null);
  c1.ctx.chrome.storage.local.get = async (k) => ({
    [k]: [{ id: 's_ready', name: '等元素', trigger: { enabled: true, domains: [], delaySec: 0, readySelector: '#ready', readyTimeoutSec: 1 } }],
  });
  c1.ctx.chrome.runtime.sendMessage = async (m) => { s1.push(m); return { ok: true }; };
  run(src('content/trigger.js'), c1.ctx, 'trigger.js');
  await sleep(150);
  check('  元素还没出现时不触发', s1.length === 0, JSON.stringify(s1.map((m) => m.scriptId)));
  present = true;
  await sleep(450);
  check('  元素出现后触发', s1.some((m) => m.scriptId === 's_ready'), JSON.stringify(s1.map((m) => m.scriptId)));

  // 等不到就不硬跑
  const s2 = [];
  const c2 = makeContext({ href: 'https://a.com/x' });
  c2.ctx.document.querySelector = () => null;
  c2.ctx.chrome.storage.local.get = async (k) => ({
    [k]: [{ id: 's_to', name: '超时', trigger: { enabled: true, domains: [], delaySec: 0, readySelector: '#never', readyTimeoutSec: 1 } }],
  });
  c2.ctx.chrome.runtime.sendMessage = async (m) => { s2.push(m); return { ok: true }; };
  run(src('content/trigger.js'), c2.ctx, 'trigger.js');
  await sleep(1500);
  check('  元素等不到就不触发（不硬跑）', s2.length === 0, JSON.stringify(s2.map((m) => m.scriptId)));

  // 标签页在后台时先等着
  const s3 = [];
  const c3 = makeContext({ href: 'https://a.com/x' });
  c3.ctx.document.visibilityState = 'hidden';
  c3.ctx.chrome.storage.local.get = async (k) => ({
    [k]: [{ id: 's_vis', name: '等前台', trigger: { enabled: true, domains: [], delaySec: 0, requireVisible: true } }],
  });
  c3.ctx.chrome.runtime.sendMessage = async (m) => { s3.push(m); return { ok: true }; };
  run(src('content/trigger.js'), c3.ctx, 'trigger.js');
  await sleep(300);
  check('  标签页在后台时不触发（等切到前台）', s3.length === 0, JSON.stringify(s3.map((m) => m.scriptId)));

  // 选择器语法错误要能安全兜底
  const s4 = [];
  const c4 = makeContext({ href: 'https://a.com/x' });
  c4.ctx.document.querySelector = () => { throw new Error('bad selector'); };
  c4.ctx.chrome.storage.local.get = async (k) => ({
    [k]: [{ id: 's_bad', name: '坏选择器', trigger: { enabled: true, domains: [], delaySec: 0, readySelector: '>>>', readyTimeoutSec: 1 } }],
  });
  c4.ctx.chrome.runtime.sendMessage = async (m) => { s4.push(m); return { ok: true }; };
  run(src('content/trigger.js'), c4.ctx, 'trigger.js');
  await sleep(400);
  check('  选择器语法错误时安全放弃', s4.length === 0, JSON.stringify(s4.map((m) => m.scriptId)));
}

  /* ---------------- 步骤匹配条件 ---------------- */

  console.log('\n\x1b[1m[10] 步骤匹配条件（加固定位用）\x1b[0m');
  const mc = makeContext({ href: 'https://m.test/x' });
  run(src('content/selector.js'), mc.ctx, 'selector.js');
  const MM = mc.win.GX;

  // matchesExtra 只依赖 el.matches，这里给最简的假元素就够
  const elOk = { nodeType: 1, matches: () => true };
  const elNo = { nodeType: 1, matches: () => false };

  check('不填条件时一律通过', MM.matchesExtra(elOk, '') === true);
  check('只有空白也等于不填', MM.matchesExtra(elOk, '   ') === true);
  check('满足条件时通过', MM.matchesExtra(elOk, '.green') === true);
  check('不满足时挡掉', MM.matchesExtra(elNo, '.green') === false);
  check('元素为空时挡掉', MM.matchesExtra(null, '.green') === false);
  check('文本节点挡掉', MM.matchesExtra({ nodeType: 3 }, '.green') === false);
  check('选择器语法出错按「不匹配」处理，而不是把定位流程带崩',
    MM.matchesExtra({ nodeType: 1, matches: () => { throw new Error('bad'); } }, '###') === false);

  mc.ctx.document.createDocumentFragment = () => ({
    querySelector: (t) => {
      if (t === '###') throw new Error('bad');
      return null;
    },
  });
  check('isValidSelector 认出坏选择器', MM.isValidSelector('###') === false);
  check('isValidSelector 放行正常选择器', MM.isValidSelector('.green[href^="/d"]') === true);
  check('空条件视为合法', MM.isValidSelector('') === true);

  // 有条件时必须逐个筛 —— querySelector 只给第一个，可能正好是不该点的那个
  const wrong = { nodeType: 1, matches: () => false };
  const right = { nodeType: 1, matches: () => true };
  mc.ctx.document.querySelectorAll = () => [wrong, right];
  check('resolve 跳过条件不符的候选，选中真正那个',
    MM.resolve(mc.ctx.document, { kind: 'css', value: '#x' }, '.green') === right);
  mc.ctx.document.querySelectorAll = () => [wrong];
  check('候选全不符时返回 null —— 于是继续等待，而不是点错元素',
    MM.resolve(mc.ctx.document, { kind: 'css', value: '#x' }, '.green') === null);
  mc.ctx.document.querySelector = () => right;
  check('不填条件时走 querySelector 快路径（不做多余的遍历）',
    MM.resolve(mc.ctx.document, { kind: 'css', value: '#x' }, '') === right);

  // elementHints：录制时存下的元素特征，编辑界面靠它一键拼条件
  const hintEl = {
    nodeType: 1,
    tagName: 'A',
    classList: ['btn', 'green', 'btn-1697123456789'],
    attributes: [
      { name: 'class', value: 'btn green' },
      { name: 'style', value: 'color:red' },
      { name: 'href', value: '/detail?id=1' },
      { name: 'data-id', value: '7' },
    ],
  };
  const hints = MM.elementHints(hintEl);
  check('记下可用的 class', hints.cls.includes('btn') && hints.cls.includes('green'), JSON.stringify(hints.cls));
  check('过滤掉带长数字、会变的那种 class',
    !hints.cls.some((c) => /1697123456789/.test(c)), JSON.stringify(hints.cls));
  check('记下 href', hints.attrs.some((a) => a.name === 'href'), JSON.stringify(hints.attrs));
  check('丢掉 style 这类噪声', !hints.attrs.some((a) => a.name === 'style'));
  check('保留 data- 属性', hints.attrs.some((a) => a.name === 'data-id'));
  check('不是元素时返回 null', MM.elementHints({ nodeType: 3 }) === null);


console.log('\n' + '─'.repeat(52));
console.log(`  通过 \x1b[32m${pass}\x1b[0m  失败 \x1b[31m${fail}\x1b[0m`);
console.log('─'.repeat(52) + '\n');
process.exit(fail ? 1 : 0);
