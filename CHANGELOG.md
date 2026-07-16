# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security decisions
- **DNS rebinding（原审查 P1-2）定为「已知接受的缺口」，不在代码里修** — 出站守卫校验 DNS 解析
  结果但不 pin 已验证 IP，fetch 会独立再解析一次，存在 TOCTOU 窗口。评估后不修，理由：
  (1) 成本——Node 不公开导出 undici，保留 `fetch` 又要传自定义 `lookup` 就必须新增 undici 依赖；
  不加依赖则须把三个出站点改写成 `node:https.request` 并重新实现流式读取/中止/重定向语义，
  而这是本产品的核心链路；(2) 收益端封堵（摘 IAM 角色 / 强制 IMDSv2 / 网络层封 169.254.169.254）
  比 pin IP 更硬——它同时覆盖没走守卫的出站点（如 `newapi-source` 的导入 fetch，即 P2-1），
  且不依赖「守卫代码写得对」，而本次正好发现该守卫的 IPv6 判定已死了两个版本；
  (3) 触发链需攻击者自建 rebinding DNS + 社工超管，而现实误用（超管填错内网地址）守卫已能挡住。
  **此决策的前提是补偿控制真的落地**，故新增 `pnpm check:egress`
  （`scripts/check-egress-mitigation.mjs`）在评测机本机核实元数据端点是否已封堵，未封堵则退出码 1。
  完整决策记录（含「什么时候必须回来修」）写在 `server/egress-guard.mjs` 的 `assertPublicTarget` 上方。
- **删除 `egress-guard.mjs` 顶部「防 DNS rebinding（校验实连 IP）」的错误注释** — 该模块既不校验
  实连 IP 也不防 rebinding，文件内的函数注释其实自认了这点，两处自相矛盾。这类注释比缺口本身更
  危险：它让读代码的人以为已处理，从而不去看。

### Fixed / Hardened
- **出站守卫的 IPv6 内网判定此前完全失效（P1-1，安全）** — `isPrivateV6` 用正则
  `/::ffff:(\d+\.\d+\.\d+\.\d+)$/` 认 IPv4-mapped，要求点分十进制书写；但 WHATWG `URL` 会先把
  `[::ffff:127.0.0.1]` 归一化成十六进制 `[::ffff:7f00:1]` 再交给守卫，正则**永不命中**——
  这段判定自 0.5.3 起是死代码。实测 `http://[::ffff:a9fe:a9fe]/`（=169.254.169.254 云元数据）
  与 `http://[::ffff:7f00:1]/`（=127.0.0.1）可直接过守卫，而评测机带 IAM 角色、响应体还会进报告。
  改为把 IPv6 解析成 16 字节按位段判定：IPv4-mapped 还原内嵌 v4 走 v4 规则，并补上 `::/96`、
  NAT64 `64:ff9b::/96`、`fe80::/10`（旧的 "fe80" 前缀只覆盖 `fe80::/16`）、`ff00::/8`、
  2002::/16 6to4 内嵌 v4；解析失败一律 fail-closed（`server/egress-guard.mjs`）。
  注：老用例 `isPrivateOrReservedIp("::ffff:10.0.0.1")` 测的是点分写法、直接调用，绕过了 URL
  归一化，所以一直是绿的——新回归用例改测归一化后的真实形态。
- **畸形 Cookie 触发 500，匿名可刷（P2-6）** — `parseCookies` 对每个值做 `decodeURIComponent`，
  遇非法转义（`%zz`、裸 `%`）抛 `URIError`；该函数在鉴权前对每个请求都跑，任何人带一个坏
  cookie 即可让请求 500 并写一条错误日志。改为逐值 try/catch，解不开按原文保留（会话 cookie
  是签名令牌，原文自然验签失败 → 正常 401）（`server/auth.mjs`）。
- **自动测试调度器盘写失败会杀掉整个进程（P2-4）** — `fireJob` 有两处状态回写不在既有 catch
  覆盖内（占位 `lastStatus="running"`、失败分支的回写）；`updateJobs` 落盘失败（盘满 / EACCES）
  时异常会冒到三个「拒绝无人接管」的调用点 —— `tick` 的 `Promise.all`、`start` 的
  `void reconcileThenTick()`、以及 **`runJobNow` 的 `void fireJob(job)`（HTTP「立即运行」端点，
  原审查未列出）** —— 成为 unhandledRejection，Node 默认直接杀进程：一次盘写失败打死整个评测
  平台。改为在 `fireJob` 外层兜底（一处覆盖三个调用点），错误照常上报，内存占位照常解除以便下轮
  重试；盘上残留的 `running` 由启动时的 `reconcileInterruptedJobs` 归位
  （`server/auto-test-scheduler.mjs`）。

