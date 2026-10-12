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
  defaultTrigger, defaultSchedule, normalizeTrigger, normalizeScript,
  defaultWait, countSteps,
} from './lib/storage.js';

import { matchesDomain } from './lib/domains.js';

import {
  makeLogger, configure as configureLog, flushNow,
  readLogs, clearLogs, logStats,
} from './lib/logger.js';

import { runUserCode, releaseCdp, releaseAllCdp } from './lib/jsruntime.js';

import {
  getStatus as driveStatus, setClientId as driveSetClient,
  connect as driveConnect, disconnect as driveDisconnect,
  upload as driveUpload, list as driveList,
  download as driveDownload, prune as drivePrune,
} from './lib/drive.js';

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
  // 日志开关在 SW 重启后是空的，必须重新读一次设置
  const settings = await getSettings();
  configureLog({ debug: settings.debug, logLimit: settings.logLimit });
  // 浏览器重启后 storage.session 被清空，录制状态需要复位
  await setRecordIcon(false);
  // 上次残留的调试连接（SW 被回收时来不及断开）在这里清掉，
  // 否则页面顶部的「正在调试」提示条会一直挂着
  await releaseAllCdp().catch(() => {});
  await syncAlarms();
  await syncOffscreen().catch(() => {});
  await syncContextMenus().catch(() => {});
  // 记录导航来源：区分「用户刷新」和「页面自己跳转」，触发冷却据此放行或拦截
  await chrome.storage.session.remove(K_NAV).catch(() => {});
  // 看门狗：offscreen 文档意外关闭时重建
  await chrome.alarms.create(WATCHDOG, { periodInMinutes: 1 });
}

/* ---------------- 右键菜单 ---------------- */

const MENU_RECORD = 'gx:record';
const MENU_RUN_ROOT = 'gx:run';
const MENU_RUN_PREFIX = 'gx:run:';
const MENU_MAX_SCRIPTS = 15;

/** 脚本增删改后要重建菜单 —— chrome.contextMenus 不支持动态更新子项 */
async function syncContextMenus() {
  if (!chrome.contextMenus) return;
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_RECORD,
    title: 'Gesture Pilot：录制 / 停止本页',
    contexts: ['page'],
  });

  const scripts = (await listScripts()).filter((s) => s.enabled !== false);
  if (!scripts.length) return;

  chrome.contextMenus.create({
    id: MENU_RUN_ROOT,
    title: 'Gesture Pilot：运行脚本',
    contexts: ['page'],
  });
  // 菜单项太多会很难用，超出部分引导用户去 popup
  for (const s of scripts.slice(0, MENU_MAX_SCRIPTS)) {
    chrome.contextMenus.create({
      id: `${MENU_RUN_PREFIX}${s.id}`,
      parentId: MENU_RUN_ROOT,
      title: trimMenuTitle(s.name),
      contexts: ['page'],
    });
  }
  if (scripts.length > MENU_MAX_SCRIPTS) {
    chrome.contextMenus.create({
      id: `${MENU_RUN_ROOT}:more`,
      parentId: MENU_RUN_ROOT,
      title: `…还有 ${scripts.length - MENU_MAX_SCRIPTS} 个，请在扩展面板里运行`,
      enabled: false,
      contexts: ['page'],
    });
  }
}

function trimMenuTitle(name) {
  const s = String(name || '未命名').replace(/\s+/g, ' ').trim();
  return s.length > 34 ? `${s.slice(0, 34)}…` : s;
}

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId || '');
  (async () => {
    if (id === MENU_RECORD) {
      const r = await toggleRecording();
      if (!r?.ok && r?.error) await notify('手势助手 · 录制', r.error).catch(() => {});
      return;
    }
    if (id.startsWith(MENU_RUN_PREFIX)) {
      const r = await runScript(id.slice(MENU_RUN_PREFIX.length), { trigger: 'manual' });
      if (!r?.ok && r?.error) await notify('手势助手 · 运行', r.error).catch(() => {});
    }
  })().catch(() => {});
});

/* ---------------- 键盘快捷键 ---------------- */

