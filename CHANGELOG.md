# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/yl0711-coder/API-evaluator/compare/v0.3.1...dev
[0.3.1]: https://github.com/yl0711-coder/API-evaluator/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/yl0711-coder/API-evaluator/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/yl0711-coder/API-evaluator/releases/tag/v0.2.0
