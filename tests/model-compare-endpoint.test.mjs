// tests/model-compare-endpoint.test.mjs
// 「模型比对」端点集成：真起 server.mjs 子进程，把 Evaluation Report/ 下的真实报告样例播种到
// REPORTS_DIR（临时 dataDir/报告），驱动 POST /api/reports/compare 走通：
//   - 未登录 → 401；缺渠道/模型 → 400 invalid_target；无匹配报告 → 400 no_reports；
//   - 正常两模型 → 200，产出并【落盘】一份对比报告；AI 叙述未配置时优雅跳过。
// 范式照搬 tests/dev-scenarios-endpoint.test.mjs。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test, { before, after } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 5386;
const dataDir = mkdtempSync(join(tmpdir(), "mc-endpoint-"));
const REPORTS_DIR = join(dataDir, "报告");
const EVAL = join(root, "Evaluation Report");
// 样例对象：文件名前缀 = 渠道_模型。A=test/…，B=Claude-1.3x/…（与夹具文件名一致）。
const A = { channel: "test", model: "claude-opus-4-8" };
const B = { channel: "Claude-1.3x", model: "claude-opus-4-8" };

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

// 把两个夹具文件夹里的 .md 报告平铺播种进 REPORTS_DIR（文件名前缀已含渠道_模型，端点按前缀匹配）。
async function seedReports() {
  await mkdir(REPORTS_DIR, { recursive: true });
  for (const sub of ["新建文件夹", "新建文件夹 (2)"]) {
    const dir = join(EVAL, sub);
    let names = [];
    try {
      names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith(".md"));
    } catch {
      continue;
    }
    for (const name of names) {
      await writeFile(join(REPORTS_DIR, name), await readFile(join(dir, name), "utf8"), "utf8");
    }
  }
}

before(async () => {
  await seedReports();
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
  const r = await post("/api/reports/compare", "", { a: A, b: B });
  assert.equal(r.status, 401);
});

test("缺渠道/模型 → 400 invalid_target", async () => {
  const r = await post("/api/reports/compare", cookie, { a: { channel: "test" }, b: B });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "invalid_target");
});

test("无匹配报告 → 400 no_reports（指出缺报告的模型）", async () => {
  const r = await post("/api/reports/compare", cookie, {
    a: A,
    b: { channel: "查无此渠道", model: "查无此模型" },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "no_reports");
  assert.match(r.body.userMessage, /查无此渠道/);
});

test("正常两模型 → 200，产出对比报告并落盘", async () => {
  const r = await post("/api/reports/compare", cookie, { a: A, b: B });
  assert.equal(r.status, 200, `期望 200，实为 ${r.status}：${JSON.stringify(r.body)}`);
  assert.ok(r.body.reportId, "有 reportId");
  assert.match(r.body.reportId, /_vs_.*_compare_/, "reportId 含 _vs_…_compare_");
  // Markdown 含关键小节。
  assert.match(r.body.markdown, /# 模型对比报告/);
  assert.match(r.body.markdown, /## 结论速览/);
  assert.match(r.body.markdown, /## 1\. 可用性与通过率/);
  // 采用报告数说明（两侧都有场景/稳定性/准入）。
  assert.match(r.body.notes.a, /场景.*稳定性.*准入/);
  assert.match(r.body.notes.b, /场景.*稳定性.*准入/);
  assert.equal(r.body.notes.aiApplied, false, "未请求 AI → 不附叙述");
  // 落盘：md + html 两份都在 REPORTS_DIR。
  assert.ok(existsSync(join(REPORTS_DIR, `${r.body.reportId}.md`)), "对比报告 .md 已落盘");
  assert.ok(existsSync(join(REPORTS_DIR, `${r.body.reportId}.html`)), "对比报告 .html 已落盘");
});

test("请求 AI 叙述但未配置 AI 模型 → 优雅跳过（200，aiApplied=false + 说明）", async () => {
  const r = await post("/api/reports/compare", cookie, { a: A, b: B, aiNarrative: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.notes.aiApplied, false);
  assert.match(r.body.notes.ai, /未在「设置」里指定 AI 总结模型/);
  // 主统计报告不受 AI 缺失影响，照常产出。
  assert.match(r.body.markdown, /## 6\. 总结/);
});
