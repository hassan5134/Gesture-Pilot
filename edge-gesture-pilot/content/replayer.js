/**
 * 回放器（路线 A：合成事件）。
 * 由 service worker 按需注入，并通过 GX_RUN_STEP / GX_RESOLVE_POINT 消息驱动。
 *
 * isTrusted 说明：
 *  dispatchEvent 产生的事件 isTrusted === false，这是浏览器硬性限制，无法伪造。
 *  绝大多数站点的框架（React/Vue 事件委托）仍然会响应，但显式校验 isTrusted 的
 *  站点会拒绝 —— 那种情况需要用 CDP 引擎。
 */
(() => {
  if (window.GX_REPLAY) return;

  const GX = window.GX;
  let lastPoint = null;

  /* ---------------- 事件投递 ---------------- */

  function mouseEvent(type, x, y, buttons) {
    return new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      // 拖拽过程中的 mousemove 必须带 buttons=1，否则页面的拖拽逻辑会当成普通移动
      buttons: buttons === undefined ? (type === 'mousedown' ? 1 : 0) : buttons,
      detail: type === 'click' ? 1 : 0,
    });
  }

  function keyEvent(type, k) {
    const vk = k.vk || 0;
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      key: k.key || '',
      code: k.code || '',
      ctrlKey: !!k.ctrl,
      altKey: !!k.alt,
      shiftKey: !!k.shift,
      metaKey: !!k.meta,
      repeat: false,
    };
    const ev = new KeyboardEvent(type, init);
    // keyCode / which 是遗留只读属性，构造参数在部分版本被忽略，这里显式覆盖
    for (const [prop, val] of [['keyCode', vk], ['which', vk], ['charCode', type === 'keypress' ? vk : 0]]) {
      try {
        Object.defineProperty(ev, prop, { get: () => val, configurable: true });
      } catch {
        /* ignore */
      }
    }
    return ev;
  }

  async function glideTo(el, point, humanize) {
    if (!humanize) return;
    const path = GX.mousePath(lastPoint, point);
    for (const p of path) {
      el.dispatchEvent(mouseEvent('mousemove', p.x, p.y));
      // 把每一小步也喂给提示层，回放的轨迹才和录制时长得一样
      try {
        window.GX_HUD?.move(p.x, p.y);
      } catch {
        /* 忽略 */
      }
      await GX.sleep(p.dt);
    }
  }

  async function click(el, step, settings) {
    // 合成事件里的 clientX/clientY 必须是「本 frame」的坐标系。
    // 顶层视口坐标只对 CDP 有意义（见 background.js 的 dispatchStepCdp）。
    const point = GX.localPointAt(el, step.rel);
    if (!point) throw new Error('元素没有可见尺寸，无法计算点击坐标');

    try {
      window.GX_HUD?.replayClick(point.x, point.y, '回放');
    } catch {
      /* 忽略 */
    }

    const humanize = settings?.humanize !== false;
    await glideTo(el, point, humanize);
    el.dispatchEvent(mouseEvent('mousemove', point.x, point.y));
    el.dispatchEvent(mouseEvent('mousedown', point.x, point.y));
    await GX.sleep(35 + Math.random() * 55);
    el.dispatchEvent(mouseEvent('mouseup', point.x, point.y));
    lastPoint = { x: point.x, y: point.y };

    // 补一次原生 click：mousedown/mouseup 只覆盖监听器，
    // 链接跳转 / 表单提交 / label 联动这些默认行为需要真正的 click 事件。
    // el.click() 只派发 click，不会重复触发上面两个，因此不会双触发。
    try {
      el.click();
    } catch {
      el.dispatchEvent(mouseEvent('click', point.x, point.y));
    }
  }

  /**
   * 拖拽回放。
   * step.path 存的是「相对拖拽起点」的偏移量，所以布局有些许位移也能落在合理位置。
   * 注意：原生 HTML5 拖放（draggable="true" + dragstart/drop）无法用合成事件驱动，
   * 这是浏览器限制，只能用 CDP 的 Input.dispatchDragEvent，当前未支持。
   */
  async function drag(el, step, settings) {
    const start = GX.localPointAt(el, step.rel);
    if (!start) throw new Error('元素没有可见尺寸，无法计算拖拽起点');

    const offsets = Array.isArray(step.path) && step.path.length ? step.path : [{ x: 0, y: 0 }];
    const pts = offsets.map((o) => ({
      x: start.x + Math.round(Number(o?.x) || 0),
      y: start.y + Math.round(Number(o?.y) || 0),
    }));

    // 先起轨迹动画，再逐步投递事件 —— 两者时间轴大致对齐，观感就是「鼠标拖着走」
    try {
      const ms = Math.min(1400, Math.max(180, pts.length * 14));
      window.GX_HUD?.animPath([start, ...pts], ms, true);
    } catch {
      /* 忽略 */
    }

    const under = (p) => {
      try {
        return document.elementFromPoint?.(p.x, p.y) || el;
      } catch {
        return el;
      }
    };

    el.dispatchEvent(mouseEvent('mousemove', start.x, start.y));
    el.dispatchEvent(mouseEvent('mousedown', start.x, start.y));
    await GX.sleep(40);

    for (const p of pts) {
      // 投递到指针底下的元素：大部分拖拽实现把 mousemove 挂在 document 上，
      // 但挂在自己身上、靠 elementFromPoint 判断的也不少，这样两边都能覆盖
      under(p).dispatchEvent(mouseEvent('mousemove', p.x, p.y, 1));
      await GX.sleep(12 + Math.random() * 16);
    }

    const end = pts[pts.length - 1];
    under(end).dispatchEvent(mouseEvent('mouseup', end.x, end.y));
    lastPoint = { x: end.x, y: end.y };
  }

  function pressKey(k) {
    const kk = k || {};
    const target = document.activeElement || document.body;
    // 回显按下。HUD 自己按定时器淡出，不用等 keyup ——
    // 合成事件里 keydown/keyup 是连着发的，不这样做就完全闪不出来。
    echoKey(kk, true);
    target.dispatchEvent(keyEvent('keydown', kk));
    if ((kk.key || '').length === 1 && !kk.ctrl && !kk.alt && !kk.meta) {
      target.dispatchEvent(keyEvent('keypress', kk));
    }
    target.dispatchEvent(keyEvent('keyup', kk));
    echoKey(kk, false);
  }

  /* ---------------- 提示层回显 ---------------- */

  function echoKey(kk, down) {
    try {
      window.GX_HUD?.key(
        {
          key: kk.key,
          code: kk.code,
          ctrl: !!kk.ctrl,
          alt: !!kk.alt,
          shift: !!kk.shift,
          meta: !!kk.meta,
        },
        down,
      );
    } catch {
      /* 忽略 */
    }
  }

  function echoInput(text, label) {
    try {
      window.GX_HUD?.input(text, label);
    } catch {
      /* 忽略 */
    }
  }

  /** 报错时把人工加的匹配条件也带上，否则用户不知道是哪个条件没满足 */
  function describeWithMatch(step) {
    const base = GX.describeLocator(step.locator);
    return step.match ? `${base} 且满足「${step.match}」` : base;
  }

  /* ---------------- 单步执行 ---------------- */

  async function runStep(step, settings) {
    const timeout = settings?.stepTimeout ?? 8000;
    const humanize = settings?.humanize !== false;

    // 匹配条件写错了必须立刻报出来。否则表现出来只是「元素找不到」，
    // 而用户会去怀疑选择器、怀疑页面改版，很难想到是自己少打了个括号。
    if (step.match && !GX.isValidSelector(step.match)) {
      return { ok: false, error: `匹配条件「${step.match}」不是合法的 CSS 选择器` };
    }

    if (step.type === 'wait') {
      await GX.sleep(Number(step.value) || 1000);
      return { ok: true };
    }

    if (step.type === 'wheel') {
      const dx = Number(step.deltaX) || 0;
      const dy = Number(step.deltaY) || 0;
      const el = step.locator ? GX.resolve(document, step.locator, step.match) : null;
      const target = el || document.scrollingElement || document.documentElement;
      // 分几次滚动，避免一次性大跳变（部分站点只监听多次 wheel）
      const parts = Math.min(6, Math.max(1, Math.round(Math.abs(dy) / 400)));
      for (let i = 0; i < parts; i++) {
        target.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            composed: true,
            deltaX: dx / parts,
            deltaY: dy / parts,
          }),
        );
        await GX.sleep(40 + Math.random() * 60);
      }
      if (!el) {
        // 合成 wheel 不会真的滚动页面，这里补上实际位移（非对象签名不会触发平滑动画）
        window.scrollBy(dx, dy);
      }
      return { ok: true };
    }

    // 页面级快捷键（录制时目标不可聚焦，locator 为 null）：
    // 必须放在 waitFor 之前，否则会去等一个不存在的元素，白等到超时才失败
    if (step.type === 'key' && !step.locator) {
      pressKey(step.key);
      return { ok: true };
    }

    const el = await GX.waitFor(step.locator, timeout, null, step.match);
    if (!el) return { ok: false, error: `元素未出现：${describeWithMatch(step)}` };

    switch (step.type) {
      case 'click':
        await click(el, step, settings);
        break;

      case 'drag':
        await drag(el, step, settings);
        break;

      case 'input':
        await click(el, step, settings);
        await GX.sleep(60);
        GX.setNativeValue(el, step.value ?? '');
        echoInput(step.value ?? '', '输入');
        break;

      case 'select':
        GX.setNativeValue(el, step.value ?? '');
        echoInput(step.value ?? '', '选择');
        break;

      case 'key': {
        if (step.locator) {
          const focusable = await GX.waitFor(step.locator, timeout, null, step.match);
          if (focusable && typeof focusable.focus === 'function') {
            focusable.focus({ preventScroll: true });
            await GX.sleep(50);
          }
        }
        pressKey(step.key);
        break;
      }

      default:
        return { ok: false, error: `不支持的步骤类型：${step.type}` };
    }

    return { ok: true };
  }

  /* ---------------- 消息处理 ---------------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;

    if (msg.type === 'GX_HUD_ON') {
      let ok = false;
      try {
        ok = !!window.GX_HUD?.enable(msg.label || '回放中');
      } catch {
        /* 忽略 */
      }
      sendResponse({ ok: true, hud: ok });
      return;
    }

    if (msg.type === 'GX_HUD_OFF') {
      try {
        window.GX_HUD?.disable();
      } catch {
        /* 忽略 */
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'GX_HUD_TICK') {
      try {
        window.GX_HUD?.setStepCount(msg.count ?? 0);
      } catch {
        /* 忽略 */
      }
      sendResponse({ ok: true });
      return;
    }

    // CDP 引擎的按键由 service worker 直接投递，页面这边收不到事件，
    // 只能靠消息把回显喂进提示层
    if (msg.type === 'GX_HUD_KEY') {
      try {
        window.GX_HUD?.key(msg.info, !!msg.down);
      } catch {
        /* 忽略 */
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'GX_HUD_INPUT') {
      try {
        window.GX_HUD?.input(msg.text, msg.label);
      } catch {
        /* 忽略 */
      }
      sendResponse({ ok: true });
      return;
    }

    // CDP 引擎下鼠标移动看不到中间过程，由后台把整条路径发过来还原成轨迹动画
    if (msg.type === 'GX_HUD_PATH') {
      try {
        window.GX_HUD?.animPath(msg.points, msg.ms, !!msg.drag);
      } catch {
        /* 忽略 */
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'GX_RUN_STEP') {
      (async () => {
        try {
          const r = await runStep(msg.step, msg.settings);
          sendResponse(r);
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message || e) });
        }
      })();
      return true;
    }

    if (msg.type === 'GX_RESOLVE_POINT') {
      (async () => {
        try {
          const el = await GX.waitFor(msg.step.locator, msg.timeout ?? 8000, null, msg.step.match);
          if (!el) {
            sendResponse({ ok: false, error: `元素未出现：${describeWithMatch(msg.step)}` });
            return;
          }
          const point = GX.clientPointAt(el, msg.step.rel);
          if (!point) {
            sendResponse({ ok: false, error: '无法换算坐标（跨域 iframe 不支持 CDP 引擎）' });
            return;
          }
          sendResponse({ ok: true, point, url: location.href });
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message || e) });
        }
      })();
      return true;
    }
  });

  window.GX_REPLAY = { runStep, reset: () => { lastPoint = null; } };
})();
