/**
 * 录制 / 回放时的页面内实时提示层（HUD）。
 *
 * 显示内容：
 *  - 鼠标轨迹：指针拖尾 + 当前位置光环
 *  - 点击涟漪：按下时从落点扩散的圆环，颜色区分左/中/右键，并浮出目标元素标签
 *  - 拖拽连线：按住期间的虚线，直观说明「这一下没被录成点击」
 *  - 按键提示：透明背景的按键胶囊，普通字符短暂一现，组合键与功能键停留更久
 *  - 状态角标：右上角「录制中 · N 步」
 *
 * 实现要点：
 *  - 整层挂在 Shadow DOM 里并 `pointer-events: none`，页面 CSS 影响不到它，
 *    它也不会抢走页面的鼠标事件（否则会把点击录成 HUD 自己的）；
 *  - 轨迹与涟漪走 canvas（避免大量 DOM 节点抖动），文字类提示走 DOM（好排版）；
 *  - 全部接口都吞异常：提示层坏掉绝不能连累录制本身。
 */
(() => {
  if (window.GX_HUD) return;

  const MIN_W = 240;
  const MIN_H = 160;

  const TRAIL_LIFE = 850;
  const RIPPLE_LIFE = 620;
  const DRAG_LIFE = 1400;

  const BTN_COLOR = { 0: [55, 138, 221], 1: [151, 196, 89], 2: [239, 159, 39] };
  const BTN_NAME = { 0: '左键', 1: '中键', 2: '右键' };

  let enabled = false;
  let built = false;
  let host = null;
  let root = null;
  let canvas = null;
  let ctx = null;
  let badgeEl = null;
  let keyBoxEl = null;

  let raf = 0;
  let dpr = 1;

  let trail = [];
  let ripples = [];
  let dragPath = null;
  let pressed = false;
  let pressPoint = null;
  let pointer = null;
  let stepCount = 0;
  /** 正在播放的路径动画（重放时让轨迹看起来和录制一致） */
  let anim = null;
  /** 最后一次指针活动时间：指针停住后还要再画一会儿让拖尾淡完，之后就停掉重绘 */
  let lastMoveAt = 0;

  /** 当前按住的修饰键（keydown 常驻，keyup 后进入淡出） */
  const heldMods = new Map();
  let charPill = null;
  let inputPill = null;

  const HUD_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; margin: 0; padding: 0; pointer-events: none; }

  .layer {
    position: fixed; inset: 0;
    pointer-events: none;
    font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }

  canvas { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; }

  /* ---------- 状态角标 ---------- */
  .badge {
    position: fixed; top: 14px; right: 14px;
    display: flex; align-items: center; gap: 7px;
    padding: 6px 11px 6px 9px;
    border-radius: 999px;
    background: rgba(16, 20, 28, .62);
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
    border: 1px solid rgba(255, 255, 255, .16);
    color: #fff; font-size: 12px; font-weight: 500; letter-spacing: .01em;
    box-shadow: 0 3px 14px rgba(0, 0, 0, .22);
    opacity: 0; transition: opacity .22s;
  }
  .badge.on { opacity: 1; }
  .badge .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: #e5484d; box-shadow: 0 0 0 0 rgba(229, 72, 77, .6);
    animation: gx-pulse 1.4s ease-out infinite;
  }
  .badge.idle .dot { background: #378add; animation: none; }
  .badge .n { font-variant-numeric: tabular-nums; opacity: .78; font-weight: 400; }
  @keyframes gx-pulse {
    0%   { box-shadow: 0 0 0 0 rgba(229, 72, 77, .55); }
    70%  { box-shadow: 0 0 0 9px rgba(229, 72, 77, 0); }
    100% { box-shadow: 0 0 0 0 rgba(229, 72, 77, 0); }
  }

  /* ---------- 按键提示 ---------- */
  .keys {
    position: fixed; left: 50%; bottom: 34px;
    transform: translateX(-50%);
    display: flex; flex-wrap: wrap; align-items: center; justify-content: center;
    gap: 6px;
    max-width: min(86vw, 720px);
    transition: opacity .2s;
  }

  .k {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 30px; height: 30px; padding: 0 9px;
    border-radius: 8px;
    background: rgba(16, 20, 28, .58);
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
    border: 1px solid rgba(255, 255, 255, .22);
    color: #fff; font-size: 12.5px; font-weight: 600; line-height: 1;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    box-shadow: 0 2px 10px rgba(0, 0, 0, .2);
    white-space: nowrap;
    animation: gx-key-in .13s cubic-bezier(.2, .9, .3, 1.2);
  }
  .k.wide { padding: 0 12px; }
  .k.fade { animation: gx-key-out .42s ease forwards; }
  .k.hot { background: rgba(55, 138, 221, .74); border-color: rgba(255, 255, 255, .4); }

  /* 输入回显：左侧一个小标签，右侧是写入的内容 */
  .k.ins {
    justify-content: flex-start;
    max-width: min(62vw, 420px);
    background: rgba(55, 138, 221, .6);
    border-color: rgba(255, 255, 255, .32);
    font-weight: 500;
  }
  .k.ins .pre {
    flex: none;
    margin-right: 8px;
    font-size: 10.5px;
    font-weight: 500;
    letter-spacing: .04em;
    opacity: .72;
  }
  .k.ins .txt {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }
  @keyframes gx-key-in {
    from { opacity: 0; transform: translateY(7px) scale(.9); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes gx-key-out {
    from { opacity: 1; transform: translateY(0) scale(1); }
    to   { opacity: 0; transform: translateY(-6px) scale(.94); }
  }

  /* ---------- 点击标签 ---------- */
  .tip {
    position: fixed;
    padding: 4px 9px; border-radius: 7px;
    background: rgba(16, 20, 28, .66);
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
    border: 1px solid rgba(255, 255, 255, .18);
    color: #fff; font-size: 11.5px; font-weight: 500;
    box-shadow: 0 2px 10px rgba(0, 0, 0, .2);
    white-space: nowrap;
    transform: translate(-50%, -100%);
    animation: gx-tip 1.05s ease forwards;
  }
  .tip .tag {
    display: inline-block; margin-right: 5px; padding: 0 5px;
    border-radius: 4px; font-size: 10.5px;
    background: rgba(255, 255, 255, .2);
    font-family: ui-monospace, Menlo, Consolas, monospace;
  }
  @keyframes gx-tip {
    0%   { opacity: 0; transform: translate(-50%, calc(-100% + 6px)) scale(.94); }
    14%  { opacity: 1; transform: translate(-50%, -100%) scale(1); }
    72%  { opacity: 1; transform: translate(-50%, -100%) scale(1); }
    100% { opacity: 0; transform: translate(-50%, calc(-100% - 12px)) scale(1); }
  }
  `;

  /* ------------------------------------------------------------------ *
   * 构建
   * ------------------------------------------------------------------ */

  function supported() {
    return typeof document !== 'undefined'
      && document.documentElement
      && window.innerWidth >= MIN_W
      && window.innerHeight >= MIN_H;
  }

  function build() {
    if (built) return;
    if (!supported()) return;

    // 清掉可能残留的旧节点（扩展重载后同一页面可能留下）
    document.getElementById('gx-hud-host')?.remove();

    host = document.createElement('div');
    host.id = 'gx-hud-host';
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial;pointer-events:none;position:static;';
    root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = HUD_CSS;
    root.appendChild(style);

    const layer = document.createElement('div');
    layer.className = 'layer';

    canvas = document.createElement('canvas');
    canvas.className = 'gx-canvas';
    layer.appendChild(canvas);

    keyBoxEl = document.createElement('div');
    keyBoxEl.className = 'keys';
    layer.appendChild(keyBoxEl);

    badgeEl = document.createElement('div');
    badgeEl.className = 'badge';
    badgeEl.innerHTML = '<span class="dot"></span><span class="label">录制中</span><span class="n">0 步</span>';
    layer.appendChild(badgeEl);

    root.appendChild(layer);

    document.documentElement.appendChild(host);

    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize, { passive: true });
    built = true;
  }

  function resize() {
    if (!canvas || !ctx) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ------------------------------------------------------------------ *
   * 绘制循环
   * ------------------------------------------------------------------ */

  /**
   * 按时间把路径点逐个喂进轨迹，让重放的鼠标移动看起来和录制时一致。
   * 返回是否还在播放。
   */
  function advanceAnim(now) {
    if (!anim) return false;
    const { pts, ms, t0 } = anim;
    const t = Math.min(1, (now - t0) / Math.max(1, ms));
    const target = Math.min(pts.length - 1, Math.floor(t * pts.length));

    lastMoveAt = now;
    while (anim.i <= target) {
      const p = pts[anim.i];
      pointer = { x: p.x, y: p.y };
      trail.push({ x: p.x, y: p.y, t: now });
      if (anim.drag && pressPoint) {
        dragPath = { x0: pressPoint.x, y0: pressPoint.y, x1: p.x, y1: p.y, t: now };
      }
      anim.i++;
    }
    if (trail.length > 64) trail.splice(0, trail.length - 64);

    if (t >= 1) {
      if (anim.drag) {
        pressed = false;
        dragPath = null;
      }
      anim = null;
      return false;
    }
    return true;
  }

  function hasWork(now) {
    if (anim) return true;
    if (pressed) return true;
    if (trail.some((p) => now - p.t < TRAIL_LIFE)) return true;
    if (ripples.some((r) => now - r.t < RIPPLE_LIFE)) return true;
    if (dragPath && now - dragPath.t < DRAG_LIFE) return true;
    // 指针停住后还要再画一会儿，等拖尾彻底淡掉；之后再停掉重绘，
    // 画面就留在最后一帧 —— 否则录制期间会一直以 60fps 空转
    if (pointer && now - lastMoveAt < TRAIL_LIFE) return true;
    return false;
  }

  function tick() {
    raf = 0;
    if (!enabled || !ctx) return;

    const now = performance.now();
    advanceAnim(now);

    const w = window.innerWidth;
    const h = window.innerHeight;

    ctx.clearRect(0, 0, w, h);

    // ---- 拖尾 ----
    trail = trail.filter((p) => now - p.t < TRAIL_LIFE);
    if (trail.length > 1) {
      for (let i = 1; i < trail.length; i++) {
        const a = trail[i - 1];
        const b = trail[i];
        const age = (now - b.t) / TRAIL_LIFE;
        if (age >= 1) continue;
        ctx.strokeStyle = `rgba(55, 138, 221, ${(1 - age) * 0.42})`;
        ctx.lineWidth = Math.max(1, 3.4 * (1 - age));
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // ---- 拖拽连线 ----
    if (dragPath && now - dragPath.t < DRAG_LIFE) {
      const age = (now - dragPath.t) / DRAG_LIFE;
      ctx.save();
      ctx.setLineDash([5, 5]);
      ctx.lineDashOffset = -((now - dragPath.t) / 26) % 10;
      ctx.strokeStyle = `rgba(239, 159, 39, ${(1 - age) * 0.9})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(dragPath.x0, dragPath.y0);
      ctx.lineTo(dragPath.x1, dragPath.y1);
      ctx.stroke();
      ctx.restore();
    }

    // ---- 点击涟漪 ----
    ripples = ripples.filter((r) => now - r.t < RIPPLE_LIFE);
    for (const r of ripples) {
      const t = (now - r.t) / RIPPLE_LIFE;
      const c = BTN_COLOR[r.button] || BTN_COLOR[0];
      const radius = 7 + t * 33;

      ctx.beginPath();
      ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${(1 - t) * 0.85})`;
      ctx.lineWidth = 2.4 * (1 - t) + 0.6;
      ctx.stroke();

      if (t < 0.34) {
        const a = 1 - t / 0.34;
        ctx.beginPath();
        ctx.arc(r.x, r.y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a * 0.95})`;
        ctx.fill();
      }
    }

    // ---- 指针光环 ----
    if (pointer) {
      ctx.beginPath();
      ctx.arc(pointer.x, pointer.y, pressed ? 11 : 7.5, 0, Math.PI * 2);
      ctx.strokeStyle = pressed ? 'rgba(239, 159, 39, .95)' : 'rgba(55, 138, 221, .78)';
      ctx.lineWidth = pressed ? 2.4 : 1.7;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(pointer.x, pointer.y, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = pressed ? 'rgba(239, 159, 39, .95)' : 'rgba(55, 138, 221, .8)';
      ctx.fill();
    }

    if (built && hasWork(now)) raf = requestAnimationFrame(tick);
  }

  function kick() {
    if (!raf && enabled) raf = requestAnimationFrame(tick);
  }

  /* ------------------------------------------------------------------ *
   * 提示元素
   * ------------------------------------------------------------------ */

  function addTip(x, y, tag, text) {
    if (!root) return;
    try {
      const el = document.createElement('div');
      el.className = 'tip';
      el.style.left = `${Math.round(x)}px`;
      el.style.top = `${Math.round(y - 14)}px`;
      const t = text ? `<span class="tag">${escapeHtml(tag)}</span>${escapeHtml(text)}` : escapeHtml(tag);
      el.innerHTML = t;
      el.addEventListener('animationend', () => el.remove(), { once: true });
      root.appendChild(el);
    } catch {
      /* 忽略 */
    }
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ------------------------------------------------------------------ *
   * 按键提示
   * ------------------------------------------------------------------ */

  const MOD_LABEL = { Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Win' };
  const MOD_ORDER = ['Control', 'Alt', 'Shift', 'Meta'];

  function pill(text, extraClass = '') {
    const el = document.createElement('span');
    el.className = `k ${extraClass}`.trim();
    el.textContent = text;
    if (text.length > 2) el.classList.add('wide');
    return el;
  }

  function isHeldModPill(el) {
    for (const m of MOD_ORDER) {
      if (MOD_LABEL[m] === el.textContent && heldMods.get(m)?.held) return true;
    }
    return false;
  }

  function dropPill(slot) {
    if (!slot) return;
    slot.el.classList.add('fade');
    clearTimeout(slot.timer);
    const dead = slot.el;
    setTimeout(() => dead.remove(), 420);
    return null;
  }

  /**
   * 组合键与功能键的胶囊。
   *
   * modNames 显式传入要展示的修饰键：录制时来自 heldMods（真按住的），
   * 回放时来自 step.key 里的 ctrl/alt/meta 标志（合成出来的）。
   * 合成出来的修饰键没有对应的 keyup，必须跟着主键一起淡出，
   * 否则会在屏幕底部越堆越多。
   */
  function showKeyPill(text, combo, modNames) {
    if (!keyBoxEl) return;
    try {
      const mods = modNames || MOD_ORDER.filter((m) => heldMods.get(m)?.held);
      const parts = [];

      for (const m of mods) {
        const p = pill(MOD_LABEL[m], 'hot');
        parts.push(p);
        keyBoxEl.appendChild(p);
      }
      if (text) {
        const p = pill(text, combo ? 'hot' : '');
        parts.push(p);
        keyBoxEl.appendChild(p);
      }
      if (!parts.length) return;

      charPill = dropPill(charPill);

      // 只有真正被按住的修饰键才常亮，其余全部一起淡出
      setTimeout(() => {
        for (const p of parts) {
          if (!p.isConnected || isHeldModPill(p)) continue;
          p.classList.add('fade');
          setTimeout(() => p.remove(), 420);
        }
      }, !combo && text ? 700 : 1100);
    } catch {
      /* 忽略 */
    }
  }

  /** 输入回显：打入一串文本时显示完整内容，比逐字符闪一下更贴合语义 */
  function showInput(text, label) {
    if (!keyBoxEl) return;
    try {
      const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
      const shown = raw.length > 32 ? `${raw.slice(0, 32)}…` : raw || '（清空）';

      inputPill = dropPill(inputPill);

      const el = document.createElement('span');
      el.className = 'k ins wide';
      const pre = document.createElement('span');
      pre.className = 'pre';
      pre.textContent = label || '输入';
      const body = document.createElement('span');
      body.className = 'txt';
      body.textContent = shown;
      el.appendChild(pre);
      el.appendChild(body);
      keyBoxEl.appendChild(el);

      const timer = setTimeout(() => {
        el.classList.add('fade');
        setTimeout(() => el.remove(), 420);
        if (inputPill?.el === el) inputPill = null;
      }, 1400);
      inputPill = { el, timer };
    } catch {
      /* 忽略 */
    }
  }

  function showChar(ch) {
    if (!keyBoxEl) return;
    try {
      charPill = dropPill(charPill);
      const el = pill(ch, 'hot');
      keyBoxEl.appendChild(el);
      const timer = setTimeout(() => {
        el.classList.add('fade');
        setTimeout(() => el.remove(), 420);
        if (charPill?.el === el) charPill = null;
      }, 380);
      charPill = { el, timer };
    } catch {
      /* 忽略 */
    }
  }

  /* ------------------------------------------------------------------ *
   * 对外接口
   * ------------------------------------------------------------------ */

  const api = {
    enable(label = '录制中') {
      try {
        build();
        if (!built) return false;
        enabled = true;
        trail = [];
        ripples = [];
        dragPath = null;
        pointer = null;
        pressed = false;
        heldMods.clear();
        charPill = null;
        inputPill = null;
        anim = null;
        lastMoveAt = 0;
        keyBoxEl.replaceChildren();
        // 角标只在顶层 frame 显示 —— 否则多 iframe 页面会冒出好几个
        if (window === window.top) {
          badgeEl.classList.add('on');
          badgeEl.classList.remove('idle');
          badgeEl.querySelector('.label').textContent = label;
        } else {
          badgeEl.classList.remove('on');
        }
        api.setStepCount(0);
        return true;
      } catch {
        return false;
      }
    },

    disable() {
      try {
        enabled = false;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        if (badgeEl) badgeEl.classList.remove('on');
        if (keyBoxEl) keyBoxEl.replaceChildren();
        heldMods.clear();
        charPill = null;
        inputPill = null;
        anim = null;
        trail = [];
        ripples = [];
        dragPath = null;
        pointer = null;
        if (ctx) ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      } catch {
        /* 忽略 */
      }
    },

    setStepCount(n) {
      stepCount = n;
      try {
        if (badgeEl) badgeEl.querySelector('.n').textContent = `${n} 步`;
      } catch {
        /* 忽略 */
      }
    },

    /** 鼠标移动 */
    move(x, y) {
      if (!enabled) return;
      pointer = { x, y };
      lastMoveAt = performance.now();
      trail.push({ x, y, t: performance.now() });
      // 拖尾不需要太长，防止长时间不动后一次性重绘太多段
      if (trail.length > 64) trail.splice(0, trail.length - 64);
      if (pressed && pressPoint) dragPath = { x0: pressPoint.x, y0: pressPoint.y, x1: x, y1: y, t: performance.now() };
      kick();
    },

    /** 鼠标离开视口 */
    leave() {
      pointer = null;
      kick();
    },

    down(x, y, button = 0, tag = '', text = '') {
      if (!enabled) return;
      pressed = true;
      lastMoveAt = performance.now();
      pressPoint = { x, y };
      pointer = { x, y };
      ripples.push({ x, y, t: performance.now(), button });
      addTip(x, y, tag || BTN_NAME[button] || '点击', text);
      kick();
    },

    up(x, y) {
      if (!enabled) return;
      pressed = false;
      dragPath = null;
      pointer = { x, y };
      kick();
    },

    /** 拖拽结束（用于提示「这一下没被录成点击」） */
    drag(x0, y0, x1, y1) {
      if (!enabled) return;
      dragPath = { x0, y0, x1, y1, t: performance.now() };
      addTip(x1, y1, '拖拽', '已录制');
      kick();
    },

    /**
     * 播放一段路径（重放用）。
     * CDP 引擎下鼠标移动是后台直接投递的，页面看不到中间过程，
     * 所以由后台把整条路径一次性发过来，这里按时间还原成轨迹动画。
     */
    animPath(points, ms, drag) {
      if (!enabled || !Array.isArray(points) || points.length === 0) return;
      try {
        const pts = points
          .map((p) => ({ x: Number(p?.x) || 0, y: Number(p?.y) || 0 }))
          .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
        if (!pts.length) return;

        anim = {
          pts,
          i: 0,
          t0: performance.now(),
          ms: Math.max(120, Number(ms) || 420),
          drag: !!drag,
        };
        if (drag) {
          pressed = true;
          pressPoint = { x: pts[0].x, y: pts[0].y };
        }
        advanceAnim(performance.now());
        kick();
      } catch {
        /* 忽略 */
      }
    },

    /**
     * 键盘回显：down=true 按下，false 抬起。
     * 录制时收到的是真实事件（修饰键会有自己的 keydown/keyup）；
     * 回放时只有一条 key 步骤，修饰键要从 ctrl/alt/shift/meta 标志补出来。
     */
    key(info, isDown) {
      if (!enabled) return;
      try {
        const name = String(info?.key || '');
        if (isDown) {
          if (MOD_LABEL[name]) {
            heldMods.set(name, { held: true });
            // 单独按下修饰键也立刻亮起，让用户看到按的是哪个
            showKeyPill(null, false, MOD_ORDER.filter((m) => heldMods.get(m)?.held));
          } else if (name.length === 1 && !info.ctrl && !info.alt && !info.meta) {
            showChar(name);
          } else {
            const mods = new Set(MOD_ORDER.filter((m) => heldMods.get(m)?.held));
            if (info.ctrl) mods.add('Control');
            if (info.alt) mods.add('Alt');
            if (info.shift) mods.add('Shift');
            if (info.meta) mods.add('Meta');
            const ordered = MOD_ORDER.filter((m) => mods.has(m));
            showKeyPill(prettyKey(name), ordered.length > 0, ordered);
          }
        } else if (MOD_LABEL[name]) {
          const st = heldMods.get(name);
          if (st) {
            st.held = false;
            setTimeout(() => {
              heldMods.delete(name);
              // 摘掉残留的修饰键胶囊
              if (keyBoxEl) {
                keyBoxEl.querySelectorAll('.k.hot').forEach((n) => {
                  if (n.textContent === MOD_LABEL[name]) {
                    n.classList.add('fade');
                    setTimeout(() => n.remove(), 420);
                  }
                });
              }
            }, 140);
          }
        }
      } catch {
        /* 忽略 */
      }
    },

    /** 输入回显：配合 input / select 步骤，显示写入的完整内容 */
    input(text, label) {
      if (!enabled) return;
      showInput(text, label);
    },

    /** 回放时给一个纯视觉的点击反馈 */
    replayClick(x, y, label = '回放') {
      if (!enabled) return;
      try {
        ripples.push({ x, y, t: performance.now(), button: 0 });
        addTip(x, y, label, '');
        kick();
      } catch {
        /* 忽略 */
      }
    },

    destroy() {
      api.disable();
      try {
        window.removeEventListener('resize', resize);
        host?.remove();
      } catch {
        /* 忽略 */
      }
      built = false;
      host = null;
      root = null;
      canvas = null;
      ctx = null;
      badgeEl = null;
      keyBoxEl = null;
    },

    isOn: () => enabled,
    isBuilt: () => built,
    /** 仅供测试：是否正在播放路径动画（按时间判定，不依赖 rAF 是否还在跑） */
    _animating: () => !!anim && performance.now() - anim.t0 < anim.ms,
    /** 仅供测试：当前轨迹点数 */
    _trailLen: () => trail.length,
    /** 仅供测试：当前按键区里的胶囊文本 */
    _pills: () =>
      keyBoxEl
        ? keyBoxEl.querySelectorAll('.k').map((n) => {
            if (n.textContent) return n.textContent;
            const pre = n.querySelector('.pre')?.textContent || '';
            const txt = n.querySelector('.txt')?.textContent || '';
            return [pre, txt].filter(Boolean).join(' ');
          })
        : [],
  };

  function prettyKey(k) {
    const map = {
      ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
      Enter: 'Enter', Escape: 'Esc', ' ': 'Space', Backspace: '⌫',
      Delete: 'Del', Tab: 'Tab', Home: 'Home', End: 'End',
      PageUp: 'PgUp', PageDown: 'PgDn', CapsLock: 'Caps',
    };
    return map[k] || k;
  }

  window.GX_HUD = api;
})();
