# Rate-limit HTTP verification record

Verified: 2026-10-16 (UTC)
Environment: Node.js v22.23.2; local loopback HTTP server; Linux; repository feature worktree. The harness starts a real `node:http` server on an ephemeral `127.0.0.1` port and closes it in `finally`; it does not create or persist the `/api/v1/collect` business route.

Reproduce from the repository root:

```sh
node --version
node backend/scripts/rate-limit-verification.js
```

The script mounts a temporary test handler at `/api/v1/collect` behind the actual auth and rate-limit middleware. It sends 31 sequential HTTP requests under the default 30-per-60-second config, then tests a one-request/one-second configuration and independent token/IP counters (trusted `X-Forwarded-For` identities). The ephemeral port and fixed-window boundary vary by run, so `Retry-After` is expected to be an integer from 1 through 60 for default policy, and 1 for the one-second policy.

Captured output (Node.js v22.23.2, 2026-10-16 UTC):

```text
default requests 1-30: 200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200
default request 31: 429
default Retry-After: 49
default error body: {"code":429,"message":"Too many requests.","data":null}
threshold=1 first request: 200
threshold=1 second request: 429
threshold=1 Retry-After: 1
threshold=1 window recovery: 200
dimension sequence (new token, same IP; same token, new IP; token limit; IP limit): 200,200,200,429,429
```

Conclusion: the default threshold allowed requests 1–30 and rejected request 31 with the documented JSON envelope and integer `Retry-After`; a lowered threshold was effective and the window reset restored a 200 response. With a limit of two, a different token from the same client IP and the same token from a different IP were admitted independently; the third request from the original token and the third request from the original IP were each rejected as expected.
