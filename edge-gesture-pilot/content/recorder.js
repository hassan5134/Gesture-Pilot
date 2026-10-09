/**
 * 录制器：捕获阶段监听鼠标 / 键盘 / 滚轮，产出可回放的步骤列表。
 *
 * 设计取舍：
 *  - 不逐键录制，而是按元素聚合「输入」步骤，记录最终值 —— 回放时整段写入，
 *    既避开逐键时序误差，也不受输入法影响；
 *  - 不记录 mousemove，只在点击时记录元素内相对落点；
 *  - 拖拽（按下到抬起位移 > 8px）暂不支持，直接跳过；
 *  - 滚轮按 350ms 窗口累积成一个步骤，回放时一次性滚动。
 *
 * 可靠性（踩过的坑）：
 *  - service worker 会在录制期间被回收，所以步骤不能只攒在内存里等 stop 时一次性上报，
 *    必须边录边增量上报（250ms 防抖），并且在 pagehide 时补一次；
 *  - 页面在录制期间重新加载会换掉整个 frame，录制状态必须能从 storage.session 自动恢复，
 *    否则导航之后的操作全部丢失；
 *  - 每一步带全局唯一的 sid，service worker 侧按 sid 去重，
 *    这样「增量上报 + 最终全量上报」不会产生重复步骤。
 */
