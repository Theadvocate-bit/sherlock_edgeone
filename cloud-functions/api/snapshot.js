/**
 * GET /api/snapshot?site=GitHub&u=torvalds
 *
 * 服务端代取单站点页面，压成可读快照返回。
 * 用途：用户本地网络打不开该站（Reddit、Instagram 等）时，
 * 由服务端把"它看到的页面"搬过来，让用户据此人工判定。
 *
 * 只用服务端直连，不做任何外网中转：拿到的可能是拦截页，这时会如实标注
 * 「被谁拦的」，绝不拿拦截页的内容冒充真实资料。
 */

import { interpolate, validateUsername, detectWaf, readCappedText } from '../lib/engine.js';
import { getSiteIndex } from '../lib/sites.js';
import { buildSnapshot } from '../lib/snapshot.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// 用完整浏览器头：很多站点对"像浏览器的请求"更宽容，也更容易拿到 SSR 内容
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Upgrade-Insecure-Requests': '1',
};

const MAX_BYTES = 800_000;
const TIMEOUT_MS = 15000;
/** 函数总时长上限 60s，单次取页留 15s，重试一次留余量 */
const RETRY_DELAY_MS = 400;

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store', ...CORS, ...extra },
  });
}

async function readDirect(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow', signal: controller.signal });
    const { text, truncated } = await readCappedText(res, MAX_BYTES);
    return { status: res.status, text, url: res.url || url, truncated };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 跨境取页偶发 ECONNRESET，重试一次能把这类抖动挡掉。
 * 但超时类失败不重试——重试只会把 15s 变成 30s，直接顶穿函数时长上限。
 */
async function withRetry(fn, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isTimeout =
        err?.name === 'AbortError' || /timeout|超时|timed out/i.test(err?.message || '') || err?.code === 'ETIMEDOUT';
      if (isTimeout || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  throw lastErr;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const name = url.searchParams.get('site') || url.searchParams.get('s') || '';
  const username = url.searchParams.get('u') || url.searchParams.get('username') || '';

  const check = validateUsername(username);
  if (!check.ok) return json({ error: check.error }, 400);

  const site = getSiteIndex().get(name);
  if (!site) return json({ error: `未知站点：${name}` }, 404);
  if (!site.u) return json({ error: '该站点缺少主页地址模板' }, 400);

  const encoded = check.value.replace(/ /g, '%20');
  const target = interpolate(site.u, encoded);
  if (!/^https?:\/\//i.test(target)) return json({ error: '站点地址无效' }, 400);

  const startedAt = Date.now();
  let page;
  try {
    page = await withRetry(() => readDirect(target));
  } catch (err) {
    const isTimeout = err?.name === 'AbortError' || /timeout|超时/i.test(err?.message || '');
    return json(
      {
        site: site.n,
        url: target,
        error: isTimeout
          ? '取页超时：服务端也没能在 15 秒内拿到页面'
          : `取页失败：${err?.message || err}`,
        ms: Date.now() - startedAt,
      },
      502,
    );
  }

  const snapshot = buildSnapshot({
    html: page.text,
    status: page.status,
    url: page.url || target,
    site,
  });

  return json(
    {
      site: site.n,
      home: site.m,
      ...snapshot,
      blocked: snapshot.blocked || detectWaf(page.text),
      truncated: Boolean(page.truncated),
      ms: Date.now() - startedAt,
    },
    200,
    { 'Cache-Control': 'no-store' },
  );
}
