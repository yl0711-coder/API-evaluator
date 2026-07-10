// tests/auto-test-digest-endpoint.test.mjs
// 端点集成：真起 server.mjs 子进程，验证「自动测试巡检报告」端到端：
//   - 未登录 → 401；登录 → 200 且落报告中心（.md/.html 可查看）；非法窗口回落 7 天。
// 空数据也应成文（无作业时兜底文案），覆盖 端点 → 格式化 → saveReportFiles → /view 渲染 全链路。
// 范式照搬 tests/dev-scenarios-endpoint.test.mjs。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test, { before, after } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 5388;
const dataDir = mkdtempSync(join(tmpdir(), "atd-endpoint-"));
let server;
let ready = false;
let cookie = "";

const baseEnv = {
  EVALUATOR_SESSION_SECRET: "test-secret",
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
async function post(path, ck, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${PORT}`, cookie: ck || "" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function getHtml(path, ck) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { origin: `http://127.0.0.1:${PORT}`, cookie: ck || "" } });
  return { status: r.status, contentType: r.headers.get("content-type") || "", text: await r.text() };
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
  const r = await post("/api/reports/auto-test-digest", "", { windowHours: 168 });
  assert.equal(r.status, 401);
});

test("登录 → 200，产出巡检报告并落报告中心（可查看）", async () => {
  const r = await post("/api/reports/auto-test-digest", cookie, { windowHours: 168 });
  assert.equal(r.status, 200, `期望 200，实为 ${r.status}：${JSON.stringify(r.body)}`);
  assert.match(r.body.reportId, /^autodigest_\d{8}_\d{6}_/, "reportId 形如 autodigest_YYYYMMDD_HHMMSS_hash");
  assert.equal(r.body.windowHours, 168);
  assert.match(r.body.markdown, /# 自动测试巡检报告/);
  assert.ok(r.body.summary && typeof r.body.summary.targets === "number");

  // 落报告中心：文件列表含该 id
  const files = await (await fetch(`http://127.0.0.1:${PORT}/api/reports/files`, { headers: { origin: `http://127.0.0.1:${PORT}`, cookie } })).json();
  assert.ok(files.some((f) => f.id === r.body.reportId), "报告文件列表应含新报告");

  // 可查看：/view 返回 HTML，含标题与调度健康小节
  const view = await getHtml(`/api/reports/${encodeURIComponent(r.body.reportId)}/view`, cookie);
  assert.equal(view.status, 200);
  assert.match(view.contentType, /text\/html/);
  assert.match(view.text, /自动测试巡检报告/);
  assert.match(view.text, /调度健康/);
});

test("非法 windowHours → 回落 7 天(168)", async () => {
  const r = await post("/api/reports/auto-test-digest", cookie, { windowHours: 999 });
  assert.equal(r.status, 200);
  assert.equal(r.body.windowHours, 168);
});

test("单模型：传 profileId → 范围限定该模型（覆盖模型=1、含范围行）", async () => {
  const r = await post("/api/reports/auto-test-digest", cookie, { windowHours: 168, profileId: "solo-model-x" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.profileId, "solo-model-x");
  assert.equal(r.body.summary.targets, 1, "单模型模式始终收录该目标（即便窗口内无运行）");
  assert.match(r.body.markdown, /\*\*范围\*\*：单个模型/);
});
