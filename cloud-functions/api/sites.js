import { getSiteData, publicSiteList } from '../lib/sites.js';

/**
 * GET /api/sites
 * 返回站点清单给前端。数据在构建时被编译进 cloud-functions/lib/sites-data.js，
 * 不依赖运行时读文件，因此函数打包后的目录结构如何变化都不影响。
 */
export async function onRequestGet() {
  const data = getSiteData();
  return new Response(
    JSON.stringify({
      source: data.source,
      upstream: data.upstream,
      generatedAt: data.generatedAt,
      count: data.count,
      popular: data.popular,
      sites: publicSiteList(),
    }),
    {
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
}
