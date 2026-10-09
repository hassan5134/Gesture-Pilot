/**
 * 页面级触发引擎。
 *
 * 让脚本可以在「打开某个站点的页面」时自动跑起来，而不必依赖定时器。
 * 只注入顶层 frame（all_frames: false），否则每个 iframe 都会触发一次。
 *
 * 触发链路：
 *   页面加载 → 判断域名是否在生效范围 → 按配置等待（延迟 / 元素出现 / 标签页切到前台）
 *            → 通知 service worker → 由 service worker 做去重与冷却判断后执行
 *
 * 去重和冷却放在 service worker 侧：内容脚本每次页面加载都是新实例，
 * 记不住「刚跑过」，而这两件事恰恰需要跨页面加载的记忆。
 */
(() => {
  if (window.GX_TRIGGER) return;

  /** 本次页面加载的唯一标识，用于「同一次加载只触发一次」的判断 */
  const LOAD_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

  const SETTINGS_KEY = 'gx_scripts'; // 必须与 lib/storage.js 的 K_SCRIPTS 一致
  const DOMAIN_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------- 域名匹配 ---------------- */
  // ⚠️ 与 lib/domains.js 保持一致，改动要同步（tools/domains-harness.mjs 会对拍）

  function parsePatterns(input) {
    if (Array.isArray(input)) return input.map((s) => String(s).trim()).filter(Boolean);
    return String(input || '')
      .split(/[\s,，;；]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function matchesDomain(url, patterns) {
    const list = parsePatterns(patterns);
    if (!list.length) return true;

    let u;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    const text = String(url);

    for (const raw of list) {
      const p = raw.trim();
      if (!p) continue;

      if (DOMAIN_RE.test(p)) {
        const bare = p.replace(/\/+$/, '');
        if (text === bare || text.startsWith(bare)) return true;
        continue;
      }

      const slash = p.indexOf('/');
      const hostPart = (slash >= 0 ? p.slice(0, slash) : p).toLowerCase();
      const pathPart = slash >= 0 ? p.slice(slash) : '';
      if (!hostPart) continue;

      const withPort = hostPart.includes(':');
      const compare = withPort ? u.host.toLowerCase() : u.hostname.toLowerCase();

      let ok;
      if (hostPart.startsWith('*.')) {
        const base = hostPart.slice(2);
        ok = !!base && compare !== base && compare.endsWith(`.${base}`);
      } else {
        ok = compare === hostPart || compare.endsWith(`.${hostPart}`);
      }

      if (ok && pathPart) ok = u.pathname.startsWith(pathPart);
      if (ok) return true;
    }
    return false;
  }

  /* ---------------- 等待条件 ---------------- */

  function whenVisible() {
    if (document.visibilityState === 'visible') return Promise.resolve();
    return new Promise((resolve) => {
      const on = () => {
        if (document.visibilityState !== 'visible') return;
        document.removeEventListener('visibilitychange', on);
        resolve();
      };
      document.addEventListener('visibilitychange', on);
    });
  }

  async function waitForSelector(selector, timeoutMs) {
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    for (;;) {
      try {
        if (document.querySelector(selector)) return true;
      } catch {
        return false; // 选择器语法错误
      }
      if (Date.now() >= deadline) return false;
      await sleep(200);
    }
  }

  /* ---------------- 单个脚本的触发流程 ---------------- */

  async function arm(script) {
    const t = script.trigger || {};
    const url = location.href;

    if (t.requireVisible) await whenVisible();
    if (!matchesDomain(location.href, t.domains)) return; // 等待期间跳走了

    const delayMs = Math.max(0, Number(t.delaySec) || 0) * 1000;
    if (delayMs) await sleep(delayMs);

    const sel = String(t.readySelector || '').trim();
    if (sel) {
      const ok = await waitForSelector(sel, Math.max(1, Number(t.readyTimeoutSec) || 20) * 1000);
      if (!ok) {
        console.info(`[Gesture Pilot] 「${script.name}」未触发：等不到元素 ${sel}`);
        return;
      }
    }

    // 等待期间可能已经跳转到别的域名了
    if (!matchesDomain(location.href, t.domains)) return;

    try {
      const res = await chrome.runtime.sendMessage({
        type: 'TRIGGER_FIRE',
        scriptId: script.id,
        loadId: LOAD_ID,
        url: location.href,
      });
      if (res?.ok) console.info(`[Gesture Pilot] 「${script.name}」已按页面加载触发`);
      else if (res?.skipped) console.info(`[Gesture Pilot] 「${script.name}」跳过：${res.skipped}`);
    } catch {
      /* service worker 正在启动或扩展已卸载，忽略 */
    }
  }

  async function evaluate() {
    let scripts;
    try {
      const got = await chrome.storage.local.get(SETTINGS_KEY);
      scripts = got?.[SETTINGS_KEY];
    } catch {
      return;
    }
    if (!Array.isArray(scripts)) return;

    for (const s of scripts) {
      const t = s?.trigger;
      if (!t?.enabled) continue;
      if (!matchesDomain(location.href, t.domains)) continue;
      arm(s); // 各自独立等待，互不阻塞
    }
  }

  window.GX_TRIGGER = { evaluate, matchesDomain, parsePatterns, LOAD_ID };

  // document_idle 注入，此时 DOM 已就绪，可以直接开始
  evaluate();
})();