chrome.commands?.onCommand.addListener((command) => {
  (async () => {
    if (command === 'toggle-record') {
      const r = await toggleRecording();
      if (!r?.ok && r?.error) await notify('手势助手 · 录制', r.error).catch(() => {});
      return;
    }
    if (command === 'run-current') {
      const r = await runFirstMatching();
      if (!r?.ok) {
        await notify('手势助手 · 运行', r?.skipped || r?.error || '没有可运行的脚本').catch(() => {});
      }
    }
  })().catch(() => {});
});

/**
 * 快捷键「运行当前页面脚本」：优先挑页面加载触发规则命中的那个，
 * 其次挑 targetUrl 与当前页面同源的。都不匹配就明确报出来，不瞎跑。
 */
async function runFirstMatching() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  const scripts = (await listScripts()).filter((s) => s.enabled !== false);
  if (!scripts.length) return { ok: false, skipped: '没有启用的脚本' };

  const byTrigger = scripts.find((s) => s.trigger?.enabled && matchesDomain(url, s.trigger.domains));
  const byScheduleDomain = scripts.find(
    (s) => s.schedule?.domains?.length && matchesDomain(url, s.schedule.domains),
  );
  const byOrigin = scripts.find((s) => s.targetUrl && sameOrigin(s.targetUrl, url));
  const hit = byTrigger || byScheduleDomain || byOrigin;

  if (!hit) return { ok: false, skipped: '当前页面没有匹配的脚本（可用域名规则或 targetUrl 建立关联）' };

  runScript(hit.id, { trigger: 'manual' });
  return { ok: true, scriptId: hit.id, name: hit.name };
}

