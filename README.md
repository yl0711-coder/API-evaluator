# API-evaluator

A self-hosted web tool to **evaluate any OpenAI-compatible / Claude-compatible API gateway or relay**.
Point it at a `baseUrl + apiKey + model`, and it runs connectivity, stability, scenario and
admission tests, estimates cost, and produces shareable Markdown/HTML reports.

It is provider-agnostic: it works with any endpoint that speaks the OpenAI Chat Completions,
OpenAI-compatible, or Claude Messages protocol (OpenAI, Anthropic, DeepSeek, or any relay in front of them).

> 一句话：一个自托管的「中转站 / OpenAI 兼容 API」模型评测平台。填入 `baseUrl + apiKey + 模型`
> 即可跑连通、稳定性、场景与准入测试，给出成本预估和可对外交付的报告。与任何具体厂商无关。

**Works standalone, or deeply with new-api.** Configure channels (`url + key`) and test models by
hand and everything works. If your gateway is built on
[new-api](https://github.com/QuantumNous/new-api), you can also one-click import all its channels
and models (enabled/disabled status synced) so you don't re-enter what's already configured —
see [new-api integration](#new-api-integration). new-api is optional, never required.

## Features

- **Any compatible endpoint** — OpenAI Chat, OpenAI-compatible, and Claude Messages protocols.
- **Test suites** — quick connectivity; **one-shot quick-verify** (authenticity + token-inflation +
  real spend in a single page); admission grade (A–F); stability (N rounds, with Wilson CI /
  bootstrap / McNemar significance); scenario packs; and **batch multi-channel compare** with ranking.
- **Model authenticity & token honesty** — claimed-vs-self-reported family check, behavioral +
  tokenizer fingerprinting, cross-channel consensus baseline, and drift detection (catch a silently
  swapped/downgraded model).
- **Trend & regression alerts** — per-channel success-rate trend chart over time, with baseline
  regression detection that flags when a channel degrades.
- **Real spend tracking** — actual token/cost per run is shown in the report and persisted to a
  spend ledger; cumulative spend is queryable via the `GET /api/spend` endpoint.
- **Concurrency queue** — heavy tests are globally rate-limited (configurable slots); excess runs
  queue with position + ETA, protecting a co-located host.
- **Channels & test models (two layers)** — a super-admin configures *channels* (`url + key +
  protocol`, holds the keys); an admin then creates *test models* by picking a channel and typing a
  model name (never sees the key). Run pages select a test model to evaluate.
- **new-api integration (optional)** — one-click import channels + models from a
  [new-api](https://github.com/QuantumNous/new-api) gateway, with enabled/disabled status synced.
  Pluggable source: `api` (admin token, metadata only) or `db` (read-only DSN, full incl. keys).
- **Channel dedup** — adding a channel whose URL + key match an existing one is rejected.
- **Cost estimates** — per-run input/output token cost using prices you configure (advisory only,
  never blocks a test).
- **Reports** — Markdown + HTML, kept in a report center, exportable for hand-off.
- **Roles** — a super-admin (role 100: configures channels, holds the keys) and an admin (role 10:
  creates test models and runs them; never sees the key).
- **Security built-in** — keys stored in an encrypted vault (never returned to the browser),
  HMAC-signed sessions, login throttling, and an egress guard that blocks requests to private /
  reserved IP ranges (SSRF protection).
- **Token-billing precision** — for OpenAI-encoding models, reported `prompt_tokens` are checked
  against the official tokenizer (absolute, single-channel over-report detection); other families
  fall back to a cross-channel consensus baseline.
- **Lightweight runtime** — Node-native (`node:http`, `node:sqlite`) with a single mature runtime
  dependency, [`gpt-tokenizer`](https://github.com/niieani/gpt-tokenizer) (MIT), for exact
  OpenAI-family token accounting. Frontend bundled with Vite.

## Requirements

- Node.js **>= 22.5** (uses the built-in `node:sqlite`). Node 24 is recommended and is what the
  Docker image ships.
- [pnpm](https://pnpm.io) (or use the Docker image, which builds everything for you).

## Quick start (local)

```bash
pnpm install

cp .env.evaluator.example .env.evaluator
# Edit .env.evaluator and set at least:
#   EVALUATOR_SESSION_SECRET   ->  openssl rand -hex 32
#   EVALUATOR_ADMIN_PASSWORD   ->  your admin password (local auth, see below)
#   EVALUATOR_COOKIE_SECURE=false  ->  for plain-http local debugging only, so the
#                                      session cookie is sent over http (keep true behind HTTPS)

pnpm build                      # build the frontend into dist/
node --env-file=.env.evaluator server.mjs
# Open http://127.0.0.1:5180  (override bind with HOST / PORT)
```

Log in with `admin` + the password you set, then add a channel under **API 配置** (base URL,
API key, protocol, model) and run a test.

## Authentication

Login is pluggable via `EVALUATOR_AUTH_BACKEND`:

| Backend | When to use | How |
|---|---|---|
| `local` (default) | Standalone / most users | Accounts come from `EVALUATOR_ADMIN_PASSWORD` (creates `admin`, role 100) and/or `EVALUATOR_LOCAL_USERS="name:password:role,..."`. |
| `newapi` | You already run a [new-api](https://github.com/QuantumNous/new-api)-compatible gateway and want to reuse its accounts | Set `EVALUATOR_NEWAPI_BASE_URL`; credentials are forwarded to `/api/user/login` to validate and read the role. Credentials are never stored or logged. |

Roles: `100` = admin (can configure models and see-but-not-expose keys), `10` = regular user
(pick a saved config + model only). Adjust the gate with `EVALUATOR_ALLOWED_ROLES` /
`EVALUATOR_CONFIG_WRITE_ROLE`. See [`.env.evaluator.example`](.env.evaluator.example) for all options.

## Deployment

Build the image on a build host or in CI (**not** on a small production box — the frontend build can
saturate CPU), then run it behind a reverse proxy that terminates HTTPS, with a `/data` volume for
persisted config and reports. A `docker-compose` file and a Caddy reverse-proxy snippet are in
[`deploy/`](deploy/).

```bash
# Build once on a build host / CI:
docker build -t api-evaluator:0.7.10 .
# Then on the server (image loaded/pulled), run without rebuilding:
docker compose --env-file .env.evaluator \
  -f deploy/docker-compose.evaluator.yml up -d --no-build evaluator
```

### Health recovery on systemd hosts

The compose deployment intentionally does **not** mount the Docker socket into any container. Docker's socket API
is privileged even when the mount is read-only. Instead, install the supplied host-side systemd timer: it checks
only the fixed `api-evaluator` container and restarts it only when Docker reports its health as `unhealthy`.

```bash
# Stop the legacy socket-owning watcher during an upgrade, if it exists.
docker rm -f api-evaluator-autoheal 2>/dev/null || true

# Run the updated compose deployment first, so Docker owns the healthcheck.
docker compose --env-file .env.evaluator \
  -f deploy/docker-compose.evaluator.yml up -d --no-build evaluator

# Copy recovery assets to a host location that application containers cannot write.
sudo install -d -o root -g root -m 0755 /usr/local/lib/api-evaluator
sudo install -o root -g root -m 0755 deploy/api-evaluator-health-recovery.sh \
  /usr/local/lib/api-evaluator/api-evaluator-health-recovery.sh
sudo install -o root -g root -m 0644 deploy/api-evaluator-health-recovery.service \
  /etc/systemd/system/api-evaluator-health-recovery.service
sudo install -o root -g root -m 0644 deploy/api-evaluator-health-recovery.timer \
  /etc/systemd/system/api-evaluator-health-recovery.timer
sudo systemctl daemon-reload
sudo systemctl enable --now api-evaluator-health-recovery.timer
```

Check the timer with `systemctl list-timers api-evaluator-health-recovery.timer` and recovery attempts with
`journalctl -u api-evaluator-health-recovery.service`. For Kubernetes, Nomad, or another orchestrator, use its
native health-recovery controller instead of installing this timer.

**Resource isolation** — the compose file caps the container (`mem_limit: 768m`, `cpus: "0.90"`) so
it can be co-located with another service without starving it: on overrun only this container is
OOM-killed, not the host. These defaults target a 1 vCPU / 1 GB host, with
`EVALUATOR_MAX_CONCURRENT_TASKS=2`（异步任务、同步测试和自动作业共用的总额度）; if memory is tight, set `EVALUATOR_OFFLINE_TOKENIZER=off` (drops
the ~70–90 MB tokenizer and falls back to the cross-channel baseline).

### Performance diagnosis and tuning

`GET /api/health` includes a `performance` snapshot with process CPU and memory, event-loop delay,
global execution slots (`active` and `queued`), automatic-test status, and rolling upstream counts for
timeouts, 429s, 5xx responses, network errors, retries, and end-to-end latency. Task API responses and
the task center expose `timing.queueWaitMs`, `timing.executionMs`, `timing.finalizeMs`, and
`timing.totalMs` for completed, failed, and cancelled tasks.

Tune in this order: inspect queue depth, event-loop delay, CPU, and memory; then inspect upstream
timeouts, retries, and rate limits. Increase `EVALUATOR_MAX_CONCURRENT_TASKS` only when CPU is not
saturated and upstream requests are not being limited. Keep model comparisons, bulk report exports,
and maintenance work low priority so they do not compete with evaluations.

## Configuration

All configuration is via environment variables — see [`.env.evaluator.example`](.env.evaluator.example).
Persisted data (model configs, encrypted key vault, reports, logs, SQLite db) lives under the data
directory (`/data` in Docker; override with `EVALUATOR_DATA_DIR`).

### Report retention & cleanup

Reports and history don't grow unbounded on a long-running server. A maintenance pass runs on
startup and then on a timer (`EVALUATOR_MAINTENANCE_INTERVAL_HOURS`, default 24h):

- Reports older than `EVALUATOR_REPORT_RETENTION_DAYS` (default 180) or beyond
  `EVALUATOR_REPORT_MAX_TOTAL` (default 2000) are deleted.
- Reports older than `EVALUATOR_REPORT_COMPRESS_AFTER_DAYS` (default 30) are gzip-compressed
  in place — filename and extension stay the same; report file/HTML reads transparently
  decompress based on the gzip magic bytes, so nothing else (report list, viewer, model
  compare) needs to know a report is compressed.
- SQLite history rows (requests/runs/alerts/fingerprints) older than
  `EVALUATOR_HISTORY_RETENTION_DAYS` (default 90) are pruned so the db doesn't grow forever.

The default retention of 180 days is meant to be read as "compress at 30 days, then keep the
compressed report around for another ~150 days before deleting it."

## new-api integration

If your gateway is built on [new-api](https://github.com/QuantumNous/new-api), a super-admin can
one-click import its channels and models (button on the **渠道管理 / Channels** page). Already
configured channels need not be re-entered; only new ones are added by hand. Re-importing is
idempotent (upsert by new-api channel id) and syncs enabled/disabled status.

Set `EVALUATOR_IMPORT_SOURCE` to pick the source (it is off when unset):

| Mode | What it imports | Needs | Note |
|---|---|---|---|
| `api` | url / models / status / protocol (no key) | new-api base URL + import token (admin access token) | new-api protects the plaintext key behind 2FA, so keys can't be pulled via the API — fill them in afterwards. |
| `db` | everything incl. keys (fully automatic) | `EVALUATOR_NEWAPI_DB_DSN` (read-only) + `mysql2` (core dep) | Reads the `channels` table directly. Grant the read-only account `SELECT` on `channels`. |

The same `EVALUATOR_NEWAPI_DB_DSN` also backs **邮件报警配置 → 一键同步线上配置** (SMTP config
sync, super-admin only, on the notify-config page). It reads new-api's `options` table
(`SMTPServer/SMTPPort/SMTPAccount/SMTPFrom/SMTPToken/SMTPSSLEnabled`) — same pattern as
newapi-monitor's own SMTP sync. Grant the read-only account `SELECT` on `options` too:

```sql
GRANT SELECT ON <newapi_db>.channels TO '<ro_user>'@'%';
GRANT SELECT ON <newapi_db>.options  TO '<ro_user>'@'%';
```

Without the DSN configured, the sync button fails with a clear "未配置 EVALUATOR_NEWAPI_DB_DSN"
error and existing config is left untouched — it never blocks page load.

For `api` mode, the new-api **base URL / import token / admin user id** can be set in-app under
**帮助与设置 → 设置 → new-api 网关** (super admin only; saved to local `settings.json`, takes effect
immediately without a restart). The token is write-only — it is never echoed back to the browser.
The matching `EVALUATOR_NEWAPI_*` env vars remain as a fallback (used only when the settings fields
are blank), so existing deployments keep working. Note the auth backend (`EVALUATOR_AUTH_BACKEND=newapi`)
still reads `EVALUATOR_NEWAPI_BASE_URL` from env for login, since that happens before any session exists.
The `db`-mode DSN stays env-only.

Compatibility: verified against new-api **v1.0.0-rc.4**. The `db` mode reads only the long-stable
core columns `id / type / name / base_url / models / status / key` and degrades gracefully, so it
works across new-api versions that keep those columns. Channel `type` maps to a protocol
(`14` → Claude Messages, otherwise OpenAI-compatible); a few native-protocol upstreams may need the
protocol adjusted by hand after import.

## Development

```bash
pnpm install
pnpm dev          # Vite dev server (frontend)
pnpm dev:server   # API server (node server.mjs)
pnpm test         # node --test (unit tests)
```

## Security notes

- Never commit a real `.env.evaluator` — it holds your session secret and passwords. It is
  git-ignored by default.
- Only the admin role can configure channels and view/store keys; keys are AES-GCM encrypted at rest
  and never sent back to the browser.
- The egress guard rejects outbound test traffic to private/reserved IP ranges. Keep
  `EVALUATOR_EGRESS_DENY_PRIVATE=true` unless you intentionally test an internal endpoint.
- The content-safety scenario pack (probes that check whether a model *refuses* disallowed
  requests) is **off by default**; enable it with `EVALUATOR_ENABLE_SAFETY_SCENARIOS=1`. A passing
  result means the model refused; the probes never ask for explicit content.

> Note: the web UI and inline code comments are primarily Chinese; contributions in English or
> Chinese are both welcome.

## License

[MIT](LICENSE)
