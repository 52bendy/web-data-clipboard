# Backend

Node.js ESM backend and management frontend host. The API routes follow a serverless-friendly layout; `src/server.js` provides the zero-dependency local development server.

Run `npm install` at the repository root, then `npm run dev`. The initial `GET /api/v1/health` route returns JSON. Collection, clipboard, devices, and webhook routes are added by their respective requirements.

## Verification code extraction (REQ-202610-1254)

`src/services/code-extractor.js` exposes a pure function `extractCode(text, options)` that pulls a verification code out of raw SMS text:

- Returns `{ extracted_code, type }`, where `type` is `verification_code` or `text`.
- Rules: 4–8 digit candidates (contiguous, or single-space separated groups) are scored by proximity to context keywords (验证码 / 校验码 / 动态码 / code / OTP …); order numbers, amounts, dates, alphanumeric tokens and over-long digit runs are excluded. Candidates below the score threshold are not extracted.
- Toggle: `options.autoExtract: false` makes the function return the text-only result; `AUTO_EXTRACT=false|0` flips the default in `src/config.js` until the admin settings panel (REQ-202610-1262) takes over.
- Sample set: `test/fixtures/code-samples.js` (20+ positive, 20+ negative), all covered by `npm test`.
