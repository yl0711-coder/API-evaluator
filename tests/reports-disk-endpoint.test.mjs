// tests/reports-disk-endpoint.test.mjs
// 端点集成：真起 server.mjs 子进程，验证 GET /api/reports/disk：
//   - 未登录 → 401；登录 → 200 且返回合理的 freeBytes/totalBytes/usedPercent。
// 范式照搬 tests/auto-test-digest-endpoint.test.mjs。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test, { before, after } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 5389;
const dataDir = mkdtempSync(join(tmpdir(), "reports-disk-endpoint-"));
let server;
let ready = false;
let cookie = "";

const baseEnv = {
  EVALUATOR_SESSION_SECRET: "test-secret-0123456789abcdef-32b+",
  EVALUATOR_ADMIN_PASSWORD: "adminpw",
  EVALUATOR_SECRET_STORE: "memory",
  EVALUATOR_COOKIE_SECURE: "false",
  HOST: "127.0.0.1",
};

async function waitHealthy() {
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
async function login() {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${PORT}` },
    body: JSON.stringify({ username: "admin", password: "adminpw" }),
  });
  return (r.headers.get("set-cookie") || "").split(";")[0];
}
async function get(path, ck) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { origin: `http://127.0.0.1:${PORT}`, cookie: ck || "" } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

before(async () => {
  server = spawn(process.execPath, [join(root, "server.mjs")], {
    env: { ...process.env, ...baseEnv, EVALUATOR_DATA_DIR: dataDir, PORT: String(PORT) },
    stdio: "ignore",
  });
  ready = await waitHealthy();
  if (ready) cookie = await login();
});
after(() => {
  server?.kill();
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* best-effort */
  }
});

test("未登录 → 401", async () => {
  assert.ok(ready, "server 未就绪");
  const r = await get("/api/reports/disk", "");
  assert.equal(r.status, 401);
});

test("登录 → 200，返回合理的磁盘用量数字", async () => {
  const r = await get("/api/reports/disk", cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(Number.isFinite(r.body.totalBytes) && r.body.totalBytes > 0, "totalBytes 应为正数");
  assert.ok(Number.isFinite(r.body.freeBytes) && r.body.freeBytes >= 0, "freeBytes 应为非负数");
  assert.ok(r.body.freeBytes <= r.body.totalBytes, "剩余不应超过总量");
  assert.ok(r.body.usedPercent >= 0 && r.body.usedPercent <= 100, "usedPercent 应在 0~100 之间");
});
