/**
 * Google Drive 云备份。
 *
 * 走 OAuth2 + PKCE，用 chrome.identity.launchWebAuthFlow 拿授权码。
 *
 * 为什么不把 client_id 内置进扩展：开源仓库里放不了客户端凭据，
 * 而且每个扩展实例的 ID 不同，重定向地址必须跟着变。所以让用户自己在
 * Google Cloud 建一个 OAuth 客户端，扩展里只存他填进来的 client_id。
 * （同一份代码装在不同机器上扩展 ID 相同，所以填一次就能一直用。）
 *
 * scope 用 drive.file —— 只能看到本应用创建的文件，碰不到用户 Drive 里
 * 其他任何东西。备份放在「Gesture Pilot Backups」文件夹里，用户自己能看见、
 * 能下载、能删，删了也只是丢备份，不影响扩展本身。
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'Gesture Pilot Backups';
const K_AUTH = 'gx_drive_auth';

/** 超过这个数量就自动删掉最旧的备份 */
export const KEEP_BACKUPS = 20;

/* ==================================================================
 * 凭据存取
 * ================================================================== */

export async function getAuth() {
  const got = await chrome.storage.local.get(K_AUTH);
  return got[K_AUTH] || null;
}

async function saveAuth(patch) {
  const next = { ...(await getAuth()), ...patch };
  await chrome.storage.local.set({ [K_AUTH]: next });
  return next;
}

export async function clearAuth() {
  await chrome.storage.local.remove(K_AUTH);
}

export async function getStatus() {
  const a = await getAuth();
  return {
    clientId: a?.clientId || '',
    connected: !!a?.refreshToken,
    redirectUri: chrome.identity.getRedirectURL(),
    folder: FOLDER_NAME,
  };
}

export async function setClientId(clientId) {
  const id = String(clientId || '').trim();
  const a = await getAuth();
  // 换了 client_id，旧 token 必然失效，直接清掉免得后面报一堆莫名其妙的错
  if (a?.clientId && a.clientId !== id) {
    await clearAuth();
    await chrome.storage.local.set({ [K_AUTH]: { clientId: id } });
  } else {
    await saveAuth({ clientId: id });
  }
  return getStatus();
}

/* ==================================================================
 * OAuth
 * ================================================================== */

function b64url(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomB64(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return b64url(a);
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json.error_description || json.error || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.code = json.error || '';
    err.status = res.status;
    throw err;
  }
  return json;
}

/**
 * 打开授权窗口拿 refresh token。
 * PKCE 是必须的：扩展是公共客户端，没有 client_secret 可放，
 * 靠 code_verifier 保证拦截到授权码也用不了。
 */
export async function connect() {
  const auth = await getAuth();
  const clientId = String(auth?.clientId || '').trim();
  if (!clientId) throw new Error('请先填写 Google OAuth Client ID');

  const redirectUri = chrome.identity.getRedirectURL();
  const verifier = randomB64(48);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = randomB64(16);

  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);

  let redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
  } catch (e) {
    const m = String(e?.message || e);
    if (/user did not approve|cancelled|canceled/i.test(m)) throw new Error('授权被取消');
    throw new Error(`打不开授权页面：${m}`);
  }
  if (!redirect) throw new Error('授权没有返回结果');

  const back = new URL(redirect);
  const code = back.searchParams.get('code');
  const gotState = back.searchParams.get('state');
  if (!code) {
    const err = back.searchParams.get('error');
    throw new Error(err ? `授权失败：${err}` : '授权没有返回 code');
  }
  if (gotState !== state) throw new Error('回调里的 state 与发出去的对不上，已中止');

  const token = await postForm(TOKEN_URL, {
    client_id: clientId,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });

  if (!token.refresh_token) {
    throw new Error(
      'Google 没有返回 refresh token。多半是这个 client_id 之前授权过 —— 去 Google 账号的「第三方应用」里撤销本应用再试一次。',
    );
  }

  await saveAuth({
    clientId,
    refreshToken: token.refresh_token,
    accessToken: token.access_token,
    expiresAt: Date.now() + Math.max(60, (token.expires_in || 3600) - 60) * 1000,
  });
  return getStatus();
}

