import { readFile } from 'node:fs/promises';

let cached = null;

/**
 * 读取站点数据。优先读构建产物里的 data/sites.json（由 edgeone.json 的
 * cloudFunctions.nodejs.includeFiles 打进函数包），失败再退回同源静态请求。
 * 结果在函数实例内缓存，避免每次调用都读盘。
 */
export async function loadSiteData(origin) {
  if (cached) return cached;

  try {
    const file = new URL('../../data/sites.json', import.meta.url);
    cached = JSON.parse(await readFile(file, 'utf8'));
    return cached;
  } catch {
    /* 继续尝试网络读取 */
  }

  if (origin) {
    const res = await fetch(new URL('/data/sites.json', origin), {
      headers: { 'User-Agent': 'sherlock-edgeone' },
    });
    if (res.ok) {
      cached = await res.json();
      return cached;
    }
  }

  throw new Error('站点数据加载失败，请确认 data/sites.json 已随项目部署');
}

export async function getSiteIndex(origin) {
  const data = await loadSiteData(origin);
  if (!data.__index) {
    const map = new Map();
    for (const site of data.sites) map.set(site.n, site);
    Object.defineProperty(data, '__index', { value: map, enumerable: false });
  }
  return data.__index;
}

export function publicSiteList(data) {
  return data.sites.map((s) => ({
    n: s.n,
    m: s.m,
    k: s.k ? 1 : 0,
    x: s.x ? 1 : 0,
  }));
}
