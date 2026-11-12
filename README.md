# Sherlock · 跨平台用户名侦察

把 [sherlock-project/sherlock](https://github.com/sherlock-project/sherlock) 这个 Python CLI 工具，改造成一个可以部署在 **Node.js 云函数平台**上的 Web 应用（本仓库已按 EdgeOne Makers / Pages 的目录约定配好，见「部署」一节）：

![预览](docs/preview.png)

- 前端是一个静态页面（用户名输入 + 实时结果表）；
- 后端是 Node.js 云函数，把 Sherlock 的判定逻辑重写成 JavaScript，在服务端并发访问各站点；
- 站点清单复用上游的 `data.json`，构建时编译成精简数据集；
- 被 WAF 拦截的站点不会硬猜，标成「无法判断」并支持**人工复核**（见下文）。

```
浏览器                         云函数
┌──────────────────┐  /api/sites  ┌──────────────────────────┐
│ index.html       │ ───────────► │ cloud-functions/api/     │
│ assets/app.js    │  /api/check  │   sites.js  → data 模块   │
│ 分批 + 并发调度   │ ───────────► │   check.js  → lib/engine  │
│ 实时进度 / 导出   │ ◄─────────── │     ├ 并发 fetch 各站点   │
└──────────────────┘   JSON 结果  │     └ 状态码/关键词/跳转  │
                                  └──────────────────────────┘
```

原项目是「一个进程跑完 480 个站点」；云函数有执行时长上限，所以改成了**客户端分批 + 服务端小并发**：首批 6 个站点先探路（约 4 秒出第一屏结果），其余每批 16 个，浏览器同时发 6 批，单次函数调用最多 24 个站点、内部并发 8。

---

## 目录结构

```
sherlock-edgeone/
├─ index.html                       # 页面
├─ assets/
│  ├─ app.js                        # 分批调度、进度、结果渲染、人工复核、导出
│  └─ style.css
├─ cloud-functions/                 # ★ 函数相关的一切都在这个目录里（原因见「打包」一节）
│  ├─ api/
│  │  ├─ sites.js                   # GET /api/sites     站点清单
│  │  ├─ check.js                   # GET/POST /api/check 探测一批站点
│  │  └─ snapshot.js                # GET /api/snapshot   服务端代取单站页面
│  └─ lib/
│     ├─ engine.js                  # ★ Sherlock 判定逻辑（状态码/关键词/跳转/WAF）
│     ├─ snapshot.js                # 页面净化与快照提取
│     ├─ sites.js                   # 站点数据访问（同步，不读文件）
│     └─ sites-data.js              # 构建产物：481 个站点的数据集（不要手改）
├─ data/
│  ├─ sites.json                    # 同一份数据集的 JSON 版，方便查看/diff
│  └─ sherlock-source.json          # 上游 data.json 快照（保证离线可构建）
├─ scripts/
│  ├─ build-data.mjs                # 数据编译：上游 JSON → data/*.json + lib/sites-data.js
│  ├─ test-engine.mjs               # 引擎冒烟测试（打真实站点）
│  └─ check-package.mjs             # 打包模拟：只带 cloud-functions/ 跑一遍全部接口
├─ server/dev.mjs                   # 本地预览（模拟静态资源 + 函数路由）
├─ edgeone.json                     # 构建/函数时长/缓存头配置
└─ package.json
```

---

## 本地预览

```bash
cd sherlock-edgeone
npm run preview        # http://localhost:8787
```

不需要登录、不需要安装依赖（零 runtime 依赖）。

```bash
npm test               # 引擎冒烟测试，默认 torvalds，断言 GitHub = 已注册
npm run test:package   # 打包模拟：只复制 cloud-functions/ 到临时目录再跑全部接口
```

`npm run test:package` 专门用来防「本地能跑、线上 500」：它把 `cloud-functions/` 单独拷到一个没有 `package.json`、没有 `data/` 的空目录里，再按平台的方式调用三个接口。目录结构一变就红，比上线后看日志快得多。

---

## 部署到 EdgeOne Makers

### 方式一：Git 仓库导入（推荐）

1. 把 `sherlock-edgeone/` 推到 GitHub / GitLab / Gitee 等仓库。
2. 打开 [EdgeOne Makers 控制台](https://console.tencentcloud.com/edgeone/makers) → 新建项目 → 导入 Git 仓库。
3. 构建设置（仓库根目录即 `sherlock-edgeone/`）：

   | 配置项 | 值 |
   | --- | --- |
   | 框架预设 | 其他 / 静态站点 |
   | 安装命令 | `npm install`（无依赖，可留空） |
   | 构建命令 | `node scripts/build-data.mjs` |
   | 输出目录 | 默认（项目根目录） |
   | Node 版本 | 22.x |

   这些值大部分已写进 `edgeone.json`，控制台按仓库配置走即可。
4. 部署完成后访问分配的域名，`/api/sites` 能返回 JSON 就说明函数已生效。

### 方式二：CLI 直接上传

```bash
npm install -g edgeone
edgeone login                       # 或 edgeone login -t <API Token>

cd sherlock-edgeone
edgeone makers deploy . -n sherlock -e production
```

### 官方本地调试（可选）

```bash
edgeone makers dev      # 需先 edgeone login，默认端口 8088
```

本项目没有配置 `devCommand`，因此它不会去启动别的前端 dev server。若不方便登录，用上面的 `npm run preview` 即可，行为等价。

---

## 关键参数

| 位置 | 参数 | 默认 | 说明 |
| --- | --- | --- | --- |
| `assets/app.js` | `BATCH_SIZE` | 16 | 每个函数调用探测的站点数 |
| 页面「高级设置」 | 单站点超时 | 9000 ms | 目标站点慢/被墙时会等这么久 |
| 页面「高级设置」 | 服务端并发 | 8 | 单次函数调用内的并发 fetch 数 |
| 页面「高级设置」 | 浏览器并发批次 | 6 | 同时在飞的函数调用数 |
| `cloud-functions/lib/engine.js` | `maxSitesPerRequest` | 24 | 接口硬上限 |
| `edgeone.json` | `maxDuration` | 60 s | 云函数单次执行上限（可配 10–120） |

约束关系：`24 / 8 × 9s ≈ 27s`，60s 的上限留了一倍余量。如果把批量调大或超时调长，记得同步提高 `maxDuration`。

---

## API

### `GET /api/sites`

```json
{ "count": 481, "popular": 88, "generatedAt": "...",
  "sites": [{ "n": "GitHub", "m": "https://www.github.com/", "k": 1, "x": 0 }] }
```

`k=1` 常用站点，`x=1` NSFW。

### `GET /api/check?u=<用户名>&s=<站点名,逗号分隔>&t=<超时ms>&c=<并发>`

也支持 `POST /api/check`，body 为 `{"username":"torvalds","sites":["GitHub","Reddit"]}`。

```json
{ "username": "torvalds", "took": 3201, "count": 2,
  "results": [
    { "name": "GitHub", "home": "https://github.com/", "url": "https://github.com/torvalds",
      "status": "claimed", "http": 200, "ms": 2103 },
    { "name": "Reddit", "home": "https://www.reddit.com/", "url": "https://www.reddit.com/user/torvalds",
      "status": "error", "http": 403, "ms": 1802, "note": "HTTP 403，疑似反爬拦截，未取到真实页面" }
  ] }
```

`status`：`claimed` 已注册 / `available` 未注册 / `illegal` 用户名不合法 / `waf` 人机校验 / `error` 请求失败。

### `GET /api/snapshot?site=Twitter&u=torvalds`

服务端代取单个站点的页面，压成可读快照。用于「本地网络打不开、但仍想看到服务端看到了什么」的场景。

```json
{ "site": "Twitter", "http": 200, "blocked": false, "blockKind": null, "ms": 5022,
  "title": "torvalds (@torvalds) on X",
  "description": "122 followers · 0 following. Joined Mar 2008.",
  "excerpt": "torvalds (@torvalds) / X\nJoined March 2008\n122 Followers\n…",
  "signals": { "notFoundHit": false }, "truncated": false }
```

`blockKind` 区分拦截至何种程度，方便前端给出不同提示：

| 值 | 含义 |
| --- | --- |
| `waf` | Cloudflare / Vercel / DataDome 等人机校验页 |
| `blocked` | 被网络层直接封锁（如 Reddit 的 "You've been blocked by network security"） |
| `ratelimit` | 429 限流 |
| `login` | 被跳转到登录页 |
| `denied` | 401 / 403 拒绝访问 |

`blockKind` 非 `null` 时，`title` / `excerpt` 里的内容**都是拦截页本身**，不能用来判断账号是否存在——前端会明确标注这一点。

---

## 判定逻辑对照

`cloud-functions/lib/engine.js` 逐条对应上游 `sherlock_project/sherlock.py` 的 `query_username` + 结果判定段：

| 上游 | 本实现 |
| --- | --- |
| `regexCheck` 不通过 → `ILLEGAL` | `compileRegex()`，并兼容 Python 的 `(?i)`、`\Z`、`\A` 写法 |
| `errorType = status_code` | 命中 `errorCode`、或状态码不在 2xx → 未注册（401/403/406/418/419 例外，见下） |
| `errorType = message` | 在响应正文里找 `errorMsg`（字符串或数组），找不到 → 已注册 |
| `errorType = response_url` | `redirect: 'manual'`，2xx → 已注册 |
| `status_code` 用 HEAD，其它用 GET | 相同，另外 HEAD 遇 405/403/501 会自动回退 GET |
| `urlProbe` / `request_payload` 插值 | 相同的递归 `{}` 替换，POST 时自动补 `Content-Type: application/json` |
| WAF 指纹 → `WAF` | 保留 Cloudflare / AWS WAF / PerimeterX 特征，另加几条常见 CDN 特征 |
| 请求异常 → `UNKNOWN` | 记录 `error` + `note`（超时 / 连接失败） |

**刻意增强的几处**（都是为了避免"判错"——既不想误报已注册，也不想误报未注册）：

1. `errorType = message` 且状态码是 401/403/406/418/419/429/5xx、正文又没命中"不存在"特征时，判为 `error` 而不是 `claimed` —— 数据中心 IP 很容易被反爬拦截，此时"没找到错误文案"并不代表账号存在。
2. `status_code` 遇到 429 / 5xx 判 `error`（上游会判为未注册），避免把目标站点自身故障当成"用户名没人用"。
3. `status_code` 和 `response_url` 遇到 401/403/406/418/419 同样判 `error`：上游会把 403 当成"未注册"，实测 Kick、Unsplash 这类站点对机房 IP 一律回 403，直接照搬会批量谎报"未注册"。
4. `errorMsg` 是 JSON 片段时（如 GitLab 用 `users?username=` 接口，`errorMsg` 为 `"[]"`）按 JSON 结构比对，不做子串包含 —— `"[]"` 这种短符号会被页面里任意 JS 数组误命中；反过来，如果接口返回的正文根本不是 JSON，判 `error` 而不是 `claimed`。
5. 正文最多读 300 KB（快照 800 KB），边读边截断，防止超大页面拖垮函数内存。

**上游数据的编译期修正**（`scripts/build-data.mjs` 的 `PATCHES`）：Twitter 的 `urlProbe` 指向的 nitter 实例早已下线，探测必然 `fetch failed`，编译时移除该 probe 并补上新版 404 页特征串（`User Profile Not Found`）；x.com 本体可直连，改完后 Twitter 能正常判定。

---

## 打包：为什么 `lib/` 必须待在 `cloud-functions/` 里

这是这类项目最容易踩、也最难在本地发现的一个坑。

平台的构建规则是：**`cloud-functions/` 目录下，导出了 `onRequest*` 的文件才会注册成路由；没有入口标识的 `.js` / `.ts` 文件被视为辅助模块，会被复制进构建产物供入口文件 `import`。** 项目根目录的其它代码不在这个复制范围内（那是静态资源，不是函数代码）。

于是：

- 把 `engine.js` 放在根目录 `lib/` 下 → 构建产物里没有它 → 线上 `Cannot find module .../lib/engine.js`，而本地 `node server/dev.mjs` 一切正常；
- 用 `readFile(new URL('../data/sites.json', import.meta.url))` 读数据 → 函数文件在产物里的位置由平台决定，`import.meta.url` 一移位就失效。之前正是靠"读不到就去 `fetch('/data/sites.json')`"的兜底掩盖了这个 bug，多花了一次跨境请求才拿到数据。

所以现在的做法是：

1. 所有函数侧代码都在 `cloud-functions/` 内（`api/` 是入口，`lib/` 是辅助模块）；
2. 站点数据在构建时被编译成 `cloud-functions/lib/sites-data.js`（普通 ES 模块，命名导出），函数 `import` 它，**不读文件、不拼路径**，目录结构怎么变都不影响；
3. `edgeone.json` 不再需要 `includeFiles`；
4. `npm run test:package` 把上面这条链路固化成测试：只复制 `cloud-functions/` 到空目录，跑通三个接口才算过。

另外两个细节：辅助模块刻意不使用 `export default`（部分平台会把 default 导出当成"框架实例"注册成路由），文件后缀统一用 `.js`（平台文档明确按 `.js` / `.ts` 识别辅助模块，`.mjs` 不在保证范围内）。

---

## 更新站点数据

```bash
npm run build:data:remote   # 从 GitHub 拉取最新 data.json，更新快照并重新编译
npm run build:data          # 只用本地快照重新编译
```

仓库里已经带了 481 个站点的快照，所以构建时即使访问不了 GitHub 也能正常产出。编译结果会同时写 `data/sites.json`（给人看）和 `cloud-functions/lib/sites-data.js`（给函数用）。

---

## 拦截页怎么办：人工复核

![人工复核](docs/preview-review.png)

Cloudflare 的 "Verify you are human"、AWS WAF 的 challenge、PerimeterX 的按压验证，这些都要**真人 + 浏览器环境**才能通过。服务端没法替你过：

- 云函数的出口是机房 IP，本来就在风控名单上；
- 验证挑战依赖 JS 执行、鼠标轨迹、Canvas 指纹，`fetch` 拿不到；
- 用 iframe 把验证页嵌进来也不行，`X-Frame-Options: DENY` / CSP `frame-ancestors` 会直接拒绝，而且拿到了 clearance cookie 也是种在 iframe 的域上，跟服务端请求无关。

所以这里做的是**把判断权交回给人**，而不是假装能自动过验证：

1. 判定为 `waf` / `error` 的行右侧会出现「复核 →」，点开展开一条操作栏；
2. 点「打开 xxx.com ↗」用**你自己的浏览器**访问（家用 IP + 已登录状态，通常直接就能看到真实页面）；
3. 回来点「已注册 / 未注册」，该行立刻变成对应颜色并加一个 `人工` 小标签，同时计入统计与导出；
4. 标记写在 `localStorage`（key `sherlock.reviews.v1`，按用户名分组），刷新或重新检测同一个用户名会自动带出，不会重复劳动；
5. 结果区顶部有一条提示条「N 个站点被拦截…·只看待复核」，点进去可以逐条过，标完一条自动展开下一条；「清除人工标记」可以一键回滚。

导出的 JSON / CSV 里，`auto_status` 是程序判定、`status` 是最终结论、`source` 区分 `auto` / `manual`，人工结论不会被当成程序结论混淆。

### 如果本地网络也打不开该站

大陆网络直连 Reddit、Instagram、X 基本不通，这时候「打开」只会得到浏览器的错误页。**这种站点验证不了，工具也不替你做判断**——操作栏里有一个「打不开」：

- 标记为 `unreachable`，badge 显示「网络不可达」，仍然算进「无法判断」，不会变成"未注册"；
- 它不再占用「待复核」队列，所以受限网络下也能把队列清空；
- 导出里 `source = manual`、`status = unreachable`，和"确实查过、确认没注册"区分得开。

同一行还有「**让服务器代看**」：由云端出口去取一次页面，把服务端读到的内容摊在你面前。

- 取到了 → 显示页面标题、简介、正文摘录（例如 `torvalds (@torvalds) on X`、`122 followers · Joined March 2008`），你据此点「已注册 / 未注册」；
- 取不到 → 如实说明被什么拦住（人机校验 / 网络层封锁 / 限流 / 跳登录页），**绝不会拿拦截页冒充真实资料**。

「复制链接」仍然保留——把它发到一台能访问的设备上打开，是最可靠的办法。

> 为什么不做一个"检测我的网络能不能连上"的按钮：浏览器端做不到可靠判断。`fetch(url, {mode:'no-cors'})` 只能告诉你"请求有没有被浏览器抛出异常"，而异常的原因可能是被墙、也可能只是站点重置了连接、返回了下载类型、被扩展拦截。实测 `codepen.io`、`x.com`、`npmjs.com` 在服务端明明能拿到 403 响应，浏览器里 `no-cors` 请求却全部 `Failed to fetch` —— 拿这种信号去提示"你的网络访问不了"，会把人骗去标「打不开」。所以只保留用户自己的判断。

> 为什么不做「浏览器端自动重试」：跨域 `fetch(..., {mode:'no-cors'})` 只能拿到 opaque response，读不到状态码和正文；`X-Frame-Options` 也挡住了 iframe 读取。想真正自动化，只能自建带住宅代理 + 无头浏览器的后端，那已经不是云函数能承担的事了。

---

## 已知限制

- **数据中心 IP 会被拦**：Cloudflare、AWS WAF、PerimeterX 等会给人机校验页，这部分结果会落到「无法判断」，需要走上面的人工复核。部署在中国大陆节点时，Twitter/X、LinkedIn、Reddit 等站点的成功率明显偏低。实测 88 个常用站点里，机房出口能直接判定的约 60 个。
- **不做出口代理/反代**：HTTP 代理和公共反代都实测过——换的仍是机房 IP，对"整段封 IP"的站点（Reddit、Instagram）拿到的还是同一张封锁页，存在与不存在的响应逐字节相同；对挑战页偶尔有效，但代价是查询内容要过第三方服务器、结果不稳定。既然救不回关键判定，代码里就没有留这条通路（`/api/snapshot` 也只用直连）。真要让它们可用，只有干净的住宅 / 移动出口加无头浏览器一条路。
- **结果只代表某一时刻**：站点改版、临时 502、频控都会影响判定，工具不保证与真实账号状态一致，也不推断账号归属。
- **单站点 9 秒超时**：慢站点会被记为超时；想更准可以调大超时、同时调小批次并发。
- **NSFW 站点默认隐藏**：页面右上角开关可以放开（19 个）。
- EdgeOne 免费版的函数地域固定，无法就近选择；Pro 及以上可在 `edgeone.json` 的 `mainlandRegions` / `overseasRegions` 指定。

## 许可

判定逻辑与站点数据来自 [sherlock-project/sherlock](https://github.com/sherlock-project/sherlock)（MIT License），本项目同样以 MIT 发布。
