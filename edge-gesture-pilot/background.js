/**
 * Service Worker：消息路由 / 录制协调 / 调度 / 回放编排。
 *
 * MV3 要点：
 *  - SW 空闲约 30 秒被回收，因此所有定时必须落在 chrome.alarms（>=1 分钟）
 *    或 offscreen 文档的 setInterval（< 1 分钟）上，绝不能用 SW 内的 setTimeout；
 *  - 运行前把所有状态写入 chrome.storage.session，SW 被回收后仍可恢复现场。
 */

import {
  listScripts, getScript, saveScript, deleteScript,
  getSettings, saveSettings,
  setRunState, getRunState,
  setRecording, getRecording,
  setFailure, getFailure,
  alarmName, scriptIdFromAlarm, newId,
  defaultTrigger, normalizeTrigger,
} from './lib/storage.js';

import {
  attach as cdpAttach, detach as cdpDetach,
  clickAt as cdpClickAt, typeText as cdpTypeText,
  pressKey as cdpPressKey, wheelAt as cdpWheelAt,
  dragPath as cdpDragPath, mouseLerp,
  sleep,
} from './lib/cdp.js';

const OFFSCREEN_PATH = 'offscreen/offscreen.html';
const WATCHDOG = 'gx:watchdog';

/** 正在运行的脚本 id，防止同一个脚本并发触发 */
const running = new Set();

/* ==================================================================
 * 生命周期
 * ================================================================== */

chrome.runtime.onInstalled.addListener(() => {
  bootstrap().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  bootstrap().catch(() => {});
});

