import SITE_DATA from './sites-data.mjs';

let cached = null;

/**
 * 站点数据直接以 JS 模块的形式静态 import（lib/sites-data.mjs，由
 * scripts/build-data.mjs 生成）。这样打包器会把数据打进函数产物，
 * 运行时既不用读 fs，也不用 fetch 自身静态资源——这两条路在 Makers
 * 打包后的目录结构里都不可靠。
 *
 * 仍保留函数形态 + 实例内缓存，调用方无需关心数据来源。
 */
export async function loadSiteData() {
  if (!cached) cached = SITE_DATA;
  return cached;
}

export async function getSiteIndex() {
  const data = await loadSiteData();
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
