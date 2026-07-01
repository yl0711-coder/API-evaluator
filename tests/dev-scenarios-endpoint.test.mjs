// tests/dev-scenarios-endpoint.test.mjs
// 端点集成：真起 server.mjs 子进程，验证开发者场景接口的【读取 + 权限】边界（不触发写，避免改动源码）：
//   - 超管 GET /api/dev/scenarios → 含 prompt/expected（不脱敏）
//   - 普通管理员(role=10) GET/POST /api/dev/* → 403
//   - 公开 GET /api/scenarios 仍不含 prompt（脱敏不变）
// 范式照搬 tests/settings-newapi-endpoint.test.mjs。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test, { before, after } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const PORT = 5393; // 避开其它端点测试占用的 5391/5392/5394-5399
const dataDir = mkdtempSync(join(tmpdir(), "dev-scn-"));
// 分组重命名/删除会「改写场景源文件」——重定向到临时目录，绝不动 server/scenarios 源码。
const scenarioWriteDir = mkdtempSync(join(tmpdir(), "dev-scn-write-"));
let server;
let ready = false;
let cookieAdmin = "";
let cookieUser = "";

const baseEnv = {
  EVALUATOR_SESSION_SECRET: "test-secret",
  EVALUATOR_ADMIN_PASSWORD: "adminpw", // admin / role=100
  EVALUATOR_LOCAL_USERS: "tester:testerpw:10", // tester / role=10
  EVALUATOR_SECRET_STORE: "memory",
  EVALUATOR_COOKIE_SECURE: "false",
  HOST: "127.0.0.1",
};

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
async function login(username, password) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${PORT}` },
    body: JSON.stringify({ username, password }),
  });
  return (r.headers.get("set-cookie") || "").split(";")[0];
}
async function get(path, cookie) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { origin: `http://127.0.0.1:${PORT}`, cookie } });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function send(method, path, cookie, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${PORT}`, cookie },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const post = (path, cookie, body) => send("POST", path, cookie, body);
const put = (path, cookie, body) => send("PUT", path, cookie, body);
const del = (path, cookie, body) => send("DELETE", path, cookie, body);

before(async () => {
  server = spawn(process.execPath, [join(root, "server.mjs")], {
    env: { ...process.env, ...baseEnv, EVALUATOR_DATA_DIR: dataDir, EVALUATOR_SCENARIO_WRITE_DIR: scenarioWriteDir, PORT: String(PORT) },
    stdio: "ignore",
  });
  ready = await waitHealthy(PORT);
  if (ready) {
    cookieAdmin = await login("admin", "adminpw");
    cookieUser = await login("tester", "testerpw");
  }
});

after(() => {
  server?.kill();
  for (const dir of [dataDir, scenarioWriteDir]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* best-effort */
    }
  }
});

test("超管 GET /api/dev/scenarios：完整数据，含 prompt + 至少一条 expected", async () => {
  assert.ok(ready, "server 未就绪");
  const { status, body } = await get("/api/dev/scenarios", cookieAdmin);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body) && body.length >= 60);
  assert.ok(body.every((s) => typeof s.prompt !== "undefined"), "每条都带 prompt（不脱敏）");
  assert.ok(body.some((s) => typeof s.expected !== "undefined"), "至少一条带 expected");
  assert.ok(body.some((s) => s.bankKey && typeof s.active === "boolean"), "带 bankKey/active");
});

test("普通管理员(role=10) GET /api/dev/scenarios → 403", async () => {
  assert.ok(ready, "server 未就绪");
  assert.equal((await get("/api/dev/scenarios", cookieUser)).status, 403);
});

test("普通管理员(role=10) POST /api/dev/scenarios → 403（写前即被挡，不触碰源文件）", async () => {
  assert.ok(ready, "server 未就绪");
  assert.equal((await post("/api/dev/scenarios", cookieUser, { id: "x", prompt: "p" })).status, 403);
});

test("公开 GET /api/scenarios：仍脱敏、不含 prompt，但含 group", async () => {
  assert.ok(ready, "server 未就绪");
  const { status, body } = await get("/api/scenarios", cookieAdmin);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body) && body.length > 0);
  assert.ok(body.every((s) => typeof s.prompt === "undefined"), "公开接口不暴露 prompt");
  assert.ok(body.every((s) => typeof s.group === "string" && s.group), "每条带非空 group，供分组筛选");
});

test("超管 GET /api/dev/scenarios：每条带 resolvedGroup（默认按 bank）", async () => {
  assert.ok(ready, "server 未就绪");
  const { body } = await get("/api/dev/scenarios", cookieAdmin);
  assert.equal(body.find((s) => s.bankKey === "basic").resolvedGroup, "基础");
  assert.equal(body.find((s) => s.bankKey === "safety").resolvedGroup, "安全红线");
});

test("分组端点：新建 → GET /api/settings 反映；改写重定向到临时目录（不动源码）", async () => {
  assert.ok(ready, "server 未就绪");
  const { status, body } = await post("/api/dev/scenario-groups", cookieAdmin, { name: "我的新组" });
  assert.equal(status, 200);
  assert.ok(body.scenarioGroups.includes("我的新组"));
  const s = await get("/api/settings", cookieAdmin);
  assert.ok(s.body.scenarioGroups.includes("我的新组"));
});

test("分组端点：重命名级联改到该组所有题（resolvedGroup 随之变）→ 再删除落回默认", async () => {
  assert.ok(ready, "server 未就绪");
  const r = await put("/api/dev/scenario-groups", cookieAdmin, { name: "安全红线", newName: "安全测试组" });
  assert.equal(r.status, 200);
  assert.ok(r.body.changed >= 1, "至少改动一题");
  const afterRename = await get("/api/dev/scenarios", cookieAdmin);
  assert.equal(afterRename.body.some((s) => s.resolvedGroup === "安全红线"), false, "不再有「安全红线」");
  assert.ok(afterRename.body.some((s) => s.bankKey === "safety" && s.resolvedGroup === "安全测试组"));

  const d = await del("/api/dev/scenario-groups", cookieAdmin, { name: "安全测试组" });
  assert.equal(d.status, 200);
  const afterDel = await get("/api/dev/scenarios", cookieAdmin);
  assert.equal(afterDel.body.find((s) => s.bankKey === "safety").resolvedGroup, "安全红线", "删除后落回 bank 默认");
});

test("普通管理员(role=10) 对分组端点 → 403", async () => {
  assert.ok(ready, "server 未就绪");
  assert.equal((await post("/api/dev/scenario-groups", cookieUser, { name: "x" })).status, 403);
  assert.equal((await put("/api/dev/scenario-groups", cookieUser, { name: "基础", newName: "y" })).status, 403);
  assert.equal((await del("/api/dev/scenario-groups", cookieUser, { name: "基础" })).status, 403);
});
