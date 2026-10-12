/**
 * 执行日志查看器。
 *
 * 日志存在 storage.local（环形缓冲），后台在 debug 打开时写入。
 * 这个页面只做读取、过滤、导出 —— 不产生日志。
 */

const $ = (s) => document.querySelector(s);
const MAX_ROWS = 500; // 一次渲染的上限，超出的让用户用过滤去缩小范围

let all = [];
let stats = null;
let timer = null;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function send(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function timeOf(t) {
  const d = new Date(t || 0);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

const LEVEL_RANK = { info: 0, ok: 1, warn: 2, error: 3 };
const LEVEL_LABEL = { info: 'INFO', ok: 'OK', warn: 'WARN', error: 'ERR' };

function filtered() {
  const task = $('#fTask').value;
  const level = $('#fLevel').value;
  const text = $('#fText').value.trim().toLowerCase();
  const minRank = level ? LEVEL_RANK[level] : -1;

  return all.filter((e) => {
    if (task && e.taskId !== task) return false;
    if (level) {
      // 「只看错误」就是 error；「警告及以上」是 warn + error
      if (level === 'ok') {
        if (e.level !== 'ok' && e.level !== 'error') return false;
      } else if ((LEVEL_RANK[e.level] ?? 0) < minRank) {
        return false;
      }
    }
    if (text) {
      const hay = `${e.msg || ''} ${e.taskName || ''} ${e.eventName || ''} ${JSON.stringify(e.data || '')}`;
      if (!hay.toLowerCase().includes(text)) return false;
    }
    return true;
  });
}

function fillTasks() {
  const sel = $('#fTask');
  const seen = new Map();
  for (const e of all) if (e.taskId && !seen.has(e.taskId)) seen.set(e.taskId, e.taskName || e.taskId);

  const cur = sel.value;
  const opts = ['<option value="">全部任务</option>'];
  for (const [id, name] of seen) opts.push(`<option value="${esc(id)}">${esc(name)}</option>`);
  sel.innerHTML = opts.join('');
  sel.value = seen.has(cur) ? cur : '';
}

function render() {
  const rows = filtered();
  const shown = rows.slice(-MAX_ROWS);

  $('#empty').hidden = all.length > 0;

  $('#list').innerHTML = shown
    .map((e) => {
      const lv = LEVEL_RANK[e.level] === undefined ? 'info' : e.level;
      const who = e.taskName || e.taskId
        ? `<span class="who"><span class="task">${esc(e.taskName || e.taskId)}</span>${
            e.eventName ? `<span class="ev"> › ${esc(e.eventName)}</span>` : ''
          }</span>`
        : '<span class="who"></span>';

      const hasData = e.data !== undefined && e.data !== null;
      const data = hasData
        ? `<details><summary>详情</summary><div class="data">${esc(JSON.stringify(e.data, null, 2))}</div></details>`
        : '';

      return `<div class="row ${lv}">
  <span class="t">${timeOf(e.t)}</span>
  <span class="lv ${lv}">${LEVEL_LABEL[lv] || lv}</span>
  ${who}
  <span class="msg">${esc(e.msg)}${data}</span>
</div>`;
    })
    .join('');

  const total = stats?.count ?? all.length;
  const limit = stats?.limit ?? 0;
  const bytes = stats?.bytes ? ` · ${(stats.bytes / 1024).toFixed(0)} KB` : '';
  const tail =
    rows.length > MAX_ROWS ? `（显示最近 ${MAX_ROWS} 条，用过滤缩小范围）` : '';

  $('#stat').textContent = `共 ${total} 条${limit ? ` / 上限 ${limit}` : ''}${bytes} · 当前匹配 ${rows.length} 条 ${tail}`;
  document.body.classList.toggle('off', stats && stats.enabled === false);
  $('#hint').hidden = !(stats && stats.enabled === false);
}

async function load() {
  const r = await send({ type: 'LOG_READ' });
  if (!r?.ok) {
    $('#stat').textContent = `读取失败：${r?.error || '未知错误'}`;
    return;
  }
  all = r.logs || [];
  stats = r.stats || null;
  fillTasks();
  render();
}

function restartTimer() {
  if (timer) clearInterval(timer);
  timer = null;
  if (!$('#auto').checked) return;
  timer = setInterval(() => {
    // 有人展开着详情时先别刷，否则刚点开就被收起来了
    if (document.querySelector('details[open]')) return;
    if ($('#fText') === document.activeElement) return;
    load();
  }, 2000);
}

$('#auto').addEventListener('change', restartTimer);
$('#btnRefresh').addEventListener('click', load);
$('#fTask').addEventListener('change', render);
$('#fLevel').addEventListener('change', render);
$('#fText').addEventListener('input', render);

$('#btnClear').addEventListener('click', async () => {
  if (!confirm('清空全部执行日志？此操作不可撤销。')) return;
  await send({ type: 'LOG_CLEAR' });
  await load();
});

$('#btnExport').addEventListener('click', () => {
  const rows = filtered();
  if (!rows.length) {
    alert('没有可导出的日志');
    return;
  }
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), count: rows.length, logs: rows }, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  a.href = url;
  a.download = `gesture-pilot-logs-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
});

// 页面隐藏时停掉轮询，省得挂在后台白刷
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (timer) clearInterval(timer);
    timer = null;
  } else {
    load();
    restartTimer();
  }
});

load();
restartTimer();
