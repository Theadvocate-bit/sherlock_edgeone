import { checkBatch, validateUsername, LIMITS, STATUS } from '../../lib/engine.mjs';
import { getSiteIndex } from '../../lib/sites.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': 'no-store',
      ...CORS,
      ...extra,
    },
  });
}

async function readInput(context) {
  const { request } = context;
  const url = new URL(request.url);
  let username = url.searchParams.get('u') || url.searchParams.get('username') || '';
  let names = [];
  let timeoutMs = Number(url.searchParams.get('t')) || LIMITS.defaultTimeoutMs;
  let concurrency = Number(url.searchParams.get('c')) || LIMITS.defaultConcurrency;

  if (request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (body && typeof body === 'object') {
      if (typeof body.username === 'string') username = body.username;
      if (typeof body.u === 'string') username = body.u;
      if (Array.isArray(body.sites)) names = body.sites;
      else if (Array.isArray(body.s)) names = body.s;
      if (Number(body.timeoutMs)) timeoutMs = Number(body.timeoutMs);
      if (Number(body.concurrency)) concurrency = Number(body.concurrency);
    }
  } else if (url.searchParams.get('s')) {
    names = url.searchParams.get('s').split(',');
  }

  return { username, names, timeoutMs, concurrency };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return onRequestOptions();

  const { username, names, timeoutMs, concurrency } = await readInput(context);

  const check = validateUsername(username);
  if (!check.ok) return json({ error: check.error }, 400);

  const requested = [...new Set(names.map((n) => String(n).trim()).filter(Boolean))];
  if (!requested.length) return json({ error: '请至少选择一个站点' }, 400);
  if (requested.length > LIMITS.maxSitesPerRequest) {
    return json({ error: `单次最多探测 ${LIMITS.maxSitesPerRequest} 个站点，请分批请求` }, 400);
  }

  const startedAt = Date.now();
  let index;
  try {
    index = await getSiteIndex(new URL(context.request.url).origin);
  } catch (err) {
    return json({ error: err.message }, 500);
  }

  const sites = [];
  const missing = [];
  for (const name of requested) {
    const site = index.get(name);
    if (site) sites.push(site);
    else missing.push(name);
  }

  const results = await checkBatch(sites, check.value, {
    timeoutMs: Math.min(Math.max(timeoutMs, 2000), LIMITS.maxTimeoutMs),
    concurrency: Math.min(Math.max(concurrency, 1), LIMITS.maxConcurrency),
  });

  for (const name of missing) {
    results.push({
      name,
      home: '',
      url: '',
      status: STATUS.ERROR,
      http: null,
      ms: 0,
      note: '站点不在数据集中',
    });
  }

  return json({
    username: check.value,
    took: Date.now() - startedAt,
    count: results.length,
    results,
  });
}