async function bootstrap() {
  // 让内容脚本能读 storage.session —— 录制器靠它判断「页面重载后要不要自动续录」
  await chrome.storage.session
    .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
    .catch(() => {});
  // 浏览器重启后 storage.session 被清空，录制状态需要复位
  await setRecordIcon(false);
  await syncAlarms();
  await syncOffscreen().catch(() => {});
  // 看门狗：offscreen 文档意外关闭时重建
  await chrome.alarms.create(WATCHDOG, { periodInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  (async () => {
    if (alarm.name === WATCHDOG) {
      await syncOffscreen().catch(() => {});
      return;
    }
    const id = scriptIdFromAlarm(alarm.name);
    if (!id) return;
    await runScript(id, { trigger: 'schedule' });
    // daily 是一次性 alarm，跑完重排下一次（这样能自然跨过夏令时）
    const s = await getScript(id);
    if (s?.schedule?.enabled && s.schedule.mode === 'daily') {
      await scheduleOne(s);
    }
  })().catch(() => {});
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (reason === 'target_closed' || reason === 'canceled_by_user') return;
});

/* ==================================================================
 * 消息路由
 * ================================================================== */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  // 内容脚本上行：不需要响应，也不能 return true
  if (msg.type === 'GX_STEPS_APPEND') {
    appendSteps(msg, sender).catch(() => {});
    return;
  }

  // offscreen 上行
  if (msg.type === 'GX_TIMER_FIRE') {
    runScript(msg.scriptId, { trigger: 'schedule' });
    return;
  }
  if (msg.type === 'GX_TIMER_READY') {
    syncOffscreen().catch(() => {});
    return;
  }

  route(msg, sender)
    .then((r) => sendResponse(r ?? { ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

async function route(msg, sender) {
  switch (msg.type) {
    /* ---------- 录制 ---------- */
    case 'RECORD_START': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('找不到活动标签页');
      if (!/^https?:|^file:/.test(tab.url || '')) {
        throw new Error('当前页面不支持录制（浏览器内置页 / 扩展页无法注入脚本）');
      }
      const rec = await getRecording();
      if (rec?.tabId) throw new Error('已有录制在进行中，请先停止');

      // 关键：按需注入，兼容「扩展安装前就已打开」的标签页
      await ensureRecorderInjected(tab.id);
      await clearCollected();

      const settings = await getSettings();
      const reached = await broadcast(tab.id, { type: 'GX_RECORD_START', hud: settings.hud !== false });
      if (!reached) throw new Error('页面脚本已注入但没有响应，请刷新该页面后重试。');

      await setRecording({
        tabId: tab.id,
        url: tab.url,
        title: tab.title || '',
        startedAt: Date.now(),
      });
      await setRecordIcon(true);
      return { ok: true, tabId: tab.id, url: tab.url, hud: settings.hud !== false };
    }

    case 'RECORD_STOP': {
      const rec = await getRecording();
      if (!rec) throw new Error('当前没有在录制');

      await broadcast(rec.tabId, { type: 'GX_RECORD_STOP' });
      await sleep(800); // 等各 frame 把最后一批上报完

      const { steps: raw, frameIds } = await readCollected();
      const steps = mergeFrameSteps(raw);

      await setRecording(null);
      await clearCollected();
      await setRecordIcon(false);

      if (!steps.length) {
        await setFailure({
          scriptName: '录制',
          error: frameIds.length
            ? `录制通道正常（${frameIds.length} 个 frame 有响应），但这段时间内没有捕获到任何操作。` +
              `请确认操作的是当前标签页；另外纯键盘输入在输入框内会被聚合成「输入」步骤，需要离开输入框才会落库。`
            : '没有任何 frame 响应录制结束信号，页面可能已经关闭或跳走。请刷新目标页面后重试。',
          at: Date.now(),
        });
        return { ok: true, saved: null };
      }

      const now = new Date();
      const stamp = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const script = {
        id: newId(),
        name: `${trimTitle(rec.title)} · ${stamp}`,
        targetUrl: rec.url,
        steps,
        createdAt: Date.now(),
        engine: null, // null = 跟随全局设置
        schedule: { enabled: false, mode: 'interval', everySec: 1800, time: '09:30' },
        trigger: defaultTrigger(),
      };
      await saveScript(script);
      return { ok: true, saved: script };
    }

    case 'RECORD_STATE': {
      const rec = await getRecording();
      return { ok: true, recording: rec };
    }

    /* ---------- 脚本 ---------- */
    case 'SCRIPT_LIST': {
      const got = await chrome.storage.session.get(K_TRIGGER_LOG);
      // 带上自身版本：popup 用它对账，能一眼看出 service worker 是不是旧代码
      return {
        ok: true,
        version: chrome.runtime.getManifest().version,
        scripts: await listScripts(),
        settings: await getSettings(),
        run: await getRunState(),
        triggerLog: got[K_TRIGGER_LOG] || {},
      };
    }

    case 'SCRIPT_GET':
      return { ok: true, script: await getScript(msg.id) };

    case 'SCRIPT_UPDATE': {
      const next = {
        ...msg.script,
        updatedAt: Date.now(),
        trigger: normalizeTrigger(msg.script?.trigger),
      };
      await saveScript(next);
      // scheduleOne 会重建该脚本的 alarm（重置倒计时 —— 用户刚改了周期，符合预期）；
      // syncAlarms 再统一收尾：清理失效 alarm，并把秒级任务同步给 offscreen。
      // 少了 syncAlarms 这一句，改成秒级周期就不会生效。
      await scheduleOne(next);
      await syncAlarms();
      return { ok: true, script: next };
    }

    case 'SCRIPT_DELETE':
      await deleteScript(msg.id);
      await syncAlarms();
      return { ok: true };

    case 'SCRIPT_DUPLICATE': {
      const src = await getScript(msg.id);
      if (!src) throw new Error('脚本不存在');
      const copy = {
        ...structuredClone(src),
        id: newId(),
        name: `${src.name}（副本）`,
        createdAt: Date.now(),
        schedule: { ...src.schedule, enabled: false },
      };
      await saveScript(copy);
      return { ok: true, script: copy };
    }

    /* ---------- 运行 ---------- */
    case 'SCRIPT_RUN':
      runScript(msg.id, { trigger: 'manual' });
      return { ok: true, started: true };

    /* ---------- 页面加载触发 ---------- */
    case 'TRIGGER_FIRE':
      return await handleTrigger(msg, sender);

    case 'RUN_STATE':
      return { ok: true, run: await getRunState() };

    /* ---------- 设置 ---------- */
    case 'SETTINGS_SAVE': {
      const s = await saveSettings(msg.patch || {});
      await syncAlarms();
      await syncOffscreen().catch(() => {});
      return { ok: true, settings: s };
    }

    default:
      throw new Error(`未知消息类型：${msg.type}`);
  }
}

/* ==================================================================
 * 录制：步骤汇集
 *
 * 关键：录制状态绝对不能放在 service worker 的模块变量里。
 * MV3 的 SW 空闲约 30 秒就被回收，而录制期间用户正在页面上操作、
 * popup 是关闭的（不会轮询），SW 必然被回收过 —— 模块状态清零后，
 * 各 frame 上报的步骤会被静默丢弃，表现就是「录制成功但一步都没有」。
 * storage.session 是唯一可靠的存放处。
 * ================================================================== */

const K_COLLECTED = 'gx_collected';

async function readCollected() {
  const got = await chrome.storage.session.get(K_COLLECTED);
  const v = got[K_COLLECTED];
  return {
    steps: Array.isArray(v?.steps) ? v.steps : [],
    frameIds: Array.isArray(v?.frameIds) ? v.frameIds : [],
  };
}

async function clearCollected() {
  await chrome.storage.session.remove(K_COLLECTED);
}

/**
 * 累积各 frame 上报的步骤。
 * 录制器是「边录边增量上报 + 停止时全量再报一次」，两者必然重叠，
 * 所以靠步骤自带的 sid 去重。frameIds 用来区分
 * 「真的没操作」和「压根没有 frame 响应」——这决定了错误提示怎么写。
 */
async function appendSteps(msg, sender) {
  const rec = await getRecording();
  if (!rec) return; // 已经停止录制，迟到的上报直接丢

  const cur = await readCollected();
  const seen = new Set();
  for (const s of cur.steps) if (s && s.sid) seen.add(s.sid);

  const top = !!msg.top;
  const url = msg.url || sender?.url || '';
  for (const s of msg.steps || []) {
    if (!s || typeof s !== 'object') continue;
    if (s.sid && seen.has(s.sid)) continue;
    if (s.sid) seen.add(s.sid);
    // 顶层 frame 的步骤不带 frameUrl，避免 SPA 路由变化后匹配失败
    cur.steps.push(top ? { ...s } : { ...s, frameUrl: url });
  }

  const fid = sender?.frameId;
  if (msg.final && typeof fid === 'number' && !cur.frameIds.includes(fid)) {
    cur.frameIds.push(fid);
  }

  await chrome.storage.session.set({ [K_COLLECTED]: cur });
}

function mergeFrameSteps(list) {
  return list
    .slice()
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .map((s, i, arr) => {
      // 合并后按时间戳重算相邻间隔，跨 frame 的时序才对得上
      const { sid, ...rest } = s;
      return { ...rest, delay: i === 0 ? 0 : Math.max(0, (s.ts || 0) - (arr[i - 1].ts || 0)) };
    });
}

function trimTitle(t) {
  const s = String(t || '未命名页面').replace(/\s+/g, ' ').trim();
  return s.length > 24 ? `${s.slice(0, 24)}…` : s;
}

/* ==================================================================
 * 调度
 * ================================================================== */

async function syncAlarms() {
  const scripts = await listScripts();
  const settings = await getSettings();
  const wanted = new Set();

  for (const s of scripts) {
    const sch = s.schedule;
    if (!sch?.enabled) continue;
    // 秒级周期走 offscreen，不建 alarm
    if (sch.mode === 'interval' && Number(sch.everySec) < 60) continue;
    wanted.add(alarmName(s.id));
    const existing = await chrome.alarms.get(alarmName(s.id));
    if (existing) continue; // 已存在就不重建，避免重置倒计时
    await scheduleOne(s);
  }

  const all = await chrome.alarms.getAll();
  for (const a of all) {
    if (a.name.startsWith('gx:script:') && !wanted.has(a.name)) {
      await chrome.alarms.clear(a.name);
    }
  }

  await syncOffscreen(scripts, settings).catch(() => {});
}

async function scheduleOne(script) {
  const sch = script?.schedule;
  if (!sch?.enabled) {
    await chrome.alarms.clear(alarmName(script.id));
    return;
  }
  const name = alarmName(script.id);
  await chrome.alarms.clear(name);

  if (sch.mode === 'daily') {
    await chrome.alarms.create(name, { when: nextDailyTs(sch.time) });
    return;
  }

  const everySec = Math.max(30, Number(sch.everySec) || 1800);
  if (everySec < 60) return; // 交给 offscreen
  await chrome.alarms.create(name, {
    delayInMinutes: everySec / 60,
    periodInMinutes: everySec / 60,
  });
}

function nextDailyTs(timeStr) {
  const [h, m] = String(timeStr || '09:00').split(':').map((n) => parseInt(n, 10) || 0);
  const next = new Date();
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= Date.now() + 1000) next.setDate(next.getDate() + 1);
  return next.getTime();
}

/* ==================================================================
 * offscreen 秒级定时器
 * ================================================================== */

async function ensureOffscreen() {
  if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      // 说明：Chrome 的 Reason 枚举里没有「定时器」这一项，
      // WORKERS 只会产生一条较低优先级的提示，这里选它影响最小。
      reasons: ['WORKERS'],
      justification: '维持秒级精度的调度定时器，MV3 service worker 无法长时间存活。',
    });
  } catch (e) {
    const m = String(e?.message || e);
    if (!/single offscreen|already exists/i.test(m)) throw e;
  }
}

