# API-evaluator

A self-hosted web tool to **evaluate any OpenAI-compatible / Claude-compatible API gateway or relay**.
Point it at a `baseUrl + apiKey + model`, and it runs connectivity, stability, scenario and
admission tests, estimates cost, and produces shareable Markdown/HTML reports.

It is provider-agnostic: it works with any endpoint that speaks the OpenAI Chat Completions,
OpenAI-compatible, or Claude Messages protocol (OpenAI, Anthropic, DeepSeek, or any relay in front of them).

> 一句话：一个自托管的「中转站 / OpenAI 兼容 API」模型评测平台。填入 `baseUrl + apiKey + 模型`
> 即可跑连通、稳定性、场景与准入测试，给出成本预估和可对外交付的报告。与任何具体厂商无关。

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
- **Channel dedup** — adding a channel whose URL + key + model all match an existing one is rejected.
- **Cost estimates** — per-run input/output token cost using prices you configure (advisory only,
  never blocks a test).
- **Reports** — Markdown + HTML, kept in a report center, exportable for hand-off.
- **Roles** — an admin role (configures models, holds the keys) and a regular role (only picks a
  saved config + model to run; never sees the key).
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
docker build -t api-evaluator:latest .
# Then on the server (image loaded/pulled), run without rebuilding:
docker compose --env-file .env.evaluator \
  -f deploy/docker-compose.evaluator.yml up -d --no-build evaluator
```

**Resource isolation** — the compose file caps the container (`mem_limit: 512m`, `cpus: "0.75"`) so
it can be co-located with another service without starving it: on overrun only this container is
OOM-killed, not the host. On a very small host (e.g. 2 vCPU / 2 GB) set
`EVALUATOR_MAX_CONCURRENT_TASKS=2`; if memory is tight, set `EVALUATOR_OFFLINE_TOKENIZER=off` (drops
the ~70–90 MB tokenizer and falls back to the cross-channel baseline).

## Configuration

All configuration is via environment variables — see [`.env.evaluator.example`](.env.evaluator.example).
Persisted data (model configs, encrypted key vault, reports, logs, SQLite db) lives under the data
directory (`/data` in Docker; override with `EVALUATOR_DATA_DIR`).

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
