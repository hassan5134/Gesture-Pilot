/**
 * CDP 引擎（路线 B）：通过 chrome.debugger 投递真实输入事件。
 * 产出的事件 isTrusted === true，与真人操作在页面看来完全一致。
 *
 * 注意：
 *  - 需要 "debugger" 权限，安装时会有额外警告；
 *  - 标签页上会出现「正在调试此浏览器」横幅；
 *  - 与开发者工具互斥，DevTools 打开时无法 attach。
 */

const CDP_VERSION = '1.3';

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 线性的鼠标中间点，用于让轨迹不是「瞬移」 */
export function mouseLerp(from, to) {
  const x0 = from?.x ?? to.x;
  const y0 = from?.y ?? to.y;
  const dist = Math.hypot(to.x - x0, to.y - y0);
  const steps = Math.max(3, Math.min(18, Math.round(dist / 40)));
  const out = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // easeInOutQuad，接近真人起止有加减速
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    out.push({
      x: x0 + (to.x - x0) * e,
      y: y0 + (to.y - y0) * e,
      dt: 8 + Math.random() * 16,
    });
  }
  return out;
}

export async function attach(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
  } catch (e) {
    const m = String(e?.message || e);
    if (/already attached/i.test(m)) return; // 之前挂上的，直接复用
    if (/another debugger|devtools|already been attached/i.test(m)) {
      throw new Error('该标签页已被开发者工具或其他调试器占用，CDP 模式不可用。请关闭 DevTools 后重试，或改用合成事件引擎。');
    }
    throw new Error(`无法连接调试接口：${m}`);
  }
}

export async function detach(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* 已经断开，忽略 */
  }
}

function send(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

/**
 * 拖拽：按下 → 沿路径移动（buttons 必须为 1）→ 抬起。
 * points 用的是顶层视口坐标。
 */
export async function dragPath(tabId, points, stepMs = 14) {
  if (!Array.isArray(points) || points.length === 0) return;
  const first = points[0];

  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: first.x, y: first.y, buttons: 0 });
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x: first.x, y: first.y, button: 'left', buttons: 1, clickCount: 1,
  });

  for (const p of points.slice(1)) {
    // 移动过程中 buttons=1，否则页面会当成普通移动而不是拖拽
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, buttons: 1 });
    await sleep(stepMs);
  }

  const end = points[points.length - 1];
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: end.x, y: end.y, button: 'left', buttons: 0, clickCount: 1,
  });
}

export async function clickAt(tabId, point, humanize = true, from) {
  if (humanize && from) {
    for (const p of mouseLerp(from, point)) {
      await send(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: p.x, y: p.y, buttons: 0,
      });
      await sleep(p.dt);
    }
  } else {
    await send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: point.x, y: point.y, buttons: 0,
    });
  }

  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1,
  });
  await sleep(40 + Math.random() * 60);
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1,
  });
}

/** 全选后整段插入 —— 比逐键 dispatchKeyEvent 快得多，也稳得多 */
export async function typeText(tabId, text, clear = true) {
  if (clear) {
    const p = {
      modifiers: 2, // Ctrl
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      code: 'KeyA',
      key: 'a',
    };
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...p });
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...p });
    await sleep(50);
  }
  await send(tabId, 'Input.insertText', { text: String(text ?? '') });
}

export async function pressKey(tabId, k = {}) {
  const modifiers = (k.alt ? 1 : 0) | (k.ctrl ? 2 : 0) | (k.meta ? 4 : 0) | (k.shift ? 8 : 0);
  const base = {
    modifiers,
    windowsVirtualKeyCode: k.vk || 0,
    nativeVirtualKeyCode: k.vk || 0,
    code: k.code || '',
    key: k.key || '',
  };
  const printable = (k.key || '').length === 1 && modifiers === 0;
  await send(
    tabId,
    'Input.dispatchKeyEvent',
    printable ? { type: 'keyDown', ...base, text: k.key, unmodifiedText: k.key } : { type: 'rawKeyDown', ...base },
  );
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

export async function wheelAt(tabId, point, deltaX, deltaY) {
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: point.x,
    y: point.y,
    deltaX: deltaX || 0,
    deltaY: deltaY || 0,
  });
}

export async function setFileInput(tabId, point, files) {
  // 需要 DOM.setFileInputFiles + 节点 ID，属于进阶用法，此处仅给出挂载点
  throw new Error(`file input 需要 DOM.setFileInputFiles，当前版本未启用（目标：${point.x},${point.y}，文件：${(files || []).join(',')}）`);
}
