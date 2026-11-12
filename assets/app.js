const BATCH_SIZE = 16;
// 只有这两类结果"值得人工复核"：拦截页和请求失败都可能只是机房 IP 被风控 / 网络抖动。
// illegal（用户名不合法）是站点规则决定的，打开也一样，不需要复核。
const REVIEWABLE = new Set(['waf', 'error']);
const REVIEW_KEY = 'sherlock.reviews.v1';
const STATUS_ORDER = ['claimed', 'available', 'illegal', 'waf', 'error', 'unreachable', 'pending'];
const STATUS_LABEL = {
  claimed: '已注册',
  available: '未注册',
  illegal: '用户名不合法',
  waf: '人机校验拦截',
  error: '请求失败',
  unreachable: '网络不可达',
  pending: '待检测',
};

const state = {
  sites: [],
  scope: 'popular',
  nsfw: false,
  username: '',
  results: new Map(),
  order: [],
  filter: 'claimed',
  running: false,
  aborted: false,
  total: 0,
  done: 0,
  startedAt: 0,
  batchTimes: [],
  controllers: new Set(),
  renderTimer: 0,
  reviews: {},
  openReview: null,
  /** 服务端代取页面的结果缓存：`${username}:${site}` → {state,data} */
  snapshots: new Map(),
};

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* ---------------- 启动 ---------------- */

init();

async function init() {
  bindEvents();
  loadReviews();
  await loadSites();
  applyUrlParams();
}

function bindEvents() {
  $('search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.running) return stopScan();
    const value = $('username').value.trim();
    if (!value) {
      toast('先输入一个用户名');
      $('username').focus();
      return;
    }
    startScan(value);
  });

  document.querySelectorAll('[data-sample]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('username').value = btn.dataset.sample;
      $('username').focus();
    });
  });

  document.querySelectorAll('#scope-switch .seg').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.running) {
        toast('检测进行中，结束后可切换范围');
        return;
      }
      document.querySelectorAll('#scope-switch .seg').forEach((b) => b.classList.toggle('active', b === btn));
      state.scope = btn.dataset.scope;
      updateCounts();
    });
  });

  $('nsfw-toggle').addEventListener('change', (event) => {
    if (state.running) {
      event.target.checked = state.nsfw;
      toast('检测进行中，结束后可切换范围');
      return;
    }
    state.nsfw = event.target.checked;
    updateCounts();
  });

  $('advanced-toggle').addEventListener('click', () => {
    const panel = $('advanced');
    const open = panel.hidden;
    panel.hidden = !open;
    $('advanced-toggle').setAttribute('aria-expanded', String(open));
  });

  $('stop-btn').addEventListener('click', stopScan);

  document.querySelectorAll('#filter-tabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#filter-tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
      state.filter = tab.dataset.filter;
      renderResults();
    });
  });

  $('export-json').addEventListener('click', exportJson);
  $('export-csv').addEventListener('click', exportCsv);
  $('copy-link').addEventListener('click', copyLink);
  $('clear-reviews').addEventListener('click', clearReviews);
  $('review-jump').addEventListener('click', toggleReviewFilter);

  // 行内的复核交互走事件委托：列表会整体重渲染，逐行绑定会失效。
  $('result-list').addEventListener('click', onResultClick);
}