async function syncOffscreen(scriptsIn, settingsIn) {
  const scripts = scriptsIn || (await listScripts());
  const jobs = scripts
    .filter((s) => {
      const sch = s.schedule;
      return sch?.enabled && sch.mode === 'interval' && Number(sch.everySec) < 60 && Number(sch.everySec) >= 1;
    })
    .map((s) => ({ id: s.id, everySec: Number(s.schedule.everySec) }));

  if (!jobs.length) {
    if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.closeDocument().catch(() => {});
    }
    return;
  }

  await ensureOffscreen();
  try {
    await chrome.runtime.sendMessage({ type: 'GX_TIMER_SYNC', jobs });
  } catch {
    /* offscreen 正在启动，下一拍会重试 */
  }
}

/* ==================================================================
 * 页面加载触发
 *
 * 去重与冷却必须放在这里，不能放在内容脚本：
 * 内容脚本每次页面加载都是全新实例，记不住「刚刚已经跑过」，
 * 而这两件事恰恰需要跨页面加载的记忆。
 * ================================================================== */

const K_TRIGGER_LOG = 'gx_trigger_log';

async function handleTrigger(msg, sender) {
  const scriptId = msg?.scriptId;
  if (!scriptId) throw new Error('缺少 scriptId');

  const script = await getScript(scriptId);
  if (!script) return { ok: false, skipped: '脚本已不存在' };

  const t = normalizeTrigger(script.trigger);
  if (!t.enabled) return { ok: false, skipped: '触发未启用' };

  // 已经有脚本在跑就不叠加，避免两个自动化互相踩
  if (running.size > 0) return { ok: false, skipped: '已有脚本正在运行' };

  const now = Date.now();
  const got = await chrome.storage.session.get(K_TRIGGER_LOG);
  const log = got[K_TRIGGER_LOG] || {};
  const prev = log[scriptId] || {};

  if (t.once && msg.loadId && prev.loadId === msg.loadId) {
    return { ok: false, skipped: '本次页面加载已经触发过' };
  }
  if (t.cooldownSec > 0 && prev.at && now - prev.at < t.cooldownSec * 1000) {
    const left = Math.ceil((t.cooldownSec * 1000 - (now - prev.at)) / 1000);
    return { ok: false, skipped: `冷却中，还要等 ${left} 秒` };
  }

  log[scriptId] = {
    at: now,
    loadId: msg.loadId || null,
    url: msg.url || sender?.url || '',
    trigger: 'page',
  };
  await chrome.storage.session.set({ [K_TRIGGER_LOG]: log });

  runScript(scriptId, { trigger: 'page' });
  return { ok: true, started: true };
}

