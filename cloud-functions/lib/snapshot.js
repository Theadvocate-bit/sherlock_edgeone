/**
 * 把服务端抓到的页面 HTML 压成「人一眼能判断」的快照。
 *
 * 定位：不是再跑一次机器判定，而是把服务端看到的内容搬到用户面前，
 * 让用户在大陆网络打不开该站时依然能做人工确认。
 * 所以输出必须是可读文本，且必须诚实标注"服务端也被拦了"。
 */

import { detectWaf } from './engine.js';

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

function decodeEntities(input) {
  return input.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (raw, code) => {
    if (code[0] === '#') {
      const isHex = code[1] === 'x' || code[1] === 'X';
      const num = Number.parseInt(isHex ? code.slice(2) : code.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(num) || num < 0 || num > 0x10ffff) return raw;
      try {
        return String.fromCodePoint(num);
      } catch {
        return raw;
      }
    }
    return ENTITIES[code.toLowerCase()] ?? raw;
  });
}

/**
 * 正文被字节上限截断时，最后一个 <style>/<script> 往往没有闭合标签，
 * 直接剥标签会把几百 KB 的 CSS 当成正文吐给用户。先把这类尾巴切掉。
 */
function dropUnclosedBlocks(html) {
  let s = html;
  for (const tag of ['style', 'script', 'noscript', 'template', 'svg']) {
    const lower = s.toLowerCase();
    const open = lower.lastIndexOf(`<${tag}`);
    if (open === -1) continue;
    const close = lower.lastIndexOf(`</${tag}>`);
    if (open > close) s = s.slice(0, open);
  }
  return s;
}

/** HTML → 纯文本：去掉脚本样式、块级标签转换行、压缩空白 */
export function htmlToText(html) {
  if (!html) return '';
  let s = dropUnclosedBlocks(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  s = s.replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  s = s.replace(/[ \t\u00a0\u2000-\u200a\u202f]+/g, ' ');
  s = s.replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();
  return s;
}

function metaContent(html, key) {
  if (!html) return '';
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property|itemprop)\\s*=\\s*["']${escaped}["'][^>]*?content\\s*=\\s*["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*?(?:name|property|itemprop)\\s*=\\s*["']${escaped}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) {
      const value = decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
      if (value) return value;
    }
  }
  return '';
}

function pageTitle(html) {
  const m = /<title[^>]*>([\s\S]{0,400}?)<\/title>/i.exec(html || '');
  if (!m) return '';
  return decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
}

function clip(value, max) {
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * 逐行挑"像人话"的内容：短行、符号密度高的行基本都是 CSS/JS 残渣或导航按钮，
 * 一起塞给用户只会淹没真正的信息。
 */
function readableExcerpt(text, max = 900) {
  if (!text) return '';
  const good = [];
  let total = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length < 12) continue;
    const junk = (line.match(/[{};<>]/g) || []).length;
    if (junk / line.length > 0.02) continue;
    good.push(line);
    total += line.length;
    if (total >= max) break;
  }
  return clip(good.join('\n'), max);
}

/**
 * 拦截类型。区分这几类不是学术洁癖：
 * 「WAF 人机校验」「被网络层直接封锁」「跳登录页」「限流」对用户意味着不同的下一步，
 * 混成一句"无法判断"用户就不知道该去做什么。
 */
const NETWORK_BLOCK_HINTS = [
  "you've been blocked by network security",
  'blocked by network security',
  'whoa there, pardner',
  "this content isn't available right now",
  'your request has been blocked',
  'requests from your network',
  'unusual traffic from your computer',
  'cf-error-details',
];

function detectBlockKind({ raw, text, status, finalUrl }) {
  if (detectWaf(raw)) return 'waf';
  const hay = `${raw.slice(0, 120_000)}\n${text.slice(0, 20_000)}`.toLowerCase();
  if (NETWORK_BLOCK_HINTS.some((h) => hay.includes(h))) return 'blocked';
  if (/\/login|\/accounts\/login|signin|sign_in/.test(finalUrl || '')) return 'login';
  if (status === 429) return 'ratelimit';
  if (status === 403 || status === 401) return 'denied';
  return null;
}

/**
 * @param {object} input
 * @param {string} input.html       服务端拿到的原始响应
 * @param {number} input.status     HTTP 状态码
 * @param {string} input.url        实际请求的 profile 地址
 * @param {object} [input.site]     站点定义（用于取 errorMsg 做"不存在"特征判断）
 */
export function buildSnapshot({ html = '', status = 0, url = '', site = null }) {
  const raw = html || '';
  const text = htmlToText(raw);
  const blocked = detectWaf(raw);
  const contentTypeJson = /^\s*[[{]/.test(raw.slice(0, 40));

  // 站点自己声明的"用户不存在"提示，命中说明拿到的确实是 404 类页面
  const rawMessages = site && site.g !== undefined ? (Array.isArray(site.g) ? site.g : [site.g]) : [];
  const messages = rawMessages.filter((m) => typeof m === 'string' && m.length >= 4);
  const notFoundHit = messages.length
    ? messages.some((m) => text.includes(m) || raw.includes(m))
    : false;

  const title = metaContent(raw, 'og:title') || pageTitle(raw);
  const description =
    metaContent(raw, 'og:description') || metaContent(raw, 'description') || metaContent(raw, 'twitter:description');

  const blockKind = detectBlockKind({ raw, text, status, finalUrl: url });

  return {
    url,
    http: status,
    blocked,
    blockKind,
    empty: !text.trim() && !title,
    signals: {
      notFoundHit,
      notFoundPatterns: messages.length,
      json: contentTypeJson,
    },
    title: clip(title, 160),
    description: clip(description, 300),
    excerpt: readableExcerpt(text),
    chars: text.length,
    bytes: raw.length,
  };
}
