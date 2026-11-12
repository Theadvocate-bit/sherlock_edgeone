import { loadSiteData, publicSiteList } from '../../lib/sites.mjs';

export async function onRequestGet(context) {
  try {
    const data = await loadSiteData(new URL(context.request.url).origin);
    return new Response(
      JSON.stringify({
        source: data.source,
        upstream: data.upstream,
        generatedAt: data.generatedAt,
        count: data.count,
        popular: data.popular,
        sites: publicSiteList(data),
      }),
      {
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'Cache-Control': 'public, max-age=3600',
          'Access-Control-Allow-Origin': '*',
        },
      },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    });
  }
}