/* ==================================================================
 * 回放编排
 * ================================================================== */

class StepError extends Error {
  constructor(index, step, detail) {
    super(`第 ${index + 1} 步失败：${detail}`);
    this.index = index;
    this.step = step;
  }
}

async function runScript(id, ctx = {}) {
  if (running.has(id)) return { ok: false, error: '该脚本正在运行中' };
  running.add(id);

  const startedAt = Date.now();
  let tabId = null;
  let scriptName = '';
  let engine = 'synthetic';

  try {
    // 新一轮开始，清掉上一次的失败留证
    await setFailure(null);

    const script = await getScript(id);
    if (!script) throw new Error('脚本不存在或已被删除');
    if (!script.steps?.length) throw new Error('脚本没有任何步骤');

    scriptName = script.name;
    const settings = await getSettings();
    engine = script.engine || settings.engine;
    const total = script.steps.length;

    const base = { scriptId: id, scriptName, startedAt, trigger: ctx.trigger || 'manual', engine };

    const tab = await ensureTargetTab(script);
    tabId = tab.id;

    await setRunState({ ...base, status: 'running', index: 0, total, tabId, phase: '准备页面' });

    const frameMap = await injectFrames(tabId);
    if (engine === 'cdp') await cdpAttach(tabId);

    // 回放时也在页面上给出实时反馈
    const hudOn = settings.hud !== false;
    if (hudOn) await broadcast(tabId, { type: 'GX_HUD_ON', label: '回放中' });

    const cursor = { last: null };

    try {
      for (let i = 0; i < script.steps.length; i++) {
        const step = script.steps[i];

        const gap = computeGap(step, i, settings);
        if (gap > 0) await sleep(gap);

        await setRunState({ ...base, status: 'running', index: i, total, tabId, phase: describeStep(step) });
        if (hudOn) broadcast(tabId, { type: 'GX_HUD_TICK', count: i + 1 });

        const frameId = resolveFrameId(frameMap, step);
        const frameIsTop = !!frameMap.find((f) => f.frameId === frameId)?.top;
        let res = await dispatchStep(tabId, frameId, step, settings, engine, cursor, frameIsTop);

        const retries = Math.max(0, Number(settings.retry) || 0);
        for (let a = 0; !res.ok && a < retries; a++) {
          await sleep(800);
          res = await dispatchStep(tabId, frameId, step, settings, engine, cursor, frameIsTop);
        }

        if (!res.ok) throw new StepError(i, step, res.error || '未知错误');
      }
    } finally {
      if (hudOn) await broadcast(tabId, { type: 'GX_HUD_OFF' });
      if (engine === 'cdp') await cdpDetach(tabId);
    }

    const finishedAt = Date.now();
    await setRunState({
      ...base, status: 'success', index: total, total, tabId,
      finishedAt, duration: finishedAt - startedAt, phase: '完成',
    });
    await clearBadge();
    return { ok: true };

  } catch (e) {
    const run = await getRunState();
    const failure = {
      scriptId: id,
      scriptName,
      error: String(e?.message || e),
      stepIndex: e instanceof StepError ? e.index : null,
      step: e instanceof StepError ? e.step : null,
      at: Date.now(),
      engine,
    };
    await setFailure(failure);
    await setRunState({
      ...(run || { scriptId: id, scriptName, startedAt }),
      status: 'failed',
      finishedAt: Date.now(),
      duration: Date.now() - startedAt,
      phase: '失败',
    });

    await captureFailure(tabId).catch(() => {});
    await notify('手势助手 · 执行失败', `${scriptName}：${failure.error}`).catch(() => {});
    await setBadgeFailure();
    return { ok: false, error: failure.error };

  } finally {
    running.delete(id);
  }
}

