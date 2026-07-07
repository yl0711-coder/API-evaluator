// tests/settings-newapi-endpoint.test.mjs
// 端点集成：真起 server.mjs 子进程，验证 new-api 网关配置经「设置」端点的存取语义：
//   - GET  /api/settings  令牌不回显（只回 newapiImportTokenSet），网址/用户ID 正常回显
//   - PUT  /api/settings  超管可写；留空令牌＝保留原值（write-only）
//   - 普通管理员(role=10) PUT /api/settings → 403
// 范式照搬 tests/tag-sync-endpoints.test.mjs 的 spawn 子进程 + 登录方式。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test, { before, after } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const PORT = 5392; // 避开其它端点测试占用的 5391/5394-5399
const dataDir = mkdtempSync(join(tmpdir(), "settings-newapi-"));
let server;
let ready = false;
let cookieAdmin = ""; // role=100 超管
let cookieUser = ""; // role=10 普通管理员

const baseEnv = {
  EVALUATOR_SESSION_SECRET: "test-secret",
  EVALUATOR_ADMIN_PASSWORD: "adminpw", // → admin / role=100
  EVALUATOR_LOCAL_USERS: "tester:testerpw:10", // → tester / role=10
  EVALUATOR_SECRET_STORE: "memory",
  EVALUATOR_COOKIE_SECURE: "false",
  HOST: "127.0.0.1",
  // 故意不配 EVALUATOR_NEWAPI_*：确保 newapiImportTokenSet 初始为 false。
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
async function getSettings(cookie) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/settings`, {
    headers: { origin: `http://127.0.0.1:${PORT}`, cookie },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function putSettings(cookie, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${PORT}`, cookie },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

before(async () => {
  server = spawn(process.execPath, [join(root, "server.mjs")], {
    env: { ...process.env, ...baseEnv, EVALUATOR_DATA_DIR: dataDir, PORT: String(PORT) },
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
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* best-effort temp cleanup（Windows 上子进程刚 kill 可能短暂持有文件）*/
  }
});

test("GET /api/settings：初始未配置 → newapiImportTokenSet=false 且不含令牌原文", async () => {
  assert.ok(ready, "server 未就绪");
  const { status, body } = await getSettings(cookieAdmin);
  assert.equal(status, 200);
  assert.equal(Object.prototype.hasOwnProperty.call(body, "newapiImportToken"), false, "绝不回显令牌字段");
  assert.equal(body.newapiImportTokenSet, false);
});

test("PUT /api/settings：超管写入网址/令牌/用户ID → 令牌被屏蔽、状态置真", async () => {
  assert.ok(ready, "server 未就绪");
  const { status, body } = await putSettings(cookieAdmin, {
    newapiBaseUrl: "https://newapi.example.com/",
    newapiUserId: "1",
    newapiImportToken: "super-secret-token",
  });
  assert.equal(status, 200);
  assert.equal(body.newapiBaseUrl, "https://newapi.example.com/", "网址原样保存");
  assert.equal(body.newapiUserId, "1");
  assert.equal(Object.prototype.hasOwnProperty.call(body, "newapiImportToken"), false, "响应不回显令牌");
  assert.equal(body.newapiImportTokenSet, true);

  // GET 复核：仍不回显令牌，状态为真。
  const g = await getSettings(cookieAdmin);
  assert.equal(g.body.newapiImportTokenSet, true);
  assert.equal(Object.prototype.hasOwnProperty.call(g.body, "newapiImportToken"), false);
  assert.equal(g.body.newapiBaseUrl, "https://newapi.example.com/");
});

test("PUT /api/settings：留空令牌＝保留原值（write-only）", async () => {
  assert.ok(ready, "server 未就绪");
  const { status, body } = await putSettings(cookieAdmin, {
    newapiBaseUrl: "https://changed.example.com",
    newapiUserId: "1",
    newapiImportToken: "", // 留空 → 不应清空已存令牌
  });
  assert.equal(status, 200);
  assert.equal(body.newapiBaseUrl, "https://changed.example.com", "网址已更新");
  assert.equal(body.newapiImportTokenSet, true, "令牌未被空串清空");
});

test("PUT /api/settings：普通管理员(role=10) 可改普通设置，new-api 相关字段被忽略", async () => {
  assert.ok(ready, "server 未就绪");
  // 可写「不影响 new-api」的设置（题库开关）。
  const r1 = await putSettings(cookieUser, { enableHle: true });
  assert.equal(r1.status, 200, "普通管理员可写非 new-api 设置");
  assert.equal(r1.body.enableHle, true, "普通设置已生效");
  // 试图改 new-api 网关配置 → 被剔除，原值不动。
  const r2 = await putSettings(cookieUser, {
    newapiBaseUrl: "https://evil.example.com",
    newapiUserId: "666",
    newapiImportToken: "SHOULD-BE-IGNORED",
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.newapiBaseUrl, "https://changed.example.com", "网址未被普通管理员改动");
  assert.equal(r2.body.newapiUserId, "1", "用户ID未被改动");
});

test("PUT /api/settings：customTags 数组 trim/去空/去重后存取", async () => {
  assert.ok(ready, "server 未就绪");
  const { status, body } = await putSettings(cookieAdmin, { customTags: ["  推理  ", "推理", "", "长上下文", "  "] });
  assert.equal(status, 200);
  assert.deepEqual(body.customTags, ["推理", "长上下文"], "trim + 去空 + 去重 + 保序");
  // GET 复核持久化。
  const g = await getSettings(cookieAdmin);
  assert.deepEqual(g.body.customTags, ["推理", "长上下文"]);
});

test("PUT /api/settings：customTags 非数组 → 归一为 []", async () => {
  assert.ok(ready, "server 未就绪");
  const { body } = await putSettings(cookieAdmin, { customTags: "not-an-array" });
  assert.deepEqual(body.customTags, []);
});

test("安全：令牌绝不写入磁盘 settings.json（走加密库）", async () => {
  assert.ok(ready, "server 未就绪");
  // 先存一个独特令牌，再直接读磁盘上的 settings.json 核对其不含令牌。
  await putSettings(cookieAdmin, { newapiBaseUrl: "https://disk.example.com", newapiImportToken: "PLAINTEXT-LEAK-CANARY-9f3a" });
  const onDisk = readFileSync(join(dataDir, "配置", "settings.json"), "utf8");
  assert.equal(onDisk.includes("PLAINTEXT-LEAK-CANARY-9f3a"), false, "settings.json 不得含令牌明文");
  assert.equal(onDisk.includes("newapiImportToken"), false, "settings.json 不得含令牌字段");
  // 但令牌确实生效（GET 报告已配置）。
  const g = await getSettings(cookieAdmin);
  assert.equal(g.body.newapiImportTokenSet, true);
});
