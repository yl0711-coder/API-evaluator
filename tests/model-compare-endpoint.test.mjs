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
import { aggregate, formatSinglePointReport } from "../server/load-test.mjs";

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
// 多场景批量报告：一份文件含多条场景行（批量测试选多个场景会落一个文件）。用于复现「首条场景名去重」缺陷。
function multiScenarioReportMd(names) {
  return [
    "# 场景测试报告",
    "",
    "## 专业分析摘要",
    "- 每个场景重复次数：3",
    "",
    "## 场景明细",
    "| 场景 | 成功率 | 平均质量分 | 平均耗时 | 问题摘要 | 场景结论 |",
    "|---|---|---|---|---|---|",
    ...names.map((n) => `| ${n} | 100% (3/3) | 80 | 1500 | - | 通过 |`),
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

// 压测报告：用 load-test.mjs 的真实 aggregate()/formatSinglePointReport() 产出（而非手写字符串），
// 与 A/B 用同一个负载点(closed/30)以便配对对比；B 稳定性略逊，压测这里也给出可区分的数字。
function loadReportMd(offered, succOk) {
  const samples = succOk
    ? [
        { ms: 500, ok: true, status: 200, err: "", warmup: false },
        { ms: 600, ok: true, status: 200, err: "", warmup: false },
      ]
    : [
        { ms: 900, ok: true, status: 200, err: "", warmup: false },
        { ms: null, ok: false, status: 429, err: "rate_limited", warmup: false },
      ];
  const point = aggregate({ samples, mode: "closed", offered, durationSec: 10 });
  return formatSinglePointReport(
    {
      mode: "closed",
      model: "claude-opus-4-8",
      profileName: "test",
      protocol: "openai_chat",
      promptProfile: "简单",
      durationSec: 10,
      warmupSec: 0,
      maxTokens: 64,
      timeoutSec: 30,
      maxInFlight: 300,
      intervalSec: 0,
      burstPeriodSec: 1,
      stream: false,
      startedAt: "2026-07-01T00:00:00.000Z",
      endedAt: "2026-07-01T00:00:10.000Z",
    },
    point,
  );
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
  await write(`test_claude-opus-4-8_load_${D}.md`, loadReportMd(30, true));
  // B = Claude-1.3x / claude-opus-4-8（略逊，产生可对比的差异）
  await write(`Claude-1.3x_claude-opus-4-8_run_${D}.md`, runReportMd("80% (8/10)", 1600));
  await write(`Claude-1.3x_claude-opus-4-8_scenario_${D}.md`, scenarioReportMd("67% (2/3)", "6.0"));
  await write(`Claude-1.3x_claude-opus-4-8_admission_${D}.md`, admissionReportMd("B", 70));
  await write(`Claude-1.3x_claude-opus-4-8_load_${D}.md`, loadReportMd(30, false));
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
  const r = await post("/api/reports/compare", cookie, {
    a: A,
    b: B,
    aName: "测试对象 A",
    bName: "测试对象 B",
    scenarios: ["基础问答"],
  });
  assert.equal(r.status, 200, `期望 200，实为 ${r.status}：${JSON.stringify(r.body)}`);
  assert.ok(r.body.reportId, "有 reportId");
  assert.match(r.body.reportId, /_vs_.*_compare_/, "reportId 含 _vs_…_compare_");
  // Markdown 含关键小节。
  assert.match(r.body.markdown, /# 模型对比报告/);
  assert.match(r.body.markdown, /## 结论速览/);
  assert.match(r.body.markdown, /## 1\. 可用性与通过率/);
  // 采用报告数说明（两侧都有场景/稳定性/准入/压测）。
  assert.match(r.body.notes.a, /场景.*稳定性.*准入.*压测/);
  assert.match(r.body.notes.b, /场景.*稳定性.*准入.*压测/);
  assert.equal(r.body.notes.aiApplied, false, "未请求 AI → 不附叙述");
  assert.equal(r.body.comparison.subjects.a.label, "测试对象 A");
  assert.equal(r.body.comparison.subjects.b.label, "测试对象 B");
  assert.equal(r.body.comparison.summary.find((row) => row.id === "stability-rate").winner, "a");
  assert.equal(r.body.comparison.summary.find((row) => row.id === "p95-latency").direction, "lower");
  assert.deepEqual(
    r.body.comparison.scenarios.map((row) => row.name),
    ["基础问答"],
  );
  // 压力测试对比节：两侧都有 closed/30 负载点，应配对出表格行（非「跳过压测对比」的空说明）。
  assert.match(r.body.markdown, /## 6\. 压力测试对比/);
  assert.match(r.body.markdown, /闭环 \| 30 并发/);
  assert.ok(!r.body.markdown.includes("两个对象都没有压力测试报告"), "两侧都有压测报告，不应走空数据分支");
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
  assert.match(r.body.markdown, /## 7\. 总结/);
});

test("压力测试单方独有：B 没有压测报告时，A 的压测数据不应被丢弃，报告应列出「仅对象A 测过」", async () => {
  // 复现过的真实缺陷：load 若被当成需要「双方都有才纳入」的类型，balanceCommonReports 会把 A 的
  // 压测报告整份丢弃，报告还会误报「两个对象都没有压力测试报告」。这里删掉 B 的压测报告文件，
  // 走一次真实 HTTP 请求验证 A 的负载点仍能进入对比、且被正确标记为「仅对象A 测过」。
  const bLoadPath = join(REPORTS_DIR, `Claude-1.3x_claude-opus-4-8_load_20260701.md`);
  const { rename } = await import("node:fs/promises");
  const bLoadBackup = `${bLoadPath}.bak`;
  await rename(bLoadPath, bLoadBackup);
  try {
    const r = await post("/api/reports/compare", cookie, { a: A, b: B });
    assert.equal(r.status, 200, `期望 200，实为 ${r.status}：${JSON.stringify(r.body)}`);
    assert.match(r.body.notes.a, /压测/, "A 的压测报告不应被丢弃");
    assert.ok(!/压测/.test(r.body.notes.b), "B 确实没有压测报告");
    assert.match(r.body.markdown, /## 6\. 压力测试对比/);
    assert.ok(!r.body.markdown.includes("两个对象都没有压力测试报告"), "A 明明有压测报告，不得声称双方都没有");
    assert.match(r.body.markdown, /仅对象A 测过、且无法插值估计的负载点/, "A 独有的负载点应被列出，而非静默消失");
  } finally {
    await rename(bLoadBackup, bLoadPath); // 恢复现场，不影响后续测试
  }
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

test("多场景报告共享首条场景名（端到端）：/compare/scenarios 共有场景数不得因首条去重而偏低", async () => {
  // 复现的真实缺陷：两份多场景批量报告只要首条场景名相同，较旧那份里其余场景就被整份连坐丢弃，
  // 导致「共有场景」计数偏低、且这些场景既不在共有也不在差集里（用户报告的现象）。
  // 这里给 A、B 各播种一份多场景报告，都以「基础问答」开头，其后带若干共有场景。
  const D = "20260703";
  const shared = ["基础问答", "多场景甲", "多场景乙", "多场景丙"];
  await writeFile(join(REPORTS_DIR, `test_claude-opus-4-8_scenario_${D}.md`), multiScenarioReportMd(shared), "utf8");
  await writeFile(join(REPORTS_DIR, `Claude-1.3x_claude-opus-4-8_scenario_${D}.md`), multiScenarioReportMd(shared), "utf8");
  try {
    const r = await post("/api/reports/compare/scenarios", cookie, { a: A, b: B });
    assert.equal(r.status, 200, `期望 200，实为 ${r.status}：${JSON.stringify(r.body)}`);
    const names = r.body.scenarios.map((s) => s.name);
    // 四个共有场景一个不少——旧逻辑下「多场景甲/乙/丙」会随首条「基础问答」去重被丢，只剩 1 个。
    for (const n of shared) assert.ok(names.includes(n), `共有场景应含「${n}」，不得因首条场景名去重而丢失`);
    assert.ok(names.length >= shared.length, `共有场景数应 ≥ ${shared.length}，实为 ${names.length}`);
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(join(REPORTS_DIR, `test_claude-opus-4-8_scenario_${D}.md`), { force: true });
    await rm(join(REPORTS_DIR, `Claude-1.3x_claude-opus-4-8_scenario_${D}.md`), { force: true });
  }
});

test("候选预算隔离：密集压测产生 7 份近期 load 文件，不得把稳定性/准入挤出对比候选", async () => {
  // 复现的真实缺陷：run/admission/load 共用「最近 6 份」预算时，6+ 份 mtime 更新的 load 文件
  // 会把较旧的 run/admission 文件全部挤出候选 → 对比里稳定性/准入静默消失（磁盘上明明有）。
  const { rm } = await import("node:fs/promises");
  const extras = Array.from({ length: 7 }, (_, i) => join(REPORTS_DIR, `test_claude-opus-4-8_load_2026071${i}.md`));
  for (const p of extras) await writeFile(p, loadReportMd(30, true), "utf8"); // 刚写入 → mtime 比 run/admission 新
  try {
    const r = await post("/api/reports/compare", cookie, { a: A, b: B });
    assert.equal(r.status, 200, `期望 200，实为 ${r.status}：${JSON.stringify(r.body)}`);
    assert.match(r.body.notes.a, /1 稳定性/, "A 的稳定性报告不得被压测文件挤出候选");
    assert.match(r.body.notes.a, /1 准入/, "A 的准入报告不得被压测文件挤出候选");
    assert.match(r.body.notes.b, /1 稳定性/, "B 的稳定性也应存活（A 的 run 若被挤掉，balance 会连坐丢掉 B 的）");
  } finally {
    for (const p of extras) await rm(p, { force: true }); // 恢复现场，不影响其它测试
  }
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
