# sherlock_edgeone

把 [sherlock-project/sherlock](https://github.com/sherlock-project/sherlock) 移植成
**EdgeOne Makers（原 EdgeOne Pages）Python 云函数**，一键部署成一个
「给定用户名 → 跨 481 个社交平台查账号」的 HTTP API。

> 上游 sherlock 是命令行工具；本仓库只做「serverless 化」改造，
> **用户名检测逻辑与上游完全一致**，仅剥离了 CLI / pandas / colorama，
> 并把它包成 Makers 的 `class handler(BaseHTTPRequestHandler)` 入口。

---

## 目录结构

```
sherlock_edgeone/
├── cloud-functions/                 # EdgeOne Makers Python 云函数根目录
│   ├── api/
│   │   └── sherlock.py              # 入口：/api/sherlock（Handler 模式）
│   ├── sherlock_core/               # 上游核心逻辑移植（辅助模块，不注册路由）
│   │   ├── sherlock.py              #   扫描主逻辑（来自上游 sherlock.py）
│   │   ├── sites.py                 #   data.json 加载器
│   │   ├── result.py                #   QueryResult / QueryStatus
│   │   └── resources/
│   │       ├── data.json            #   481 个站点的检测规则
│   │       └── data.schema.json
│   └── requirements.txt             # requests / requests-futures / certifi / PySocks
├── edgeone.json                     # 云函数配置：python maxDuration = 120s
└── README.md
```

Makers 按文件系统自动生成路由：`cloud-functions/api/sherlock.py` → `https://<你的域名>/api/sherlock`。

项目根目录的 `index.html` 会被 Makers 作为静态首页托管在 `/`，是一个调用该接口的网页版查询界面
（输入用户名 → 按状态分组展示结果）。直接访问 `https://<域名>/` 即可使用，无需拼 URL。

---

## 部署

### 方式一：GitHub 导入（推荐）

1. Fork 或使用本仓库。
2. 登录 [EdgeOne Makers 控制台](https://console.tencentcloud.com/edgeone/makers)。
3. 新建项目 → 选择「从 Git 仓库导入」→ 选本仓库。
4. 构建配置保持默认（Makers 会自动识别 `cloud-functions/` 与 `requirements.txt`）。
5. 部署完成后即可访问 `https://<分配域名>/api/sherlock?username=<name>`。

### 方式二：EdgeOne CLI

```bash
npm i -g edgeone
edgeone login
edgeone pages deploy
```

### 方式三：直接上传

把仓库打包，通过控制台「Direct Upload」上传。

---

## 使用

### GET

```bash
curl "https://<域名>/api/sherlock?username=torvalds"
```

### POST

```bash
curl -X POST "https://<域名>/api/sherlock" \
  -H "Content-Type: application/json" \
  -d '{"username": "torvalds", "timeout": 20, "exclude_nsfw": true}'
```

### 响应示例

```json
{
  "username": "torvalds",
  "elapsed_seconds": 25.6,
  "total_sites": 481,
  "found": 204,
  "results": {
    "GitHub": {
      "status": "Claimed",
      "url": "https://github.com/torvalds",
      "http_status": 200,
      "context": null,
      "query_time": 0.31
    }
  }
}
```

`status` 取值：`Claimed`（已注册）/ `Available`（未注册）/ `Unknown`（出错）/
`Illegal`（该站不允许此用户名）/ `WAF`（被 WAF/人机验证拦截）。

### 参数

| 参数 | 位置 | 默认 | 说明 |
|---|---|---|---|
| `username` | query / body | 必填 | 要查询的用户名 |
| `timeout` | query / body | `20` | 单站点请求超时（秒），范围 1–60 |
| `sites` | query / body | 全部 | 逗号分隔的站点名，只扫这些站（如 `GitHub,Twitter`） |
| `exclude_nsfw` | query / body | `false` | `true` 时跳过标记为 NSFW 的站点 |
| `proxy` | query / body | 无 | 可选代理，`http(s)://` 或 `socks5://` |

---

## 已知限制

- **WAF / 人机验证**：云函数走数据中心 IP，大量站点（Cloudflare / AWS WAF / PerimeterX）
  会返回挑战页，sherlock 会把这些标为 `WAF` 而非误报。`Unknown` 多为连接失败或探测站不可用。
  这意味着**结果会漏报，不能当作绝对结论**。
- **120 秒上限**：`edgeone.json` 已把 Python 云函数 `maxDuration` 设为 120s。
  实测全量 481 站（`timeout=10`）约 25s，正常够用。若调高 `timeout` 或网络较差，
  可能触顶——建议全量扫描用较小 `timeout`，或用 `sites` 限定站点。
- **需要出网**：云函数运行时会向各站点发起真实 HTTP 请求，确保所在环境允许外网访问。

---

## 更新 data.json

`cloud-functions/sherlock_core/resources/data.json` 是上游的快照。要跟进最新站点：

```bash
curl -o cloud-functions/sherlock_core/resources/data.json \
  https://raw.githubusercontent.com/sherlock-project/sherlock/master/sherlock_project/resources/data.json
```

---

## 许可与致谢

- 本仓库遵循 **MIT License**（见 `LICENSE`，版权归 Sherlock Project）。
- 核心检测逻辑来自 [sherlock-project/sherlock](https://github.com/sherlock-project/sherlock)，
  本仓库仅做 serverless 适配，所有功劳属于上游作者与贡献者。
