// tests/model-compare-multi-endpoint.test.mjs
// 「多模型比对」两个端点的集成测试：真起 server.mjs 子进程。
//   POST /api/reports/compare/peers —— 扫报告目录、按 `_vs_` 文件名反查「曾与基准比对过」的模型；
//   POST /api/reports/compare/multi —— 基准 + 1~6 个 peer，产出列数可变的并列对比表（不落报告文件）。
//
// 为什么要通过 API 播种渠道 / 模型目标，而不是写 channels.json：
//   channel-store / model-target-store 都以 SQLite 为主，JSON 只在【SQLite 不可用时】兜底。
//   本环境 node:sqlite 可用 → loadChannels() 返回 []（不是 null），压根不会去读 JSON，
//   直接写文件会被静默忽略、测试白跑。故这里走 POST /api/channels + /api/model-targets。
//
// peers 端点依赖 slug 索引把文件名切出来的 slug 映射回模型目标，所以刻意播种了两个「难切」的渠道名：
// 含下划线的「对比渠道_甲」与含 `_vs_` 子串的「对比_vs_渠道」。
// 范式照搬 tests/model-compare-endpoint.test.mjs。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test, { before, after } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 5401;
const dataDir = mkdtempSync(join(tmpdir(), "mc-multi-endpoint-"));
const REPORTS_DIR = join(dataDir, "报告");

const MODEL = "claude-opus-4-8";
const BASE = { channel: "基准渠道", model: MODEL };
const PEER_UNDERSCORE = { channel: "对比渠道_甲", model: MODEL }; // 渠道名含下划线
const PEER_VS = { channel: "对比_vs_渠道", model: MODEL }; // 渠道名含 `_vs_` 子串
const PEER_NO_REPORT = { channel: "没跑过测试的渠道", model: MODEL }; // 有模型目标、无报告

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

