/**
 * Sherlock 判定引擎（EdgeOne 版）
 * ------------------------------------------------------------------
 * 逻辑移植自 sherlock-project/sherlock 的 sherlock_project/sherlock.py：
 *   - 先用站点自己的 regexCheck 校验用户名是否合法，不合法直接标 illegal；
 *   - errorType = status_code：命中 errorCode，或状态码不在 2xx 区间 → 未注册；
 *   - errorType = message：在响应正文里找 errorMsg，找不到 → 已注册；
 *   - errorType = response_url：禁止跟随跳转，2xx → 已注册；
 *   - 额外的 WAF 指纹识别，避免把 Cloudflare 挑战页误判成"已注册"。
 * 为适配 Serverless 增加了：单站点超时、正文截断、HEAD 失败回退 GET。
 */

export const STATUS = {
  CLAIMED: 'claimed',
  AVAILABLE: 'available',
  ILLEGAL: 'illegal',
  WAF: 'waf',
  ERROR: 'error',
  UNKNOWN: 'unknown',
};

export const LIMITS = {
  /** 单次函数调用最多探测多少个站点（客户端按此分批） */
  maxSitesPerRequest: 24,
  /** 用户名长度上限 */
  maxUsernameLength: 64,
  /** 单站点默认超时（毫秒） */
  defaultTimeoutMs: 9000,
  maxTimeoutMs: 15000,
  /** 单站点最多读取多少字节正文，防止大页面打爆内存 */
  maxBodyBytes: 300_000,
  /** 单次调用内部并发数 */
  defaultConcurrency: 8,
  maxConcurrency: 20,
};

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * WAF 指纹：命中说明拿到的是拦截页/人机校验页，而不是真实个人主页。
 * 前 4 条与 sherlock 上游保持一致，后几条是针对常见 CDN 的补充。
 */
const WAF_PATTERNS = [
  '<span id="challenge-error-text">',
  'AwsWafIntegration.forceRefreshToken',
  '"perimeterxIdentifiers",{enumerable:',
  '.loading-spinner{visibility:hidden}body.no-js .challenge-running{display:none}',
  '<title>Just a moment...</title>',
  'window._cf_chl_opt',
  'cf-browser-verification',
  'Checking your browser before accessing',
  'Please enable JS and disable any ad blocker',
  'ddos-guard',
];

/** 把 "{}" 占位符替换成用户名（支持字符串 / 数组 / 对象，保持 sherlock 的递归语义） */
export function interpolate(value, username) {
  if (typeof value === 'string') return value.split('{}').join(username);
  if (Array.isArray(value)) return value.map((v) => interpolate(v, username));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, username);
    return out;
  }
  return value;
}

/**
 * Python 正则 → JS 正则。Sherlock 的数据里有少量 Python 专有写法，
 * 直接 new RegExp 会抛异常，这里做最小兼容，失败就跳过校验（宁可不校验，不可误杀）。
 */
