// tests/auto-test-jobs-endpoint.test.mjs
// 端点集成：真起 server.mjs 子进程，验证自动测试作业接口的 CRUD + 权限 + 校验边界。
// /api/auto-test-jobs 非 /api/dev 前缀：登录即可用（普通管理员 role=10 也可），未登录仍 401。
// 快乐路径先经 API 建渠道 + 模型目标，得到可运行 targetId；作业 nextRunAt 落在 6 小时后，
// 故测试期间调度器不会真触发上游调用。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test, { before, after } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 5390;
const dataDir = mkdtempSync(join(tmpdir(), "atj-endpoint-"));
let server;
let ready = false;
let cookieAdmin = "";
let cookieUser = "";
let targetId = "";

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
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const post = (path, cookie, body) => send("POST", path, cookie, body);
const del = (path, cookie, body) => send("DELETE", path, cookie, body);

before(async () => {
  server = spawn(process.execPath, [join(root, "server.mjs")], {
    env: { ...process.env, ...baseEnv, EVALUATOR_DATA_DIR: dataDir, PORT: String(PORT) },
    stdio: "ignore",
  });
  ready = await waitHealthy(PORT);
  if (ready) {
    cookieAdmin = await login("admin", "adminpw");
    cookieUser = await login("tester", "testerpw");
    // 建一个渠道 + 模型目标，拿到可运行 targetId。
    await post("/api/channels", cookieAdmin, {
      name: "测试渠道", baseUrl: "https://api.example.com", protocol: "openai_chat", models: "gpt-4o", apiKey: "sk-test1234567890",
    });
    const channels = await get("/api/channels", cookieAdmin);
    const channelId = channels.body?.[0]?.id;
    await post("/api/model-targets", cookieAdmin, { channelId, model: "gpt-4o" });
    const targets = await get("/api/model-targets", cookieAdmin);
    targetId = targets.body?.find((t) => t.model === "gpt-4o")?.id || targets.body?.[0]?.id || "";
  }
});

after(() => {
  server?.kill();
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* best-effort */
  }
});

test("前置：拿到可运行 targetId", () => {
  assert.ok(ready, "server 未就绪");
  assert.ok(targetId, "应已建好模型目标");
});

test("超管 GET 空列表 → { ok, jobs: [] }", async () => {
  assert.ok(ready, "server 未就绪");
  const { status, body } = await get("/api/auto-test-jobs", cookieAdmin);
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, jobs: [] });
});

test("超管 POST 缺 targetId → 400；非法 targetId → 400", async () => {
  assert.ok(ready, "server 未就绪");
  assert.equal((await post("/api/auto-test-jobs", cookieAdmin, { kind: "quick", periodHours: 6 })).status, 400);
  assert.equal(
    (await post("/api/auto-test-jobs", cookieAdmin, { targetId: "mt_nope", kind: "quick", periodHours: 6 })).status,
    400,
  );
});

test("超管 CRUD 快乐路径：建 → GET 反映（含 targetName/targetRunnable）→ 删", async () => {
  assert.ok(ready, "server 未就绪");
  const created = await post("/api/auto-test-jobs", cookieAdmin, {
    name: "每日快检", targetId, kind: "quick", periodHours: 6,
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.job.enabled, true);
  assert.ok(created.body.job.nextRunAt, "启用作业应算出 nextRunAt");
  const jobId = created.body.job.id;

  const list = await get("/api/auto-test-jobs", cookieAdmin);
  const found = list.body.jobs.find((j) => j.id === jobId);
  assert.ok(found, "列表含新作业");
  assert.equal(found.targetRunnable, true);
  assert.ok(found.targetName, "补出渠道/模型名");

  // 更新：改周期应重算 nextRunAt（且仍是同一 id）
  const updated = await post("/api/auto-test-jobs", cookieAdmin, { id: jobId, targetId, kind: "quick", periodHours: 12 });
  assert.equal(updated.body.job.id, jobId);
  assert.equal(updated.body.job.periodHours, 12);

  assert.equal((await del(`/api/auto-test-jobs/${jobId}`, cookieAdmin)).status, 200);
  const after = await get("/api/auto-test-jobs", cookieAdmin);
  assert.equal(after.body.jobs.some((j) => j.id === jobId), false, "删除后不在列表");
});

test("普通管理员(role=10) 可完整使用作业端点：GET / 建 / 删", async () => {
  assert.ok(ready, "server 未就绪");
  // 列表可读
  assert.equal((await get("/api/auto-test-jobs", cookieUser)).status, 200);
  // 建作业（目标由超管建好，全局可运行）
  const created = await post("/api/auto-test-jobs", cookieUser, { name: "普管每日快检", targetId, kind: "quick", periodHours: 6 });
  assert.equal(created.status, 200, "普通管理员应能新建作业");
  const jobId = created.body.job.id;
  // 立即运行接口也放行（不真触发上游，只校验鉴权不被 403）
  assert.notEqual((await post(`/api/auto-test-jobs/${jobId}/run`, cookieUser)).status, 403);
  // 删除
  assert.equal((await del(`/api/auto-test-jobs/${jobId}`, cookieUser)).status, 200);
});

test("熔断复活：由停用转启用时清零 consecutiveFailures 与 autoDisabledAt，并重算 nextRunAt", async () => {
  assert.ok(ready, "server 未就绪");
  // 造一个「已自动停用」的作业：create 无 existing，故 body 里的熔断态被采纳（模拟调度器停用后的盘上状态）。
  const created = await post("/api/auto-test-jobs", cookieAdmin, {
    name: "熔断作业", targetId, kind: "quick", periodHours: 6,
    enabled: false, consecutiveFailures: 3, autoDisabledAt: "2026-07-03T00:00:00.000Z",
  });
  assert.equal(created.status, 200);
  const jobId = created.body.job.id;
  let found = (await get("/api/auto-test-jobs", cookieAdmin)).body.jobs.find((j) => j.id === jobId);
  assert.equal(found.consecutiveFailures, 3, "停用态应保留熔断计数");
  assert.equal(found.autoDisabledAt, "2026-07-03T00:00:00.000Z", "停用态应保留 autoDisabledAt");
  assert.equal(found.enabled, false);

  // 重新启用 → 清零复活
  const reenabled = await post("/api/auto-test-jobs", cookieAdmin, { id: jobId, targetId, kind: "quick", periodHours: 6, enabled: true });
  assert.equal(reenabled.body.job.enabled, true);
  found = (await get("/api/auto-test-jobs", cookieAdmin)).body.jobs.find((j) => j.id === jobId);
  assert.equal(found.consecutiveFailures, 0, "重新启用清零熔断计数");
  assert.equal(found.autoDisabledAt, null, "重新启用清除 autoDisabledAt");
  assert.ok(found.nextRunAt, "重新启用重算 nextRunAt");
  await del(`/api/auto-test-jobs/${jobId}`, cookieAdmin);
});

test("未登录：作业端点一律 401", async () => {
  assert.ok(ready, "server 未就绪");
  assert.equal((await get("/api/auto-test-jobs", "")).status, 401);
  assert.equal((await post("/api/auto-test-jobs", "", { targetId, kind: "quick", periodHours: 6 })).status, 401);
  assert.equal((await del("/api/auto-test-jobs/whatever", "")).status, 401);
});
