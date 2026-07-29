// tests/notify-endpoint.test.mjs
// 端点集成：真起 server.mjs 子进程，验证邮件报警发信配置的存取语义与门禁：
//   - /api/notify/config、/api/notify/test、/api/notify/smtp/sync 全部方法（含 GET）仅超管可访问
//   - GET 初始为默认值；PUT 保存后密码不回显，只回 smtpPasswordSet
//   - PUT 留空密码＝保留原值（write-only，同 /api/settings 的令牌）
//   - POST /api/notify/test 缺 host/收件人 → 400
//   - POST /api/notify/smtp/sync 未配 EVALUATOR_NEWAPI_DB_DSN → 502（测试进程不连真实数据库）
// 范式照搬 tests/settings-newapi-endpoint.test.mjs 的 spawn 子进程 + 登录方式。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test, { before, after } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const PORT = 5394; // 避开其它端点测试占用的 5386-5393
const dataDir = mkdtempSync(join(tmpdir(), "notify-endpoint-"));
let server;
let ready = false;
let cookieAdmin = ""; // role=100 超管
let cookieUser = ""; // role=10 普通管理员

const baseEnv = {
  EVALUATOR_SESSION_SECRET: "test-secret-0123456789abcdef-32b+",
  EVALUATOR_ADMIN_PASSWORD: "adminpw", // → admin / role=100
  EVALUATOR_LOCAL_USERS: "tester:testerpw:10", // → tester / role=10
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
async function getConfig(cookie) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/notify/config`, {
    headers: { origin: `http://127.0.0.1:${PORT}`, cookie },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function putConfig(cookie, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/notify/config`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${PORT}`, cookie },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function postTest(cookie) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/notify/test`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${PORT}`, cookie },
    body: "{}",
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

test("门禁：未登录 → 401（GET/PUT/POST 全部方法）", async () => {
  assert.ok(ready, "server 未就绪");
  const g = await fetch(`http://127.0.0.1:${PORT}/api/notify/config`);
  assert.equal(g.status, 401);
  const p = await fetch(`http://127.0.0.1:${PORT}/api/notify/config`, {
    method: "PUT",
    body: "{}",
    headers: { "content-type": "application/json" },
  });
  assert.equal(p.status, 401);
  const t = await fetch(`http://127.0.0.1:${PORT}/api/notify/test`, { method: "POST" });
  assert.equal(t.status, 401);
});

test("门禁：普通管理员(role=10) → 403（GET 也不例外，因为持有 SMTP 凭证信息）", async () => {
  assert.ok(ready, "server 未就绪");
  const g = await getConfig(cookieUser);
  assert.equal(g.status, 403);
  const p = await putConfig(cookieUser, { smtpHost: "evil.example.com" });
  assert.equal(p.status, 403);
  const t = await postTest(cookieUser);
  assert.equal(t.status, 403);
});

test("GET /api/notify/config：初始默认值，smtpPasswordSet=false（对齐 monitor ensureSMTPDefault：未配 DSN 时静默跳过、不 500）", async () => {
  assert.ok(ready, "server 未就绪");
  const { status, body } = await getConfig(cookieAdmin);
  assert.equal(status, 200);
  assert.equal(body.smtpHost, "");
  assert.equal(body.smtpPort, 465);
  assert.equal(body.smtpSsl, true);
  assert.equal(body.smtpPasswordSet, false);
  assert.equal(Object.prototype.hasOwnProperty.call(body, "smtpPassword"), false);
});

test("POST /api/notify/test：未配置 host/收件人 → 400", async () => {
  assert.ok(ready, "server 未就绪");
  const { status, body } = await postTest(cookieAdmin);
  assert.equal(status, 400);
  assert.equal(body.error, "missing_config");
});

test("门禁：POST /api/notify/smtp/sync 未登录 401 / 非超管 403", async () => {
  assert.ok(ready, "server 未就绪");
  const r1 = await fetch(`http://127.0.0.1:${PORT}/api/notify/smtp/sync`, { method: "POST" });
  assert.equal(r1.status, 401);
  const r2 = await fetch(`http://127.0.0.1:${PORT}/api/notify/smtp/sync`, {
    method: "POST",
    headers: { origin: `http://127.0.0.1:${PORT}`, cookie: cookieUser },
  });
  assert.equal(r2.status, 403);
});

test("POST /api/notify/smtp/sync：未配置 EVALUATOR_NEWAPI_DB_DSN → 502 sync_failed，不改动已有配置（测试进程绝不连真实数据库）", async () => {
  assert.ok(ready, "server 未就绪");
  const before = await getConfig(cookieAdmin);
  const r = await fetch(`http://127.0.0.1:${PORT}/api/notify/smtp/sync`, {
    method: "POST",
    headers: { origin: `http://127.0.0.1:${PORT}`, cookie: cookieAdmin },
  });
  const body = await r.json().catch(() => null);
  assert.equal(r.status, 502);
  assert.equal(body.error, "sync_failed");
  assert.match(body.userMessage, /EVALUATOR_NEWAPI_DB_DSN/);
  const after = await getConfig(cookieAdmin);
  assert.deepEqual(after.body, before.body, "同步失败不应改动已有配置");
});

test("PUT /api/notify/config：超管写入含密码 → 响应不回显密码、smtpPasswordSet=true", async () => {
  assert.ok(ready, "server 未就绪");
  const { status, body } = await putConfig(cookieAdmin, {
    smtpHost: "smtp.example.com",
    smtpPort: 587,
    smtpSsl: false,
    smtpUser: "bot@example.com",
    smtpFrom: "alerts@example.com",
    recipients: "a@example.com, b@example.com",
    smtpPassword: "super-secret-pw",
  });
  assert.equal(status, 200);
  assert.equal(body.smtpHost, "smtp.example.com");
  assert.equal(body.smtpPort, 587);
  assert.equal(body.smtpSsl, false);
  assert.equal(body.smtpPasswordSet, true);
  assert.equal(Object.prototype.hasOwnProperty.call(body, "smtpPassword"), false, "响应绝不回显密码");

  const g = await getConfig(cookieAdmin);
  assert.equal(g.body.smtpPasswordSet, true);
  assert.equal(Object.prototype.hasOwnProperty.call(g.body, "smtpPassword"), false);
  assert.equal(g.body.smtpHost, "smtp.example.com");
});

test("PUT /api/notify/config：留空密码＝保留原值（write-only）", async () => {
  assert.ok(ready, "server 未就绪");
  const { status, body } = await putConfig(cookieAdmin, {
    smtpHost: "changed.example.com",
    smtpPort: 587,
    smtpUser: "bot@example.com",
    recipients: "a@example.com",
    smtpPassword: "", // 留空 → 不应清空已存密码
  });
  assert.equal(status, 200);
  assert.equal(body.smtpHost, "changed.example.com", "其它字段已更新");
  assert.equal(body.smtpPasswordSet, true, "密码未被空串清空");
});

test("普通管理员写入被拒后原配置不受影响", async () => {
  assert.ok(ready, "server 未就绪");
  await putConfig(cookieUser, { smtpHost: "should-not-apply.example.com" }); // 403，忽略结果
  const g = await getConfig(cookieAdmin);
  assert.equal(g.body.smtpHost, "changed.example.com", "普通管理员的写入未生效");
});

test("安全：密码绝不写入磁盘 notify-config.json（走加密库）", async () => {
  assert.ok(ready, "server 未就绪");
  await putConfig(cookieAdmin, { smtpHost: "disk.example.com", recipients: "a@example.com", smtpPassword: "PLAINTEXT-LEAK-CANARY-9f3a" });
  const onDisk = readFileSync(join(dataDir, "配置", "notify-config.json"), "utf8");
  assert.equal(onDisk.includes("PLAINTEXT-LEAK-CANARY-9f3a"), false, "notify-config.json 不得含密码明文");
  // 注意：字段名 smtpPasswordSet 本身以 "smtpPassword" 开头，不能用子串判断；按 JSON key 精确核对。
  const onDiskObj = JSON.parse(onDisk);
  assert.equal(Object.prototype.hasOwnProperty.call(onDiskObj, "smtpPassword"), false, "notify-config.json 不得含密码字段");
  assert.equal(onDiskObj.smtpPasswordSet, true, "smtpPasswordSet 标记本身应保留");
});
