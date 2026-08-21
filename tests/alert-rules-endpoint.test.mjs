// tests/alert-rules-endpoint.test.mjs
// 端点集成：真起 server.mjs 子进程，验证报警规则接口的 CRUD + 权限 + 校验边界。
// /api/alert-rules 非 /api/dev、非 /api/notify 前缀：登录即可用（普通管理员 role=10 也可），未登录仍 401。
// 范式照搬 tests/auto-test-jobs-endpoint.test.mjs 的 spawn 子进程 + 登录方式。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test, { before, after } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 5395; // 避开其它端点测试占用的 5386-5394
const dataDir = mkdtempSync(join(tmpdir(), "ar-endpoint-"));
let server;
let ready = false;
let cookieAdmin = "";
let cookieUser = "";

const baseEnv = {
  EVALUATOR_SESSION_SECRET: "test-secret-0123456789abcdef-32b+",
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

test("超管 GET 空列表 → { ok, rules: [] }", async () => {
  assert.ok(ready, "server 未就绪");
  const { status, body } = await get("/api/alert-rules", cookieAdmin);
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, rules: [] });
});

test("POST 校验失败（名称为空）→ 400 invalid_rule", async () => {
  assert.ok(ready, "server 未就绪");
  const { status, body } = await post("/api/alert-rules", cookieAdmin, {
    name: "",
    metric: "successRate",
    comparator: "lt",
    threshold: 0.8,
  });
  assert.equal(status, 400);
  assert.equal(body.error, "invalid_rule");
  assert.ok(body.userMessage);
});