function computeGap(step, index, settings) {
  if (index === 0) return 300;
  const speed = Math.max(0.25, Number(settings.speed) || 1);
  const raw = (Number(step.delay) || 0) / speed;
  const min = Number(settings.minGapMs) || 0;
  const max = Number(settings.maxGapMs) || 15000;
  const jitter = Math.random() * (Number(settings.jitterMs) || 0);
  return Math.min(max, Math.max(min, raw)) + jitter;
}

function describeStep(step) {
  const map = {
    click: '点击', drag: '拖拽', input: '输入',
    select: '选择', key: '按键', wheel: '滚动', wait: '等待',
  };
  if (step.type === 'drag') return `拖拽 · ${(step.path || []).length} 个路径点`;
  const detail = step.type === 'key' ? step.key?.key || '' : truncate(step.value || '');
  return `${map[step.type] || step.type} · ${detail}`;
}

function truncate(s, n = 18) {
  const t = String(s).replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/* ---------------- 目标标签页 ---------------- */

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

async function ensureTargetTab(script) {
  const url = script.targetUrl;

  if (url && /^https?:|^file:/.test(url)) {
    const tabs = await chrome.tabs.query({});
    const want = new URL(url);

    // 优先复用已打开的同源标签页，保留其登录态与页面状态
    const candidate = tabs.find(
      (t) => t.id != null && t.url && sameOrigin(t.url, url) && !/^chrome(-extension)?:/.test(t.url),
    );

    if (candidate) {
      await chrome.tabs.update(candidate.id, { active: true });
      await chrome.windows.update(candidate.windowId, { focused: true }).catch(() => {});
      const cur = new URL(candidate.url);
      if (cur.pathname !== want.pathname || cur.search !== want.search) {
        await chrome.tabs.update(candidate.id, { url });
        await waitForComplete(candidate.id);
      }
      return await chrome.tabs.get(candidate.id);
    }

    const created = await chrome.tabs.create({ url, active: true });
    await waitForComplete(created.id);
    return await chrome.tabs.get(created.id);
  }

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active?.id) throw new Error('找不到可用的目标标签页');
  return active;
}

