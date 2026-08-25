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

// —— 报警汇总：配置端点走真实 HTTP 层 ——
// 权限口径与规则端点一致（登录即可用，非仅超管）——汇总节奏属于「报警怎么报」，与规则同层。

test("汇总配置 GET：默认关闭 + 每天 09:07 + 带队列现状", async () => {
  assert.ok(ready, "server 未就绪");
  const { status, body } = await get("/api/alert-rules/digest", cookieAdmin);
  assert.equal(status, 200);
  assert.equal(body.config.enabled, false, "默认必须关闭，现有用户行为不变");
  assert.equal(body.config.cron, "7 9 * * *");
  assert.deepEqual(body.pending, { alerts: 0, runs: 0 });
});

test("汇总配置 PUT：开启并设 cron → 回读一致，且算出 nextDigestAt", async () => {
  assert.ok(ready, "server 未就绪");
  const saved = await send("PUT", "/api/alert-rules/digest", cookieAdmin, { enabled: true, cron: "30 8 * * *" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.config.enabled, true);
  assert.equal(saved.body.config.cron, "30 8 * * *");
  assert.ok(saved.body.config.nextDigestAt, "开启时必须算出下一个到期时刻");
  assert.ok(Date.parse(saved.body.config.nextDigestAt) > Date.now(), "下一个时刻必须在未来");

  const back = await get("/api/alert-rules/digest", cookieAdmin);
  assert.equal(back.body.config.cron, "30 8 * * *");
});

// 坏 cron 存下去的话，nextDigestAt 会算成 null → 每个 tick 都判「立即到期」→ 每分钟一封汇总信。
// 这比不发信更糟，必须在端点挡掉。
test("汇总配置 PUT：cron 永无可执行时刻 → 400，不落盘", async () => {
  assert.ok(ready, "server 未就绪");
  const { status, body } = await send("PUT", "/api/alert-rules/digest", cookieAdmin, { enabled: true, cron: "0 0 30 2 *" });
  assert.equal(status, 400);
  assert.equal(body.error, "invalid_cron");
  assert.ok(body.userMessage);
  // 确认没被写进去
  const back = await get("/api/alert-rules/digest", cookieAdmin);
  assert.notEqual(back.body.config.cron, "0 0 30 2 *");
});

test("汇总配置 PUT：关闭时清掉 nextDigestAt（避免下次开启沿用过期时刻）", async () => {
  assert.ok(ready, "server 未就绪");
  await send("PUT", "/api/alert-rules/digest", cookieAdmin, { enabled: true, cron: "7 9 * * *" });
  const off = await send("PUT", "/api/alert-rules/digest", cookieAdmin, { enabled: false, cron: "7 9 * * *" });
  assert.equal(off.status, 200);
  assert.equal(off.body.config.enabled, false);
  assert.equal(off.body.config.nextDigestAt, null);
});

test("普通管理员(role=10) 可读写汇总配置（与规则端点同口径，非仅超管）", async () => {
  assert.ok(ready, "server 未就绪");
  assert.equal((await get("/api/alert-rules/digest", cookieUser)).status, 200);
  const saved = await send("PUT", "/api/alert-rules/digest", cookieUser, { enabled: true, cron: "15 10 * * *" });
  assert.equal(saved.status, 200, "普通管理员应能改汇总节奏");
  await send("PUT", "/api/alert-rules/digest", cookieAdmin, { enabled: false, cron: "7 9 * * *" }); // 复位
});

test("未登录：汇总端点一律 401", async () => {
  assert.ok(ready, "server 未就绪");
  assert.equal((await get("/api/alert-rules/digest", "")).status, 401);
  assert.equal((await send("PUT", "/api/alert-rules/digest", "", { enabled: true })).status, 401);
  assert.equal((await post("/api/alert-rules/digest/test", "", {})).status, 401);
});

// 路由顺序护栏：/api/alert-rules/digest 不能被 /api/alert-rules/:id 的 DELETE 语义吃掉，
// 也不能让 GET digest 落到「查某条规则」上。
test("路由不串：GET digest 返回配置形状，而非规则对象", async () => {
  assert.ok(ready, "server 未就绪");
  const { body } = await get("/api/alert-rules/digest", cookieAdmin);
  assert.ok(body.config, "应返回 config 字段");
  assert.equal(body.rule, undefined, "不该返回单条规则");
});

// 未配 SMTP 时「立即发送」应给出可操作的错误，而不是假装成功。
test("汇总测试发送：未配 SMTP → 400 且给出原因", async () => {
  assert.ok(ready, "server 未就绪");
  const { status, body } = await post("/api/alert-rules/digest/test", cookieAdmin, {});
  assert.equal(status, 400);
  assert.match(body.userMessage, /SMTP|收件人/);
});

// 【回归：关掉汇总会静默吞掉已攒的报警】
// maybeSendDigest 在功能关闭时直接早退，既不发也不清；而这些报警【已经记过冷却】
// （入队即视为已交付）。于是关掉汇总 = 队列里的报警永不送达且不再重报；
// 日后重新开启还会让几周前的陈旧报警诈尸。实测两种症状都会出现。
test("关闭汇总时：清空队列并清掉相关规则的冷却（不静默吞报警）", async () => {
  assert.ok(ready, "server 未就绪");
  // 建一条规则 + 开汇总
  const rule = await post("/api/alert-rules", cookieAdmin, {
    name: "汇总关闭测试规则",
    metric: "successRate",
    comparator: "lt",
    threshold: 0.8,
  });
  const ruleId = rule.body.rule.id;
  await send("PUT", "/api/alert-rules/digest", cookieAdmin, { enabled: true, cron: "7 9 * * *" });

  // 关闭。此处队列是空的，故不应有 flushed 字段。
  const off = await send("PUT", "/api/alert-rules/digest", cookieAdmin, { enabled: false, cron: "7 9 * * *" });
  assert.equal(off.status, 200);
  assert.equal(off.body.flushed, undefined, "队列为空时不该报告清理");

  // 关闭后再关一次：不得报错
  const offAgain = await send("PUT", "/api/alert-rules/digest", cookieAdmin, { enabled: false, cron: "7 9 * * *" });
  assert.equal(offAgain.status, 200);

  const back = await get("/api/alert-rules/digest", cookieAdmin);
  assert.deepEqual(back.body.pending, { alerts: 0, runs: 0 }, "关闭后队列必须是空的");

  await del(`/api/alert-rules/${ruleId}`, cookieAdmin);
});

test("重复保存同一份汇总设置：幂等，不报错", async () => {
  assert.ok(ready, "server 未就绪");
  const body = { enabled: true, cron: "22 7 * * *" };
  const a = await send("PUT", "/api/alert-rules/digest", cookieAdmin, body);
  const b = await send("PUT", "/api/alert-rules/digest", cookieAdmin, body);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(b.body.config.cron, "22 7 * * *");
  await send("PUT", "/api/alert-rules/digest", cookieAdmin, { enabled: false, cron: "7 9 * * *" });
});

// —— 汇总的作业筛选 ——

test("汇总配置 GET：回作业清单（供前端渲染勾选框）+ 默认 jobScope=all", async () => {
  assert.ok(ready, "server 未就绪");
  const { status, body } = await get("/api/alert-rules/digest", cookieAdmin);
  assert.equal(status, 200);
  assert.equal(body.config.jobScope, "all");
  assert.deepEqual(body.config.jobIds, []);
  assert.ok(Array.isArray(body.jobs), "必须回作业清单");
});

test("汇总配置 GET：作业清单只含渲染要用的字段，不带 options 大块内容", async () => {
  assert.ok(ready, "server 未就绪");
  // 先建一个作业（需要一个可运行目标）。
  // 【三个字段都要与本文件其它用例不同】渠道查重按 baseUrl + 模型 + Key 三者全一致判定
  // （见 server/profile-store.mjs findDuplicateProfile）。照抄上面 scope=target 用例的
  // api.example.com + gpt-4o + sk-test1234567890 会被判重复、渠道压根建不出来，
  // 随后 targetId 为 undefined —— 症状是本用例单跑绿、全文件跑红。
  await post("/api/channels", cookieAdmin, {
    name: "汇总作业筛选渠道",
    baseUrl: "https://digest-jobs.example.com",
    protocol: "openai_chat",
    models: "gpt-4o-digest",
    apiKey: "sk-digestjobs0987654321",
  });
  const channels = await get("/api/channels", cookieAdmin);
  const channelId = channels.body.find((c) => c.name === "汇总作业筛选渠道")?.id;
  assert.ok(channelId, "渠道应已建好（若为空，多半是与其它用例撞了查重三元组）");
  await post("/api/model-targets", cookieAdmin, { channelId, model: "gpt-4o-digest" });
  const targets = await get("/api/model-targets", cookieAdmin);
  const targetId = targets.body.find((t) => t.channelId === channelId)?.id;
  assert.ok(targetId);

  const job = await post("/api/auto-test-jobs", cookieAdmin, {
    name: "筛选用作业",
    targetId,
    kind: "quick",
    periodHours: 24,
    enabled: true,
  });
  assert.equal(job.status, 200);
  const jobId = job.body.job.id;

  const { body } = await get("/api/alert-rules/digest", cookieAdmin);
  const found = body.jobs.find((j) => j.id === jobId);
  assert.ok(found, "新建的作业应出现在清单里");
  assert.equal(found.name, "筛选用作业");
  assert.equal(found.kind, "quick");
  assert.ok(found.targetName, "应补出渠道/模型名（勾选框上要显示）");
  assert.equal(found.options, undefined, "不该把 options 送到浏览器");
  assert.equal(found.scenarioIds, undefined);

  // 勾选该作业
  const saved = await send("PUT", "/api/alert-rules/digest", cookieAdmin, {
    enabled: true,
    cron: "7 9 * * *",
    jobScope: "selected",
    jobIds: [jobId],
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.config.jobScope, "selected");
  assert.deepEqual(saved.body.config.jobIds, [jobId]);

  // 删掉作业 → 该 id 变成 stale，GET 要如实报出来
  await del(`/api/auto-test-jobs/${jobId}`, cookieAdmin);
  const after = await get("/api/alert-rules/digest", cookieAdmin);
  assert.deepEqual(after.body.staleJobIds, [jobId], "已删除的作业 id 要如实报出，不能让配置里躺着看不见的东西");

  await send("PUT", "/api/alert-rules/digest", cookieAdmin, { enabled: false, cron: "7 9 * * *" }); // 复位
});

// 选了「只汇总勾选的」却一个都没勾：存下去后每期汇总信都是空的，而用户以为开着汇总。
test("汇总配置 PUT：jobScope=selected 但 jobIds 为空 → 400", async () => {
  assert.ok(ready, "server 未就绪");
  const { status, body } = await send("PUT", "/api/alert-rules/digest", cookieAdmin, {
    enabled: true,
    cron: "7 9 * * *",
    jobScope: "selected",
    jobIds: [],
  });
  assert.equal(status, 400);
  assert.equal(body.error, "no_jobs_selected");
  assert.match(body.userMessage, /至少勾一个|全部自动测试/);
});

// 关闭状态下允许存空勾选（用户可能先关掉、回头再配）。
test("汇总配置 PUT：关闭时 jobScope=selected 且空勾选 → 允许（不拦已关闭的配置）", async () => {
  assert.ok(ready, "server 未就绪");
  const { status } = await send("PUT", "/api/alert-rules/digest", cookieAdmin, {
    enabled: false,
    cron: "7 9 * * *",
    jobScope: "selected",
    jobIds: [],
  });
  assert.equal(status, 200);
});

test("汇总配置 PUT：jobScope=all 时清空 jobIds（避免残留看不见的勾选）", async () => {
  assert.ok(ready, "server 未就绪");
  const saved = await send("PUT", "/api/alert-rules/digest", cookieAdmin, {
    enabled: true,
    cron: "7 9 * * *",
    jobScope: "all",
    jobIds: ["atj_残留"],
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.config.jobIds, [], "选了全部就不该留着勾选清单");
  await send("PUT", "/api/alert-rules/digest", cookieAdmin, { enabled: false, cron: "7 9 * * *" });
});

test("汇总配置 PUT：jobScope 脏值 → 落回 all", async () => {
  assert.ok(ready, "server 未就绪");
  const saved = await send("PUT", "/api/alert-rules/digest", cookieAdmin, {
    enabled: true,
    cron: "7 9 * * *",
    jobScope: "bogus",
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.config.jobScope, "all");
  await send("PUT", "/api/alert-rules/digest", cookieAdmin, { enabled: false, cron: "7 9 * * *" });
});
