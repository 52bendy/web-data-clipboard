# Web Data Clipboard

轻量、解耦的跨平台短信采集与网络剪贴板基座，采用单一职责的 Monorepo 结构。

## 快速开始

需要 Node.js 20+ 和 npm。克隆仓库后，在根目录运行：

```sh
npm install
npm run dev
# 另开终端验证：curl -i http://localhost:3000/api/v1/health
npm test
npm run lint
```

服务默认监听 `:3000`，可通过 `PORT` 环境变量覆盖。健康检查返回 HTTP 200 JSON。

全链路联调与冷启动验收：

```sh
node backend/scripts/e2e-chain.js
node backend/scripts/cold-start-benchmark.js --runs 6
node backend/scripts/pc-poll-sync.js --help
node backend/scripts/sse-subscribe.js --help
```

多来源剪贴板、命名空间与项目级写入接口见
[backend/docs/multi-source-clipboard.md](backend/docs/multi-source-clipboard.md)。
验收矩阵与测量口径见
[backend/docs/acceptance-matrix.md](backend/docs/acceptance-matrix.md)，PC 轮询示例见
[backend/docs/pc-poll-sync.md](backend/docs/pc-poll-sync.md)，SSE 实时订阅契约见
[backend/docs/realtime.md](backend/docs/realtime.md)。剪贴板 TTL 过期读取语义
（404 = 不存在，历史日志与 TTL 解耦）见
[backend/docs/clipboard-ttl-semantics.md](backend/docs/clipboard-ttl-semantics.md)。

## 管理后台

管理后台位于 `/admin`，默认拒绝匿名访问。启动前配置管理员凭据（推荐使用 scrypt 哈希）：

```sh
node backend/scripts/hash-admin-password.js 'your-strong-password'
ADMIN_USERNAME=admin ADMIN_PASSWORD_HASH='scrypt$...' npm run dev
# 打开 http://localhost:3000/admin
```

未配置凭据时后台 fail closed；管理 API（devices / webhooks / logs / stats / settings）
统一要求登录态。详见 [backend/docs/admin-auth.md](backend/docs/admin-auth.md)。

## 目录说明

- `backend/`：后端 API、剪贴板存储服务、本地开发服务器及管理前端静态资源落点。
- `android-client/`：Android Kotlin 采集端；Gradle 工程由后续子需求建设。
- `ios-scripts/`：iOS 快捷指令接入包与教程，由后续子需求建设。

## 技术决策与偏差记录

- 后端采用 Node.js + JavaScript ESM，开发服务仅依赖 Node 内置模块，与 Vercel / Cloudflare 部署选型解耦。
- 管理前端将基于 [shadcn-admin](https://github.com/satnaing/shadcn-admin)；本基线不引入其完整工程，`backend/public/` 作为未来构建产物目录。相较 PRD §3 的静态 `public/` 页面方案，这是负责人指定的模板决策；静态资源落点仍予保留。
- 健康检查、采集上报、剪贴板查询、日志/统计、设备管理、Webhook 配置与投递、管理后台及仪表盘路由均已落地；剪贴板存储服务（服务端接收时间权威排序 / 原子更新 / 后到者覆盖留痕 / TTL / 历史）位于 `backend/src/services/`，存储抽象层与部署选型解耦（内存实现可本地运行）。
- 剪贴板已从短信专用泛化为项目级多来源基座：`POST /api/v1/clipboard/write` 支持文本/链接/JSON，命名空间隔离不同项目，短信采集作为首个 `collector=sms` 接入 `default` 命名空间；后台按采集器/项目/来源标签/命名空间展示与筛选。
- 全链路验收脚本、PC 轮询同步示例、SSE 实时订阅示例和验收矩阵位于 `backend/scripts/` 与 `backend/docs/`；实时推送优先采用 SSE（Serverless 兼容），WebSocket 事件总线已解耦但跨实例广播留待部署子需求；部署配置（`vercel.json` / `wrangler.toml`）仍由对应部署子需求负责。
- 仓库名为 `web-data-clipboard`，PRD 示例目录名 `data-collection-center` 仅为说明性名称。

## 规范入口

协作、提交与格式约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。
