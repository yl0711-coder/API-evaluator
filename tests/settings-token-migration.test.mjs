// tests/settings-token-migration.test.mjs
// 启动迁移：旧版把 new-api 系统令牌明文写在 settings.json。新版启动应把它挪进加密库、
// 从 settings.json 抹除，且功能不受影响（GET 报告已配置）。
// 预先在临时 dataDir 写一个含明文令牌的 settings.json，再起 server.mjs 子进程核对。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test, { before, after } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 5393;
const dataDir = mkdtempSync(join(tmpdir(), "settings-migrate-"));
const settingsFile = join(dataDir, "配置", "settings.json");
const LEGACY_TOKEN = "LEGACY-PLAINTEXT-TOKEN-7c1d";
let server;
let ready = false;
let cookieAdmin = "";

async function waitHealthy(port) {
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

before(async () => {
  // 预置旧版 settings.json：明文令牌 + 非密字段。
  mkdirSync(dirname(settingsFile), { recursive: true });
  writeFileSync(
    settingsFile,
    JSON.stringify({ newapiBaseUrl: "https://legacy.example.com", newapiUserId: "1", newapiImportToken: LEGACY_TOKEN }, null, 2),
    "utf8",
  );
  server = spawn(process.execPath, [join(root, "server.mjs")], {
    env: {
      ...process.env,
      EVALUATOR_SESSION_SECRET: "test-secret",
      EVALUATOR_ADMIN_PASSWORD: "adminpw",
      EVALUATOR_SECRET_STORE: "memory",
      EVALUATOR_COOKIE_SECURE: "false",
      HOST: "127.0.0.1",
      EVALUATOR_DATA_DIR: dataDir,
      PORT: String(PORT),
    },
    stdio: "ignore",
  });
  ready = await waitHealthy(PORT);
  if (ready) {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${PORT}` },
      body: JSON.stringify({ username: "admin", password: "adminpw" }),
    });
    cookieAdmin = (r.headers.get("set-cookie") || "").split(";")[0];
  }
});

after(() => {
  server?.kill();
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* best-effort temp cleanup */
  }
});

test("启动后 settings.json 不再含明文令牌（已迁移加密库）", async () => {
  assert.ok(ready, "server 未就绪");
  const onDisk = readFileSync(settingsFile, "utf8");
  assert.equal(onDisk.includes(LEGACY_TOKEN), false, "settings.json 不得残留明文令牌");
  assert.equal(onDisk.includes("newapiImportToken"), false, "settings.json 不得残留令牌字段");
  // 非密字段仍在。
  assert.equal(onDisk.includes("https://legacy.example.com"), true, "网址等非密字段保留");
});

test("迁移后令牌仍生效：GET 报告已配置、网址正常回显、绝不回显令牌", async () => {
  assert.ok(ready, "server 未就绪");
  const r = await fetch(`http://127.0.0.1:${PORT}/api/settings`, { headers: { origin: `http://127.0.0.1:${PORT}`, cookie: cookieAdmin } });
  const body = await r.json();
  assert.equal(body.newapiImportTokenSet, true, "令牌已迁移、仍判为已配置");
  assert.equal(Object.prototype.hasOwnProperty.call(body, "newapiImportToken"), false, "GET 绝不回显令牌");
  assert.equal(body.newapiBaseUrl, "https://legacy.example.com");
});
