#!/usr/bin/env node
/**
 * 模拟平台打包：只把 cloud-functions/ 目录复制到一个全新的位置（不带项目根的任何文件），
 * 再按平台的调用方式执行三个函数。用来验证「打包后目录结构变了函数会不会挂」。
 *
 *   node scripts/check-package.mjs
 */
import { mkdtemp, mkdir, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = await mkdtemp(path.join(tmpdir(), 'fn-package-'));
const target = path.join(stage, 'cloud-functions');

await mkdir(stage, { recursive: true });
// 平台只保证把 cloud-functions/ 下的模块带进构建产物，这里就只复制它
await cp(path.join(ROOT, 'cloud-functions'), target, { recursive: true });

const load = (rel) => import(pathToFileURL(path.join(target, rel)).href);
const ctx = (url, init) => ({ request: new Request(url, init), params: {}, env: {} });
const base = 'https://example.com';

let failures = 0;
const ok = (name, extra = '') => console.log(`  ✓ ${name} ${extra}`);
const bad = (name, err) => {
  failures += 1;
  console.log(`  ✗ ${name} → ${err?.stack?.split('\n').slice(0, 3).join('\n') || err}`);
};

console.log(`\n打包目录：${stage}\n（这里没有 package.json，也没有 data/、index.html，只有 cloud-functions/）\n`);

// 1) /api/sites
try {
  const mod = await load('api/sites.js');
  const res = await mod.onRequestGet(ctx(`${base}/api/sites`));
  const body = await res.json();
  if (res.status !== 200 || body.count < 100) throw new Error(`status=${res.status} count=${body.count}`);
  ok('/api/sites', `${body.count} 个站点`);
} catch (err) {
  bad('/api/sites', err);
}

// 2) /api/check
try {
  const mod = await load('api/check.js');
  const res = await mod.onRequest(ctx(`${base}/api/check?u=torvalds&s=GitHub,npm`, { method: 'GET' }));
  const body = await res.json();
  if (res.status !== 200 || body.count !== 2) throw new Error(`status=${res.status} body=${JSON.stringify(body).slice(0, 200)}`);
  const gh = body.results.find((r) => r.name === 'GitHub');
  if (gh?.status !== 'claimed') throw new Error(`GitHub 判定异常：${JSON.stringify(gh)}`);
  ok('/api/check', `${body.results.map((r) => `${r.name}=${r.status}`).join(' ')}`);
} catch (err) {
  bad('/api/check', err);
}

// 3) /api/check 参数校验
try {
  const mod = await load('api/check.js');
  const empty = await mod.onRequest(ctx(`${base}/api/check?u=&s=GitHub`, { method: 'GET' }));
  const tooMany = await mod.onRequest(
    ctx(`${base}/api/check?u=torvalds&s=${Array.from({ length: 30 }, (_, i) => `s${i}`).join(',')}`, { method: 'GET' }),
  );
  if (empty.status !== 400 || tooMany.status !== 400) throw new Error(`empty=${empty.status} tooMany=${tooMany.status}`);
  ok('参数校验', '空用户名 / 超量站点 → 400');
} catch (err) {
  bad('参数校验', err);
}

// 4) /api/snapshot（取一个稳定的站点，验证快照链路）
try {
  const mod = await load('api/snapshot.js');
  const res = await mod.onRequestGet(ctx(`${base}/api/snapshot?site=GitHub&u=torvalds`));
  const body = await res.json();
  if (res.status !== 200 || typeof body.http !== 'number') throw new Error(`status=${res.status} body=${JSON.stringify(body).slice(0, 200)}`);
  ok('/api/snapshot', `http=${body.http} title=${JSON.stringify(body.title || '').slice(0, 50)} blockKind=${body.blockKind}`);
} catch (err) {
  bad('/api/snapshot', err);
}

// 5) 未知站点
try {
  const mod = await load('api/snapshot.js');
  const res = await mod.onRequestGet(ctx(`${base}/api/snapshot?site=NoSuchSite&u=torvalds`));
  if (res.status !== 404) throw new Error(`status=${res.status}`);
  ok('未知站点 → 404');
} catch (err) {
  bad('未知站点', err);
}

await rm(stage, { recursive: true, force: true });
console.log(failures ? `\n✗ ${failures} 项失败\n` : '\n✓ 打包后全部通过\n');
process.exit(failures ? 1 : 0);
