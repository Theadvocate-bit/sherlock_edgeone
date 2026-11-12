#!/usr/bin/env node
/**
 * 引擎冒烟测试：拿几个真实站点验证三种判定逻辑是否与 Sherlock 一致。
 *   node scripts/test-engine.mjs [username]
 *
 * 特意走和线上完全相同的入口（cloud-functions/lib），
 * 这样数据模块、判定逻辑一旦在打包后失效，这里能第一时间发现。
 */
import { checkBatch } from '../cloud-functions/lib/engine.js';
import { getSiteIndex, getSiteData } from '../cloud-functions/lib/sites.js';

const index = getSiteIndex();
const data = getSiteData();

const username = process.argv[2] || 'torvalds';
const targets = ['GitHub', 'GitLab', 'Reddit', 'HackerNews', 'npm', 'PyPi', 'Keybase', 'Codeforces'];
const sites = targets.map((n) => index.get(n)).filter(Boolean);

console.log(`\n数据集：${data.count} 个站点（常用 ${data.popular}），生成于 ${data.generatedAt}`);
console.log(`探测用户名 "${username}"，${sites.length} 个站点\n`);
const started = Date.now();
const results = await checkBatch(sites, username, { timeoutMs: 10000, concurrency: 8 });
for (const r of results) {
  const label = { claimed: '已注册', available: '未注册', illegal: '不合法', waf: 'WAF', error: '失败' }[r.status] || r.status;
  console.log(
    `  ${r.name.padEnd(14)} ${label.padEnd(8)} http=${String(r.http ?? '—').padEnd(4)} ${String(r.ms).padStart(5)}ms  ${r.note || ''}`,
  );
}
console.log(`\n总耗时 ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

const github = results.find((r) => r.name === 'GitHub');
if (!github || github.status !== 'claimed') {
  console.error('✗ 预期 GitHub 判定为 claimed，实际：', github?.status);
  process.exit(1);
}
console.log('✓ GitHub 判定通过');
