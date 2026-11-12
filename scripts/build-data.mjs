#!/usr/bin/env node
/**
 * 把 sherlock-project/sherlock 的 data.json 编译成本项目使用的紧凑数据集。
 *
 *   node scripts/build-data.mjs            # 用本地快照 data/sherlock-source.json
 *   node scripts/build-data.mjs --remote   # 直接从 GitHub 拉最新数据（构建机需可访问 GitHub）
 *
 * 输出两份（内容相同，用途不同）：
 *   data/sites.json                     便于人工查看 / diff
 *   cloud-functions/lib/sites-data.js   云函数静态 import 的模块
 *
 * 为什么要额外生成一个 .js：云函数打包后目录结构由平台决定，用相对路径去
 * readFile 很容易在线上失效；把数据变成普通 ES 模块后，它跟着 import 图走，
 * 不再依赖运行时的文件布局。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'data', 'sherlock-source.json');
const OUTPUT = path.join(ROOT, 'data', 'sites.json');
const MODULE_OUTPUT = path.join(ROOT, 'cloud-functions', 'lib', 'sites-data.js');
const UPSTREAM =
  'https://raw.githubusercontent.com/sherlock-project/sherlock/master/sherlock_project/resources/data.json';

/** 常用站点：首页默认展示这些，覆盖主流平台 */
const POPULAR = [
  'GitHub', 'GitLab', 'BitBucket', 'Codeberg', 'Gitee', 'Twitter', 'Instagram', 'Reddit',
  'YouTube', 'TikTok', 'Telegram', 'Discord', 'Twitch', 'Steam Community (User)',
  'Pinterest', 'tumblr', 'Medium', 'DeviantArt', 'SoundCloud', 'Spotify', 'VK', 'Dribbble',
  'Behance', 'Flickr', 'HackerNews', 'HackerOne', 'Keybase', 'Kaggle', 'Codeforces',
  'LeetCode', 'npm', 'PyPi', 'Docker Hub', 'HackerRank', 'Codepen', 'Codewars', 'TryHackMe',
  'HackTheBox', 'Unsplash', 'Duolingo', 'Strava', 'Letterboxd', 'ProductHunt', 'Patreon',
  'kofi', 'BuyMeACoffee', 'Giphy', 'Imgur', 'Bandcamp', 'last.fm', 'Trello', 'Wakatime',
  'Hugging Face', 'Replit.com', 'Scratch', 'Roblox', 'Minecraft', 'osu!', 'Chess', 'Lichess',
  'Bluesky', 'threads', 'mastodon.social', 'LinkedIn', 'Fandom', 'Wattpad', 'GoodReads',
  'MyAnimeList', 'Anilist', 'TradingView', 'Gravatar', 'Linktree', 'About.me', 'Substack',
  'WordPress', 'SourceForge', 'Pastebin', 'Disqus', 'Slack', 'Snapchat', 'Vimeo', 'Rumble',
  'Odysee', 'Kick', 'Archive of Our Own', 'Freesound', 'SlideShare', 'Venmo',
];

/** 只需要保留判定逻辑用得到的字段，键名压缩以减小体积 */
function compact(name, raw) {
  const entry = {
    n: name,
    m: raw.urlMain || '',
    u: raw.url,
  };
  if (raw.urlProbe) entry.p = raw.urlProbe;
  entry.t = raw.errorType;
  if (raw.errorMsg !== undefined) entry.g = raw.errorMsg;
  if (raw.errorCode !== undefined) entry.c = raw.errorCode;
  if (raw.errorUrl !== undefined) entry.e = raw.errorUrl;
  if (raw.regexCheck) entry.r = raw.regexCheck;
  if (raw.headers && Object.keys(raw.headers).length) entry.h = raw.headers;
  if (raw.request_method) entry.o = raw.request_method;
  if (raw.request_payload !== undefined) entry.d = raw.request_payload;
  if (raw.isNSFW) entry.x = 1;
  return entry;
}

async function loadSource() {
  if (process.argv.includes('--remote')) {
    process.stdout.write('→ 正在从 GitHub 拉取上游 data.json … ');
    const res = await fetch(UPSTREAM, { headers: { 'User-Agent': 'sherlock-edgeone-build' } });
    if (!res.ok) throw new Error(`上游下载失败: HTTP ${res.status}`);
    const text = await res.text();
    await writeFile(SOURCE, text);
    console.log('已更新本地快照');
    return JSON.parse(text);
  }
  return JSON.parse(await readFile(SOURCE, 'utf8'));
}

const raw = await loadSource();
const names = Object.keys(raw).filter((k) => k !== '$schema');
/**
 * 上游数据修正表：只改"已经和现实不符"的字段，避免手改 data/sites.json
 * （手改的会在下次 build 时被覆盖，反而更难发现问题）。
 *
 *   Twitter: urlProbe 指向的 nitter 实例早已下线，探测必然是 fetch failed；
 *            x.com 本体直连可访问，去掉 probe，并补上新版 404 页的特征串。
 */
const PATCHES = {
  Twitter(info) {
    delete info.urlProbe;
    const extra = ['<title>User Profile Not Found', 'This account doesn’t exist'];
    const current = Array.isArray(info.errorMsg) ? info.errorMsg : info.errorMsg ? [info.errorMsg] : [];
    info.errorMsg = [...current, ...extra.filter((m) => !current.includes(m))];
  },
};

const sites = [];
const skipped = [];

for (const name of names) {
  const info = raw[name];
  if (!info || !info.url || !info.errorType) {
    skipped.push(name);
    continue;
  }
  const patched = { ...info };
  if (PATCHES[name]) PATCHES[name](patched);
  const item = compact(name, patched);
  item.k = POPULAR.includes(name) ? 1 : 0;
  sites.push(item);
}

const popularMissing = POPULAR.filter((n) => !raw[n]);
sites.sort((a, b) => a.n.localeCompare(b.n, 'en'));

const payload = {
  source: 'sherlock-project/sherlock',
  upstream: 'https://github.com/sherlock-project/sherlock',
  generatedAt: new Date().toISOString(),
  count: sites.length,
  popular: sites.filter((s) => s.k).length,
  sites,
};

await writeFile(OUTPUT, JSON.stringify(payload));
await writeFile(
  MODULE_OUTPUT,
  [
    '// 本文件由 scripts/build-data.mjs 生成，请勿手工编辑。',
    `// 上游：${UPSTREAM}`,
    '// 命名导出（不用 export default）：平台的入口识别会把 default 导出当成框架实例，',
    '// 命名导出才能确保这个文件只被当作辅助模块。',
    `export const siteData = ${JSON.stringify(payload)};`,
    '',
  ].join('\n'),
);
const bytes = Buffer.byteLength(JSON.stringify(payload));
console.log(`✓ ${sites.length} 个站点（常用 ${payload.popular} 个），输出 ${(bytes / 1024).toFixed(1)} KB`);
console.log(`  → data/sites.json + cloud-functions/lib/sites-data.js`);
if (skipped.length) console.log(`  跳过 ${skipped.length} 个无效条目: ${skipped.join(', ')}`);
if (popularMissing.length) console.log(`  ⚠ 常用列表里这些站点在数据集中不存在: ${popularMissing.join(', ')}`);
