/**
 * 秒级定时器宿主。
 * service worker 把需要 < 60 秒周期的任务同步过来，这里用 setInterval 驱动，
 * 到点后通过 runtime.sendMessage 唤醒 service worker 执行。
 */

/** @type {Map<string, {timer:number, everySec:number, nextAt:number}>} */
const jobs = new Map();

function sync(list) {
  const wanted = new Set(list.map((j) => j.id));

  for (const [id, job] of jobs) {
    if (!wanted.has(id)) {
      clearInterval(job.timer);
      jobs.delete(id);
    }
  }

  for (const j of list) {
    const every = Math.max(1, Number(j.everySec) || 30);
    const existing = jobs.get(j.id);
    if (existing && existing.everySec === every) continue;
    if (existing) clearInterval(existing.timer);

    const timer = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'GX_TIMER_FIRE', scriptId: j.id }).catch(() => {
        /* service worker 正在启动，消息可能丢失，下一拍会重试 */
      });
    }, every * 1000);

    jobs.set(j.id, { timer, everySec: every, nextAt: Date.now() + every * 1000 });
  }

  return { ok: true, count: jobs.size };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'GX_TIMER_SYNC') {
    sendResponse(sync(msg.jobs || []));
    return;
  }
  if (msg.type === 'GX_TIMER_STATE') {
    sendResponse({
      ok: true,
      jobs: Array.from(jobs.entries()).map(([id, j]) => ({ id, everySec: j.everySec, nextAt: j.nextAt })),
    });
    return;
  }
});

// 启动即向 service worker 报到，触发一次全量同步
chrome.runtime.sendMessage({ type: 'GX_TIMER_READY' }).catch(() => {});