test("超管 CRUD 快乐路径：建 → GET 反映 → 改 → 删", async () => {
  assert.ok(ready, "server 未就绪");
  const created = await post("/api/alert-rules", cookieAdmin, {
    name: "成功率过低报警",
    metric: "successRate",
    comparator: "lt",
    threshold: 0.8,
    cooldownHours: 2,
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.rule.name, "成功率过低报警");
  const ruleId = created.body.rule.id;

  const list = await get("/api/alert-rules", cookieAdmin);
  const found = list.body.rules.find((r) => r.id === ruleId);
  assert.ok(found, "列表含新规则");
  assert.equal(found.cooldownHours, 2);

  const updated = await post("/api/alert-rules", cookieAdmin, {
    id: ruleId,
    name: "成功率过低报警（改）",
    metric: "successRate",
    comparator: "lt",
    threshold: 0.9,
    cooldownHours: 2,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.rule.id, ruleId, "更新应保持同一 id");
  assert.equal(updated.body.rule.name, "成功率过低报警（改）");

  assert.equal((await del(`/api/alert-rules/${ruleId}`, cookieAdmin)).status, 200);
  const after = await get("/api/alert-rules", cookieAdmin);
  assert.equal(
    after.body.rules.some((r) => r.id === ruleId),
    false,
    "删除后不在列表",
  );
});

test("scope=target 时列表补出 targetName/targetRunnable", async () => {
  assert.ok(ready, "server 未就绪");
  await post("/api/channels", cookieAdmin, {
    name: "报警测试渠道",
    baseUrl: "https://api.example.com",
    protocol: "openai_chat",
    models: "gpt-4o",
    apiKey: "sk-test1234567890",
  });
  const channels = await get("/api/channels", cookieAdmin);
  const channelId = channels.body.find((c) => c.name === "报警测试渠道")?.id;
  await post("/api/model-targets", cookieAdmin, { channelId, model: "gpt-4o" });
  const targets = await get("/api/model-targets", cookieAdmin);
  const targetId = targets.body.find((t) => t.channelId === channelId)?.id;
  assert.ok(targetId, "应已建好模型目标");

  const created = await post("/api/alert-rules", cookieAdmin, {
    name: "指定渠道报警",
    scope: { type: "target", targetId },
    metric: "successRate",
    comparator: "lt",
    threshold: 0.8,
  });
  assert.equal(created.status, 200);
  const ruleId = created.body.rule.id;

  const list = await get("/api/alert-rules", cookieAdmin);
  const found = list.body.rules.find((r) => r.id === ruleId);
  assert.equal(found.targetRunnable, true);
  assert.ok(found.targetName, "应补出渠道/模型名");

  await del(`/api/alert-rules/${ruleId}`, cookieAdmin);
});

test("scope=target 但 targetId 指向不存在的目标 → targetRunnable=false", async () => {
  assert.ok(ready, "server 未就绪");
  const created = await post("/api/alert-rules", cookieAdmin, {
    name: "指向已删除目标",
    scope: { type: "target", targetId: "mt_does_not_exist" },
    metric: "successRate",
    comparator: "lt",
    threshold: 0.8,
  });
  assert.equal(created.status, 200);
  const ruleId = created.body.rule.id;

  const list = await get("/api/alert-rules", cookieAdmin);
  const found = list.body.rules.find((r) => r.id === ruleId);
  assert.equal(found.targetRunnable, false);

  await del(`/api/alert-rules/${ruleId}`, cookieAdmin);
});

test("普通管理员(role=10) 可完整使用规则端点：GET / 建 / 删（登录即可用，非仅超管）", async () => {
  assert.ok(ready, "server 未就绪");
  assert.equal((await get("/api/alert-rules", cookieUser)).status, 200);
  const created = await post("/api/alert-rules", cookieUser, {
    name: "普管建的规则",
    metric: "score",
    comparator: "lt",
    threshold: 60,
  });
  assert.equal(created.status, 200, "普通管理员应能新建规则");
  const ruleId = created.body.rule.id;
  assert.equal((await del(`/api/alert-rules/${ruleId}`, cookieUser)).status, 200);
});

test("未登录：规则端点一律 401", async () => {
  assert.ok(ready, "server 未就绪");
  assert.equal((await get("/api/alert-rules", "")).status, 401);
  assert.equal((await post("/api/alert-rules", "", { name: "x", metric: "score", comparator: "lt", threshold: 1 })).status, 401);
  assert.equal((await del("/api/alert-rules/whatever", "")).status, 401);
});

test("DELETE 不存在的 id → 200（幂等，不报错）", async () => {
  assert.ok(ready, "server 未就绪");
  const { status } = await del("/api/alert-rules/alr_does_not_exist", cookieAdmin);
  assert.equal(status, 200);
});

// —— 两种复合规则形态走真实 HTTP 层的往返 ——
// store/evaluator 的单测绕过了端点，这里补上「前端真实送出的 body → 存盘 → GET 读回」这一段。

test("抖动规则：POST → GET 读回 params 完整，且不带 metric/threshold 死字段", async () => {
  assert.ok(ready, "server 未就绪");
  const created = await post("/api/alert-rules", cookieAdmin, {
    name: "抖动规则",
    kind: "stability-jitter",
    params: { jitterRatioMax: 6, firstAttemptSuccessRateMin: 0.9, retryOverheadP95MsMax: null },
    cooldownHours: 1,
  });
  assert.equal(created.status, 200);
  const ruleId = created.body.rule.id;

  const list = await get("/api/alert-rules", cookieAdmin);
  const found = list.body.rules.find((r) => r.id === ruleId);
  assert.equal(found.kind, "stability-jitter");
  assert.equal(found.params.jitterRatioMax, 6);
  assert.equal(found.params.firstAttemptSuccessRateMin, 0.9);
  assert.equal(found.params.retryOverheadP95MsMax, null, "未配置的子阈值应为 null");
  assert.equal(found.metric, undefined, "复合规则不该带 metric");
  assert.equal(found.threshold, undefined);

  await del(`/api/alert-rules/${ruleId}`, cookieAdmin);
});

test("退化规则：POST → GET 读回 params 完整（窗口 + 判定阈值）", async () => {
  assert.ok(ready, "server 未就绪");
  const created = await post("/api/alert-rules", cookieAdmin, {
    name: "退化规则",
    kind: "stability-decline",
    params: { recentRuns: 3, baselineRuns: 20, successRateDropPp: 0.1, p95WorsenRatio: 1.5 },
    cooldownHours: 24,
  });
  assert.equal(created.status, 200);
  const ruleId = created.body.rule.id;

  const list = await get("/api/alert-rules", cookieAdmin);
  const found = list.body.rules.find((r) => r.id === ruleId);
  assert.equal(found.kind, "stability-decline");
  assert.deepEqual(found.params, { recentRuns: 3, baselineRuns: 20, successRateDropPp: 0.1, p95WorsenRatio: 1.5 });
  assert.equal(found.cooldownHours, 24);
  assert.equal(found.metric, undefined);

  await del(`/api/alert-rules/${ruleId}`, cookieAdmin);
});

test("抖动规则：一项子阈值都没配 → 400", async () => {
  assert.ok(ready, "server 未就绪");
  const { status, body } = await post("/api/alert-rules", cookieAdmin, {
    name: "空抖动",
    kind: "stability-jitter",
    params: { jitterRatioMax: null, firstAttemptSuccessRateMin: null, retryOverheadP95MsMax: null },
  });
  assert.equal(status, 400);
  assert.equal(body.error, "invalid_rule");
  assert.match(body.userMessage, /至少要配一项/);
});

test("退化规则：两个判定阈值都没配 → 400（窗口尺寸有默认值，不算配了一项）", async () => {
  assert.ok(ready, "server 未就绪");
  const { status, body } = await post("/api/alert-rules", cookieAdmin, {
    name: "空退化",
    kind: "stability-decline",
    params: { recentRuns: 3, baselineRuns: 20, successRateDropPp: null, p95WorsenRatio: null },
  });
  assert.equal(status, 400);
  assert.match(body.userMessage, /至少要配一项判定阈值/);
});

// 回归：store 的钳制下界曾是 2、评估器门槛是 5，填 2~4 会存下一条永不生效的规则。
test("退化规则：baselineRuns 填 2 → 存盘被抬到 5（不留永不生效的规则）", async () => {
  assert.ok(ready, "server 未就绪");
  const created = await post("/api/alert-rules", cookieAdmin, {
    name: "小基线",
    kind: "stability-decline",
    params: { recentRuns: 3, baselineRuns: 2, p95WorsenRatio: 1.5 },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.rule.params.baselineRuns, 5);
  await del(`/api/alert-rules/${created.body.rule.id}`, cookieAdmin);
});

test("未知 kind → 回退成 threshold（不接受脏数据）", async () => {
  assert.ok(ready, "server 未就绪");
  const created = await post("/api/alert-rules", cookieAdmin, {
    name: "脏 kind",
    kind: "bogus-kind",
    metric: "successRate",
    comparator: "lt",
    threshold: 0.8,
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.rule.kind, "threshold");
  await del(`/api/alert-rules/${created.body.rule.id}`, cookieAdmin);
});

// 形态互切：退化规则改成阈值规则时，params 该被清掉、不留死字段。
test("形态互切：退化规则改成阈值规则，params 被清除", async () => {
  assert.ok(ready, "server 未就绪");
  const created = await post("/api/alert-rules", cookieAdmin, {
    name: "先退化",
    kind: "stability-decline",
    params: { recentRuns: 3, baselineRuns: 20, p95WorsenRatio: 1.5 },
  });
  const ruleId = created.body.rule.id;

  const switched = await post("/api/alert-rules", cookieAdmin, {
    id: ruleId,
    name: "改成阈值",
    kind: "threshold",
    metric: "p95TotalMs",
    comparator: "gt",
    threshold: 60000,
  });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.rule.kind, "threshold");
  assert.equal(switched.body.rule.threshold, 60000);
  assert.equal(switched.body.rule.params, undefined, "切成阈值形态后不该残留 params");

  await del(`/api/alert-rules/${ruleId}`, cookieAdmin);
});
