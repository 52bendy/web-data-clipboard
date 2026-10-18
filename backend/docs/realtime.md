# 实时订阅（SSE）— REQ-202610-1274

`GET /api/v1/clipboard/stream` 把剪贴板更新从轮询改为服务端推送，实现 PRD
§10 Phase 2。传输层选择 **Server-Sent Events (SSE)**：它是纯 HTTP 响应，浏览器
`EventSource`、`fetch()` 和 Node.js 均可消费，在 Vercel / Cloudflare 等
Serverless 平台上不需要长连接协议升级，免费额度内的连接成本也更可控。

WebSocket 评估结论：当前零依赖、单进程的事件总线（`src/services/realtime-hub.js`）
已经与传输层解耦，后续可以复用同一事件契约接入 WebSocket；但跨实例广播需要
共享 pub/sub（如 Redis / Durable Objects），属于部署子需求的范畴，本需求先交付
SSE。

## 鉴权

Token 只接受 `X-DCC-Token` Header：

```sh
curl -N http://localhost:3000/api/v1/clipboard/stream \
  -H 'X-DCC-Token: <API_SECRET_TOKEN>' \
  -H 'Accept: text/event-stream'
```

- 缺少、为空或错误的 Token → `401`（统一错误信封）。
- URL 中出现 `token`、`access_token`、`api_key` 等凭据类参数 → `400`，且在鉴权
  之前返回，避免 Token 出现在代理日志、浏览器历史和 Referer 中（defect 21）。
- `API_SECRET_TOKEN` 未配置时 fail closed。
- 非 GET 方法 → `405`。
- 原生浏览器 `EventSource` 不能设置 Header；浏览器端请使用 `fetch()` 流式读取或
  支持自定义 Header 的 EventSource polyfill，不要把 Token 放进 URL。

## 事件格式

连接建立后，服务端先发送一帧 `ready`（同一帧携带 `retry`），随后按需发送当前
快照和增量更新：

```text
event: ready
retry: 3000
data: {"connected_at":1792249245880,"heartbeat_interval_ms":15000,"retry_ms":3000,"namespace":"default"}

id: 1792249245885-8a5ca37f-0df2-4ec4-9eb2-fb3c0a6d3d6b
event: clipboard.updated
data: {"content":"839201","type":"verification_code","raw_text":"【中国移动】您的验证码是：839201，5分钟内有效。","source_device":"小米 13Pro","platform":"android","namespace":"default","source_project":"sms","source_label":"短信采集","collector":"sms","updated_at":1792249245885,"expire_in_seconds":1800}
```

`clipboard.updated` 的 `data` 与 `GET /api/v1/clipboard/latest`（REQ-202610-1256）
的 `data` 完全一致：

| 字段                | 类型    | 含义                                       |
| ------------------- | ------- | ------------------------------------------ |
| `content`           | string  | 提取出的验证码；无提取结果时为原始文本     |
| `type`              | string  | `verification_code` 或 `text`              |
| `raw_text`          | string  | 原始短信/剪贴板文本                        |
| `source_device`     | string  | 上报设备名（缺失时为 `unknown`）           |
| `platform`          | string  | `android` / `ios` / `api`（缺失时为 `unknown`） |
| `namespace`         | string  | 剪贴板命名空间（默认 `default`，短信链路） |
| `source_project`    | string  | 来源项目（短信采集为 `sms`）               |
| `source_label`      | string  | 后台展示的来源标签                         |
| `collector`         | string  | 采集器标识（`sms` / `api`）                |
| `updated_at`        | integer | 服务端接收时间（epoch ms，客户端时间不参与） |
| `expire_in_seconds` | integer | 距离 TTL 过期的剩余秒数                    |

事件 `id` 为 `<updated_at>-<clipboard_id>`，稳定且可去重。同一连接的重复 id 不会
重复发送。通过 `?namespace=<name>` 订阅指定命名空间（默认 `default`）；其他
命名空间的 `clipboard.updated` 会被过滤，不会推送给该连接。

## 心跳与断线重连

- 心跳：空闲时每 `REALTIME_HEARTBEAT_INTERVAL_MS`（默认 15 秒）发送注释帧
  `: heartbeat <epoch-ms>`。注释帧不触发客户端事件，只用于保活和探测断线。
- `retry`：`ready` 帧中的 `retry: 3000` 告诉 `EventSource` 断线后 3 秒重连，可用
  `REALTIME_RETRY_MS` 调整。
