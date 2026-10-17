# Clipboard latest API (REQ-202610-1256)

`GET /api/v1/clipboard/latest` is the standard read endpoint for downstream
consumers (PC scripts, bots, desktop tools). It implements PRD §4.1.2 with the
security decisions from defects 21 and 24.

## Authentication

Send the shared secret in the `X-DCC-Token` header:

```sh
curl -i http://localhost:3000/api/v1/clipboard/latest \
  -H 'X-DCC-Token: <API_SECRET_TOKEN>'
```

- Header-only. Credentials are never read from the query string: any
  token-like parameter (`token`, `access_token`, `api_key`, `authorization`,
  `secret`, ...) is rejected with `400` and
  `Token must be sent in the X-DCC-Token header; query-string tokens are not supported.`
  before authentication, whether or not a valid header is also present
  (defect 21). `Authorization: Bearer <token>` is accepted as an alternative
  header.
- Missing, empty, wrong, or oversized tokens receive `401` with the shared
  error envelope. When `API_SECRET_TOKEN` is not configured the endpoint fails
  closed.

## Success response (200)

```json
{
  "code": 200,
  "data": {
    "content": "839201",
    "type": "verification_code",
    "raw_text": "【中国移动】您的验证码是：839201，5分钟内有效。请勿泄漏给他人。",
    "source_device": "小米 13Pro",
    "platform": "android",
    "updated_at": 1728950400000,
    "expire_in_seconds": 1800
  }
}
```

| Field               | Type    | Meaning                                                                                 |
| ------------------- | ------- | --------------------------------------------------------------------------------------- |
| `content`           | string  | Extracted code (`parsed_code`) when present; otherwise the raw text                     |
| `type`              | string  | Stored data type: `verification_code` or `text`                                         |
| `raw_text`          | string  | Original SMS/raw clipboard text                                                         |
| `source_device`     | string  | Device name reported by the collector (`unknown` if absent)                             |
| `platform`          | string  | `android` / `ios` (`unknown` if absent)                                                 |
| `updated_at`        | integer | Server receive time in epoch milliseconds (defect 23: client timestamps are never used) |
| `expire_in_seconds` | integer | Whole seconds remaining before the clipboard TTL elapses                                |

The top-level shape intentionally matches the PRD §4.1.2 example: `code` plus
`data`, with no `message` on success.

`expire_in_seconds` is derived from the configured `CLIPBOARD_TTL_MS` (default
30 minutes per §8.2) and the server-assigned `updated_at`, not from a
client-provided timestamp.

## Errors and expiry semantics (defect 24)

An absent clipboard and a TTL-expired clipboard are indistinguishable: both
return `404` with the shared error envelope. Expired data is never served, and
the history log is not exposed by this endpoint.

| Status | Condition                          | Body                                                                                                                        |
| ------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 400    | token-like query parameter present | `{"code":400,"message":"Token must be sent in the X-DCC-Token header; query-string tokens are not supported.","data":null}` |
| 401    | missing / invalid `X-DCC-Token`    | `{"code":401,"message":"Missing or invalid X-DCC-Token header.","data":null}`                                               |
| 403    | HTTPS required (`ENFORCE_HTTPS`)   | `{"code":403,"message":"HTTPS is required.","data":null}`                                                                   |
| 404    | clipboard absent or TTL-expired    | `{"code":404,"message":"No clipboard data available.","data":null}`                                                         |
| 405    | method other than GET              | `{"code":405,"message":"Method not allowed.","data":null}`                                                                  |
| 500    | unexpected failure                 | `{"code":500,"message":"Internal server error.","data":null}`                                                               |

## Polling without re-downloading unchanged data

Every `200` response includes:

- `ETag: "<updated_at_ms>-<clipboard_id>"` — opaque strong validator;
- `Last-Modified: <HTTP date derived from updated_at>`;
- `Cache-Control: no-store` — the clipboard is sensitive, so intermediaries
  must not store it.

Pollers should persist the `ETag` and send it back on the next request:

```sh
# First request: read and remember the ETag
curl -i http://localhost:3000/api/v1/clipboard/latest \
  -H 'X-DCC-Token: <API_SECRET_TOKEN>'

# Subsequent polls: 304 Not Modified with an empty body when nothing changed
curl -i http://localhost:3000/api/v1/clipboard/latest \
  -H 'X-DCC-Token: <API_SECRET_TOKEN>' \
  -H 'If-None-Match: "<updated_at_ms>-<clipboard_id>"'
```

Supported conditional forms, in precedence order:

1. `If-None-Match` — accepts the full ETag, a quoted `updated_at` value, or a
   bare `updated_at` value; `*` matches any current record.
2. `If-Modified-Since` — accepts an HTTP date (or ISO-8601 timestamp); the
   comparison uses the one-second resolution of `Last-Modified`.
3. `?updated_after=<epoch-ms|ISO-8601>` — the simple polling form: returns
   `304` when the current record's `updated_at` is less than or equal to the
   supplied value.

A `304 Not Modified` response has no body and carries the current `ETag`,
`Last-Modified`, and `Cache-Control` headers. A changed clipboard returns
`200` with the full contract. If `If-None-Match` is present but does not match,
`If-Modified-Since` is ignored, per RFC 9110.

## curl example

```sh
curl -sS http://localhost:3000/api/v1/clipboard/latest \
  -H 'X-DCC-Token: <API_SECRET_TOKEN>' | jq .
```
