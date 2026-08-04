# Local Website Preview Workflow

This guide explains how developers and AI agents can start a local preview,
verify it in a browser, and hand over the correct URL.

## Services and URLs

| Process | Default URL | Purpose |
| --- | --- | --- |
| Vite frontend | `http://127.0.0.1:5179` | Serves the UI with hot reload. |
| API server | `http://127.0.0.1:5180` | Handles `/api`, storage, login, and scheduled jobs. |

Vite proxies browser requests beginning with `/api` to the API server. Start
only Vite for visual inspection. Start both processes when a preview needs
login, storage, or API requests.

## One-time setup

Use Node.js 24.18.0 or a compatible version and pnpm 11.

```powershell
pnpm install
Copy-Item .env.evaluator.example .env.evaluator
```

For a functional local preview, configure the session secret and local admin
password in `.env.evaluator`. Never put real credentials in source files,
terminal output, screenshots, or handoff messages.

## UI-only preview

From the repository root, run:

```powershell
pnpm dev
```

Open `http://127.0.0.1:5179` in a browser. Keep the command running while the
page is being reviewed. Frontend source changes reload automatically.

This mode is suitable for layout, copy, and local interaction checks that do
not require the API. Requests to `/api` fail unless the API server is running.

## Functional preview

Open two terminals in the repository root.

Terminal A starts the backend with the local environment file:

```powershell
node --env-file=.env.evaluator server.mjs
```

Terminal B starts Vite:

```powershell
pnpm dev
```

Open `http://127.0.0.1:5179`. Use this URL for development review because it
includes hot reload and forwards `/api` traffic to the backend.

For a production-like check, build the frontend and use the backend URL:

```powershell
pnpm build
node --env-file=.env.evaluator server.mjs
```

Open `http://127.0.0.1:5180` in this mode. The backend serves `dist/`.

## Use a different port

Vite uses `strictPort`, so it stops instead of silently choosing another port.
If the defaults are occupied, use a matching pair. This example uses frontend
`5181` and backend `5182`.

Terminal A:

```powershell
$env:API_PORT = "5182"
node --env-file=.env.evaluator server.mjs
```

Terminal B:

```powershell
$env:VITE_PORT = "5181"
$env:API_PORT = "5182"
pnpm dev
```

Open `http://127.0.0.1:5181`. The frontend and backend must use the same
`API_PORT`, otherwise Vite proxies to the wrong process.

## Browser verification for AI agents

When the Codex desktop browser is available, an agent should:

1. Start the required local process or processes in the background and retain
   their process information until verification is complete.
2. Navigate the in-app browser to the exact frontend URL.
3. Wait for the page to settle, then inspect the visible state and take a
   screenshot when the change is visual or interactive.
4. Exercise the changed workflow. For API-backed work, confirm that the
   request succeeds, not merely that the control is visible.
5. Report the URL, what was verified, and whether the preview is UI-only or
   backed by the local API server.

For a user handoff, provide a plain local URL such as
`http://127.0.0.1:5179`. Do not describe a preview as available unless its
server process is still running.

## Quick diagnostics

| Symptom | Check | Resolution |
| --- | --- | --- |
| Vite reports that the port is in use | Another local process owns `5179`. | Stop the known process or use the paired-port procedure above. |
| The page loads but API actions fail | The backend is not running or Vite has a different API port. | Start the backend and match `API_PORT` in both terminals. |
| Login does not persist locally | The local environment is incomplete or secure cookies are enabled over HTTP. | Review `.env.evaluator`; use the documented local HTTP cookie setting only for local debugging. |
| The production URL is stale | `dist/` was built before the latest change. | Run `pnpm build`, then restart the backend if necessary. |
| Vite cannot write `.vite-temp` in an automated sandbox | The sandbox blocks temporary writes under `node_modules`. | Grant narrowly scoped permission for the Vite build or run it in a writable local environment. |

## Safety rules

- Keep the development server bound to `127.0.0.1`; do not expose it on a
  network interface unless the task explicitly requires it.
- Treat `.env.evaluator` as secret material. It is for local use only and must
  not be committed.
- Stop preview processes when they are no longer needed, especially before
  changing ports or switching worktrees.