async function accessToken() {
  const a = await getAuth();
  if (!a?.refreshToken) throw new Error('还没有连接 Google Drive');
  if (a.accessToken && a.expiresAt > Date.now() + 30000) return a.accessToken;

  let json;
  try {
    json = await postForm(TOKEN_URL, {
      client_id: a.clientId,
      refresh_token: a.refreshToken,
      grant_type: 'refresh_token',
    });
  } catch (e) {
    // invalid_grant = 用户在 Google 账号里撤销了授权，或者改了密码
    if (e.code === 'invalid_grant') {
      await clearAuth();
      throw new Error('授权已失效（可能被撤销了）。请重新连接。');
    }
    throw new Error(`刷新访问令牌失败：${e.message}`);
  }

  await saveAuth({
    accessToken: json.access_token,
    expiresAt: Date.now() + Math.max(60, (json.expires_in || 3600) - 60) * 1000,
  });
  return json.access_token;
}

export async function disconnect() {
  const a = await getAuth();
  // 尽力向 Google 撤销，失败也无所谓 —— 本地清掉就够用了
  if (a?.refreshToken) {
    fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(a.refreshToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }).catch(() => {});
  }
  await clearAuth();
  return { ok: true };
}

/* ==================================================================
 * Drive API
 * ================================================================== */

async function call(url, init = {}) {
  const token = await accessToken();
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j.error?.message || JSON.stringify(j).slice(0, 200);
    } catch {
      detail = (await res.text().catch(() => '')).slice(0, 200);
    }
    throw new Error(`Drive 返回 ${res.status}${detail ? `：${detail}` : ''}`);
  }
  return res;
}

/** 找到（或建出）备份文件夹 */
async function ensureFolder() {
  const a = await getAuth();
  if (a?.folderId) return a.folderId;

  const q = encodeURIComponent(
    `name = '${FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
  );
  const found = await call(`${API}/files?q=${q}&fields=files(id)&spaces=drive`);
  const json = await found.json();
  if (json.files?.length) {
    await saveAuth({ folderId: json.files[0].id });
    return json.files[0].id;
  }

  const created = await call(`${API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  });
  const id = (await created.json()).id;
  await saveAuth({ folderId: id });
  return id;
}

/** 上传一份 JSON 备份（multipart：元数据 + 内容一个请求发完） */
export async function upload(name, text) {
  const folderId = await ensureFolder();
  const boundary = `gx${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

  const meta = JSON.stringify({ name, parents: [folderId], mimeType: 'application/json' });
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${meta}\r\n` +
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${text}\r\n` +
    `--${boundary}--`;

  const res = await call(`${UPLOAD_API}/files?uploadType=multipart&fields=id,name,createdTime`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return res.json();
}

export async function list() {
  const folderId = await ensureFolder();
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const res = await call(
    `${API}/files?q=${q}&orderBy=createdTime desc&pageSize=100&fields=files(id,name,size,createdTime)`,
  );
  const json = await res.json();
  return json.files || [];
}

export async function download(fileId) {
  const res = await call(`${API}/files/${encodeURIComponent(fileId)}?alt=media`);
  return res.text();
}

export async function remove(fileId) {
  await call(`${API}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
  return { ok: true };
}

/** 只保留最近 keep 份，其余删掉 —— 自动备份不定期清理会越堆越多 */
export async function prune(keep = KEEP_BACKUPS) {
  const files = await list();
  const dead = files.slice(keep);
  for (const f of dead) {
    await remove(f.id).catch(() => {});
  }
  return { removed: dead.length, total: files.length };
}

export async function storageInfo() {
  const a = await getAuth();
  return {
    connected: !!a?.refreshToken,
    clientId: a?.clientId || '',
    redirectUri: chrome.identity.getRedirectURL(),
    folder: FOLDER_NAME,
    keep: KEEP_BACKUPS,
  };
}
