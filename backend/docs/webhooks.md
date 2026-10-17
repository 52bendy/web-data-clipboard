# Webhook 配置与异步分发（REQ-202610-1258）

新数据写入剪贴板后，后端通过异步分发器把事件推送给已启用的 Webhook。分发在采集响应之后执行，不阻塞、也不影响设备上报结果（PRD §4.1.3 / §7.2.2）。

## 1. 管理 API

所有管理接口要求 `X-DCC-Token` 头（当前与采集接口共用 `API_SECRET_TOKEN`；REQ-202610-1260 的管理端鉴权会统一前置）。

| 方法     | 路径                          | 说明                                                                                |
| -------- | ----------------------------- | ----------------------------------------------------------------------------------- |
| `POST`   | `/api/v1/webhooks`            | 新建配置，body：`{ "url": "...", "name": "可选", "enabled": true }`                 |
| `GET`    | `/api/v1/webhooks`            | 列出全部配置                                                                        |
| `GET`    | `/api/v1/webhooks/:id`        | 查看单个配置                                                                        |
| `PATCH`  | `/api/v1/webhooks/:id`        | 修改 `url` / `name` / `enabled`；`rotate_secret: true` 轮换签名密钥                 |
| `DELETE` | `/api/v1/webhooks/:id`        | 删除配置                                                                            |
| `POST`   | `/api/v1/webhooks/:id/test`   | 后台「测试」按钮：立即执行一次真实转发（即使配置为停用）                            |
| `GET`    | `/api/v1/webhooks/deliveries` | 分发记录；支持 `webhook_id`、`status=success\|failed`、`limit`（默认 50，最大 200） |

创建响应（HTTP 201）：

```json
{
  "code": 201,
  "message": "Webhook created",
  "data": {
    "webhook_id": "wh_…",
    "name": "Ops",
    "url": "https://example.com/dcc-hook",
    "enabled": true,
    "secret": "whsec_…",
    "created_at": "2026-10-17T02:00:00.000Z",
    "updated_at": "2026-10-17T02:00:00.000Z"
  }
}
```

`secret` 用于下游校验 HMAC 签名，属于敏感配置：仅通过鉴权后的管理接口返回，不要写入客户端或日志。

```sh
curl -sS -X POST http://localhost:3000/api/v1/webhooks \
  -H 'Content-Type: application/json' \
  -H 'X-DCC-Token: <API_SECRET_TOKEN>' \
  -d '{"url":"https://example.com/dcc-hook","name":"Ops"}'
```

## 2. 投递请求

每次事件（采集写入剪贴板后）向每个启用配置发送一次 `POST`：

```
Content-Type: application/json; charset=utf-8
User-Agent: DCC-Webhook/1.0
X-DCC-Event: clipboard.updated
X-DCC-Delivery-Id: dlv_<uuid>
X-DCC-Timestamp: <unix 秒>
X-DCC-Signature: sha256=<hex>
```

请求体：

```json
{
  "event": "clipboard.updated",
  "delivery_id": "dlv_…",
  "collection_id": "col_…",
  "sender": "+8610086",
  "created_at": "2026-10-17T02:00:00.000Z",
  "data": {
    "clipboard_id": "…",
    "data_type": "verification_code",
    "parsed_code": "839201",
    "full_text": "【中国移动】您的验证码是：839201，5分钟内有效。",
    "updated_at": "2026-10-17T02:00:00.000Z",
    "source": { "device_name": "小米 13Pro", "platform": "android" }
  },
  "message": "📱 收到新验证码\n-------------------\n验证码：839201\n来源设备：小米 13Pro\n\n\n原始短信：【中国移动】您的验证码是：839201，5分钟内有效。"
}
```

`message` 严格按 PRD §7.2.2 模板生成，可直接转发到 Telegram / 钉钉 / 飞书的自建中转；结构化消费者使用 `data`。`sender` 作为顶层字段提供（它不在 §7.1 剪贴板记录结构里）；未解析出验证码时标题为 `📱 收到新消息` 且省略验证码行。

## 3. HMAC 签名校验

签名算法：

```
signature = "sha256=" + hex(HMAC-SHA256(secret, timestamp + "." + rawBody))
```

- `timestamp` 取 `X-DCC-Timestamp`（十进制 Unix 秒）。
- `rawBody` 必须是收到的原始字节（先验签，再 JSON 解析；不要重新序列化）。
- 建议同时校验时间戳与当前时间相差不超过 5 分钟，防重放。

