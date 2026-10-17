# Deployment and runtime configuration

## Runtime choice

This service targets Vercel Serverless Functions on Node.js 20.x, with the Vercel project Root Directory set to `backend`. The catch-all handler is exposed through `api/index.js`; Vercel filesystem routes take precedence, so `/api/v1/health` is served directly by `api/v1/health.js` and the `vercel.json` rewrite is only a fallback for unmatched paths. The implementation uses Node's `node:http` and ESM and needs no runtime dependencies. Cloudflare Workers use a Fetch-style `fetch` handler rather than this Node HTTP entry point, so Vercel minimizes changes today. A future Workers migration can retain the HTTP-based Upstash REST storage adapter and replace/adapt only the platform entry point, then rerun the API and health-check tests.

## Storage

The target production store is Upstash Redis REST: it is accessed over HTTP, works without a persistent Node process, and supports expiring keys, offers a free tier, and keeps the storage access HTTP-based for future migration. Select it with `STORAGE_DRIVER=upstash` and configure `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, and optionally `STORAGE_KEY_PREFIX`. Keep `memory` for local development and tests; it is not durable or shared across serverless instances. Vercel KV is a possible managed alternative, while D1 or Supabase could be evaluated as a future persistence enhancement; neither is configured by this deployment task.

## First Vercel deployment

1. Import the repository into Vercel and set the project Root Directory to `backend`.
2. Create an Upstash Redis database and configure `STORAGE_DRIVER=upstash`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, and `STORAGE_KEY_PREFIX` in Vercel Project Settings → Environment Variables for Production (and Preview if needed). Never commit real values.
3. Deploy from Vercel. Check the deployment at `https://<domain>/api/v1/health`; it should return HTTP 200 and `{"status":"ok"}`. The repository helper can check a deployed URL with `node scripts/health-check.js https://<domain>/api/v1/health` from the `backend` directory.

## GitHub Actions

`.github/workflows/ci.yml` runs on every branch push and pull request. It installs dependencies, then runs lint and tests on Node.js 20.x and 22.x; it never deploys. `.github/workflows/deploy.yml` validates on pushes to `main` and manual dispatch, then deploys to Vercel production only when all three repository Actions secrets are present: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID`.

If any Vercel secret is missing, the deploy workflow writes a `Deployment skipped` explanation referencing REQ-202610-1251 to the run's Job Summary, marks deployment as unconfigured, and skips deployment without failing the validation job. This preserves a visible record while allowing CI validation in environments without deployment credentials. Add the three secrets in GitHub repository Settings → Secrets and variables → Actions to enable deployment.

## Health checks and rollback

The health endpoint is `GET /api/v1/health` and returns `{"status":"ok"}` with HTTP 200. `backend/scripts/health-check.js [url]` checks that response; when run from the repository root, use `node backend/scripts/health-check.js https://<domain>/api/v1/health`. The deploy workflow performs this check against the resulting Vercel deployment URL and fails if the endpoint does not become healthy within its retry window.

To roll back, use Vercel Dashboard → Deployments to promote/redeploy the last known-good production deployment, or use the Vercel CLI `vercel rollback` from the linked project. Confirm the health endpoint after rollback.

## Security and limitations

Keep credentials out of source control: `.env` and `.env.*` are ignored, with `.env.example` intentionally allowed and containing no real secrets. Store production application values in Vercel Project Settings → Environment Variables and CI credentials in GitHub Actions Secrets. The `API_SECRET_TOKEN`, HTTPS/proxy, CSP/HSTS, and rate-limit variables are inventory for REQ-202610-1252 and are not enforced by this backend yet; do not assume they provide protection in this revision.

An initial production release requires a maintainer to configure Vercel and Upstash values manually. In the absence of the three Vercel Actions secrets, the workflow validates but records and skips deployment, as required by REQ-202610-1251. The Cloudflare Workers runtime adapter is not included; migration requires implementing and testing its Fetch handler. Any listed alternative storage (Vercel KV, D1, or Supabase) is not configured here.
