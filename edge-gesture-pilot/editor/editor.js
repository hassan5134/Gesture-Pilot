/**
 * JS 事件的代码编辑器。
 *
 * 独立页面而不是塞进 popup：popup 只有 420px 宽，写几行就看不见全貌了。
 * 保存走和 popup 同一条消息（SCRIPT_UPDATE），所以两边的行为完全一致。
 */

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const taskId = params.get('task') || '';
const eventId = params.get('event') || '';

let task = null;
let ev = null;
let saved = '';
let dirty = false;

function setStatus(text, kind = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = `status ${kind}`.trim();
}

function markDirty() {
  dirty = $('#code').value !== saved;
  setStatus(dirty ? '有未保存的改动' : '已保存', dirty ? 'dirty' : 'ok');
}

async function send(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function load() {
  if (!taskId || !eventId) {
    setStatus('地址里缺少 task / event 参数', 'err');
    return;
  }

  const r = await send({ type: 'SCRIPT_GET', id: taskId });
  task = r?.script || null;
  if (!task) {
    setStatus('任务不存在，可能已经被删了', 'err');
    return;
  }

  ev = (task.events || []).find((e) => e.id === eventId) || null;
  if (!ev) {
    setStatus('这个事件不存在，可能已经被删了', 'err');
    return;
  }
  if (ev.type !== 'js') {
    setStatus('这个事件不是 JS 类型', 'err');
    return;
  }

  document.title = `${ev.name || 'JS 事件'} · Gesture Pilot`;
  $('#evName').textContent = ev.name || 'JS 事件';
  $('#taskName').textContent = `· ${task.name}`;
  $('#code').value = ev.code || '';
  saved = $('#code').value;
  dirty = false;
  setStatus('已载入', 'ok');
  $('#code').focus();
}

async function save() {
  if (!task || !ev) return;
  const code = $('#code').value;

  const idx = (task.events || []).findIndex((e) => e.id === ev.id);
  if (idx < 0) {
    setStatus('事件已经不在了，无法保存', 'err');
    return;
  }

  task.events[idx] = { ...ev, code };
  const r = await send({ type: 'SCRIPT_UPDATE', script: task });

  if (!r?.ok) {
    setStatus(`保存失败：${r?.error || '未知错误'}`, 'err');
    return;
  }

  // 用后台规范化后的结果回写，避免本地留着一份和存储不一致的副本
  task = r.script;
  ev = (task.events || []).find((e) => e.id === eventId) || ev;
  saved = code;
  dirty = false;
  setStatus(`已保存 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`, 'ok');
}

/** 极简缩进整理：只按括号层级重排，不碰字符串内容（够用，不引第三方库） */
function reindent(src) {
  const lines = String(src).split(String.fromCharCode(10));
  let depth = 0;
  return lines
    .map((line) => {
      const t = line.trim();
      if (!t) return '';
      if (/^[)\]}]+/.test(t)) depth = Math.max(0, depth - 1);
      const out = '  '.repeat(depth) + t;
      const opens = (t.match(/[([{]/g) || []).length;
      const closes = (t.match(/[)\]}]/g) || []).length;
      depth = Math.max(0, depth + opens - closes);
      if (/^[)\]}]+/.test(t)) depth += 1;
      return out;
    })
    .join(String.fromCharCode(10));
}

$('#btnSave').addEventListener('click', save);
$('#btnSave2').addEventListener('click', save);
$('#btnClose').addEventListener('click', () => window.close());

$('#btnReset').addEventListener('click', () => {
  if (!dirty || confirm('放弃未保存的改动？')) {
    $('#code').value = saved;
    markDirty();
  }
});

$('#btnFormat').addEventListener('click', () => {
  $('#code').value = reindent($('#code').value);
  markDirty();
});

$('#code').addEventListener('input', markDirty);

// Tab 缩进 —— 在代码框里按 Tab 跳焦点太恼人了
$('#code').addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const el = e.target;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    el.value = `${el.value.slice(0, start)}  ${el.value.slice(end)}`;
    el.selectionStart = el.selectionEnd = start + 2;
    markDirty();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

load();
