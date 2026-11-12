/**
 * 站点数据的唯一入口。
 *
 * 这里刻意不读文件、不拼路径：站点数据在构建时被编译成同目录的
 * `sites-data.js`（普通 ES 模块），由打包器/模块加载器直接解析。
 *
 * 原因：平台在部署时只保证把 `cloud-functions/` 下的模块复制进构建产物，
 * 函数文件的实际落盘路径、以及 `includeFiles` 的复制位置都属于平台实现细节。
 * 一旦用 `import.meta.url` 去拼 `../data/sites.json`，打包后目录一变就
 * "本地能跑、线上 500"。改成静态模块后，数据跟着代码一起走，与目录结构无关。
 */

import { siteData } from './sites-data.js';

const data = siteData;

let index = null;

/** 原始数据集（含 source / generatedAt / count / popular） */
export function getSiteData() {
  return data;
}

/** 名称 → 站点定义的索引，进程内复用 */
export function getSiteIndex() {
  if (!index) index = new Map(data.sites.map((site) => [site.n, site]));
  return index;
}

/** 给前端的最小字段集 */
export function publicSiteList() {
  return data.sites.map((s) => ({
    n: s.n,
    m: s.m,
    k: s.k ? 1 : 0,
    x: s.x ? 1 : 0,
  }));
}
