import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

// 端点级鉴权集成测试：真正起 server.mjs 子进程，用 http 验证"渠道写=超管、模型目标写=管理员"
// 这条中间件接线（纯函数判定已在 api-access.test 覆盖，这里坐实路由确实挂了中间件）。
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 5391;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = BASE;
const dataDir = mkdtempSync(join(tmpdir(), "server-auth-test-"));

const server = spawn(process.execPath, [join(root, "server.mjs")], {
  env: {
    ...process.env,
    EVALUATOR_SESSION_SECRET: "test-secret",
    EVALUATOR_ADMIN_PASSWORD: "adminpw",
    EVALUATOR_LOCAL_USERS: "tester:testerpw:10",
    EVALUATOR_DATA_DIR: dataDir,
    EVALUATOR_SECRET_STORE: "memory",
    EVALUATOR_COOKIE_SECURE: "false",
    HOST: "127.0.0.1",
    PORT: String(PORT),
  },
  stdio: "ignore",
});
test.after(() => {
  server.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

async function waitHealthy() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
const ready = await waitHealthy();

async function login(username, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ username, password }),
  });
  const setCookie = r.headers.get("set-cookie") || "";
  return setCookie.split(";")[0]; // evaluator_session=...
}
async function call(method, path, cookie, body) {
  return fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("超管(100)可写渠道；管理员(10)写渠道 403、但可写模型目标 + 可看渠道", async () => {
  assert.ok(ready, "server 未就绪");
  const admin = await login("admin", "adminpw");
  const tester = await login("tester", "testerpw");
  assert.ok(admin && tester, "登录失败");

  // 超管建渠道 -> 200
  const created = await call("POST", "/api/channels", admin, { name: "渠道Z", baseUrl: "https://z.test", protocol: "openai_chat", apiKey: "sk-z" });
  assert.equal(created.status, 200);
  const channel = await created.json();

  // 管理员写渠道 -> 403 forbidden_admin
  const denied = await call("POST", "/api/channels", tester, { name: "x", baseUrl: "https://x.test", protocol: "openai_chat", apiKey: "k" });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, "forbidden_admin");

  // 管理员看渠道列表 -> 200（GET 不需超管）
  assert.equal((await call("GET", "/api/channels", tester)).status, 200);

  // 管理员写模型目标（引用超管建的渠道）-> 200
  const tg = await call("POST", "/api/model-targets", tester, { channelId: channel.id, model: "gpt-4o" });
  assert.equal(tg.status, 200);

  // 管理员触发 new-api 导入（/api/channels/import 属渠道写）-> 403
  assert.equal((await call("POST", "/api/channels/import", tester, {})).status, 403);
});

test("未登录访问受保护端点 -> 401", async () => {
  assert.ok(ready);
  assert.equal((await call("GET", "/api/channels", "")).status, 401);
});