function waitForComplete(tabId, timeout = 30000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const timer = setTimeout(finish, timeout);

    chrome.tabs.get(tabId).then((t) => {
      if (t?.status === 'complete') finish();
    }).catch(finish);

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

/* ---------------- 注入与 frame 映射 ---------------- */

async function injectIntoFrames(tabId, files) {
  let frames = [];
  try {
    frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  } catch {
    frames = [];
  }
  if (!frames.length) frames = [{ frameId: 0, url: '' }];

  const map = [];
  for (const f of frames) {
    // 只注入 http/https/file，浏览器内置页与扩展页会被拒绝
    if (f.frameId !== 0 && !/^https?:|^file:/.test(f.url || '')) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [f.frameId] },
        files,
      });
      map.push({ frameId: f.frameId, url: f.url || '', top: f.frameId === 0 });
    } catch {
      /* 该 frame 不可注入，跳过 */
    }
  }
  return map;
}

/**
 * 静态 content_scripts 只对「扩展安装/更新之后加载的页面」生效。
 * 对安装前就已经开着的标签页必须按需注入，否则录制永远收不到事件 ——
 * 这是新手最容易踩的坑：装完扩展直接在已打开的页面上点录制，什么都不发生。
 * selector.js / recorder.js 内部都有幂等守卫，重复注入是安全的。
 */
async function ensureRecorderInjected(tabId) {
  const map = await injectIntoFrames(tabId, [
    'content/selector.js',
    'content/hud.js',
    'content/recorder.js',
  ]);
  if (!map.length) {
    throw new Error('无法向该页面注入脚本。可能是浏览器内置页 / 扩展页，或 file:// 未开启「允许访问文件 URL」。');
  }
  return map.length;
}

/**
 * 向标签页内所有 frame 广播消息。
 * chrome.tabs.sendMessage 省略 frameId 时会发给全部 frame，但只返回其中一个的响应，
 * 这里不关心返回值；如果一个接收方都没有会 reject，吞掉即可。
 */
async function broadcast(tabId, msg) {
  try {
    await chrome.tabs.sendMessage(tabId, msg);
    return true;
  } catch {
    return false;
  }
}

async function injectFrames(tabId) {
  const map = await injectIntoFrames(tabId, [
    'content/selector.js',
    'content/hud.js',
    'content/replayer.js',
  ]);
  if (!map.length) {
    throw new Error('无法向页面注入脚本 —— 可能是浏览器内置页、扩展页，或 file:// 未开启「允许访问文件网址」');
  }
  return map;
}

function resolveFrameId(map, step) {
  if (step.frameUrl) {
    const exact = map.find((m) => m.url === step.frameUrl);
    if (exact) return exact.frameId;
    const loose = map.find((m) => m.url && sameOrigin(m.url, step.frameUrl));
    if (loose) return loose.frameId;
  }
  return map.find((m) => m.top)?.frameId ?? 0;
}

