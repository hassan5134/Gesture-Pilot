/**
 * 元素定位与通用工具（注入到扩展隔离世界的每个 frame）。
 * 暴露在 window.GX 上，供 recorder.js / replayer.js 以及
 * service worker 通过 chrome.scripting.executeScript 复用。
 */
(() => {
  if (window.GX) return;

  const STABLE_ID = /^[A-Za-z][\w:.-]{2,}$/;
  // 形如 btn-1697123456789 / react-select-3-input / item_8f3a2b1c 这类会变的 id
  const VOLATILE_ID = /(^|[-_])(\d{4,}|[0-9a-f]{8,})([-_]|$)|\b(react|ember|ng|vue|radix|headlessui)[-_]?\d+/i;

  const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'));
  const attrEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  /* ---------------- 元素特征提取 ---------------- */

  const isStableId = (id) => !!id && STABLE_ID.test(id) && !VOLATILE_ID.test(id);

  function attrText(el, name) {
    return (el && el.getAttribute && el.getAttribute(name)) || '';
  }

  function labelOf(el) {
    if (!el) return '';
    return attrText(el, 'aria-label') || attrText(el, 'title') || attrText(el, 'alt') || '';
  }

  function visibleText(el) {
    if (!el) return '';
    const t = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
    return t.slice(0, 60);
  }

  function nthOfType(el) {
    let i = 1;
    let sib = el;
    while ((sib = sib.previousElementSibling)) {
      if (sib.tagName === el.tagName) i++;
    }
    return i;
  }

  function cssPath(el, maxDepth = 8) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (isStableId(node.id)) {
        parts.unshift(`#${cssEscape(node.id)}`);
        break;
      }
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${nthOfType(node)})`);
      if (parts.length >= maxDepth) break;
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  /* ---------------- 生成定位器 ---------------- */

  const TEST_ATTRS = ['data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-qa'];

  /**
   * 定位器分级：显式测试属性 > 稳定 id > name > 无障碍名 > placeholder > CSS 路径。
   * 坐标只作为点击落点的兜底信息，永远不作为定位依据。
   */
  function buildLocator(el) {
    if (!el || el.nodeType !== 1) return { kind: 'css', value: 'body' };
    const tag = el.tagName.toLowerCase();

    for (const a of TEST_ATTRS) {
      const v = attrText(el, a);
      if (v) return { kind: 'attr', attr: a, value: v, tag };
    }

    if (isStableId(el.id)) return { kind: 'css', value: `#${cssEscape(el.id)}` };

    const name = attrText(el, 'name');
    if (name) return { kind: 'attr', attr: 'name', value: name, tag };

    const label = labelOf(el);
    if (label) return { kind: 'aria', value: label, tag };

    const ph = attrText(el, 'placeholder');
    if (ph) return { kind: 'attr', attr: 'placeholder', value: ph, tag };

    const type = attrText(el, 'type');
    if (type && (tag === 'input' || tag === 'button')) {
      return { kind: 'css', value: `${cssPath(el)}[type="${attrEscape(type)}"]`, tag };
    }

    return { kind: 'css', value: cssPath(el), tag };
  }

  /**
   * 录制时顺手记下元素特征，供事后加固定位条件用。
   *
   * 只存 class 名和属性名（不是完整快照），体积很小，但足够在编辑界面上
   * 一键把「.green」「[href]」这类条件拼出来。没有它，用户就得自己回页面
   * 开 DevTools 抄选择器 —— 那这个功能基本没人会去用。
   */
  function elementHints(el) {
    if (!el || el.nodeType !== 1) return null;
    try {
      const cls = Array.from(el.classList || [])
        .filter((c) => c && c.length <= 40 && !VOLATILE_ID.test(c))
        .slice(0, 8);

      // 只留那些有语义、能当条件的属性；style / 随机 data 属性留着是噪声
      const KEEP = ['href', 'name', 'type', 'role', 'title', 'alt', 'placeholder', 'value', 'for', 'target'];
      const attrs = [];
      for (const a of Array.from(el.attributes || [])) {
        if (a.name === 'class' || a.name === 'style' || a.name === 'id') continue;
        if (!KEEP.includes(a.name) && !/^(data-|aria-)/.test(a.name)) continue;
        attrs.push({ name: a.name, value: String(a.value).slice(0, 60) });
        if (attrs.length >= 12) break;
      }

      return { tag: el.tagName.toLowerCase(), cls, attrs };
    } catch {
      return null;
    }
  }

  function describeLocator(loc) {
    if (!loc) return '（空定位器）';
    if (loc.kind === 'css') return loc.value;
    if (loc.kind === 'attr') return `[${loc.attr}="${loc.value}"]`;
    if (loc.kind === 'aria') return `「${loc.value}」`;
    return JSON.stringify(loc);
  }

  /* ---------------- 解析定位器 ---------------- */

  /**
   * 步骤级「额外匹配条件」。
   *
   * 录制出来的定位器是自动挑的，遇到同名按钮、列表里结构一样的行就容易点错。
   * 这里允许人工补一条 CSS 选择器来加固，例如：
   *   .green         class 里有 green
   *   [href]         必须有 href 属性
   *   a.green[href^="/detail"]   几个条件叠加
   *   :not(.disabled)
   *
   * 校验不通过就当作「这个候选不是目标」，继续等 —— 于是有了重试的机会，
   * 而不是一上来就点到错的元素。
   */
  function matchesExtra(el, extra) {
    const s = String(extra || '').trim();
    if (!s) return true;
    if (!el || el.nodeType !== 1) return false;
    try {
      return el.matches(s);
    } catch {
      return false;
    }
  }

  /** 选择器语法是否合法（写错了要让用户立刻看到，而不是表现成「找不到元素」） */
  function isValidSelector(s) {
    const t = String(s || '').trim();
    if (!t) return true;
    try {
      document.createDocumentFragment().querySelector(t);
      return true;
    } catch {
      return false;
    }
  }

  /** 在候选里挑第一个满足额外条件的 */
  function pick(scope, selector, extra) {
    let list;
    try {
      list = scope.querySelectorAll(selector);
    } catch {
      return null;
    }
    for (const el of list) {
      if (matchesExtra(el, extra)) return el;
    }
    return null;
  }

  function resolve(root, loc, extra) {
    if (!loc) return null;
    const scope = root || document;
    const ok = (el) => el && matchesExtra(el, extra);

    try {
      if (loc.kind === 'css') {
        // 有条件时必须逐个筛，querySelector 只给第一个，可能正好是不该点的那个
        if (extra) return pick(scope, loc.value, extra);
        return scope.querySelector(loc.value);
      }

      if (loc.kind === 'attr') {
        const sel = `${loc.tag || '*'}${loc.attr ? `[${loc.attr}="${attrEscape(loc.value)}"]` : ''}`;
        const hit = extra ? pick(scope, sel, extra) : scope.querySelector(sel);
        if (hit) return hit;
        // 属性值被运行时改写时，退化为「属性存在 + 文本相近」
        const loose = Array.from(scope.querySelectorAll(`${loc.tag || '*'}[${loc.attr}]`));
        return loose.find((el) => ok(el) && visibleText(el).includes(loc.value)) || null;
      }

      if (loc.kind === 'aria') {
        const sel = loc.tag || 'button,a,[role="button"],input,textarea,select';
        const cands = Array.from(scope.querySelectorAll(sel)).filter(ok);
        return (
          cands.find((el) => labelOf(el) === loc.value) ||
          cands.find((el) => visibleText(el) === loc.value) ||
          cands.find((el) => labelOf(el).includes(loc.value)) ||
          cands.find((el) => visibleText(el).includes(loc.value)) ||
          null
        );
      }
    } catch {
      return null;
    }
    return null;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(loc, timeout = 8000, root, extra) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const el = resolve(root, loc, extra);
      if (el && isVisible(el)) return el;
      if (Date.now() >= deadline) return el || null; // 存在但不可见时也返回，交给调用方判断
      await sleep(120);
    }
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  }

  /* ---------------- 坐标换算 ---------------- */

  /**
   * 把元素内相对位置换算成「顶层视口」坐标 —— CDP 的 Input.dispatchMouseEvent
   * 使用的正是顶层视口坐标系，所以需要逐层叠加 iframe 偏移。
   * 跨域 iframe 无法读取 frameElement，返回 null 表示无法换算。
   */
  function clientPointAt(el, rel) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    const rx = rel && Number.isFinite(rel.x) ? rel.x : 0.5;
    const ry = rel && Number.isFinite(rel.y) ? rel.y : 0.5;

    let x = r.left + r.width * rx;
    let y = r.top + r.height * ry;

    let w = window;
    let guard = 0;
    while (w !== w.top && guard++ < 20) {
      let fe;
      try {
        fe = w.frameElement;
      } catch {
        return null; // 跨域，坐标不可换算
      }
      if (!fe) return null;
      const fr = fe.getBoundingClientRect();
      x += fr.left;
      y += fr.top;
      w = w.parent;
    }
    return { x: Math.round(x), y: Math.round(y), w: r.width, h: r.height };
  }

  /**
   * 只在本 frame 的坐标系里算点击落点（不做 iframe 偏移叠加）。
   * 提示层画在自己 frame 的画布上，用的是这个坐标系；
   * CDP 的 Input.dispatchMouseEvent 用的才是 clientPointAt 的顶层坐标系。
   */
  function localPointAt(el, rel) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    const rx = rel && Number.isFinite(rel.x) ? rel.x : 0.5;
    const ry = rel && Number.isFinite(rel.y) ? rel.y : 0.5;
    return { x: Math.round(r.left + r.width * rx), y: Math.round(r.top + r.height * ry) };
  }

  /* ---------------- 写入受控组件 ---------------- */

  function readValue(el) {
    if (!el) return '';
    if (el.isContentEditable) return el.innerText || el.textContent || '';
    if (el.tagName === 'SELECT' && el.multiple) {
      return Array.from(el.selectedOptions).map((o) => o.value).join(',');
    }
    return el.value ?? '';
  }

  /**
   * React / Vue 的受控组件会劫持原型上的 value setter，
   * 直接 el.value = x 不会触发 onChange。必须绕过原型调用原生 setter。
   */
  function setNativeValue(el, value) {
    const v = String(value ?? '');
    try {
      el.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }

    if (el.isContentEditable) {
      el.textContent = v;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: v }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      return;
    }

    if (el.tagName === 'SELECT') {
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      return;
    }

    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, v);
    else el.value = v;

    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: v, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  /* ---------------- 鼠标轨迹自然化 ---------------- */

  /** 贝塞尔风格的曲线路径 + 生理抖动，避免「直线等速瞬移」这种明显的程序特征 */
  function mousePath(from, to) {
    const x0 = from?.x ?? to.x;
    const y0 = from?.y ?? to.y;
    const dx = to.x - x0;
    const dy = to.y - y0;
    const dist = Math.hypot(dx, dy) || 1;
    const steps = Math.max(4, Math.min(36, Math.round(dist / 22)));
    const bow = (Math.random() - 0.5) * Math.min(70, dist * 0.3);
    const nx = -dy / dist;
    const ny = dx / dist;

    const pts = [];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const off = Math.sin(t * Math.PI) * bow;
      pts.push({
        x: x0 + dx * e + nx * off + (Math.random() - 0.5) * 2.5,
        y: y0 + dy * e + ny * off + (Math.random() - 0.5) * 2.5,
        dt: 5 + Math.random() * 18,
      });
    }
    return pts;
  }

  window.GX = {
    buildLocator,
    describeLocator,
    resolve,
    waitFor,
    matchesExtra,
    isValidSelector,
    elementHints,
    isVisible,
    clientPointAt,
    localPointAt,
    readValue,
    setNativeValue,
    mousePath,
    visibleText,
    labelOf,
    cssPath,
    sleep,
  };
})();