### Changed
- **API 路由表（route table）** — `handleApi` 的 62 条 `if (method && pathname)` 顺序匹配（约 1100 行）
  换成文件顶部一张声明式路由表 + 5 行分发，`handleApi` 缩到 35 行。65 条接口现在有唯一清单，
  handler 拆成命名函数（签名 `(req, res, { url, params })`），不依赖 `handleApi` 闭包。零新增依赖，
  未引入 Express 等框架：本服务替用户保管中转站 API key，不宜在请求路径上增加供应链面，
  而鉴权（`api-access.mjs`）与业务逻辑（`server/*.mjs`）本就已抽离，剩下的只是薄分发
  (`server/router.mjs`)。鉴权位置不变，仍在分发之前，门禁判定与路由表无耦合。
  `createRouter` 在建表时做重复规则与顺序体检（被前面的宽规则完全遮蔽的后置规则永不命中，
  是原 if 链最难查的坑：不报错、只是安静走错分支），排错直接启动失败。
- **畸形路径由「静默成功」收紧为 404**（上条的行为变化，仅影响手工构造的请求）——
  原 `startsWith` 匹配会把多段 / 空 id 也吞进 handler，例如 `DELETE /api/profiles/export/`、
  `DELETE /api/auto-test-jobs/a/b` 旧版返回 `200 {"ok":true}`（对一个根本不存在的资源报告删除成功），
  `PUT /api/dev/scenarios/` 返回 400、`POST /api/auto-test-jobs//run` 返回 409。新版路由表要求
  `:id` 为单个非空段，这些一律 404。前端不受影响：`src/` 内 13 处 URL 拼接全部经
  `encodeURIComponent`，id 里的 `/` 编码为 `%2F`，始终是单段（`%2F` 解码后与旧写法等价）。
  另：`:id` 含非法百分号编码（如 `%ZZ`）时旧版 `decodeURIComponent` 抛错被兜成 500，现为 404。

### Added
- **自动测试配置（Auto-test scheduler）** — new page under 高级测试 to configure
  recurring tests for a channel's model: pick model + test kind (快速/准入/稳定性/场景) + period
  (hours); a new in-process scheduler runs each job on its cadence and produces a report. Config
  persisted to `配置/auto-test-jobs.json`; CRUD via `/api/auto-test-jobs` — login-required and
  usable by ordinary admins (role 10), same tier as running tests manually (not `/api/dev/*`)
  (`server/auto-test-store.mjs`, `server/auto-test-scheduler.mjs`). Scheduler is in-process:
  effective only while the server runs, catches up overdue jobs on restart via persisted
  `nextRunAt`, does not resume a run interrupted mid-flight. Hardened: all job-file writes go
  through a serialized `updateJobs` (no read-modify-write races between scheduler and CRUD
  endpoints), and concurrent runs are capped by a semaphore (`EVALUATOR_AUTO_TEST_CONCURRENCY`,
  default 2) so simultaneously-due jobs can't burst the upstream API.

### Fixed / Hardened
- **Atomic JSON writes** — settings, channels, model-targets, profiles, scenario-overrides and the
  encrypted key-vault now write via a shared `writeJsonAtomic` (temp file + rename), so a crash
  mid-write can no longer truncate a config into silent data loss (key-vault corruption would have
  made all channel keys unreadable).
- **`ensureDataDir` startup guard** — a read-only/permission-denied/full `/data` volume now exits
  with an actionable operator message instead of an uncaught stack in a restart loop.
- **SQLite history retention** — `test_requests`/`test_runs`/`regression_alerts`/`model_fingerprints`
  now get the same retention (days + max-rows) as reports, so `evaluator.db` no longer grows
  unbounded (`pruneHistory`, env `EVALUATOR_HISTORY_RETENTION_DAYS`).
- **Scenario group rename no longer pins built-in scenarios** — renaming a group now records a
  field-level group patch for built-in题 instead of freezing the whole scenario into the override
  layer, so future image updates to those scenarios' prompt/scorer are no longer silently masked.

## [0.4.9] - 2026-07-02

### Fixed
- **CI Docker build failed since 0.4.5** — the frontend imports `src/docs/*.md` via Vite's
  `?raw`, but the `.gitignore` rule `docs/` also matched `src/docs/`, so those Markdown files
  were never committed. Local builds passed (files on disk); the CI build (fresh checkout) had
  no such files and `vite build` exited 1. Anchored the ignore to `/docs/` and committed
  `src/docs/category-field.md` and `src/docs/scorer-mechanism.md`.

## [0.4.8] - 2026-07-02

### Changed
- Maintenance re-release of 0.4.6 to publish a versioned container image. The earlier
  `v0.4.7` tag did not trigger CI (pushed as a lightweight tag inside a multi-tag batch,
  which GitHub suppresses); this release re-triggers the image build via a single
  annotated `v0.4.8` tag. No functional changes beyond 0.4.6.

## [0.4.6] - 2026-07-02

### Removed
- **new-api write operations** — removed pushing channels/models to new-api and delete-sync
  (including the `enableDeleteSync` setting and its UI). The only external write features were
  these; new-api integration is now read-only (import + sync-models). Deleted
  `server/newapi-channel-sync.mjs` and its live script/tests; delete of a channel/model is now
  local-only.

## [0.4.3] - 2026-06-29