function sendToFrame(tabId, frameId, msg, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish({ ok: false, error: '执行超时（页面可能已卡死或无响应）' }), timeoutMs);

    try {
      chrome.tabs.sendMessage(tabId, msg, { frameId }, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) finish({ ok: false, error: err.message || '无法与页面通信' });
        else finish(resp ?? { ok: false, error: '页面没有返回结果' });
      });
    } catch (e) {
      finish({ ok: false, error: String(e?.message || e) });
    }
  });
}

/* ---------------- 步骤投递 ---------------- */

function dispatchStep(tabId, frameId, step, settings, engine, cursor, frameIsTop) {
  return engine === 'cdp'
    ? dispatchStepCdp(tabId, frameId, step, settings, cursor, frameIsTop)
    : dispatchStepSynthetic(tabId, frameId, step, settings);
}

function dispatchStepSynthetic(tabId, frameId, step, settings) {
  const budget = (Number(settings.stepTimeout) || 8000) + 5000;
  return sendToFrame(tabId, frameId, { type: 'GX_RUN_STEP', step, settings }, budget);
}

/* ---------------- 提示层回显 ---------------- */

const hudWanted = (settings) => settings?.hud !== false;

/** 提示层是锦上添花：不 await、失败也不管，绝不能拖慢回放 */
function hudEcho(tabId, frameId, payload) {
  if (typeof frameId !== 'number') return;
  sendToFrame(tabId, frameId, payload, 1500);
}

function keyInfo(k) {
  return {
    key: k?.key,
    code: k?.code,
    ctrl: !!k?.ctrl,
    alt: !!k?.alt,
    shift: !!k?.shift,
    meta: !!k?.meta,
  };
}

/** 把拖拽步骤里「相对起点的偏移」换算成绝对坐标 */
function dragPoints(step, start) {
  const offsets = Array.isArray(step.path) && step.path.length ? step.path : [{ x: 0, y: 0 }];
  return offsets.map((o) => ({
    x: start.x + Math.round(Number(o?.x) || 0),
    y: start.y + Math.round(Number(o?.y) || 0),
  }));
}

async function dispatchStepCdp(tabId, frameId, step, settings, cursor, frameIsTop) {
  const showHud = hudWanted(settings);

  if (step.type === 'wait') {
    await sleep(Number(step.value) || 1000);
    return { ok: true };
  }

  // 页面级快捷键（没有目标元素）：按键要回显在顶层 frame，那里才是用户在看的地方
  if (step.type === 'key' && !step.locator) {
    if (showHud) hudEcho(tabId, 0, { type: 'GX_HUD_KEY', info: keyInfo(step.key), down: true });
    await cdpPressKey(tabId, step.key);
    return { ok: true };
  }

  if (step.type === 'wheel' && !step.locator) {
    await cdpWheelAt(tabId, { x: 320, y: 320 }, step.deltaX || 0, step.deltaY || 0);
    return { ok: true };
  }

  const budget = (Number(settings.stepTimeout) || 8000) + 5000;
  const r = await sendToFrame(tabId, frameId, { type: 'GX_RESOLVE_POINT', step, timeout: settings.stepTimeout }, budget);
  if (!r?.ok) return { ok: false, error: r?.error || '坐标解析失败' };

  const point = r.point;
  const humanize = settings.humanize !== false;

  // 提示层：CDP 用的是顶层视口坐标，只有在顶层 frame 里画才对得上；
  // 子 frame 的画布是它自己的坐标系，画上去会错位，所以这里直接跳过。
  if (frameIsTop && showHud) {
    if (step.type === 'drag') {
      const all = [point, ...dragPoints(step, point)];
      hudEcho(tabId, 0, {
        type: 'GX_HUD_PATH',
        points: all,
        ms: Math.min(1400, Math.max(180, all.length * 14)),
        drag: true,
      });
    } else {
      // 连中间点一起发过去，CDP 回放的鼠标轨迹才和录制时长得一样
      const from = cursor.last || point;
      const mid = mouseLerp(from, point).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
      hudEcho(tabId, 0, { type: 'GX_HUD_PATH', points: [from, ...mid], ms: 420, drag: false });
      hudEcho(tabId, 0, { type: 'GX_HUD_CLICK', x: point.x, y: point.y, label: '回放' });
    }
  }

  if (step.type === 'wheel') {
    await cdpWheelAt(tabId, point, step.deltaX || 0, step.deltaY || 0);
    return { ok: true };
  }

  if (step.type === 'drag') {
    await cdpDragPath(tabId, [point, ...dragPoints(step, point)], 16);
    cursor.last = null; // 拖完之后指针停在终点，下一次点击重新起算轨迹
    return { ok: true };
  }

  // select 的 CDP 处理需要键盘方向键模拟，成本高收益低，退回合成事件
  // （合成路径里会自己回显）
  if (step.type === 'select') {
    return dispatchStepSynthetic(tabId, frameId, step, settings);
  }

  if (step.type === 'key') {
    await cdpClickAt(tabId, point, humanize, cursor.last);
    cursor.last = point;
    await sleep(70);
    await cdpPressKey(tabId, step.key);
    // CDP 的按键是后台直接投递的，页面收不到事件 —— 只能靠消息回显
    if (showHud) hudEcho(tabId, frameId, { type: 'GX_HUD_KEY', info: keyInfo(step.key), down: true });
    return { ok: true };
  }

  await cdpClickAt(tabId, point, humanize, cursor.last);
  cursor.last = point;

  if (step.type === 'input') {
    await sleep(90);
    await cdpTypeText(tabId, step.value ?? '', true);
    if (showHud) hudEcho(tabId, frameId, { type: 'GX_HUD_INPUT', text: step.value ?? '', label: '输入' });
  }

  return { ok: true };
}