function toggleReviewFilter() {
  state.filter = state.filter === 'review' ? 'all' : 'review';
  document.querySelectorAll('#filter-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.filter === state.filter));
  updateStats();
  renderResults();
  $('results-panel').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function onResultClick(event) {
  const toggle = event.target.closest('[data-review-toggle]');
  if (toggle) {
    const name = toggle.dataset.reviewToggle;
    state.openReview = state.openReview === name ? null : name;
    renderResults();
    if (state.openReview) {
      const bar = $('result-list').querySelector(`.review-bar[data-for="${cssEscape(name)}"]`);
      bar?.scrollIntoView({ block: 'nearest' });
    }
    return;
  }

  const copy = event.target.closest('[data-copy]');
  if (copy) {
    copyText(copy.dataset.copy);
    return;
  }

  const snap = event.target.closest('[data-snapshot]');
  if (snap) {
    fetchSnapshot(snap.dataset.snapshot, snap);
    return;
  }

  const mark = event.target.closest('[data-review]');
  if (!mark) return;
  const name = mark.dataset.site;
  const verdict = mark.dataset.review || null;
  setReview(state.username, name, verdict);

  // 在「只看待复核」里标记完，自动展开下一条，方便连续过一遍
  let next = null;
  if (state.filter === 'review' && verdict) {
    next = state.order.find((n) => {
      const item = state.results.get(n);
      return item && canReview(item) && !reviewFor(state.username, n);
    }) || null;
  }
  if (state.filter === 'review' && !next && counts().review === 0) {
    state.filter = 'all';
    document.querySelectorAll('#filter-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.filter === 'all'));
  }
  state.openReview = next;

  updateStats();
  renderResults();
  if (next) {
    $('result-list').querySelector(`.review-bar[data-for="${cssEscape(next)}"]`)?.scrollIntoView({ block: 'nearest' });
  }
  toast(
    verdict === 'claimed'
      ? `${name} 已标记为「已注册」`
      : verdict === 'available'
        ? `${name} 已标记为「未注册」`
        : verdict === 'unreachable'
          ? `${name} 已标记为「网络不可达」，移出待复核`
          : `${name} 的人工标记已撤销`,
  );
}

async function copyText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('链接已复制');
  } catch {
    toast(text);
  }
}

/* ---------------- 服务端代看（/api/snapshot） ---------------- */

const BLOCK_KIND_TEXT = {
  waf: '人机校验拦截',
  blocked: '遭到网络层封锁',
  ratelimit: '被限流',
  login: '被跳转到登录页',
  denied: '拒绝访问',
};

const snapshotKey = (name) => `${state.username}:${name}`;

function snapshotHtml(name) {
  const entry = state.snapshots.get(snapshotKey(name));
  if (!entry) return '';
  if (entry.state === 'loading') return '<div class="snap loading">正在用服务端出口取页面…（通常 3–10 秒）</div>';
  if (entry.state === 'error') return `<div class="snap bad"><p class="snap-verdict bad">取页失败：${esc(entry.message)}</p></div>`;
  return renderSnapshot(entry.data);
}

function renderSnapshot(data) {
  const kind = data.blockKind ? BLOCK_KIND_TEXT[data.blockKind] || data.blockKind : '';
  const head = `HTTP ${data.http}${kind ? ` · ${kind}` : ''}`;
  const hasContent = Boolean(data.title || data.description || data.excerpt);

  let verdict;
  if (data.blockKind) {
    // 只要判定为拦截，页面里的内容一律不能当作账号信息 —— 哪怕它"看起来有标题"
    verdict = `<p class="snap-verdict bad">服务端被挡住了（${head}）。以下是拦截页本身，不能用来判断账号是否存在，这条得靠你自己的网络确认。</p>`;
  } else if (!hasContent) {
    verdict = `<p class="snap-verdict bad">服务端拿到了 ${head}，但页面里没有可读内容（可能是纯 JS 渲染，或页面太大只取到脚本和样式）。</p>`;
  } else {
    verdict = `<p class="snap-verdict ok">服务端读到的页面（${head}），可据此判断：</p>`;
  }

  const excerpt = data.blockKind ? (data.excerpt || '').slice(0, 240) : data.excerpt;
  const body = [
    data.title && !data.blockKind ? `<p class="snap-title">${esc(data.title)}</p>` : '',
    data.description && !data.blockKind ? `<p class="snap-desc">${esc(data.description)}</p>` : '',
    excerpt ? `<pre class="snap-excerpt">${esc(excerpt)}</pre>` : '',
  ].join('');

  const note = data.truncated ? '<p class="snap-note">页面较大，只读取了前 800KB。</p>' : '';

  return `<div class="snap">${verdict}${body}${note}</div>`;
}

function repaintSnapshot(name) {
  const slot = $('result-list').querySelector(`.snap-slot[data-snap-for="${cssEscape(name)}"]`);
  if (slot) slot.innerHTML = snapshotHtml(name);
}

async function fetchSnapshot(name, button) {
  const key = snapshotKey(name);
  if (state.snapshots.get(key)?.state === 'loading') return;
  state.snapshots.set(key, { state: 'loading' });
  repaintSnapshot(name);
  button.disabled = true;
  try {
    const url = new URL('/api/snapshot', location.origin);
    url.searchParams.set('site', name);
    url.searchParams.set('u', state.username);
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.snapshots.set(key, { state: 'ok', data });
  } catch (err) {
    state.snapshots.set(key, { state: 'error', message: err?.message || '请求失败' });
  } finally {
    button.disabled = false;
    repaintSnapshot(name);
  }
}

async function loadSites() {
  try {
    const res = await fetch('/api/sites');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.sites = data.sites;
    $('site-count').textContent = data.count;
    const chip = $('runtime-chip');
    chip.textContent = `${data.count} 个站点`;
    chip.title = `站点数据生成于 ${new Date(data.generatedAt).toLocaleString('zh-CN')}`;
    updateCounts();
  } catch (err) {
    $('site-count').textContent = '加载失败';
    toast(`站点数据加载失败：${err.message}`);
  }
}

function activeSites() {
  return state.sites.filter((s) => (state.scope === 'popular' ? s.k === 1 : true) && (state.nsfw || s.x !== 1));
}

function updateCounts() {
  const all = state.sites.filter((s) => state.nsfw || s.x !== 1);
  $('popular-count').textContent = state.sites.filter((s) => s.k === 1 && (state.nsfw || s.x !== 1)).length;
  $('all-count').textContent = all.length;
}

/* ---------------- 扫描 ---------------- */

async function startScan(username) {
  // 与服务端 validateUsername 保持一致：这些字符会把站点 URL 改写成别的意思
  if (/[/\\?#&\u0000-\u001f]/.test(username)) {
    toast('用户名不能包含 / \\ ? # & 等字符');
    return;
  }
  const targets = activeSites();
  if (!targets.length) {
    toast('没有可检测的站点');
    return;
  }

  state.running = true;
  state.aborted = false;
  state.username = username;
  state.openReview = null;
  state.results = new Map(targets.map((s) => [s.n, { name: s.n, home: s.m, status: 'pending', http: null, ms: 0 }]));
  state.order = targets.map((s) => s.n);
  state.total = targets.length;
  state.done = 0;
  state.startedAt = Date.now();
  state.batchTimes = [];
  // 扫描期间先看全部，结果落定的同时用户能看到进展；结束后自动切到「已注册」。
  state.filter = 'all';
  $('username').value = username;

  document.querySelectorAll('#filter-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.filter === 'all'));
  $('stats').hidden = false;
  $('results-panel').hidden = false;
  $('progress-wrap').hidden = false;
  $('stop-btn').hidden = false;
  $('submit-btn').classList.add('busy');
  $('submit-btn').disabled = false;
  $('submit-btn').querySelector('.btn-label').textContent = '停止';
  updateStats();
  renderResults();
  updateProgress();

  const timeoutMs = clamp(Number($('opt-timeout').value) || 9000, 2000, 15000);
  const serverConcurrency = clamp(Number($('opt-server-concurrency').value) || 8, 1, 20);
  const browserConcurrency = clamp(Number($('opt-browser-concurrency').value) || 6, 1, 12);

  const batches = [];
  let start = 0;
  // 首批只放 6 个站点，让第一屏结果尽快出现（约 4 秒），其余按 BATCH_SIZE 切分
  if (targets.length > BATCH_SIZE) {
    batches.push(targets.slice(0, 6).map((s) => s.n));
    start = 6;
  }
  for (let i = start; i < targets.length; i += BATCH_SIZE) {
    batches.push(targets.slice(i, i + BATCH_SIZE).map((s) => s.n));
  }

  let cursor = 0;
  const worker = async () => {
    for (;;) {
      if (state.aborted) return;
      const index = cursor++;
      if (index >= batches.length) return;
      await runBatch(batches[index], { timeoutMs, serverConcurrency });
      if (state.aborted) return;
    }
  };

  await Promise.all(Array.from({ length: Math.min(browserConcurrency, batches.length) }, worker));
  finishScan();
}

async function runBatch(names, options, attempt = 1) {
  const startedAt = Date.now();
  const controller = new AbortController();
  state.controllers.add(controller);
  const params = new URLSearchParams({
    u: state.username,
    s: names.join(','),
    t: String(options.timeoutMs),
    c: String(options.serverConcurrency),
  });

  try {
    const res = await fetch(`/api/check?${params.toString()}`, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const error = new Error(body.error || `HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    const data = await res.json();
    for (const item of data.results) {
      if (state.results.has(item.name)) state.results.set(item.name, item);
    }
    state.batchTimes.push(Date.now() - startedAt);
    state.done = state.order.filter((n) => state.results.get(n)?.status !== 'pending').length;
    updateStats();
    updateProgress();
    scheduleRender();
  } catch (err) {
    if (state.aborted || err.name === 'AbortError') return;
    // 4xx 是参数错了（比如用户名不合法），重试没有意义；5xx / 网络错误才值得再试一次
    const retryable = err.status ? err.status >= 500 || err.status === 429 : true;
    if (retryable && attempt < 2) {
      return runBatch(names, options, attempt + 1);
    }
    for (const name of names) {
      const site = state.results.get(name);
      if (site && site.status === 'pending') {
        state.results.set(name, { ...site, status: 'error', ms: 0, note: err.message || '批次请求失败' });
      }
    }
    state.done = state.order.filter((n) => state.results.get(n)?.status !== 'pending').length;
    updateStats();
    updateProgress();
    scheduleRender();
  } finally {
    state.controllers.delete(controller);
  }
}

function stopScan() {
  if (!state.running) return;
  state.aborted = true;
  for (const controller of state.controllers) controller.abort();
  state.controllers.clear();
  finishScan();
  toast('已停止检测');
}

function finishScan() {
  state.running = false;
  $('stop-btn').hidden = true;
  $('submit-btn').classList.remove('busy');
  $('submit-btn').querySelector('.btn-label').textContent = '开始检测';
  const pending = state.total - state.done;
  if (state.aborted && pending > 0) {
    $('progress-text').textContent = `已停止 · 完成 ${state.done} / ${state.total}`;
    $('progress-eta').textContent = '';
  } else {
    const seconds = ((Date.now() - state.startedAt) / 1000).toFixed(1);
    $('progress-text').textContent = `完成 · ${state.done} / ${state.total} 个站点`;
    $('progress-eta').textContent = `用时 ${seconds}s`;
  }
  updateStats();
  if (!state.aborted && state.filter === 'all' && counts().claimed > 0) {
    state.filter = 'claimed';
    document.querySelectorAll('#filter-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.filter === 'claimed'));
  }
  renderResults();
  updateHistory();
}

function updateProgress() {
  const pct = state.total ? Math.round((state.done / state.total) * 100) : 0;
  $('progress-bar').style.width = `${pct}%`;
  if (state.running) {
    $('progress-text').textContent = state.done === 0 ? '正在连接站点…' : `已检测 ${state.done} / ${state.total}`;
    if (state.batchTimes.length) {
      const avg = state.batchTimes.reduce((a, b) => a + b, 0) / state.batchTimes.length;
      const remaining = Math.max(0, state.total - state.done);
      const concurrency = clamp(Number($('opt-browser-concurrency').value) || 6, 1, 12);
      const eta = Math.ceil((remaining / BATCH_SIZE / concurrency) * (avg / 1000));
      $('progress-eta').textContent = eta > 0 ? `预计剩余 ${eta}s` : '';
    } else {
      $('progress-eta').textContent = '连接站点中…';
    }
  }
}

/* ---------------- 人工复核 ---------------- */

function loadReviews() {
  try {
    const raw = JSON.parse(localStorage.getItem(REVIEW_KEY) || '{}');
    state.reviews = raw && typeof raw === 'object' ? raw : {};
  } catch {
    state.reviews = {};
  }
}

function saveReviews() {
  try {
    localStorage.setItem(REVIEW_KEY, JSON.stringify(state.reviews));
  } catch {
    /* 隐私模式下 localStorage 可能不可写，忽略即可 */
  }
}

function reviewFor(username, name) {
  if (!username) return null;
  return state.reviews[username]?.[name] || null;
}

function setReview(username, name, verdict) {
  if (!username) return;
  const bucket = state.reviews[username] || (state.reviews[username] = {});
  if (verdict) bucket[name] = { v: verdict, t: Date.now() };
  else delete bucket[name];
  if (!Object.keys(bucket).length) delete state.reviews[username];
  saveReviews();
}

function reviewedCount() {
  return state.order.filter((name) => reviewFor(state.username, name)).length;
}

function clearReviews() {
  const count = reviewedCount();
  if (!count) return;
  if (!confirm(`清除 ${state.username} 的 ${count} 条人工标记？清除后这些站点会回到程序判定的结果。`)) return;
  delete state.reviews[state.username];
  saveReviews();
  state.openReview = null;
  updateStats();
  renderResults();
  toast('已清除人工标记');
}

/** 有 review 时以人工结论为准 */
function effectiveStatus(item) {
  const review = reviewFor(state.username, item.name);
  return review ? review.v : item.status;
}

function canReview(item) {
  return REVIEWABLE.has(item.status);
}

/* ---------------- 渲染 ---------------- */

function counts() {
  const out = {
    claimed: 0,
    available: 0,
    illegal: 0,
    waf: 0,
    error: 0,
    unreachable: 0,
    pending: 0,
    review: 0,
    reviewed: 0,
  };
  for (const name of state.order) {
    const item = state.results.get(name);
    if (!item || item.status === 'pending') {
      out.pending += 1;
      continue;
    }
    const review = reviewFor(state.username, name);
    const status = review ? review.v : item.status;
    out[status] = (out[status] || 0) + 1;
    if (review) out.reviewed += 1;
    else if (REVIEWABLE.has(item.status)) out.review += 1;
  }
  return out;
}

/** 归到「无法判断」这一栏的所有状态 */
function unknownCount(c) {
  return c.illegal + c.waf + c.error + c.unreachable;
}

function updateStats() {
  const c = counts();
  $('stat-claimed').textContent = c.claimed;
  $('stat-available').textContent = c.available;
  $('stat-unknown').textContent = unknownCount(c);
  $('stat-pending').textContent = c.pending;

  const tabs = {
    claimed: c.claimed,
    available: c.available,
    unknown: unknownCount(c),
    all: state.order.length - c.pending,
  };
  document.querySelectorAll('#filter-tabs .tab').forEach((tab) => {
    tab.querySelector('b').textContent = tabs[tab.dataset.filter] ?? 0;
  });

  // 待复核提示条：拦截/失败的行都是"可能误判"，给一条显眼的入口而不是再加一个 tab
  const banner = $('review-banner');
  if (c.review === 0 && state.filter !== 'review') {
    banner.hidden = true;
  } else {
    banner.hidden = false;
    $('review-banner-text').textContent =
      state.filter === 'review'
        ? `只显示 ${c.review} 个待复核站点`
        : `${c.review} 个站点被拦截或请求失败，程序无法判断`;
    $('review-jump').textContent = state.filter === 'review' ? '显示全部' : '只看待复核';
  }

  const clearBtn = $('clear-reviews');
  clearBtn.hidden = c.reviewed === 0;
  clearBtn.textContent = `清除人工标记 (${c.reviewed})`;
}

function scheduleRender() {
  if (state.renderTimer) return;
  state.renderTimer = window.setTimeout(() => {
    state.renderTimer = 0;
    renderResults();
  }, 160);
}

function renderResults() {
  const list = $('result-list');
  const items = [];
  for (const name of state.order) {
    const item = state.results.get(name);
    if (!item || item.status === 'pending') continue;
    const review = reviewFor(state.username, name);
    if (state.filter === 'review') {
      if (!canReview(item) || review) continue;
    } else if (state.filter !== 'all') {
      const status = review ? review.v : item.status;
      const bucket = status === 'claimed' || status === 'available' ? status : 'unknown';
      if (bucket !== state.filter) continue;
    }
    items.push(item);
  }

  items.sort((a, b) => {
    const sa = STATUS_ORDER.indexOf(effectiveStatus(a));
    const sb = STATUS_ORDER.indexOf(effectiveStatus(b));
    if (sa !== sb) return sa - sb;
    return a.name.localeCompare(b.name, 'en');
  });

  list.innerHTML = items.map(rowHtml).join('');
  $('empty-hint').hidden = items.length > 0;
  if (state.running && state.done === 0) {
    $('empty-hint').textContent = '正在并发探测站点，结果会陆续出现…';
  } else if (state.filter === 'review') {
    $('empty-hint').textContent = state.done === 0 ? '还没有需要复核的站点' : '没有待复核的站点，拦截页都已处理';
  } else if (state.filter === 'all') {
    $('empty-hint').textContent = '还没有结果';
  } else if (state.filter === 'claimed') {
    $('empty-hint').textContent = '这批站点里没有检测到已注册账号';
  } else {
    $('empty-hint').textContent = '没有符合该条件的结果';
  }
}

function rowHtml(item) {
  const site = siteByName(item.name);
  const home = item.home || site?.m || '';
  const host = hostOf(home);
  const initial = esc(item.name.slice(0, 1).toUpperCase());
  const link = item.url || home;
  const review = reviewFor(state.username, item.name);
  const status = review ? review.v : item.status;
  const label = STATUS_LABEL[status] || status;
  const meta = `${item.http ? `HTTP ${item.http}` : '—'}${item.ms ? ` · ${item.ms}ms` : ''}`;
  const note = item.note ? `<span class="note">${esc(item.note)}</span>` : '';
  const open = state.openReview === item.name;

  let action = '';
  if (canReview(item)) {
    if (review) {
      action = `<button type="button" class="meta-action done" data-review-toggle="${esc(item.name)}">已人工确认 · 改</button>`;
    } else {
      action = `<button type="button" class="meta-action" data-review-toggle="${esc(item.name)}">复核 →</button>`;
    }
  }

  const bar = canReview(item)
    ? `<div class="review-bar" data-for="${esc(item.name)}"${open ? '' : ' hidden'}>
        <p class="review-tip">
          <span>${esc(item.note || '这条结果没法自动判断')}。拦截页来自云函数的机房 IP，需要你用自己的浏览器确认，或点下面的「让服务器代看」。</span>
          <span class="review-tip-sub">标记只保存在本机浏览器，重新检测同一个用户名会自动带出。</span>
        </p>
        <div class="review-actions">
          <a class="mini-btn primary" href="${esc(link)}" target="_blank" rel="noreferrer noopener">打开 ${esc(host || item.name)} ↗</a>
          <button type="button" class="mini-btn ok${review?.v === 'claimed' ? ' on' : ''}" data-review="claimed" data-site="${esc(item.name)}">已注册</button>
          <button type="button" class="mini-btn no${review?.v === 'available' ? ' on' : ''}" data-review="available" data-site="${esc(item.name)}">未注册</button>
          <button type="button" class="mini-btn off${review?.v === 'unreachable' ? ' on' : ''}" data-review="unreachable" data-site="${esc(item.name)}">打不开</button>
          ${review ? `<button type="button" class="mini-btn ghost" data-review="" data-site="${esc(item.name)}">撤销</button>` : ''}
        </div>
        <div class="review-aux">
          <button type="button" class="aux-link" data-copy="${esc(link)}">复制链接</button>
          <button type="button" class="aux-link" data-snapshot="${esc(item.name)}">让服务器代看</button>
          <span class="aux-hint">本地打不开就点「让服务器代看」：由云端出口去取这个页面，能取到就把内容摊在这里给你判断，取不到也会说明被什么拦住。</span>
        </div>
        <div class="snap-slot" data-snap-for="${esc(item.name)}">${snapshotHtml(item.name)}</div>
      </div>`
    : '';

  return `<li class="row${open ? ' open' : ''}">
    <div class="row-head">
      <span class="fav"><span>${initial}</span>${host ? `<img src="https://${esc(host)}/favicon.ico" alt="" loading="lazy" referrerpolicy="no-referrer" onload="this.classList.add('ok')" onerror="this.classList.add('dead')">` : ''}</span>
      <span class="row-main">
        <span class="row-name">${link ? `<a href="${esc(link)}" target="_blank" rel="noreferrer noopener">${esc(item.name)}</a>` : esc(item.name)}${review ? '<i class="mark">人工</i>' : ''}</span>
        <span class="row-url">${esc(host || home)}</span>
      </span>
      <span class="badge ${esc(status)}">${esc(label)}</span>
      <span class="row-meta"><span class="meta-num">${esc(meta)}</span>${note}${action}</span>
    </div>
    ${bar}
  </li>`;
}

function siteByName(name) {
  if (!state.siteIndex) state.siteIndex = new Map(state.sites.map((s) => [s.n, s]));
  return state.siteIndex.get(name);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/* ---------------- 导出 / 分享 ---------------- */

function orderedResults() {
  return state.order.map((n) => state.results.get(n)).filter(Boolean);
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportJson() {
  if (!state.order.length) return toast('还没有结果');
  const results = orderedResults().map((item) => {
    const review = reviewFor(state.username, item.name);
    return {
      ...item,
      auto_status: item.status,
      status: review ? review.v : item.status,
      source: review ? 'manual' : 'auto',
      reviewed_at: review ? new Date(review.t).toISOString() : null,
    };
  });
  download(
    `sherlock-${state.username}.json`,
    JSON.stringify({ username: state.username, generatedAt: new Date().toISOString(), results }, null, 2),
    'application/json',
  );
}

function exportCsv() {
  if (!state.order.length) return toast('还没有结果');
  const rows = [['site', 'status', 'auto_status', 'source', 'profile_url', 'http_status', 'elapsed_ms', 'note']];
  for (const item of orderedResults()) {
    const review = reviewFor(state.username, item.name);
    rows.push([
      item.name,
      review ? review.v : item.status,
      item.status,
      review ? 'manual' : 'auto',
      item.url || '',
      item.http ?? '',
      item.ms || '',
      item.note || '',
    ]);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  download(`sherlock-${state.username}.csv`, `\ufeff${csv}`, 'text/csv;charset=utf-8');
}

async function copyLink() {
  if (!state.username) return toast('先检测一个用户名');
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('u', state.username);
  url.searchParams.set('scope', state.scope);
  if (state.nsfw) url.searchParams.set('nsfw', '1');
  try {
    await navigator.clipboard.writeText(url.toString());
    toast('分享链接已复制');
  } catch {
    toast(url.toString());
  }
}

function updateHistory() {
  const url = new URL(location.href);
  url.searchParams.set('u', state.username);
  url.searchParams.set('scope', state.scope);
  if (state.nsfw) url.searchParams.set('nsfw', '1');
  history.replaceState(null, '', url);
}

function applyUrlParams() {
  const params = new URLSearchParams(location.search);
  const username = params.get('u');
  const scope = params.get('scope');
  const nsfw = params.get('nsfw');
  if (scope === 'all' || scope === 'popular') {
    state.scope = scope;
    document.querySelectorAll('#scope-switch .seg').forEach((b) => b.classList.toggle('active', b.dataset.scope === scope));
  }
  if (nsfw === '1') {
    state.nsfw = true;
    $('nsfw-toggle').checked = true;
  }
  updateCounts();
  if (username) {
    const value = username.trim().slice(0, 64);
    $('username').value = value;
    if (value) startScan(value);
  }
}

/* ---------------- 工具 ---------------- */

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function cssEscape(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
}

let toastTimer = 0;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => (el.hidden = true), 220);
  }, 2400);
}
