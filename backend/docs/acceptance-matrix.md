# 验收矩阵 — REQ-202610-1268

端到端联调、边界负例、下游 PC 轮询示例与冷启动测量口径。对应 PRD §7.2、§8.3。

## 1. 验收环境与入口

| 项目     | 说明                                                                  |
| -------- | --------------------------------------------------------------------- |
| 代码分支 | `feat/req-202610-1268-e2e-acceptance`                                 |
| 运行环境 | Node.js 20+（本次记录：Node.js 22.23.2，Linux 6.8）                   |
| 存储     | 内存适配器（`STORAGE_DRIVER=memory`）；生产 KV 适配器复用同一服务契约 |
| 自动化   | `npm test`、`npm run lint`、`node backend/scripts/e2e-chain.js`       |
| 性能测量 | `node backend/scripts/cold-start-benchmark.js --runs 6`               |
| 下游示例 | `node backend/scripts/pc-poll-sync.js --help`                         |

全链路脚本使用真实的 `createServer` / `createServices` 服务图，只把 Webhook
出站 HTTPS 传输重定向到本地接收器；目标校验、HMAC 签名、投递记录仍走生产实现。
脚本中的设备上报为模拟数据，不代表真机验收。

## 2. 功能验收

| ID   | 场景                     | 方法                                                                    | 预期                                                                                  | 自动化结果                |
| ---- | ------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------- |
| F-01 | 设备上报写入剪贴板       | `e2e-chain.js`：`POST /api/v1/collect`                                  | 200；`extracted_code=839201`；`clipboard_updated=true`                                | 通过                      |
| F-02 | 查询最新剪贴板           | `e2e-chain.js`：`GET /api/v1/clipboard/latest`                          | 200；`content/type/raw_text/source_device/platform/updated_at/expire_in_seconds` 完整 | 通过                      |
| F-03 | 条件轮询不重复下载       | `e2e-chain.js`：携带 `If-None-Match`                                    | 304；空 body；ETag 保持                                                               | 通过                      |
| F-04 | Webhook 异步转发         | `e2e-chain.js`：配置 Webhook 后上报，轮询 `/api/v1/webhooks/deliveries` | `status=success`；`attempts=1`；接收端收到 `clipboard.updated`                        | 通过                      |
| F-05 | Webhook 签名可验证       | `e2e-chain.js`：用创建响应中的 `secret` 重算                            | `X-DCC-Signature == sha256(HMAC(secret, timestamp + "." + rawBody))`                  | 通过                      |
| F-06 | 管理仪表盘与公开统计一致 | `npm test`（`admin-dashboard.test.js`）                                 | 仪表盘 stats 与 `/api/v1/stats` 字段一致；剪贴板卡片与查询接口一致                    | 通过                      |
| F-07 | 日志 / 统计 / 设备管理   | `npm test`（`logs-api`、`devices-api`、`admin-management`）             | 分页、过滤、脱敏、在线状态、Token 脱敏符合契约                                        | 通过                      |
| F-08 | PC 端发现更新并写剪贴板  | `npm test`（`pc-poll-sync.test.js`）+ 手工桌面验证                      | 首次更新写系统剪贴板；重复轮询不重复写；状态文件持久化                                | 自动化通过；桌面显示见 §7 |

## 3. 边界与负例

| ID   | 场景                 | 请求                                                          | 预期                                                                               | 自动化结果   |
| ---- | -------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------ |
| N-01 | 非法 Token（上报）   | `POST /api/v1/collect`，`X-DCC-Token: wrong-token`            | 401；`{"code":401,"message":"Missing or invalid X-DCC-Token header.","data":null}` | 通过         |
| N-02 | 非法 Token（查询）   | `GET /api/v1/clipboard/latest`，错误 Token                    | 401；统一错误信封                                                                  | 通过         |
| N-03 | 触发限流             | 限流配置 2 次/分钟，连续 3 次上报                             | 前 2 次 200，第 3 次 429；带 `Retry-After` 且为 ≥1 的整数秒                        | 通过         |
| N-04 | 超大报文             | `POST /api/v1/collect`，body > `MAX_BODY_BYTES`（测试 1 KiB） | 413；统一错误信封                                                                  | 通过         |
| N-05 | 过期读取             | 短 TTL（120ms）写入后等待 180ms 再查询                        | 404；`No clipboard data available.`；响应不含原始内容                              | 通过         |
| N-06 | 坏 JSON              | `POST /api/v1/collect`，body `{"device_id":`                  | 400；message 包含 `valid JSON`                                                     | 通过         |
| N-07 | Query 传 Token       | `GET /api/v1/clipboard/latest?token=...`                      | 带合法 Header 时 400（拒绝 Query Token）；仅 Query 时 401                          | 通过（单测） |
| N-08 | Webhook 非法目标     | 创建 `http://`、localhost、私网 IP、带凭据 URL                | 400；拒绝非 HTTPS / 回环 / 私网 / 保留地址                                         | 通过（单测） |
| N-09 | 过期或不存在不可区分 | 空剪贴板 / TTL 过期                                           | 均为 404，不泄露历史内容                                                           | 通过         |

## 4. 性能验收与冷启动口径（§8.3）

### P-01 冷启动 < 200ms

**测量定义**：从 `spawn(node src/server.js)` 开始计时，到本机
`GET /api/v1/health` 首次返回 HTTP 200 为止。包含 Node 进程创建、模块加载、
服务构造和 localhost 首次请求往返；不包含 `npm install`、容器镜像拉取、DNS
和外部网络延迟。

**方法**：

```sh
node backend/scripts/cold-start-benchmark.js --runs 6
```