Node.js 示例：

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, headers, secret) {
  const timestamp = headers['x-dcc-timestamp'];
  const received = headers['x-dcc-signature'] ?? '';
  const expected =
    'sha256=' +
    createHmac('sha256', secret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

## 4. 超时、重试与失败记录

- 单次请求超时：`WEBHOOK_TIMEOUT_MS`（默认 5000ms）。
- 最多尝试次数：`WEBHOOK_MAX_ATTEMPTS`（默认 3，含首次）。
- 重试间隔：`WEBHOOK_RETRY_BASE_DELAY_MS × 2^(attempt-1)`，默认 1000ms → 1s、2s。
- 2xx 视为成功；非 2xx、超时、连接错误和 DNS/目标校验失败都会重试。
- 每次投递结果写入分发记录（成功与失败都写），失败记录可通过 `GET /api/v1/webhooks/deliveries?status=failed` 查询，并输出结构化日志 `webhook.delivery.succeeded` / `webhook.delivery.failed` / `webhook.delivery.retry`。
- 分发器在采集响应之后执行（fire-and-forget）：慢 Webhook 不会延迟 `POST /api/v1/collect`，分发失败也不会让采集失败。

分发记录字段：`delivery_id`、`webhook_id`、`webhook_url`、`event`、`collection_id`、`test`、`status`、`attempts`、`http_status`、`error`、`response_excerpt`、`started_at`、`finished_at`、`duration_ms`。

## 5. SSRF / 目标校验（缺陷 22）

创建、修改和每次投递前都会校验目标：

- 仅允许 `https:`；拒绝 URL 中携带用户名/密码。
- 拒绝 `localhost`、`*.localhost`、`*.local`、`*.internal`、`*.home.arpa`、`*.lan` 和单标签主机名。
- 拒绝回环、私有、链路本地、保留地址：IPv4 `0/8`、`10/8`、`100.64/10`、`127/8`、`169.254/16`、`172.16/12`、`192.0.0/24`、`192.0.2/24`、`192.168/16`、`198.18/15`、`198.51.100/24`、`203.0.113/24`、`224/4`、`240/4`；IPv6 `::`、`::1`、`fc00::/7`、`fe80::/10`、`ff00::/8`、`2001:db8::/32`、`100::/64`，以及 IPv4-mapped / NAT64 中嵌入的上述 IPv4 地址。
- 主机名在配置时解析一次（任一解析结果为受限地址即拒绝），投递时再次解析；实际建立 TLS 连接时还会对 DNS 结果做一次校验，防止 DNS rebinding。
- 不跟随重定向（3xx 视为失败并按重试策略处理）。
- 可选目标白名单：设置 `WEBHOOK_ALLOWED_HOSTS` 后，仅允许匹配的主机名；白名单是叠加在内网/回环拦截之上的额外限制，不能把受限地址放行。

### 5.1 可选目标白名单

默认不启用（允许任意通过上述校验的公网 https 目标）。需要把出站范围收紧到已知下游时，设置逗号分隔的 `WEBHOOK_ALLOWED_HOSTS`：

```sh
# 精确匹配 hooks.example.com；通配 *.partner.example 匹配其子域（不含裸域）
WEBHOOK_ALLOWED_HOSTS=hooks.example.com,*.partner.example
```

- 匹配不区分大小写，忽略末尾的 `.`，端口不参与匹配（`https://hooks.example.com:8443/...` 仍按主机名匹配）。
- `*.example.com` 只匹配至少一级子域（`a.example.com`、`a.b.example.com`），不匹配 `example.com`；如裸域也要放行，请同时列出 `example.com`。
- 创建、修改配置和每次投递前都会按当前白名单重新校验；修改环境变量并重启后，历史配置中不再匹配的目标会在投递时失败并记录分发失败。
- 白名单条目只能是主机名、IP 字面量或 `*.domain` 通配；非法条目会在启动时直接报错（fail fast），避免误配置静默放大范围。

## 6. 环境变量

| 变量                          | 默认   | 说明                                        |
| ----------------------------- | ------ | ------------------------------------------- |
| `WEBHOOK_ALLOWED_HOSTS`       | 空     | 可选目标白名单（逗号分隔，支持 `*.domain`） |
| `WEBHOOK_TIMEOUT_MS`          | `5000` | 单次投递超时                                |
| `WEBHOOK_MAX_ATTEMPTS`        | `3`    | 总尝试次数（含首次）                        |
| `WEBHOOK_RETRY_BASE_DELAY_MS` | `1000` | 指数退避基数                                |
| `WEBHOOK_MAX_CONFIGS`         | `20`   | 最大配置数                                  |
| `WEBHOOK_MAX_DELIVERIES`      | `200`  | 内存分发记录保留条数                        |