// —— 报告夹具（与 model-compare-endpoint.test.mjs 同口径的最小可解析体）——
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
function scenarioReportMd(rows) {
  return [
    "# 场景测试报告",
    "",
    "## 专业分析摘要",
    "- 每个场景重复次数：3",
    "",
    "## 场景明细",
    "| 场景 | 成功率 | 平均质量分 | 平均耗时 | 问题摘要 | 场景结论 |",
    "|---|---|---|---|---|---|",
    ...rows.map(([name, rate, quality]) => `| ${name} | ${rate} | ${quality} | 1500 | - | 通过 |`),
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

const slug = (s) => `${s.channel}_${s.model}`;
const write = (name, md) => writeFile(join(REPORTS_DIR, name), md, "utf8");

// 一个对象的一整套报告（稳定性 + 场景 + 准入）。场景名两方共有，便于配对。
async function seedSubjectReports(subject, { rate, ms, quality, grade, composite }) {
  const D = "20260701";
  await write(`${slug(subject)}_run_${D}.md`, runReportMd(rate, ms));
  await write(
    `${slug(subject)}_scenario_${D}.md`,
    scenarioReportMd([
      ["场景甲", "100% (3/3)", quality],
      ["场景乙", "100% (3/3)", quality],
    ]),
  );
  await write(`${slug(subject)}_admission_${D}.md`, admissionReportMd(grade, composite));
}

// 一份「对比报告」：只有文件名有意义（peers 端点只读名字，不解析正文）。
async function seedCompareReport(a, b, { date, time, hash = "ab12" }) {
  const name = `${slug(a)}_vs_${slug(b)}_compare_${date}_${time}_${hash}.md`;
  await write(name, "# 模型对比报告\n");
  return name.replace(/\.md$/, "");
}

async function seedReports() {
  await mkdir(REPORTS_DIR, { recursive: true });
  await seedSubjectReports(BASE, { rate: "100% (10/10)", ms: 1200, quality: "9.0", grade: "A", composite: 88 });
  await seedSubjectReports(PEER_UNDERSCORE, { rate: "80% (8/10)", ms: 1600, quality: "6.0", grade: "B", composite: 70 });
  await seedSubjectReports(PEER_VS, { rate: "100% (10/10)", ms: 2000, quality: "9.5", grade: "A", composite: 90 });

  // 比对历史：基准 ↔ 两个 peer。PEER_UNDERSCORE 比过两次（验证 compareCount 累计与取最近一份）。
  await seedCompareReport(BASE, PEER_UNDERSCORE, { date: "20260801", time: "120000" });
  await seedCompareReport(PEER_UNDERSCORE, BASE, { date: "20260802", time: "133000", hash: "cd34" }); // 反序，基准在 B 侧
  await seedCompareReport(BASE, PEER_VS, { date: "20260731", time: "090000", hash: "ef56" });
  // 与基准无关的一对（两个 peer 互比）：不该出现在基准的 peers 列表里。
  await seedCompareReport(PEER_UNDERSCORE, PEER_VS, { date: "20260803", time: "140000", hash: "0a1b" });
  // 基准 ↔ 已删除模型：基准这一侧认得出、另一侧对应不上 → 记入 unresolved（这才是要提醒用户的漏项）。
  await write(`${slug(BASE)}_vs_查无此渠道_查无此模型_compare_20260804_150000_dead.md`, "# 模型对比报告\n");
  // 两侧都与基准无关且都解析不出（另外两个模型互比、双方均已删除）：**不**计入基准的 unresolved，
  // 否则用户选个基准就被告知「另有 N 份无法对应」，而那 N 份跟他选的基准毫无关系。
  await write("另一个幽灵_幽灵模型_vs_第三个幽灵_幽灵模型乙_compare_20260805_160000_gh01.md", "# 模型对比报告\n");
}

// 通过 API 播种渠道 + 模型目标（SQLite 为主，写 JSON 无效——见文件头注释）。
async function seedTargets() {
  for (const subject of [BASE, PEER_UNDERSCORE, PEER_VS, PEER_NO_REPORT]) {
    const ch = await post("/api/channels", cookie, {
      name: subject.channel,
      baseUrl: `https://example.invalid/${encodeURIComponent(subject.channel)}`,
      protocol: "openai_chat",
      models: [subject.model],
    });
    assert.equal(ch.status, 200, `建渠道失败：${JSON.stringify(ch.body)}`);
    const mt = await post("/api/model-targets", cookie, { channelId: ch.body.id, model: subject.model });
    assert.equal(mt.status, 200, `建模型目标失败：${JSON.stringify(mt.body)}`);
  }
}

before(async () => {
  await seedReports();
  server = spawn(process.execPath, [join(root, "server.mjs")], {
    env: { ...process.env, ...baseEnv, EVALUATOR_DATA_DIR: dataDir, PORT: String(PORT) },
    stdio: "ignore",
  });
  ready = await waitHealthy();
  if (ready) {
    cookie = await login();
    await seedTargets();
  }
});
after(() => {
  server?.kill();
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* best-effort */
  }
});

// —— /api/reports/compare/peers ——

test("peers：未登录 → 401", async () => {
  assert.ok(ready, "server 未就绪");
  const r = await post("/api/reports/compare/peers", "", { base: BASE });
  assert.equal(r.status, 401);
});

test("peers：缺渠道/模型 → 400 invalid_target", async () => {
  const r = await post("/api/reports/compare/peers", cookie, { base: { channel: "基准渠道" } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "invalid_target");
});

test("peers：列出曾与基准比对过的模型（含渠道名带下划线 / 带 `_vs_` 的难切样本）", async () => {
  const r = await post("/api/reports/compare/peers", cookie, { base: BASE });
  assert.equal(r.status, 200, `期望 200，实为 ${r.status}：${JSON.stringify(r.body)}`);
  const byChannel = new Map(r.body.peers.map((p) => [p.channel, p]));
  assert.ok(byChannel.has(PEER_UNDERSCORE.channel), "渠道名含下划线的 peer 应被正确切分并列出");
  assert.ok(byChannel.has(PEER_VS.channel), "渠道名含 `_vs_` 子串的 peer 应被正确切分并列出");
  assert.equal(r.body.peers.length, 2, `只该列出与基准比对过的 2 个模型，实为 ${r.body.peers.length}`);
});

test("peers：基准在文件名任一侧都算（compareCount 累计，lastComparedAt 取最近一份）", async () => {
  const r = await post("/api/reports/compare/peers", cookie, { base: BASE });
  const peer = r.body.peers.find((p) => p.channel === PEER_UNDERSCORE.channel);
  // 两份：20260801（基准在 A 侧）+ 20260802（基准在 B 侧，反序）。
  assert.equal(peer.compareCount, 2, "基准出现在文件名哪一侧都该计入");
  assert.match(peer.lastComparedAt, /^2026-08-02 13:30:00$/, "应取更近的那份的时间戳");
  assert.match(peer.lastReportId, /_compare_20260802_133000_cd34$/, "lastReportId 指向最近那份报告");
});

test("peers：与基准无关的一对不出现在列表里", async () => {
  const r = await post("/api/reports/compare/peers", cookie, { base: BASE });
  // 两个 peer 互比的那份（20260803）不得让任何一方的 compareCount 变成 3。
  for (const p of r.body.peers) {
    assert.ok(p.compareCount <= 2, `${p.channel} 的 compareCount=${p.compareCount}，与基准无关的报告被误计入`);
  }
});

test("peers：基准在一侧、另一侧解析不出 → 记入 unresolved，不污染 peers", async () => {
  const r = await post("/api/reports/compare/peers", cookie, { base: BASE });
  assert.equal(r.body.unresolved, 1, `只该有 1 份「基准 ↔ 已删除模型」的漏项，实为 ${r.body.unresolved}`);
  assert.ok(!r.body.peers.some((p) => p.channel.includes("幽灵") || p.channel.includes("查无此")), "解析不出的对象不得作为 peer 列出");
});

// unresolved 是给用户看的提示文案（「另有 N 份对比报告无法对应到当前配置」）。
// 报告目录是全局的，里面大量对比报告与当前基准无关；把它们也计进来，用户每选一个基准
// 都会看到一个与他无关的大数字，提示就成了噪音。
test("peers：与基准两侧都无关的解析失败报告不计入 unresolved", async () => {
  const r = await post("/api/reports/compare/peers", cookie, { base: BASE });
  // 目录里有两份解析不出的：一份含基准（该计），一份两侧都是幽灵（不该计）。
  assert.equal(r.body.unresolved, 1, "两侧都与基准无关的报告不该计入基准的 unresolved");
  // 换个从未比对过的基准：那两份幽灵报告与它同样无关，计数应为 0 而不是 2。
  const other = await post("/api/reports/compare/peers", cookie, { base: PEER_NO_REPORT });
  assert.equal(other.body.unresolved, 0, `无关的幽灵报告不该计入，实为 ${other.body.unresolved}`);
});

test("peers：从未比对过的基准 → 空列表（不是报错）", async () => {
  const r = await post("/api/reports/compare/peers", cookie, { base: PEER_NO_REPORT });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.peers, [], "没有比对历史就是空列表");
});

// —— /api/reports/compare/multi ——

test("multi：未登录 → 401", async () => {
  const r = await post("/api/reports/compare/multi", "", { base: BASE, peers: [PEER_UNDERSCORE] });
  assert.equal(r.status, 401);
});

test("multi：缺基准 → 400 invalid_target", async () => {
  const r = await post("/api/reports/compare/multi", cookie, { peers: [PEER_UNDERSCORE] });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "invalid_target");
});