(() => {
  if (window.GX_RECORDER) return;

  const GX = window.GX;
  const IS_TOP = window === window.top;

  /** 每次 frame 实例一个 id：页面重载后是新实例，旧步骤不会被误判成重复 */
  const SESSION_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  const DRAG_THRESHOLD = 8;
  const DRAG_SAMPLE_MS = 25;
  const INPUT_DEBOUNCE = 400;
  const WHEEL_WINDOW = 350;
  const STREAM_DEBOUNCE = 250;

  let active = false;
  let steps = [];
  let streamed = 0;      // 已经增量上报出去的条数
  let lastTs = 0;
  let streamTimer = null;

  let pendingClick = null;
  let pendingInput = null;
  let inputTimer = null;
  let wheelAcc = null;
  let wheelTimer = null;
  /** 已经被 click 步骤覆盖过的元素，避免 change 事件重复记一步 */
  let clickCovered = new WeakSet();
  /** 是否显示页面内实时提示层，可在设置里关掉 */
  let hudWant = true;

  // 设置可以从 content script 直接读 storage.local
  (async () => {
    try {
      const got = await chrome.storage.local.get('gx_settings');
      if (got?.gx_settings?.hud === false) hudWant = false;
    } catch {
      /* 读不到就用默认值 */
    }
  })();

  /* ---------------- 上行通道 ---------------- */

  function post(payload) {
    try {
      const p = chrome.runtime.sendMessage(payload);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* 扩展被卸载或上下文失效，忽略 */
    }
  }

  function scheduleStream() {
    if (streamTimer) return;
    streamTimer = setTimeout(() => {
      streamTimer = null;
      streamNew();
    }, STREAM_DEBOUNCE);
  }

  /** 把还没上报的步骤推给 service worker（不重置本地缓冲，stop 时仍会全量再发一次） */
  function streamNew() {
    if (!active) return;
    const fresh = steps.slice(streamed);
    if (!fresh.length) return;
    streamed = steps.length;
    post({ type: 'GX_STEPS_APPEND', steps: fresh, url: location.href, top: IS_TOP });
  }

  /* ---------------- 实时提示层 ---------------- */

  /** HUD 是「锦上添花」，任何异常都不能影响录制本身 */
  const HUD = {
    get api() {
      try {
        return active ? window.GX_HUD : null;
      } catch {
        return null;
      }
    },
    call(method, ...args) {
      try {
        this.api?.[method]?.(...args);
      } catch {
        /* 忽略 */
      }
    },
  };

  /** 生成点击标签：元素标签名 + 一段可见文本 */
  function hudLabel(el) {
    if (!el || el.nodeType !== 1) return '';
    const tag = el.tagName.toLowerCase();
    let text = '';
    try {
      text = (el.getAttribute('aria-label') || el.value || el.innerText || el.textContent || '')
        .trim()
        .replace(/\s+/g, ' ');
    } catch {
      text = '';
    }
    if (!text && el.id) text = `#${el.id}`;
    if (text.length > 14) text = `${text.slice(0, 14)}…`;
    return { tag, text };
  }

  /* ---------------- 步骤缓冲区 ---------------- */

  function push(step) {
    const ts = step.ts ?? Date.now();
    step.ts = ts;
    // 首步没有「等待」语义，间隔置 0
    step.delay = steps.length ? Math.max(0, ts - lastTs) : 0;
    lastTs = ts;
    // 全局唯一 id：增量上报与最终上报靠它去重
    step.sid = `${SESSION_ID}:${steps.length}`;
    // 非顶层 frame 的步骤带上来源 URL，回放时用于投递到正确的 frame
    if (!IS_TOP) step.frameUrl = location.href;
    steps.push(step);
    HUD.call('setStepCount', steps.length);
    scheduleStream();
  }

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag !== 'INPUT') return false;
    const t = (el.getAttribute('type') || 'text').toLowerCase();
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color'].includes(t);
  }

  function isTypable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
  }

  function eventTarget(e) {
    const t = e.target;
    if (!t || t.nodeType !== 1) return null;
    // Shadow DOM 下 target 会被重定向到宿主，需要从 composedPath 取真实节点
    const path = typeof e.composedPath === 'function' ? e.composedPath() : null;
    if (path && path.length && path[0] && path[0].nodeType === 1) return path[0];
    return t;
  }

  /* ---------------- 输入聚合 ---------------- */

  function flushInput() {
    clearTimeout(inputTimer);
    inputTimer = null;
    const p = pendingInput;
    pendingInput = null;
    if (!p) return;
    // 注意：不要再拿「初始值」和当前值比对。initial 是在第一个 input 事件里读的，
    // 那时值已经变过一轮了，比对必然相等 —— 结果就是只敲一个字符的输入被整条丢掉。
    // input 事件本身只在值真的变化时才触发，收到过就说明有改动。
    push({
      type: p.tag === 'SELECT' ? 'select' : 'input',
      locator: p.locator,
      value: p.value,
      tag: p.tag.toLowerCase(),
      ts: p.ts,
    });
  }

  function noteInput(el) {
    if (!el) return;
    if (pendingInput && pendingInput.el === el) {
      pendingInput.value = GX.readValue(el);
      pendingInput.ts = Date.now();
    } else {
      flushInput();
      pendingInput = {
        el,
        locator: GX.buildLocator(el),
        value: GX.readValue(el),
        ts: Date.now(),
        tag: el.tagName,
      };
    }
    clearTimeout(inputTimer);
    inputTimer = setTimeout(flushInput, INPUT_DEBOUNCE);
  }

  /* ---------------- 滚轮聚合 ---------------- */

  function flushWheel() {
    clearTimeout(wheelTimer);
    wheelTimer = null;
    const acc = wheelAcc;
    wheelAcc = null;
    if (!acc) return;
    if (Math.abs(acc.deltaY) < 4 && Math.abs(acc.deltaX) < 4) return;
    push({
      type: 'wheel',
      deltaX: Math.round(acc.deltaX),
      deltaY: Math.round(acc.deltaY),
      ts: acc.ts,
    });
  }

  /* ---------------- 事件处理 ---------------- */

  /** 把绝对坐标换算成元素内的相对落点（0~1） */
  function relPoint(x, y, r) {
    if (!r || (!r.width && !r.height)) return { x: 0.5, y: 0.5 };
    return {
      x: Math.min(1, Math.max(0, (x - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (y - r.top) / r.height)),
    };
  }

  /**
   * 拖拽路径抽稀：保住首尾，中间等距取样。
   * 原始采样点能有几百个，直接存进脚本会又大又慢，回放观感也没区别。
   */
  function simplifyPath(pts, max) {
    if (!Array.isArray(pts) || pts.length <= max) return pts || [];
    const out = [];
    const step = (pts.length - 1) / (max - 1);
    for (let i = 0; i < max; i++) out.push(pts[Math.round(i * step)]);
    return out;
  }

  const onClickDown = (e) => {
    if (!active) return;
    const el = eventTarget(e);
    if (!el) return;

    if (e.button !== 0) {
      const info = hudLabel(el);
      HUD.call('down', e.clientX, e.clientY, e.button, info.tag, info.text);
      return;
    }

    flushInput();
    pendingClick = { el, x: e.clientX, y: e.clientY, ts: Date.now() };
    const info = hudLabel(el);
    HUD.call('down', e.clientX, e.clientY, e.button, info.tag, info.text);
  };

  const onMouseUp = (e) => {
    if (!active || !pendingClick) return;
    const c = pendingClick;
    pendingClick = null;

    /* ---- 拖拽：录成 drag 步骤，路径以「相对起点的偏移」保存 ---- */
    if (c.dragging) {
      if (!c.el.isConnected) return;
      const r = c.el.getBoundingClientRect();

      // 抬起位置一定是路径的最后一站
      const endDx = Math.round(e.clientX - c.x);
      const endDy = Math.round(e.clientY - c.y);
      const last = c.pts[c.pts.length - 1];
      if (!last || last.x !== endDx || last.y !== endDy) c.pts.push({ x: endDx, y: endDy });

      HUD.call('up', e.clientX, e.clientY);
      HUD.call('drag', c.x, c.y, e.clientX, e.clientY);

      push({
        type: 'drag',
        locator: GX.buildLocator(c.el),
        rel: relPoint(c.x, c.y, r),
        path: simplifyPath(c.pts, 48),
        button: 0,
        ts: c.ts,
      });
      return;
    }

    if (!c.el.isConnected) return;

    const r = c.el.getBoundingClientRect();
    const tag = c.el.tagName.toLowerCase();
    // 记下这个元素，让紧随其后的 change 事件不要重复产生一步
    clickCovered.add(c.el);

    HUD.call('up', e.clientX, e.clientY);
    push({
      type: 'click',
      locator: GX.buildLocator(c.el),
      rel: relPoint(c.x, c.y, r),
      tag,
      ts: c.ts,
    });
  };

  /** 只服务于提示层与拖拽路径采集，不参与点击步骤的生成 */
  const onMouseMove = (e) => {
    if (!active) return;
    HUD.call('move', e.clientX, e.clientY);

    const c = pendingClick;
    if (!c) return;
    const dx = e.clientX - c.x;
    const dy = e.clientY - c.y;

    if (!c.dragging) {
      if (Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
      c.dragging = true;
      c.pts = [{ x: 0, y: 0 }];
      c.lastSample = 0;
    }

    const now = performance.now();
    if (now - c.lastSample < DRAG_SAMPLE_MS) return;
    c.lastSample = now;
    c.pts.push({ x: Math.round(dx), y: Math.round(dy) });
    if (c.pts.length > 500) c.pts.splice(0, c.pts.length - 500); // 防御性上限
  };

  const onMouseLeave = () => {
    if (!active) return;
    HUD.call('leave');
  };

  const onInput = (e) => {
    if (!active) return;
    const el = eventTarget(e);
    if (!isEditable(el)) return;
    noteInput(el);
  };

  const onChange = (e) => {
    if (!active) return;
    const el = eventTarget(e);
    if (!el) return;
    if (el.tagName === 'SELECT') {
      flushInput();
      push({
        type: 'select',
        locator: GX.buildLocator(el),
        value: GX.readValue(el),
        tag: 'select',
        ts: Date.now(),
      });
      return;
    }
    if (el.tagName === 'INPUT') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      // 勾选/单选的状态变化已由 click 步骤覆盖，只在非点击途径（键盘、脚本）触发时补记
      if ((t === 'checkbox' || t === 'radio') && !clickCovered.has(el)) {
        flushInput();
        push({
          type: 'click',
          locator: GX.buildLocator(el),
          rel: { x: 0.5, y: 0.5 },
          tag: 'input',
          ts: Date.now(),
        });
      }
    }
  };

  const onFocusOut = (e) => {
    if (!active) return;
    if (pendingInput && eventTarget(e) === pendingInput.el) flushInput();
  };

  const onKeyDown = (e) => {
    if (!active) return;

    // 提示层要在「是否记成步骤」的判断之前喂数据，
    // 否则纯打字时 HUD 什么都看不到（打字被聚合成 input 步骤，不产生 key 步骤）
    HUD.call('key', { key: e.key, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey }, true);

    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;

    const hasMod = e.ctrlKey || e.altKey || e.metaKey;
    // 普通打字交给 input 步骤覆盖，只在有修饰键或非输入区按键时单独记录
    if (!hasMod && e.key.length === 1 && isEditable(e.target)) return;

    flushInput();
    const el = eventTarget(e);
    push({
      type: 'key',
      locator: isTypable(el) || (el && typeof el.focus === 'function') ? GX.buildLocator(el) : null,
      key: {
        key: e.key,
        code: e.code,
        vk: e.keyCode || 0,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        shift: e.shiftKey,
        meta: e.metaKey,
      },
      ts: Date.now(),
    });
  };

  const onKeyUp = (e) => {
    if (!active) return;
    HUD.call('key', { key: e.key, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey }, false);
  };

  const onWheel = (e) => {
    if (!active) return;
    flushInput();
    if (!wheelAcc) wheelAcc = { deltaX: 0, deltaY: 0, ts: Date.now() };
    wheelAcc.deltaX += e.deltaX;
    wheelAcc.deltaY += e.deltaY;
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(flushWheel, WHEEL_WINDOW);
  };

  /** 页面即将卸载（导航 / 刷新）—— 把还压在手里的步骤补一次上报 */
  const onPageHide = () => {
    if (!active) return;
    flushInput();
    flushWheel();
    clearTimeout(streamTimer);
    streamTimer = null;
    streamNew();
  };

  const onVisibility = () => {
    if (!active) return;
    if (document.visibilityState === 'hidden') onPageHide();
  };

  /* ---------------- 挂载 / 卸载 ---------------- */

  const OPT = { capture: true, passive: true };
  const OPT_ACTIVE = { capture: true, passive: false };

  function attach() {
    window.addEventListener('mousedown', onClickDown, OPT_ACTIVE);
    window.addEventListener('mouseup', onMouseUp, OPT_ACTIVE);
    window.addEventListener('mousemove', onMouseMove, OPT);
    window.addEventListener('mouseleave', onMouseLeave, OPT);
    window.addEventListener('input', onInput, OPT);
    window.addEventListener('change', onChange, OPT);
    window.addEventListener('focusout', onFocusOut, OPT);
    window.addEventListener('keydown', onKeyDown, OPT_ACTIVE);
    window.addEventListener('keyup', onKeyUp, OPT);
    window.addEventListener('wheel', onWheel, OPT);
    window.addEventListener('blur', onPageHide, OPT);
    window.addEventListener('pagehide', onPageHide, OPT);
    document.addEventListener('visibilitychange', onVisibility, OPT);
  }

  function detach() {
    window.removeEventListener('mousedown', onClickDown, OPT_ACTIVE);
    window.removeEventListener('mouseup', onMouseUp, OPT_ACTIVE);
    window.removeEventListener('mousemove', onMouseMove, OPT);
    window.removeEventListener('mouseleave', onMouseLeave, OPT);
    window.removeEventListener('input', onInput, OPT);
    window.removeEventListener('change', onChange, OPT);
    window.removeEventListener('focusout', onFocusOut, OPT);
    window.removeEventListener('keydown', onKeyDown, OPT_ACTIVE);
    window.removeEventListener('keyup', onKeyUp, OPT);
    window.removeEventListener('wheel', onWheel, OPT);
    window.removeEventListener('blur', onPageHide, OPT);
    window.removeEventListener('pagehide', onPageHide, OPT);
    document.removeEventListener('visibilitychange', onVisibility, OPT);
  }

  /* ---------------- 生命周期 ---------------- */

  function start() {
    if (active) return false;
    active = true;
    steps = [];
    streamed = 0;
    lastTs = 0;
    pendingClick = null;
    pendingInput = null;
    wheelAcc = null;
    clickCovered = new WeakSet();
    clearTimeout(inputTimer);
    clearTimeout(wheelTimer);
    clearTimeout(streamTimer);
    streamTimer = null;
    attach();
    // 提示层：录制开始时亮起（设置里可关）
    if (hudWant) {
      try {
        window.GX_HUD?.enable('录制中');
      } catch {
        /* 忽略 */
      }
    }
    return true;
  }

  /** 停止录制并返回全部步骤（增量上报过的也在内，由 service worker 按 sid 去重） */
  function stop() {
    if (!active) return [];
    flushInput();
    flushWheel();
    clearTimeout(streamTimer);
    streamTimer = null;
    detach();
    active = false;
    try {
      window.GX_HUD?.disable();
    } catch {
      /* 忽略 */
    }
    const out = steps.slice();
    steps = [];
    streamed = 0;
    return out;
  }

  /* ---------------- 录制中页面重载后自动续录 ---------------- */

  function sameOrigin(a, b) {
    try {
      return new URL(a).origin === new URL(b).origin;
    } catch {
      return false;
    }
  }

  (async () => {
    try {
      const got = await chrome.storage.session.get('gx_recording');
      const rec = got?.gx_recording;
      if (!rec?.url) return;
      // 只在同源页面自动续录，避免录制期间打开别的站点被误录进来
      if (!sameOrigin(rec.url, location.href)) return;
      start();
    } catch {
      /* 拿不到 storage.session（未授权），交给显式广播 */
    }
  })();

  /* ---------------- 消息接口 ---------------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;

    if (msg.type === 'GX_RECORD_START') {
      if (typeof msg.hud === 'boolean') hudWant = msg.hud;
      const fresh = start();
      sendResponse({ ok: true, top: IS_TOP, fresh, hud: hudWant && !!window.GX_HUD });
      return;
    }

    if (msg.type === 'GX_RECORD_STOP') {
      const out = stop();
      // 无论有没有步骤都要上报：service worker 靠「有没有 frame 响应」区分
      // 「没操作」和「通道不通」，这决定了错误提示能不能把问题说清楚
      post({
        type: 'GX_STEPS_APPEND',
        final: true,
        total: out.length,
        steps: out,
        url: location.href,
        top: IS_TOP,
      });
      sendResponse({ ok: true, count: out.length, top: IS_TOP });
      return;
    }

    if (msg.type === 'GX_PING') {
      sendResponse({
        ok: true,
        recording: active,
        top: IS_TOP,
        url: location.href,
        count: steps.length,
        streamed,
      });
      return;
    }
  });

  window.GX_RECORDER = { start, stop, isActive: () => active, peek: () => steps.slice() };
})();
