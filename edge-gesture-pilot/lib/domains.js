/**
 * 生效域名的匹配规则。
 *
 * 支持四种写法（逗号 / 分号 / 空白分隔，也可以直接给数组）：
 *   example.com          匹配 example.com 及其所有子域（a.example.com 也命中）
 *   *.example.com        只匹配子域，不含 example.com 本身
 *   10.0.0.5:8080        带端口的 host
 *   https://a.com/admin  带协议时按整段 URL 前缀匹配（可带路径）
 *
 * 空列表 = 所有域名都生效。
 *
 * ⚠️ content/trigger.js 里有一份等价实现（内容脚本不能用 import）。
 *    两者必须保持一致 —— tools/domains-harness.mjs 会拿同一组用例对拍。
 */

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export function parsePatterns(input) {
  if (Array.isArray(input)) return input.map((s) => String(s).trim()).filter(Boolean);
  return String(input || '')
    .split(/[\s,，;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function matchesDomain(url, patterns) {
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

    // 带协议的写法：整段 URL 前缀匹配
    if (SCHEME_RE.test(p)) {
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

/** 给界面用的一句话描述 */
export function describePatterns(patterns) {
  const list = parsePatterns(patterns);
  if (!list.length) return '所有域名';
  if (list.length <= 2) return list.join('、');
  return `${list.slice(0, 2).join('、')} 等 ${list.length} 条`;
}
