#!/usr/bin/env node
/**
 * 本地预览服务器：模拟云函数平台的「静态资源 + 函数路由」行为。
 * 不需要登录，`npm run preview` 后访问 http://localhost:8787
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { onRequest as checkHandler, onRequestOptions } from '../cloud-functions/api/check.js';
import { onRequestGet as sitesHandler } from '../cloud-functions/api/sites.js';
import { onRequestGet as snapshotHandler, onRequestOptions as snapshotOptions } from '../cloud-functions/api/snapshot.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8787;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

async function toRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  return new Request(url, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
  });
}

async function send(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  try {
    const { pathname } = new URL(req.url, 'http://localhost');

    if (pathname === '/api/check') {
      if (req.method === 'OPTIONS') return send(res, await onRequestOptions());
      return send(res, await checkHandler({ request: await toRequest(req), params: {}, env: {} }));
    }
    if (pathname === '/api/snapshot') {
      if (req.method === 'OPTIONS') return send(res, await snapshotOptions());
      return send(res, await snapshotHandler({ request: await toRequest(req), params: {}, env: process.env }));
    }
    if (pathname === '/api/sites') {
      return send(res, await sitesHandler({ request: await toRequest(req), params: {}, env: {} }));
    }

    let filePath = path.join(ROOT, decodeURIComponent(pathname));
    if (!filePath.startsWith(ROOT)) {
      res.statusCode = 403;
      return res.end('Forbidden');
    }
    const info = await stat(filePath).catch(() => null);
    if (!info || info.isDirectory()) filePath = path.join(ROOT, 'index.html');

    const data = await readFile(filePath);
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(data);
    if (pathname !== '/favicon.ico') {
      console.log(`  ${req.method} ${pathname} → ${res.statusCode} (${Date.now() - started}ms)`);
    }
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
});

server.listen(PORT, () => {
  console.log(`\n  Sherlock 本地预览 → http://localhost:${PORT}\n`);
});
