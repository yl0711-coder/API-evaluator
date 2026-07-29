// tests/model-compare-endpoint.test.mjs
// 「模型比对」端点集成：真起 server.mjs 子进程，把 Evaluation Report/ 下的真实报告样例播种到
// REPORTS_DIR（临时 dataDir/报告），驱动 POST /api/reports/compare 走通：
//   - 未登录 → 401；缺渠道/模型 → 400 invalid_target；无匹配报告 → 400 no_reports；
//   - 正常两模型 → 200，产出并【落盘】一份对比报告；AI 叙述未配置时优雅跳过。
//   - 老化报告压缩：seedReports 故意把一份场景报告原地 gzip（真实压缩后的形态），
//     验证 loadBalancedCompareFiles/readReportFileText 的透明解压链路；另有一条测试
//     单独验证 /api/reports/:id/view 对压缩后的 .html 同样能正常查看。
// 范式照搬 tests/dev-scenarios-endpoint.test.mjs。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test, { before, after } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 5386;
const dataDir = mkdtempSync(join(tmpdir(), "mc-endpoint-"));
const REPORTS_DIR = join(dataDir, "报告");
// 样例对象：文件名前缀 = 渠道_模型。A=test/…，B=Claude-1.3x/…（与夹具文件名一致）。
const A = { channel: "test", model: "claude-opus-4-8" };
const B = { channel: "Claude-1.3x", model: "claude-opus-4-8" };

let server;
let ready = false;
let cookie = "";

const baseEnv = {
  EVALUATOR_SESSION_SECRET: "test-secret-0123456789abcdef-32b+",
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

// 自造最小但可解析的报告夹具（旧实现读 Evaluation Report/ 下的真实样例，但那目录从未提交进仓库
// → seedReports 播不进任何报告 → 端点 no_reports → 测试挂）。这里内联生成，测试自包含、可复现。
// 文件名前缀 = sanitizeReportBaseName(渠道_模型)_类型_YYYYMMDD，与端点匹配口径一致；
// 每模型各一份 稳定性(run)/场景(scenario)/准入(admission)，场景名两方共有（「基础问答」）以便配对对比。
function runReportMd(rate, ms) {
  return [
    "# 稳定性测试报告",
    "",
    "## 测试对象",
    "- 测试轮数：10",
    "- 并发数：1",
    "",
    "## 专业汇总结论",
    `- 成功率：${rate}`,
    `- 平均总耗时：${ms} ms`,
    "- 平均首包：300 ms",
    "",
  ].join("\n");
}
function scenarioReportMd(rate, quality) {
  return [
    "# 场景测试报告",
    "",
    "## 专业分析摘要",
    "- 每个场景重复次数：3",
    "",
    "## 场景明细",
    "| 场景 | 成功率 | 平均质量分 | 平均耗时 | 问题摘要 | 场景结论 |",
    "|---|---|---|---|---|---|",
    `| 基础问答 | ${rate} | ${quality} | 1500 | - | 通过 |`,
    "",
  ].join("\n");
}
function admissionReportMd(grade, composite) {
  return [
    "# 准入评测报告",
    "",
    "## 准入结论",
    `- 准入等级：${grade}`,
    `- 综合分：${composite}`,
    "- 结论：可用",
    "",
    "## 关键指标",
    "- 成功率：100% (12/12)",
    "- 平均耗时：1300 ms",
    "",
  ].join("\n");
}

async function seedReports() {
  await mkdir(REPORTS_DIR, { recursive: true });
  const D = "20260701";
  const write = (name, md) => writeFile(join(REPORTS_DIR, name), md, "utf8");
  // A = test / claude-opus-4-8（较优）
  await write(`test_claude-opus-4-8_run_${D}.md`, runReportMd("100% (10/10)", 1200));
  // 场景报告故意原地 gzip（老化压缩后的真实形态：文件名/扩展名不变），验证读取链路
  // （loadBalancedCompareFiles → readReportFileText）能透明解压，不影响模型比对结果。
  await write(`test_claude-opus-4-8_scenario_${D}.md`, scenarioReportMd("100% (3/3)", "8.5"));
  await gzipInPlace(join(REPORTS_DIR, `test_claude-opus-4-8_scenario_${D}.md`));
  await write(`test_claude-opus-4-8_admission_${D}.md`, admissionReportMd("A", 85));
  // B = Claude-1.3x / claude-opus-4-8（略逊，产生可对比的差异）
  await write(`Claude-1.3x_claude-opus-4-8_run_${D}.md`, runReportMd("80% (8/10)", 1600));
  await write(`Claude-1.3x_claude-opus-4-8_scenario_${D}.md`, scenarioReportMd("67% (2/3)", "6.0"));
  await write(`Claude-1.3x_claude-opus-4-8_admission_${D}.md`, admissionReportMd("B", 70));
}

async function gzipInPlace(path) {
  const { gzipSync } = await import("node:zlib");
  const { readFile: readFileAsync } = await import("node:fs/promises");
  const original = await readFileAsync(path);
  await writeFile(path, gzipSync(original));
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

test("/api/reports/compare/gaps：两方场景相同 → onlyA/onlyB 均为空", async () => {
  const r = await post("/api/reports/compare/gaps", cookie, { a: A, b: B });
  assert.equal(r.status, 200, `期望 200，实为 ${r.status}：${JSON.stringify(r.body)}`);
  assert.deepEqual(r.body.onlyA, [], "两方都只测了「基础问答」，A 无独有场景");
  assert.deepEqual(r.body.onlyB, [], "两方都只测了「基础问答」，B 无独有场景");
});

test("/api/reports/compare/gaps：追加一份仅 A 测过的新场景 → onlyA 含该场景，onlyB 仍空", async () => {
  // 追加一份新日期的场景报告（场景名「编程题」），只属于 A；B 未测过 → 应出现在 onlyA。
  await writeFile(
    join(REPORTS_DIR, `test_claude-opus-4-8_scenario_20260702.md`),
    scenarioReportMd("100% (3/3)", "9.0").replace("基础问答", "编程题"),
    "utf8",
  );
  const r = await post("/api/reports/compare/gaps", cookie, { a: A, b: B });
  assert.equal(r.status, 200, `期望 200，实为 ${r.status}：${JSON.stringify(r.body)}`);
  assert.deepEqual(
    r.body.onlyA.map((s) => s.name),
    ["编程题"],
    "A 独有新场景应出现在 onlyA",
  );
  assert.deepEqual(r.body.onlyB, [], "B 仍无独有场景");
});

test("/api/reports/:id/view：已被原地 gzip 压缩的报告仍能正常查看（透明解压）", async () => {
  // 复用已播种的场景报告（seedReports 里已把它原地 gzip 过），先渲染出对应 .html，
  // 再单独把该 .html 也原地 gzip，验证 handleReportView 一样能透明解压服务。
  const id = `test_claude-opus-4-8_scenario_20260701`;
  const htmlPath = join(REPORTS_DIR, `${id}.html`);
  await writeFile(htmlPath, "<!doctype html><html><body>场景测试报告（压缩后）</body></html>", "utf8");
  await gzipInPlace(htmlPath);

  const r = await fetch(`http://127.0.0.1:${PORT}/api/reports/${encodeURIComponent(id)}/view`, {
    headers: { cookie },
  });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /场景测试报告（压缩后）/);
});