- 每个样本使用独立空闲端口和独立进程；第一个样本作为预热丢弃，其余样本统计。
- 通过标准：剩余样本的中位数 `< 200ms`。
- 生产验收应在目标部署环境（Vercel / Cloudflare / VPS）重跑同一脚本；不同硬件和
  运行时版本的结果不可直接横向比较。

**本次记录（2026-10-17，Node.js 22.23.2，Linux 6.8）**：

| 指标   | 数值                                                              |
| ------ | ----------------------------------------------------------------- |
| 样本   | 130.18 / 95.77 / 94.37 / 102.39 / 89.73 / 102.43 ms（首个为预热） |
| 中位数 | 95.77ms                                                           |
| P95    | 102.43ms                                                          |
| 最大值 | 102.43ms                                                          |
| 结论   | 通过（< 200ms）                                                   |

### P-02 其他性能相关验证

| ID   | 项目                   | 方法 / 观察                                                           | 结论             |
| ---- | ---------------------- | --------------------------------------------------------------------- | ---------------- |
| P-02 | Webhook 不阻塞采集响应 | E2E 中 Webhook 投递在 `collect` 响应后异步完成；`deliveries` 记录可见 | 通过（功能层面） |
| P-03 | 条件轮询减少传输       | 未变更时 304 且空 body；ETag 由 `updated_at + clipboard_id` 生成      | 通过             |
| P-04 | 并发写入原子性         | `npm test`（`clipboard-store.test.js` 并发用例）                      | 通过             |
| P-05 | 生产负载 / 长稳        | 需要目标环境压测工具与真实 Webhook 接收端                             | 待人工           |

## 5. 安全验收

| ID   | 项目                   | 预期                                                                    | 证据                                      |
| ---- | ---------------------- | ----------------------------------------------------------------------- | ----------------------------------------- |
| S-01 | Token 仅 Header 传递   | Query Token 被拒绝；缺失/错误 Token 401；空配置 fail closed             | `npm test`（security / clipboard-latest） |
| S-02 | HTTPS 强制             | `ENFORCE_HTTPS=true` 时非 HTTPS 返回 403                                | `npm test`（security）                    |
| S-03 | 管理端鉴权             | 匿名 401；会话 Cookie `HttpOnly`/`SameSite=Strict`；CSRF 校验；登录限流 | `npm test`（admin-auth）                  |
| S-04 | Webhook SSRF 防护      | 仅 HTTPS；拒绝 localhost/私网/保留地址；DNS 解析与连接时二次校验        | `npm test`（webhook-target）              |
| S-05 | Webhook 签名与重放窗口 | `X-DCC-Signature` HMAC-SHA256；下游可校验时间戳                         | E2E + `webhook-forwarder` 单测            |
| S-06 | 敏感信息不落日志       | Token 仅掩码展示；日志不打印明文 Token/Webhook secret                   | 代码审查 + 单测                           |
| S-07 | 限流                   | 30 次/分钟默认；429 + `Retry-After`                                     | E2E N-03 + 单测                           |

## 6. 兼容性验收

| ID   | 项目               | 预期                                                                                         | 证据                       |
| ---- | ------------------ | -------------------------------------------------------------------------------------------- | -------------------------- |
| C-01 | Node.js 运行时     | Node.js 20+，ESM，无运行时第三方依赖                                                         | 本次 Node 22.23.2 全量测试 |
| C-02 | Android / iOS 上报 | `platform` 接受 `android`/`ios`；可选 sender；时间戳为 epoch ms                              | `npm test`（collect）      |
| C-03 | PC 轮询脚本        | Windows `clip`；macOS `pbcopy` + `osascript`；Linux `wl-copy`/`xclip`/`xsel` + `notify-send` | 单测注入 + 平台探测        |
| C-04 | 存储适配器         | 业务层只依赖 KV 契约；内存适配器可替换为生产 KV                                              | `storage-swap.test.js`     |
| C-05 | HTTP 客户端        | curl、fetch、浏览器管理端均可按文档调用                                                      | 文档示例 + E2E fetch       |

## 7. 下游 PC 轮询示例（§7.2.1）

脚本：`backend/scripts/pc-poll-sync.js`，使用说明见
[pc-poll-sync.md](pc-poll-sync.md)。核心行为：

1. 携带 `X-DCC-Token` 请求 `GET /api/v1/clipboard/latest`，并持久化 ETag；
2. 304 / 404 时不重复写入；429 时读取 `Retry-After` 并在下一轮退避；
3. 发现新 `updated_at` 后，按 `content`（或 `--raw` 的 `raw_text`）写系统剪贴板；
4. 同时发送桌面通知（Linux `notify-send`、macOS `osascript`、Windows Toast）；
5. 状态文件默认 `~/.dcc-clipboard-state.json`，权限 `0600`。

## 8. 仍需人工处理 / 未覆盖项

- **真机上报**：本任务使用模拟 Android 上报；Android/iOS 真机采集链路需在设备上验收。
- **真实公网 Webhook**：E2E 只验证到本地接收器；上线前需对实际 HTTPS 下游（Telegram/钉钉/飞书中转）做一次真实投递。
- **桌面通知显示**：脚本逻辑已单测；Windows/macOS/Linux 的实际通知样式需在桌面会话中人工确认。
- **管理后台浏览器验收**：接口和静态资源由单测覆盖，视觉/交互建议按 PRD 在浏览器走查。
- **生产性能**：冷启动数据来自本次服务器；部署环境需用同一口径复测，并按需补压测。

## 9. 结论

- 全链路脚本一次运行通过（12 个检查点）。
- 负例全部按契约返回（401 / 429 / 413 / 404 / 400）。
- PC 轮询示例可直接运行；冷启动中位数 95.77ms，低于 200ms 目标。
- 真机、真实下游与桌面通知显示列为上线前人工项。