### Added
- **Push channels & models to new-api** — sync configured channels and their test models
  back to a new-api gateway, with a live channel-sync endpoint and tests
  (`server/newapi-channel-sync.mjs`, import scripts under `scripts/`).
- **New scenario packs** — hardcore-logic and HLE (harder objective probes) added alongside
  the existing livebench pack (`server/scenarios/hardcore-logic.mjs`, `server/scenarios/hle.mjs`).

### Changed
- Benchmark scorers, scenario evaluator, new-api import/source handling, and the
  confirm-dialog refined; accompanying test updates.

## [0.4.2] - 2026-06-24

### Added
- **In-app report popup** — when a long task (stability / scenario / batch) finishes, the
  report now opens automatically in an in-app overlay (iframe), so it works on headless
  Docker / remote deployments where the desktop browser auto-open (`EVALUATOR_OPEN_REPORT`)
  cannot. Toolbar link to open in a new tab; a client toggle (default on) disables it.
- New auth-gated route `GET /api/reports/:id/view` serves a report's HTML over HTTP
  (filename sanitized via `sanitizeReportBaseName`; `nosniff` + script-free CSP). Public
  task results now carry `reportId` / `aiAnalysisId` for the frontend to build the URL.

## [0.4.1] - 2026-06-24

### Added
- **Push model tags to new-api** — aggregate the capability tags granted to model
  targets and write them back to the new-api model marketplace (read-modify-write the
  `tags` field). New endpoint `POST /api/model-targets/push-tags`
  (`server/newapi-tag-writer.mjs`) and a "推送标签到 new-api" button on the model page.
- **LiveBench-style anti-contamination probe pack** for scenario tests (objective
  capability probes resistant to benchmark leakage).
- **Claude tokenizer fingerprint** baseline tool (probe + `count_tokens` / chat dual
  mode); admission tests now cross-check the tokenizer fingerprint.
- **Two-dimension batch target picker** (channel health-check / channel selection) and
  a cascading channel→model picker for single-target run pages.
- Report-center conclusion cards reworked; reports gained a "model return" column; AI
  analysis split into its own HTML; AI summary can read an API from the environment.

### Fixed
- `styles.css`: resolve the undefined `--border` custom property (use `--line`).
- Channel / model-target / profile validation failures now return HTTP 400 with a
  user-facing message instead of being swallowed as a 500.

### Changed
- Removed internal codenames from code comments and report output (neutral wording).
- Single source of truth for runnable test targets (`resolveRunnableTargets`), shared
  by the dashboard count, the run selectors and the workflow guide.
- Unified the protocol-label helper; the new-api `api` import now warns when it hits
  the pagination cap (possible truncation).
- In-app manual and per-page help updated for the channel / model two-layer flow.

### CI
- Tests and image build now also run on the `dev` branch and publish a `:dev` test image.

## [0.3.1] - 2026-06-10

### Added
- Per-channel "sync models" — re-pull a single new-api channel's model list and
  upsert its test models.

### Changed
- Dashboard health card counts runnable test targets (channels + models) so a fresh
  install no longer shows zero.
- Consistent onboarding and flow: nav step numbers, dashboard progress rail, and
  wording aligned to the channel → model → admission → standard flow.

### Fixed
- Readable contrast for secondary / hint text on the dark theme.
- Backend de-duplication of runnable targets after migration (single source of truth).
- Protocol-inference note on import; sanitized A2 (db) import errors (no DSN echo);
  finite-number guards for max tokens / timeout.

## [0.3.0] - 2026-06-10

### Added
- Two-layer configuration: **channels** (super-admin: base URL + key + protocol, holds
  the key) and **test models** (admin: pick a channel + model name, never sees the key).
- One-click import of channels and models from a [new-api](https://github.com/QuantumNous/new-api)
  gateway. Pluggable source: `api` (metadata only, via admin token) or `db` (full incl.
  keys, via a read-only DSN; `mysql2` is an optional, lazy-loaded dependency).
- One-time migration of existing profiles into channels + test models on startup
  (idempotent; reuses ids so the encrypted key survives).

### Changed
- Two-section UI (channels / models) with role-based visibility; the legacy single
  API-config page is retired.

## [0.2.0] - 2026-06-10

Initial open-source release.

### Added
- Built-in presets for common models and expanded model-family fingerprinting.

### Security
- Client-log import is restricted to an allow-list of roots (fail-closed,
  `EVALUATOR_LOG_IMPORT_ROOTS`).
- Replay actions are written to an audit record.
- Login throttling trusts `X-Forwarded-For` only when `EVALUATOR_TRUST_PROXY=true`
  (defaults to the socket address otherwise).

### Fixed
- Concurrency-queue slot leak on the task-manager cancel path.

[Unreleased]: https://github.com/yl0711-coder/API-evaluator/compare/v0.4.6...dev
[0.4.6]: https://github.com/yl0711-coder/API-evaluator/compare/v0.4.3...v0.4.6
[0.3.1]: https://github.com/yl0711-coder/API-evaluator/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/yl0711-coder/API-evaluator/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/yl0711-coder/API-evaluator/releases/tag/v0.2.0