- `Last-Event-ID`：客户端重连时把最后收到的事件 id 放入 Header（或
  `last_event_id` 查询参数）。服务端先读取当前快照，若快照 id 与
  `Last-Event-ID` 相同则跳过，避免重复处理；之后的新更新照常推送。
- 连接 TTL：设置 `REALTIME_CONNECTION_TTL_MS > 0` 时，服务端在到期前发送
  `event: reconnect`（`{"reason":"connection_ttl"}`）并关闭连接，让客户端在
  Serverless 函数被强制终止前主动重连。默认 `0` 表示不限制。
- 客户端应使用指数退避或服务端 `retry` 值重连；网络错误、连接关闭都可重试，
  `400/401/403/404` 属于配置错误，不应无限重试。

## 连接数管理

`REALTIME_MAX_CONNECTIONS`（默认 100）限制单实例并发订阅数。超限时返回：

```json
{
  "code": 503,
  "message": "Realtime connection limit reached. Retry later.",
  "data": null
}
```

响应带 `Retry-After: 5`。客户端断开、TTL 到期或写失败都会释放名额。心跳使用
一个共享定时器，不为每个连接单独建表；慢客户端写失败会被关闭，避免队列无限增长。

## 配置

| 变量                             | 默认值  | 说明                                       |
| -------------------------------- | ------- | ------------------------------------------ |
| `REALTIME_ENABLED`               | `true`  | `false` 时订阅接口返回 503                 |
| `REALTIME_HEARTBEAT_INTERVAL_MS` | `15000` | 心跳间隔（毫秒，正整数）                   |
| `REALTIME_MAX_CONNECTIONS`       | `100`   | 单实例最大并发订阅数                       |
| `REALTIME_RETRY_MS`              | `3000`  | 下发给客户端的重连间隔（毫秒）             |
| `REALTIME_CONNECTION_TTL_MS`     | `0`     | 连接最长存活时间；`0` 表示不限制           |

## Serverless 与免费额度

- SSE 是普通 HTTP 响应，不占用 WebSocket 并发配额；但 Serverless 平台通常限制
  单次函数最长执行时间。把 `REALTIME_CONNECTION_TTL_MS` 设为小于该上限的值，
  客户端会收到 `reconnect` 并自动续订。
- 事件总线当前是进程内实现：单实例部署可直接工作；多实例/多区域部署需要把
  `realtimeHub.publish` 换成共享 pub/sub，否则只有写入所在实例的订阅者能收到。
- 连接上限默认 100，配合心跳与 TTL 可在免费额度内稳定运行；如需更高并发，
  应先引入共享存储/消息层，再提高 `REALTIME_MAX_CONNECTIONS`。

## 命令行订阅示例

`backend/scripts/sse-subscribe.js` 是零依赖的 Node.js 20+ 客户端：订阅 SSE、
自动重连、把更新写入系统剪贴板并弹桌面通知。

```sh
export DCC_TOKEN='<API_SECRET_TOKEN>'
node backend/scripts/sse-subscribe.js --url http://localhost:3000
node backend/scripts/sse-subscribe.js --once --no-notify
node backend/scripts/sse-subscribe.js --token-file ~/.dcc-token --quiet
```

| 参数                | 说明                                             |
| ------------------- | ------------------------------------------------ |
| `--url <base>`      | 服务地址，默认 `$DCC_URL` 或 `http://localhost:3000` |
| `--token-file`      | 从文件读取 Token（推荐，避免 shell history）     |
| `--once`            | 收到首个 `clipboard.updated` 后退出              |
| `--raw`             | 写 `raw_text` 而不是提取后的 `content`           |
| `--no-clipboard`    | 只检测更新，不写系统剪贴板                       |
| `--no-notify`       | 不弹桌面通知                                     |
| `--timeout <秒>`    | 空闲超时后主动重连，默认 60 秒                   |
| `--quiet`           | 抑制常规日志                                     |

脚本不会把 Token 写入日志或状态；平台剪贴板/通知依赖与
[pc-poll-sync.md](pc-poll-sync.md) 相同。

## 验收与测试

- `backend/test/clipboard-stream.test.js`：ready/快照字段、采集后 <1s 推送、心跳、
  鉴权与 Query Token、`Last-Event-ID` 去重、连接上限、禁用开关。
- `backend/test/realtime-hub.test.js`：多订阅者、连接上限、共享心跳、TTL、
  事件 id、写入钩子隔离。
- `backend/test/sse-client.test.js`：SSE 解析、参数解析、断线重连、`Last-Event-ID`、
  鉴权失败不重试。
