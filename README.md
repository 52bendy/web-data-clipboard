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

## 目录说明

- `backend/`：后端 API、本地开发服务器及管理前端静态资源落点。
- `android-client/`：Android Kotlin 短信采集端，包含配置界面、前台服务、OkHttp 上报与 WorkManager 持久重试队列。
- `ios-scripts/`：iOS 快捷指令接入包与教程，由后续子需求建设。

## 技术决策与偏差记录

- 后端采用 Node.js + JavaScript ESM，开发服务仅依赖 Node 内置模块，与 Vercel / Cloudflare 部署选型解耦。
- 管理前端将基于 [shadcn-admin](https://github.com/satnaing/shadcn-admin)；本基线不引入其完整工程，`backend/public/` 作为未来构建产物目录。相较 PRD §3 的静态 `public/` 页面方案，这是负责人指定的模板决策；静态资源落点仍予保留。
- 本阶段只提供健康检查路由。`collect`、`clipboard`、`devices`、`webhooks` 由对应后续子需求实现；部署配置（`vercel.json` / `wrangler.toml`）留待运行时选型任务。
- 仓库名为 `web-data-clipboard`，PRD 示例目录名 `data-collection-center` 仅为说明性名称。

## 规范入口

协作、提交与格式约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。