/* ---------------- 失败留证 ---------------- */

async function captureFailure(tabId) {
  if (!tabId) return;
  const windowId = (await chrome.tabs.get(tabId).catch(() => null))?.windowId;
  if (windowId == null) return;
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 55 });
  const cur = await getFailure();
  if (cur) await setFailure({ ...cur, screenshot: dataUrl });
}

/* ==================================================================
 * 通知与徽标
 * ================================================================== */

const FALLBACK_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let iconPromise = null;
function iconUrl() {
  if (iconPromise) return iconPromise;
  iconPromise = (async () => {
    try {
      const c = new OffscreenCanvas(64, 64);
      const g = c.getContext('2d');
      g.fillStyle = '#185FA5';
      g.fillRect(0, 0, 64, 64);
      g.fillStyle = '#ffffff';
      g.font = 'bold 42px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('G', 32, 35);
      const blob = await c.convertToBlob({ type: 'image/png' });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (const b of buf) bin += String.fromCharCode(b);
      return `data:image/png;base64,${btoa(bin)}`;
    } catch {
      return FALLBACK_ICON;
    }
  })();
  return iconPromise;
}

async function notify(title, message) {
  const settings = await getSettings();
  if (!settings.notifyOnFail) return;
  const url = await iconUrl();
  await chrome.notifications.create(`gx:${Date.now()}`, {
    type: 'basic',
    title,
    message: String(message).slice(0, 200),
    iconUrl: url || FALLBACK_ICON,
    priority: 1,
  });
}

async function setBadgeFailure() {
  await chrome.action.setBadgeText({ text: '!' }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ color: '#E24B4A' }).catch(() => {});
}

async function clearBadge() {
  await chrome.action.setBadgeText({ text: '' }).catch(() => {});
}

/** 录制中把工具栏图标切成红色，关掉 popup 也能一眼看出状态 */
async function setRecordIcon(on) {
  const set = on ? 'rec' : 'icon';
  const path = {
    16: `icons/${set}16.png`,
    32: `icons/${set}32.png`,
    48: `icons/${set}48.png`,
    128: `icons/${set}128.png`,
  };
  await chrome.action.setIcon({ path }).catch(() => {});
  await chrome.action.setTitle({ title: on ? 'Gesture Pilot · 正在录制' : 'Gesture Pilot' }).catch(() => {});
}