export function compileRegex(pattern) {
  if (!pattern) return null;
  let source = pattern;
  let flags = '';
  const inline = source.match(/^\(\?([imsx]+)\)/);
  if (inline) {
    flags += inline[1].replace(/x/g, '');
    source = source.slice(inline[0].length);
  }
  source = source
    .replace(/\\Z/g, '$')
    .replace(/\\A/g, '^')
    .replace(/\(\?P</g, '(?<')
    .replace(/\(\?:/g, '(?:');
  try {
    return new RegExp(source, flags);
  } catch {
    try {
      return new RegExp(source.replace(/\\p\{[^}]+\}/g, '.'));
    } catch {
      return null;
    }
  }
}

function buildProfileUrl(site, username) {
  const encoded = username.replace(/ /g, '%20');
  return interpolate(site.u, encoded);
}

function buildProbe(site, username) {
  const encoded = username.replace(/ /g, '%20');
  return interpolate(site.p || site.u, encoded);
}

async function readCapped(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      size += value.byteLength;
      if (size >= maxBytes) {
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
    }
  } catch {
    /* 读取中断时用已到手的内容继续判断 */
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged) + (truncated ? '' : '');
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * 探测单个站点。
 * @param {object} site 精简后的站点定义 { n, m, u, p, t, g, c, e, r, h, o, d, x }
 * @param {string} username
 * @param {{timeoutMs?: number, maxBodyBytes?: number}} options
 * @returns {Promise<{name:string,home:string,url:string,status:string,http:number|null,ms:number,note?:string}>}
 */
export async function checkSite(site, username, options = {}) {
  const timeoutMs = Math.min(options.timeoutMs ?? LIMITS.defaultTimeoutMs, LIMITS.maxTimeoutMs);
  const maxBodyBytes = options.maxBodyBytes ?? LIMITS.maxBodyBytes;
  const startedAt = Date.now();
  const profileUrl = buildProfileUrl(site, username);
  const base = { name: site.n, home: site.m, url: profileUrl };

  // 1) 站点侧用户名校验，避免发出必然 404 的请求
  if (site.r) {
    const re = compileRegex(site.r);
    if (re && !re.test(username)) {
      return { ...base, status: STATUS.ILLEGAL, http: null, ms: 0 };
    }
  }

  const errorTypes = Array.isArray(site.t) ? site.t : [site.t];
  const onlyStatusCheck = errorTypes.length === 1 && errorTypes[0] === 'status_code';
  const method = (site.o || (onlyStatusCheck ? 'HEAD' : 'GET')).toUpperCase();
  const needsBody = errorTypes.some((t) => t !== 'status_code');
  const redirect = errorTypes.includes('response_url') ? 'manual' : 'follow';

  const headers = { ...DEFAULT_HEADERS, ...(site.h || {}) };
  let body;
  if (site.d !== undefined) {
    body = JSON.stringify(interpolate(site.d, username));
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
  }

  const probe = buildProbe(site, username);
  const effectiveMethod = method === 'HEAD' && needsBody ? 'GET' : method;
  const request = async (m) => {
    const { signal, clear } = timeoutSignal(timeoutMs);
    try {
      const res = await fetch(probe, {
        method: m,
        headers,
        body: m === 'HEAD' ? undefined : body,
        redirect,
        signal,
      });
      const text = m === 'HEAD' ? '' : await readCapped(res, maxBodyBytes);
      return { res, text };
    } finally {
      clear();
    }
  };

  let res;
  let text = '';
  try {
    const attempt = await request(effectiveMethod);
    res = attempt.res;
    text = attempt.text;

    // HEAD 被站点拒绝（405/403/501 等）时回退 GET，避免把"方法不支持"当成"用户名不存在"
    if (effectiveMethod === 'HEAD' && (res.status === 405 || res.status === 403 || res.status === 501)) {
      const retry = await request('GET');
      res = retry.res;
      text = retry.text;
    }
  } catch (err) {
    const reason = err?.name === 'AbortError' || /timeout/i.test(err?.message || '')
      ? '请求超时'
      : `请求失败：${err?.message || err}`;
    return { ...base, status: STATUS.ERROR, http: null, ms: Date.now() - startedAt, note: reason };
  }

  const status = res.status;
  const ms = Date.now() - startedAt;
  // 与 sherlock 一致：初始为 UNKNOWN，由下面的判定分支逐步落定
  const result = { ...base, status: STATUS.UNKNOWN, http: status, ms };

  // 2) WAF 指纹
  if (text && WAF_PATTERNS.some((p) => text.includes(p))) {
    result.status = STATUS.WAF;
    result.note = '站点返回了人机校验页，结果不可信';
    return result;
  }

  if (errorTypes.some((t) => !['message', 'status_code', 'response_url'].includes(t))) {
    result.status = STATUS.ERROR;
    result.note = `未知判定方式：${site.t}`;
    return result;
  }

  // 3) 正文关键词判定
  if (errorTypes.includes('message')) {
    const raw = site.g;
    const messages = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    if (!messages.length) {
      result.status = STATUS.ERROR;
      result.note = '站点缺少 errorMsg，无法判定';
      return result;
    }
    const hit = messages.some((msg) => typeof msg === 'string' && text.includes(msg));
    if (hit) {
      result.status = STATUS.AVAILABLE;
    } else if (status === 404 || status === 410) {
      // 页面本身就 404，基本可以确定账号不存在
      result.status = STATUS.AVAILABLE;
    } else if (status === 401 || status === 403 || status === 406 || status === 418 || status === 419 || status === 429 || status >= 500) {
      // 未命中"不存在"特征 + 明显是拒绝/限流状态码 → 服务端拿不到真实页面，不臆断
      result.status = STATUS.ERROR;
      result.note = `HTTP ${status}，疑似反爬拦截，未取到真实页面`;
    } else {
      result.status = STATUS.CLAIMED;
    }
  }

  // 4) 状态码判定（前面已判为"未注册"时不再覆盖，保持 sherlock 的短路语义）
  if (errorTypes.includes('status_code') && result.status !== STATUS.AVAILABLE) {
    const codes = site.c === undefined ? null : Array.isArray(site.c) ? site.c : [site.c];
    result.status = STATUS.CLAIMED;
    if (codes && codes.includes(status)) {
      result.status = STATUS.AVAILABLE;
    } else if (status === 429 || status >= 500) {
      // 目标站点自己挂了或被限流，不能据此断定"未注册"
      result.status = STATUS.ERROR;
      result.note = `HTTP ${status}，目标站点不可用或限流`;
    } else if (status >= 300 || status < 200) {
      result.status = STATUS.AVAILABLE;
    }
  }

  // 5) 跳转判定
  if (errorTypes.includes('response_url') && result.status !== STATUS.AVAILABLE) {
    result.status = status >= 200 && status < 300 ? STATUS.CLAIMED : STATUS.AVAILABLE;
  }

  if (result.status === STATUS.UNKNOWN) {
    result.status = STATUS.ERROR;
    result.note = '站点判定规则未产生结果';
  }

  return result;
}

/** 有并发上限的批量探测 */
export async function checkBatch(sites, username, options = {}) {
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? LIMITS.defaultConcurrency, LIMITS.maxConcurrency, sites.length || 1),
  );
  const results = new Array(sites.length);
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= sites.length) return;
      try {
        results[index] = await checkSite(sites[index], username, options);
      } catch (err) {
        results[index] = {
          name: sites[index].n,
          home: sites[index].m,
          url: interpolate(sites[index].u, username),
          status: STATUS.ERROR,
          http: null,
          ms: 0,
          note: `内部错误：${err?.message || err}`,
        };
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

export function validateUsername(username) {
  if (typeof username !== 'string') return { ok: false, error: '缺少用户名参数' };
  const value = username.trim();
  if (!value) return { ok: false, error: '用户名不能为空' };
  if (value.length > LIMITS.maxUsernameLength) {
    return { ok: false, error: `用户名长度不能超过 ${LIMITS.maxUsernameLength} 个字符` };
  }
  if (/[\s\u0000-\u001f]/.test(value) && !/^[\w.\- ]+$/.test(value)) {
    return { ok: false, error: '用户名包含非法字符' };
  }
  return { ok: true, value };
}