test("multi：peers 为空 / 只含基准自身 → 400 invalid_target", async () => {
  const empty = await post("/api/reports/compare/multi", cookie, { base: BASE, peers: [] });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, "invalid_target");
  // 只勾了基准自己：去重后为空，同样拦下（自己跟自己并列没有意义）。
  const selfOnly = await post("/api/reports/compare/multi", cookie, { base: BASE, peers: [BASE] });
  assert.equal(selfOnly.status, 400);
  assert.equal(selfOnly.body.error, "invalid_target");
});

test("multi：超过 6 个 peer → 400 too_many_peers", async () => {
  const peers = Array.from({ length: 7 }, (_, i) => ({ channel: `渠道${i}`, model: MODEL }));
  const r = await post("/api/reports/compare/multi", cookie, { base: BASE, peers });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "too_many_peers");
});

test("multi：基准无报告 → 400 no_reports", async () => {
  const r = await post("/api/reports/compare/multi", cookie, { base: PEER_NO_REPORT, peers: [PEER_UNDERSCORE] });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "no_reports");
});

test("multi：两个 peer → 3 列并列表，基准列固定 50 分", async () => {
  const r = await post("/api/reports/compare/multi", cookie, { base: BASE, peers: [PEER_UNDERSCORE, PEER_VS] });
  assert.equal(r.status, 200, `期望 200，实为 ${r.status}：${JSON.stringify(r.body)}`);
  const c = r.body.comparison;
  assert.equal(c.subjects.length, 3, "基准 + 2 个 peer = 3 列");
  assert.equal(c.subjects[0].isBase, true, "第一列是基准");
  assert.equal(c.subjects[0].label, `${BASE.channel} / ${BASE.model}`);
  // 每行 values 长度必须等于列数，否则前端按 subjects.length 生成 td 会串列。
  for (const row of c.summary) assert.equal(row.values.length, 3, `摘要行「${row.label}」values 长度应为 3`);
  for (const row of c.scenarios) assert.equal(row.values.length, 3, `场景行「${row.name}」values 长度应为 3`);
  const overall = c.summary.find((row) => row.id === "overall-score");
  assert.equal(overall.values[0].value, 50, "基准列固定 50 分（打平锚点）");
  assert.match(overall.detail, /不具传递性/, "综合相对分行须注明跨列比较不具传递性");
});

