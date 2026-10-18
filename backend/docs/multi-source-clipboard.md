# Multi-source clipboard and namespaces (REQ-202610-1276)

The clipboard used to be an SMS-only pipeline. This requirement generalises it
into a project-level clipboard: any project or script can copy text, links or
JSON into a namespace, and another project can paste it from the same namespace
without touching the SMS pipeline.

## Concepts

| Concept       | Meaning                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `namespace`   | An isolated clipboard (own `latest` record and history). Default: `default`, which the SMS collector owns.                    |
| `project`     | The logical source project recorded on every write (`source.project`).                                                        |
| `label`       | Human-readable source label shown and filterable in the admin (`source.label`).                                                |
| `collector`   | The integration that produced the write: `sms` for the built-in collector, `api` for general writes (configurable per token). |
| `source_device` | Free-form device/runner name; defaults to the token name for API writes.                                                     |

Namespaces are case-sensitive, 1–64 characters, and restricted to letters,
digits, `.`, `_` and `-` (must start with a letter or digit). Missing or empty
namespace values mean `default`, so existing clients keep working unchanged.

## Authentication and scopes

`API_SECRET_TOKEN` remains the system credential: it can read/write every
namespace and attribute a write to any project.

Additional project credentials are configured as a JSON array in
`CLIPBOARD_TOKENS`:

```json
[
  {
    "token": "replace-with-a-long-random-secret",
    "project": "project-a",
    "label": "项目 A",
    "name": "project-a-ci",
    "collector": "api",
    "namespaces": ["project-a", "shared"],
    "permissions": ["read", "write"]
  }
]
```

- `namespaces` defaults to `["default"]`; use `["*"]` for all namespaces.
- `permissions` defaults to `["read", "write"]`.
- A project token may only write records whose `project` equals its own
  configured project. Attempting another project returns `403`.
- Namespace access outside the list returns `403`.
- Tokens are header-only (`X-DCC-Token`); query-string tokens are rejected.

## Write API

`POST /api/v1/clipboard/write`

```sh
curl -sS -X POST http://localhost:3000/api/v1/clipboard/write \
  -H 'Content-Type: application/json' \
  -H 'X-DCC-Token: <project token>' \
  -d '{
    "content": "release v1.2.3 is green",
    "type": "text",
    "namespace": "shared",
    "label": "CI 构建结果"
  }'
```

Body fields:

| Field           | Required | Meaning                                                                                     |
| --------------- | -------- | ------------------------------------------------------------------------------------------- |
| `content`       | yes      | Text/link string, or any JSON value when `type` is `json`.                                  |
| `type`          | no       | `text` (default), `link` or `json`. `link` requires an absolute `http`/`https` URL.        |
| `namespace`     | no       | Target namespace; defaults to `default`.                                                    |
| `project`       | no       | Source project. Defaults to the token's project; system token defaults to `api`.           |
| `label`         | no       | Source label shown in the admin; defaults to the token label/project.                      |
| `source_device` | no       | Device/runner name; defaults to the token name/project.                                     |
| `platform`      | no       | Free-form platform tag; defaults to `api`.                                                  |

Success response (`200`):

```json
{
  "code": 200,
  "message": "Clipboard updated",
  "data": {
    "content": "release v1.2.3 is green",
    "type": "text",
    "raw_text": "release v1.2.3 is green",
    "source_device": "project-a-ci",
    "platform": "api",
    "namespace": "shared",
    "source_project": "project-a",
    "source_label": "CI 构建结果",
    "collector": "api",
    "updated_at": 1792296000000,
    "expire_in_seconds": 1800,
    "clipboard_id": "…",
    "received_at": "2026-10-17T12:00:00.000Z",
    "collection_id": "col_…"
  }
}
```

For `type: "json"`, `content` in the response is the original JSON value (not a
string) and `raw_text` is its pretty-printed serialization.

## Read API and SSE

`GET /api/v1/clipboard/latest?namespace=<name>` reads one namespace. The
response keeps the PRD §4.1.2 fields and adds `namespace`, `source_project`,
`source_label` and `collector`. ETag/conditional polling and TTL semantics are
unchanged.

`GET /api/v1/clipboard/stream?namespace=<name>` subscribes to one namespace
only; events from other namespaces are filtered out. The `ready` event echoes
the subscribed namespace.

## SMS collector integration

`POST /api/v1/collect` is unchanged on the wire. Internally every SMS record is
tagged with:

- `source.project` = `SMS_PROJECT` (default `sms`)
- `source.label` = `SMS_SOURCE_LABEL` (default `短信采集`)
- `source.collector` = `sms`
- namespace = `SMS_NAMESPACE` (default `default`)

The collector log entry stores the same metadata, which is what the admin log
board filters on.

## Admin display and filtering

- Dashboard: the clipboard card shows source project, source label, collector
  and namespace; the stat row adds today's non-SMS API writes.
- Logs: `GET /api/v1/logs` and `/api/admin/logs` accept `collector`, `project`,
  `source` (substring across collector/project/label) and `namespace` filters.
  The log page exposes the same filters and columns.

## Acceptance walkthrough

```sh
# 1. SMS writes the default namespace.
curl -sS -X POST http://localhost:3000/api/v1/collect \
  -H 'Content-Type: application/json' -H 'X-DCC-Token: <system token>' \
  -d '{"device_id":"android_1","device_name":"Pixel","platform":"android","raw_content":"验证码 839201","timestamp":1792296000000}'

# 2. Project A copies JSON into the shared namespace.
curl -sS -X POST http://localhost:3000/api/v1/clipboard/write \
  -H 'Content-Type: application/json' -H 'X-DCC-Token: <project-a token>' \
  -d '{"content":{"build":"42"},"type":"json","namespace":"shared","label":"CI"}'

# 3. Project B pastes it.
curl -sS 'http://localhost:3000/api/v1/clipboard/latest?namespace=shared' \
  -H 'X-DCC-Token: <project-b token>'

# 4. The SMS clipboard is still intact.
curl -sS http://localhost:3000/api/v1/clipboard/latest \
  -H 'X-DCC-Token: <system token>'
```

This flow is covered by `backend/test/multi-source-acceptance.test.js`.

## Security notes

- Clipboard content is sensitive: all reads remain header-authenticated and
  `Cache-Control: no-store`; query tokens are rejected.
- Project tokens are stored in `CLIPBOARD_TOKENS`; never commit real values or
  log them. Validation errors deliberately omit token contents.
- Namespace isolation is enforced at the HTTP layer for every read, write and
  SSE subscription.
- API writes are mirrored into the collection log, but a log failure never
  rejects or rolls back a durable clipboard write.
