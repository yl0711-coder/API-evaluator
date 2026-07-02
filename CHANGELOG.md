# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