test("multi：共享场景只保留各 peer 都与基准共有的那批", async () => {
  const r = await post("/api/reports/compare/multi", cookie, { base: BASE, peers: [PEER_UNDERSCORE, PEER_VS] });
  const names = r.body.comparison.scenarios.map((row) => row.name);
  assert.deepEqual(names, ["场景甲", "场景乙"], "三方都测过场景甲/乙");
  assert.equal(r.body.notes.sharedScenarioCount, 2);
});

test("multi：基准列不随勾选了哪些 peer 而变（N 列共享同一份基准画像）", async () => {
  const both = await post("/api/reports/compare/multi", cookie, { base: BASE, peers: [PEER_UNDERSCORE, PEER_VS] });
  const onlyOne = await post("/api/reports/compare/multi", cookie, { base: BASE, peers: [PEER_UNDERSCORE] });
  const baseCol = (body) => body.comparison.summary.map((row) => `${row.id}=${row.values[0].value}`);
  assert.deepEqual(baseCol(onlyOne.body), baseCol(both.body), "基准列的每个指标都不该随 peer 组合变化");
});

test("multi：有模型目标但没有报告的 peer 记入 skipped，其余照常出表", async () => {
  const r = await post("/api/reports/compare/multi", cookie, { base: BASE, peers: [PEER_UNDERSCORE, PEER_NO_REPORT] });
  assert.equal(r.status, 200, `期望 200，实为 ${r.status}：${JSON.stringify(r.body)}`);
  assert.equal(r.body.comparison.subjects.length, 2, "只有基准 + 能比的那个 peer 成列");
  assert.equal(r.body.skipped.length, 1);
  assert.match(r.body.skipped[0].label, /没跑过测试的渠道/);
  assert.match(r.body.skipped[0].reason, /报告/);
});

test("multi：全部 peer 都无法并列 → 400 no_common_reports（说明每个被跳过的原因）", async () => {
  const r = await post("/api/reports/compare/multi", cookie, { base: BASE, peers: [PEER_NO_REPORT] });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "no_common_reports");
  assert.match(r.body.userMessage, /没跑过测试的渠道/);
});

test("multi：不落报告文件（纯前端展示，不往报告中心塞东西）", async () => {
  const before = await fetch(`http://127.0.0.1:${PORT}/api/reports/files`, { headers: { cookie } });
  const beforeCount = (await before.json()).files?.length ?? null;
  const r = await post("/api/reports/compare/multi", cookie, { base: BASE, peers: [PEER_UNDERSCORE] });
  assert.equal(r.status, 200);
  assert.equal(r.body.reportId, undefined, "响应里不该有 reportId——多模型对比不产报告");
  const after = await fetch(`http://127.0.0.1:${PORT}/api/reports/files`, { headers: { cookie } });
  const afterCount = (await after.json()).files?.length ?? null;
  assert.equal(afterCount, beforeCount, "报告文件数不该变化");
});

test("multi：与基准同名场景重测后不重复列出（沿用现有去重口径）", async () => {
  // 追加一份更新的场景报告（同名场景甲，质量分不同）：应替换而非叠加成两行。
  const extra = join(REPORTS_DIR, `${slug(PEER_UNDERSCORE)}_scenario_20260705.md`);
  await writeFile(extra, scenarioReportMd([["场景甲", "100% (3/3)", "8.0"]]), "utf8");
  try {
    const r = await post("/api/reports/compare/multi", cookie, { base: BASE, peers: [PEER_UNDERSCORE] });
    assert.equal(r.status, 200, `期望 200，实为 ${r.status}：${JSON.stringify(r.body)}`);
    const names = r.body.comparison.scenarios.map((row) => row.name);
    assert.equal(new Set(names).size, names.length, "同名场景不得出现多行");
    assert.ok(names.includes("场景甲"));
  } finally {
    await rm(extra, { force: true });
  }
});