chrome.alarms.onAlarm.addListener((alarm) => {
  (async () => {
    if (alarm.name === WATCHDOG) {
      await syncOffscreen().catch(() => {});
      return;
    }
    const id = scriptIdFromAlarm(alarm.name);
    if (!id) return;
    // 定时也是「自动」路径，同样受冷却约束 ——
    // 周期再短也不会突破冷却，用户配错了也不会把页面点烂
    const slot = await acquireAutoSlot(id, 'schedule');
    if (slot.ok) await runScript(id, { trigger: 'schedule' });
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

chrome.webNavigation.onCommitted.addListener((details) => {
  recordNav(details);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  // 内容脚本上行：不需要响应，也不能 return true
  if (msg.type === 'GX_STEPS_APPEND') {
    appendSteps(msg, sender).catch(() => {});
    return;
  }

  // offscreen 上行
  if (msg.type === 'GX_TIMER_FIRE') {
    (async () => {
      const slot = await acquireAutoSlot(msg.scriptId, 'schedule');
      if (slot.ok) await runScript(msg.scriptId, { trigger: 'schedule' });
    })().catch(() => {});
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

/* ==================================================================
 * 录制：开始 / 停止
 *
 * 抽成独立函数，因为 popup、右键菜单、键盘快捷键三个入口都要用。
 * ================================================================== */

async function startRecording() {
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

  await setRecording({ tabId: tab.id, url: tab.url, title: tab.title || '', startedAt: Date.now() });
  await setRecordIcon(true);
  return { ok: true, tabId: tab.id, url: tab.url, hud: settings.hud !== false };
}

async function stopRecording() {
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

  const script = normalizeScript({
    id: newId(),
    name: `${trimTitle(rec.title)} · ${stamp}`,
    targetUrl: rec.url,
    steps,
    createdAt: Date.now(),
    enabled: true,
    engine: null, // null = 跟随全局设置
    schedule: defaultSchedule(),
    // 一段录制 = 一个手势事件。之后可以在界面上插入 JS 事件、调整顺序，
    // 或者给步骤补匹配条件，凑成完整的执行流程。
    events: [{ type: 'gesture', name: '手势', wait: defaultWait(), steps }],
  });

  await saveScript(script);
  await syncContextMenus().catch(() => {});
  return { ok: true, saved: script };
}

/** 右键菜单与快捷键共用：在「开始」和「停止」之间切换 */
async function toggleRecording() {
  const rec = await getRecording();
  return rec?.tabId ? stopRecording() : startRecording();
}

async function route(msg, sender) {
  switch (msg.type) {
    /* ---------- 录制 ---------- */
    case 'RECORD_START':
      return await startRecording();

    case 'RECORD_STOP':
      return await stopRecording();

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
        logStats: await logStats(),
      };
    }

    case 'SCRIPT_GET':
      return { ok: true, script: await getScript(msg.id) };

    case 'SCRIPT_UPDATE': {
      const next = normalizeScript({ ...msg.script, updatedAt: Date.now() });
      await saveScript(next);
      // scheduleOne 会重建该脚本的 alarm（重置倒计时 —— 用户刚改了周期，符合预期）；
      // syncAlarms 再统一收尾：清理失效 alarm，并把秒级任务同步给 offscreen。
      // 少了 syncAlarms 这一句，改成秒级周期就不会生效。
      await scheduleOne(next);
      await syncAlarms();
      await syncContextMenus().catch(() => {});
      return { ok: true, script: next };
    }

    case 'SCRIPT_DELETE':
      await deleteScript(msg.id);
      await syncAlarms();
      await syncContextMenus().catch(() => {});
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
      await syncContextMenus().catch(() => {});
      return { ok: true, script: copy };
    }

    case 'SCRIPT_IMPORT': {
      const incoming = Array.isArray(msg.scripts) ? msg.scripts : [];
      if (!incoming.length) throw new Error('没有可导入的脚本');

      const existing = await listScripts();
      const ids = new Set(existing.map((s) => s.id));
      const added = [];
      let skipped = 0;

      for (const raw of incoming) {
        // 结构不完整的直接跳过，不让一条坏数据毁掉整次导入。
        // 能接受两种形态：新结构（events）和老结构（扁平 steps）。
        const hasEvents = Array.isArray(raw?.events) && raw.events.length > 0;
        const hasSteps = Array.isArray(raw?.steps) && raw.steps.length > 0;
        if (!raw || typeof raw !== 'object' || (!hasEvents && !hasSteps)) {
          skipped++;
          continue;
        }
        // id 已存在就跳过 —— 导入是「补充」不是「覆盖」，避免误删现有配置
        if (raw.id && ids.has(raw.id)) {
          skipped++;
          continue;
        }
        const s = normalizeScript({
          ...raw,
          id: raw.id || newId(),
          name: String(raw.name || '导入的脚本'),
          importedAt: Date.now(),
        });
        ids.add(s.id);
        await saveScript(s);
        added.push(s);
      }

      await syncAlarms();
      await syncContextMenus().catch(() => {});
      return { ok: true, added: added.length, skipped, scripts: added };
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

    /* ---------- Google Drive 云备份 ---------- */
    case 'DRIVE_STATUS':
      return { ok: true, drive: await driveStatus() };

    case 'DRIVE_SET_CLIENT':
      return { ok: true, drive: await driveSetClient(msg.clientId) };

    case 'DRIVE_CONNECT':
      return { ok: true, drive: await driveConnect() };

    case 'DRIVE_DISCONNECT':
      return { ok: true, ...(await driveDisconnect()) };

    case 'DRIVE_BACKUP':
      return { ok: true, ...(await doCloudBackup()) };

    case 'DRIVE_LIST':
      return { ok: true, files: await driveList() };

    case 'DRIVE_RESTORE':
      return { ok: true, ...(await doCloudRestore(msg.fileId)) };

    /* ---------- 执行日志 ---------- */
    case 'LOG_READ':
      return { ok: true, logs: await readLogs(), stats: await logStats() };

    case 'LOG_CLEAR':
      await clearLogs();
      return { ok: true, stats: await logStats() };

    case 'LOG_STATS':
      return { ok: true, stats: await logStats() };

    /* ---------- 设置 ---------- */
    case 'SETTINGS_SAVE': {
      const s = await saveSettings(msg.patch || {});
      configureLog({ debug: s.debug, logLimit: s.logLimit });
      await syncAlarms();
      await syncOffscreen().catch(() => {});
      return { ok: true, settings: s };
    }

    default:
      throw new Error(`未知消息类型：${msg.type}`);
  }
}

/* ==================================================================
 * Google Drive 备份
 *
 * 备份文件的格式与「导出 JSON」完全一致，所以云端导出的文件
 * 可以直接用本地导入还原，反过来也一样。
 * ================================================================== */

function stampName(prefix, ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}

async function doCloudBackup() {
  const scripts = await listScripts();
  const settings = await getSettings();

  const payload = {
    format: 'gesture-pilot-scripts',
    version: 1,
    exportedAt: new Date().toISOString(),
    count: scripts.length,
    scripts,
    // 设置一起存下来，换台机器恢复时不用重新配一遍
    settings,
  };

  const file = await driveUpload(stampName('gesture-pilot', 'json'), JSON.stringify(payload, null, 2));
  // 只保留最近若干份，不然自动备份攒久了会把 Drive 塞满
  const pruned = await drivePrune().catch(() => ({ removed: 0 }));
  return { file, pruned: pruned.removed, count: scripts.length };
}

async function doCloudRestore(fileId) {
  if (!fileId) throw new Error('没有指定要恢复哪一份备份');

  const text = await driveDownload(fileId);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`这份备份不是合法的 JSON：${e?.message || e}`);
  }

  const incoming = Array.isArray(parsed) ? parsed : parsed?.scripts || [];
  if (!Array.isArray(incoming) || !incoming.length) throw new Error('这份备份里没有任务');

  // 走和本地导入完全相同的那条路：同 id 跳过、结构不全的跳过，
  // 所以恢复是「补充」而不是「覆盖」，不会把你现在的配置冲掉
  const r = await route({ type: 'SCRIPT_IMPORT', scripts: incoming });
  return { added: r.added, skipped: r.skipped, from: parsed?.exportedAt || '' };
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
    // 总开关关掉的脚本，定时与页面触发都不再生效
    if (s.enabled === false) continue;
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
      if (s.enabled === false) return false;
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
const K_NAV = 'gx_nav';

/**
 * 浏览器认可的「用户主动导航」。
 *
 * 用它把「用户刷新 / 重新敲地址 / 点书签」和「页面或脚本自己跳转」区分开：
 * 前者是用户新的一次意图，不该被防连环触发的冷却拦住；
 * 后者才需要拦 —— 脚本点个链接跳到同样匹配的页面，会无止境地自己触发自己。
 */
const USER_NAV = new Set(['reload', 'typed', 'auto_bookmark', 'generated']);

/** 记录每个标签页顶层 frame 最近一次导航的来源 */
async function recordNav(details) {
  if (details.frameId !== 0) return; // 内容脚本只注入顶层，只关心顶层
  try {
    const got = await chrome.storage.session.get(K_NAV);
    const map = got[K_NAV] || {};
    map[String(details.tabId)] = {
      url: details.url,
      transitionType: details.transitionType,
      qualifiers: details.transitionQualifiers || [],
      at: Date.now(),
    };
    await chrome.storage.session.set({ [K_NAV]: map });
  } catch {
    /* 导航已经发生了，这里写失败不能反过来影响它 */
  }
}

/**
 * 判断这次触发所对应的页面加载，是不是用户主动发起的。
 * 窗口取 15 秒：onCommitted 一定早于内容脚本的 document_idle，
 * 超时的记录说明这是上一次导航留下的，不能拿来用。
 */
async function isUserNavigation(tabId, url) {
  if (typeof tabId !== 'number') return false;
  try {
    const got = await chrome.storage.session.get(K_NAV);
    const nav = (got[K_NAV] || {})[String(tabId)];
    if (!nav) return false;
    if (Date.now() - nav.at > 15000) return false;
    if (!USER_NAV.has(nav.transitionType)) return false;
    // 比 origin 而不是完整 URL：SPA 可能在导航之后改写路径
    return sameOrigin(nav.url, url || nav.url);
  } catch {
    return false;
  }
}

/** 记下「这次为什么没触发」，界面直接显示，省得开控制台猜 */
async function noteTriggerSkip(scriptId, reason, url) {
  try {
    const got = await chrome.storage.session.get(K_TRIGGER_LOG);
    const log = got[K_TRIGGER_LOG] || {};
    log[`skip_${scriptId}`] = { reason, at: Date.now(), url: url || '' };
    await chrome.storage.session.set({ [K_TRIGGER_LOG]: log });
  } catch {
    /* 诊断信息写失败不影响主流程 */
  }
}

/* ---------------- 冷却：所有自动路径共用 ---------------- */

/**
 * 自动触发（定时 / 页面加载 / 刷新）统一走这里：冷却没结束就不放行。
 *
 * 手动运行不经过它 —— 用户明确点了「运行」，那是新的意图，
 * 不该被防重复的闸门挡着。
 */
async function acquireAutoSlot(taskId, trigger) {
  const task = await getScript(taskId);
  if (!task) return { ok: false, reason: '任务已不存在' };
  if (task.enabled === false) return { ok: false, reason: '任务已停用' };

  const cd = Math.max(0, Number(task.trigger?.cooldownSec) || 0);
  if (cd > 0) {
    const got = await chrome.storage.session.get(K_TRIGGER_LOG);
    const prev = (got[K_TRIGGER_LOG] || {})[taskId];
    if (prev?.at) {
      const left = cd * 1000 - (Date.now() - prev.at);
      if (left > 0) {
        return { ok: false, reason: `冷却中，还要等 ${Math.ceil(left / 1000)} 秒（手动运行不受此限制）` };
      }
    }
  }

  await markFired(taskId, trigger);
  return { ok: true };
}

/** 记录一次触发，供冷却与「上次触发」显示使用 */
async function markFired(taskId, trigger, loadId, url) {
  const got = await chrome.storage.session.get(K_TRIGGER_LOG);
  const log = got[K_TRIGGER_LOG] || {};
  const prev = log[taskId] || {};
  log[taskId] = {
    ...prev,
    at: Date.now(),
    trigger,
    ...(loadId !== undefined ? { loadId } : {}),
    ...(url !== undefined ? { url } : {}),
  };
  await chrome.storage.session.set({ [K_TRIGGER_LOG]: log });
}

async function handleTrigger(msg, sender) {
  const scriptId = msg?.scriptId;
  if (!scriptId) throw new Error('缺少 scriptId');

  const url = msg.url || sender?.url || '';
  const skip = async (reason) => {
    await noteTriggerSkip(scriptId, reason, url);
    return { ok: false, skipped: reason };
  };

  const script = await getScript(scriptId);
  if (!script) return skip('脚本已不存在');
  if (script.enabled === false) return skip('脚本已停用');

  const t = normalizeTrigger(script.trigger);
  if (!t.enabled) return skip('触发未启用');

  // 已经有脚本在跑就不叠加，避免两个自动化互相踩
  if (running.size > 0) return skip('已有脚本正在运行');

  const now = Date.now();
  const got = await chrome.storage.session.get(K_TRIGGER_LOG);
  const log = got[K_TRIGGER_LOG] || {};
  const prev = log[scriptId] || {};

  // 用户按 F5 / 重新敲地址 / 点书签 —— 这是新的一次意图
  const userNav = await isUserNavigation(sender?.tab?.id, url);

  if (t.once && msg.loadId && prev.loadId === msg.loadId) {
    return skip('本次页面加载已经触发过');
  }

  // 冷却对所有自动路径一视同仁：页面加载、刷新、定时都受它约束。
  // 只有手动点「运行」/ 快捷键时豁免 —— 那条路径根本不经过这里。
  // （上一版让「用户刷新绕过冷却」，结果变成怎么刷都触发，反而更难预期。）
  if (t.cooldownSec > 0 && prev.at && now - prev.at < t.cooldownSec * 1000) {
    const left = Math.ceil((t.cooldownSec * 1000 - (now - prev.at)) / 1000);
    return skip(`冷却中，还要等 ${left} 秒（手动运行不受此限制）`);
  }

  log[scriptId] = {
    at: now,
    loadId: msg.loadId || null,
    url,
    trigger: userNav ? 'reload' : 'page',
  };
  await chrome.storage.session.set({ [K_TRIGGER_LOG]: log });

  runScript(scriptId, { trigger: 'page' });
  return { ok: true, started: true, reload: userNav };
}

/* ==================================================================
 * 回放编排
 * ================================================================== */

class StepError extends Error {
  constructor({ eventIndex, eventName, stepIndex, step, detail }) {
    const where = eventName ? `事件「${eventName}」` : `第 ${eventIndex + 1} 个事件`;
    super(`${where}的第 ${stepIndex + 1} 步失败：${detail}`);
    this.eventIndex = eventIndex;
    this.stepIndex = stepIndex;
    this.step = step;
  }
}

class EventError extends Error {
  constructor(index, event, detail) {
    const name = event?.name ? `「${event.name}」` : '';
    super(`第 ${index + 1} 个事件${name}失败：${detail}`);
    this.eventIndex = index;
    this.event = event;
  }
}

function describeEvent(ev) {
  if (ev.type === 'js') {
    const head = firstLine(ev.name || ev.code || '');
    return `JS · ${truncate(head, 20)}`;
  }
  return `手势 · ${ev.steps?.length || 0} 步`;
}

/** 取第一行，用来给没有名字的 JS 事件起个摘要 */
function firstLine(s) {
  const t = String(s || '').trim();
  const m = t.match(/[^\r\n]*/);
  return (m ? m[0] : t).trim();
}

/* ---------------- 事件闸门 ---------------- */

/**
 * 事件执行前的等待闸门。
 *
 *   wait.url      —— 等地址栏变成匹配的样子（上一个事件可能刚触发了跳转）
 *   wait.selector —— 等元素出现（给 SPA 渲染留时间，比固定延迟可靠得多）
 *
 * 等不到只跳过这一个事件，不整条任务失败：「页面这次渲染慢了」这种瞬时问题
 * 不该连累后面本来能跑的事件。需要严格时在事件上勾 fatal。
 */
async function passEventGate(ev, tabId, log) {
  const w = ev.wait || {};
  const budget = Math.max(1, Number(w.timeoutSec) || 20) * 1000;

  if (w.url) {
    log.info('等待地址匹配', { pattern: w.url, timeoutSec: Math.round(budget / 1000) });
    const ok = await waitForTabUrl(tabId, w.url, budget);
    if (!ok) {
      const cur = (await chrome.tabs.get(tabId).catch(() => null))?.url || '';
      return { ok: false, reason: `等不到地址匹配「${w.url}」（当前是 ${hostOf(cur)}）` };
    }
    log.ok('地址已匹配', { url: (await chrome.tabs.get(tabId).catch(() => null))?.url || '' });
  }

  if (w.selector) {
    log.info('等待元素出现', { selector: w.selector, timeoutSec: Math.round(budget / 1000) });
    const ok = await waitForSelectorInTab(tabId, w.selector, budget);
    if (!ok) return { ok: false, reason: `等不到元素「${w.selector}」` };
    log.ok('元素已出现', { selector: w.selector });
  }

  return { ok: true };
}

async function waitForTabUrl(tabId, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (matchesDomain(tab?.url || '', [pattern])) return true;
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
}

/**
 * 轮询页面里有没有这个元素。
 * 用 executeScript 而不是给内容脚本发消息：静态 content script 对
 * 「扩展加载之前就打开的标签页」不生效，而这里恰恰经常跑在这种页面上。
 * 注入的 func 必须是自包含的，不能引用外部变量。
 */
async function waitForSelectorInTab(tabId, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let found = false;
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: (sel) => {
          try {
            return !!document.querySelector(sel);
          } catch {
            return false;
          }
        },
        args: [selector],
      });
      found = r?.[0]?.result === true;
    } catch {
      found = false;
    }
    if (found) return true;
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
}

/* ---------------- 主流程 ---------------- */

async function runScript(id, ctx = {}) {
  if (running.has(id)) return { ok: false, error: '该任务正在运行中' };
  running.add(id);

  const startedAt = Date.now();
  const trigger = ctx.trigger || 'manual';
  let tabId = null;
  let taskName = '';
  let engine = 'synthetic';
  let cdpTouched = false;
  let log = makeLogger({ taskId: id });
  const skips = [];

  try {
    // 新一轮开始，清掉上一次的失败留证
    await setFailure(null);

    const task = await getScript(id);
    if (!task) throw new Error('任务不存在或已被删除');

    const events = (task.events || []).filter((e) => e.enabled !== false);
    if (!events.length) throw new Error('任务里没有启用的事件');

    taskName = task.name;
    const settings = await getSettings();
    configureLog({ debug: settings.debug, logLimit: settings.logLimit });
    log = makeLogger({ taskId: id, taskName });
    engine = task.engine || settings.engine;

    const total = countSteps(task);
    const base = { scriptId: id, scriptName: taskName, startedAt, trigger, engine };

    log.info('任务开始', { trigger, engine, events: events.length, steps: total });

    const tab = await ensureTargetTab(task);
    tabId = tab.id;
    log.info('目标页面', { url: tab.url || '', tabId });

    // 生效域名守卫：只约束自动路径（定时 / 页面加载触发）。
    // 手动运行是明确的用户意图，不受限制。
    if (trigger !== 'manual') {
      const allowed = task.schedule?.domains || [];
      if (allowed.length && !matchesDomain(tab.url || '', allowed)) {
        throw new Error(
          `当前页面 ${hostOf(tab.url)} 不在生效域名范围内，已跳过（生效域名：${allowed.join('、')}）`,
        );
      }
    }

    await setRunState({ ...base, status: 'running', index: 0, total, tabId, phase: '准备页面' });

    const hudWanted = settings.hud !== false;
    let hudOn = false;
    const cursor = { last: null };
    let frameMap = null;
    let done = 0;

    const injectOnce = async () => {
      if (!frameMap) frameMap = await injectFrames(tabId);
      return frameMap;
    };
    const lightHud = async (label) => {
      if (!hudWanted || hudOn) return;
      await broadcast(tabId, { type: 'GX_HUD_ON', label });
      hudOn = true;
    };
    const eventState = (ei, phase) => ({
      ...base, status: 'running', index: done, total, tabId,
      eventIndex: ei, events: events.length, phase,
    });

    try {
      for (let ei = 0; ei < events.length; ei++) {
        const ev = events[ei];
        const elog = makeLogger({
          taskId: id,
          taskName,
          eventIndex: ei,
          eventName: ev.name || `事件 ${ei + 1}`,
        });

        await setRunState(eventState(ei, `事件 ${ei + 1}/${events.length} · ${describeEvent(ev)}`));

        // ---- 闸门：等地址 / 等元素 ----
        const gate = await passEventGate(ev, tabId, elog);
        if (!gate.ok) {
          elog.warn('事件被跳过', { reason: gate.reason });
          skips.push({ eventIndex: ei, eventName: ev.name || `事件 ${ei + 1}`, reason: gate.reason });
          if (ev.wait?.fatal) throw new EventError(ei, ev, gate.reason);
          continue;
        }

        // ---- JS 事件 ----
        if (ev.type === 'js') {
          const code = String(ev.code || '');
          if (!code.trim()) {
            elog.warn('JS 事件里没有代码，跳过');
            skips.push({ eventIndex: ei, eventName: ev.name || `事件 ${ei + 1}`, reason: 'JS 事件里没有代码' });
            continue;
          }

          elog.info('执行 JS 事件', { world: ev.world || 'auto', chars: code.length });
          const r = await runUserCode({
            tabId,
            frameId: 0,
            code,
            world: ev.world || 'auto',
            timeoutMs: Math.max(5000, (Number(settings.stepTimeout) || 8000) * 3),
            context: { task: taskName, event: ev.name || `事件 ${ei + 1}` },
            log: elog,
          });
          if (r.via === 'cdp') cdpTouched = true;

          if (!r.ok) throw new EventError(ei, ev, r.error);
          elog.ok('JS 事件完成', {
            via: r.via,
            fellBack: !!r.fellBack,
            value: r.value === undefined ? '(无返回值)' : r.value,
          });

          done += 1;
          if (hudOn) broadcast(tabId, { type: 'GX_HUD_TICK', count: done });
          await flushNow();
          continue;
        }

        // ---- 手势事件 ----
        const steps = ev.steps || [];
        if (!steps.length) {
          elog.warn('手势事件里没有步骤，跳过');
          skips.push({ eventIndex: ei, eventName: ev.name || `事件 ${ei + 1}`, reason: '手势事件里没有步骤' });
          continue;
        }

        const map = await injectOnce();
        if (engine === 'cdp' && !cdpTouched) {
          await cdpAttach(tabId);
          cdpTouched = true;
        }
        await lightHud('回放中');

        for (let si = 0; si < steps.length; si++) {
          const step = steps[si];
          const gap = computeGap(step, si, settings);
          if (gap > 0) await sleep(gap);

          const label = describeStep(step);
          await setRunState(eventState(ei, `事件 ${ei + 1}/${events.length} · ${label}`));
          if (hudOn) broadcast(tabId, { type: 'GX_HUD_TICK', count: done + 1 });
          elog.info(`步骤 ${si + 1}/${steps.length}`, { step: label, delayMs: Math.round(gap) });

          const frameId = resolveFrameId(map, step);
          const frameIsTop = !!map.find((f) => f.frameId === frameId)?.top;
          const args = [tabId, frameId, step, settings, engine, cursor, frameIsTop];
          let res = await dispatchStep(...args);

          const retries = Math.max(0, Number(settings.retry) || 0);
          for (let a = 0; !res.ok && a < retries; a++) {
            await sleep(800);
            elog.warn(`步骤重试 ${a + 1}/${retries}`, { error: res.error });
            res = await dispatchStep(...args);
          }

          if (!res.ok) {
            throw new StepError({
              eventIndex: ei,
              eventName: ev.name || `事件 ${ei + 1}`,
              stepIndex: si,
              step,
              detail: res.error || '未知错误',
            });
          }
          done += 1;
        }

        elog.ok('手势事件完成', { steps: steps.length });
        await flushNow();
      }
    } finally {
      if (hudOn) await broadcast(tabId, { type: 'GX_HUD_OFF' });
      // 手势的 CDP 引擎和 JS 事件的降级路径共用同一个调试连接，
      // 这里统一断开，页面上的「正在调试」提示条才会消失
      if (engine === 'cdp' || cdpTouched) {
        await cdpDetach(tabId).catch(() => {});
        await releaseCdp(tabId).catch(() => {});
      }
    }

    const finishedAt = Date.now();
    await setRunState({
      ...base, status: 'success', index: total, total, tabId, skips,
      finishedAt, duration: finishedAt - startedAt, phase: '完成',
    });
    log.ok('任务完成', { durationMs: finishedAt - startedAt, steps: done, skipped: skips.length });
    await flushNow();
    await clearBadge();
    return { ok: true };
  } catch (e) {
    const run = await getRunState();
    const failure = {
      scriptId: id,
      scriptName: taskName,
      error: String(e?.message || e),
      stepIndex: e instanceof StepError ? e.stepIndex : null,
      step: e instanceof StepError ? e.step : null,
      eventIndex: e instanceof StepError || e instanceof EventError ? e.eventIndex : null,
      event: e instanceof EventError ? e.event : null,
      at: Date.now(),
      engine,
    };

    log.error('任务失败', {
      error: failure.error,
      eventIndex: failure.eventIndex,
      stepIndex: failure.stepIndex,
    });
    await flushNow();

    await setFailure(failure);
    await setRunState({
      ...(run || { scriptId: id, scriptName: taskName, startedAt }),
      status: 'failed',
      finishedAt: Date.now(),
      duration: Date.now() - startedAt,
      phase: '失败',
    });

    await captureFailure(tabId).catch(() => {});
    await notify('手势助手 · 执行失败', `${taskName}：${failure.error}`).catch(() => {});
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

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url || '未知页面');
  }
}

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
