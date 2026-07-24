// tests/report-compare.test.mjs
// 模型对比内核（server/report-compare.mjs）的纯函数测试：用 tests/fixtures/report-compare/ 下
// 的真实报告样例作夹具（随仓库入库，自包含、不依赖外部目录），
// 验证三种报告的解析、对象聚合、两对象对比与 Markdown 产出。离线、无网络/无 AI。
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  parseReportBaseName,
  detectReportType,
  parseRunReport,
  parseScenarioReport,
  parseAdmissionReport,
  aggregateSubject,
  balanceCommonReports,
  buildComparison,
  commonScenarioNames,
  exclusiveScenarioNames,
  formatCompareReportMarkdown,
  pickRecentReports,
  buildCompareAnalysisPrompt,
} from "../server/report-compare.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const EVAL = join(root, "tests", "fixtures", "report-compare");
const DIR_A = join(EVAL, "A"); // test / claude-opus-4-8：9 场景 + 1 稳定性(8/10) + 1 准入
const DIR_B = join(EVAL, "B"); // Claude-1.3x / claude-opus-4-8：9 场景 + 1 稳定性(10/10) + 1 准入

async function readFolder(dir) {
  const names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith(".md"));
  return Promise.all(names.map(async (name) => ({ name, md: await readFile(join(dir, name), "utf8") })));
}
const read = (dir, name) => readFile(join(dir, name), "utf8");

test("parseReportBaseName / detectReportType 从文件名切出渠道/模型/种类", () => {
  const p = parseReportBaseName("Claude-1.3x_claude-opus-4-8_run_20260707_141205_04b7.md");
  assert.equal(p.channel, "Claude-1.3x");
  assert.equal(p.model, "claude-opus-4-8");
  assert.equal(p.type, "run");
  assert.equal(p.date, "20260707");
  assert.equal(detectReportType("x_y_scenario_20260707_101803_78bf.md", ""), "scenario");
  assert.equal(detectReportType("noname.md", "# 稳定性测试报告\n"), "run");
});

test("parseRunReport 抽取稳定性关键指标", async () => {
  const md = await read(DIR_B, "Claude-1.3x_claude-opus-4-8_run_20260707_141205_04b7.md");
  const r = parseRunReport(md);
  assert.equal(r.succ, 10);
  assert.equal(r.total, 10);
  assert.equal(r.p95TotalMs, 16965);
  assert.equal(r.p50TotalMs, 6574);
  assert.equal(r.inputTokens, 67453);
  assert.equal(r.outputTokens, 771);
  assert.equal(r.rounds, 10);
  assert.equal(r.concurrency, 1);
});

test("parseScenarioReport 抽取逐场景成功率/质量分（含 - → null）", async () => {
  const pass = parseScenarioReport(await read(DIR_B, "Claude-1.3x_claude-opus-4-8_scenario_20260707_140900_4acf.md"));
  assert.equal(pass.scenarios.length, 1);
  assert.equal(pass.scenarios[0].quality, 94);
  assert.equal(pass.scenarios[0].rate, 1);
  assert.equal(pass.scenarios[0].succ, 1);

  const fail = parseScenarioReport(await read(DIR_A, "test_claude-opus-4-8_scenario_20260707_101803_78bf.md"));
  assert.equal(fail.scenarios[0].quality, 0);
  assert.equal(fail.scenarios[0].rate, 0);
  assert.equal(fail.scenarios[0].succ, 0);
  assert.equal(fail.scenarios[0].avgMs, null); // 源里是 "-"
});

test("parseAdmissionReport 抽取等级/纯度/分词器指纹", async () => {
  const a = parseAdmissionReport(await read(DIR_B, "Claude-1.3x_claude-opus-4-8_admission_20260707_141705_1d79.md"));
  assert.equal(a.grade, "A");
  assert.equal(a.composite, 100);
  assert.equal(a.succ, 5);
  assert.equal(a.total, 5);
  assert.equal(a.purityScore, 92);
  assert.equal(a.tokenizerSlope, 6.3461);
  assert.equal(a.tokenizerR2, 0.4874);
});

test("aggregateSubject 按场景名归组并池化", async () => {
  const a = aggregateSubject({ files: await readFolder(DIR_A) });
  assert.equal(a.label, "test / claude-opus-4-8");
  assert.equal(a.reportCounts.scenario, 8);
  assert.equal(a.reportCounts.run, 1);
  assert.equal(a.reportCounts.admission, 1);
  // 稳定性来自那份 run 报告（8/10）。
  assert.equal(a.stability.succ, 8);
  assert.equal(a.stability.total, 10);
  // 8 份场景报告、8 个不同场景；通过率按每份 1 次池化 → total=8。
  assert.equal(a.scenarios.length, 8);
  assert.equal(a.scenarioPass.total, 8);
  assert.equal(a.admission.grade, "A");
});

test("buildComparison：小样本→差异不显著；配对场景匹配", async () => {
  const a = aggregateSubject({ files: await readFolder(DIR_A) });
  const b = aggregateSubject({ files: await readFolder(DIR_B) });
  const cmp = buildComparison(a, b);
  // 8/10 vs 10/10，Wilson CI 重叠 → 不显著。
  assert.equal(cmp.verdicts.stability.significant, false);
  assert.equal(cmp.verdicts.stability.verdict, "差异不显著");
  // 两文件夹场景名一致 → 8 个配对，无独有。
  assert.equal(cmp.scenarioQuality.matched.length, 8);
  assert.equal(cmp.scenarioQuality.onlyA.length, 0);
  assert.equal(cmp.scenarioQuality.onlyB.length, 0);
});

test("formatCompareReportMarkdown 含各对比小节", async () => {
  const a = aggregateSubject({ files: await readFolder(DIR_A) });
  const b = aggregateSubject({ files: await readFolder(DIR_B) });
  const md = formatCompareReportMarkdown(buildComparison(a, b), { generatedAt: "2026-07-07T00:00:00.000Z" });
  // 新顺序：结论速览 → 可用性 → 延迟 → 准入身份 → 档位 → 逐场景 → 总结。
  for (const heading of [
    "# 模型对比报告",
    "## 结论速览",
    "## 1. 可用性与通过率",
    "## 2. 延迟",
    "## 3. 准入分项与身份纯度",
    "## 4. 按难度档位拆解",
    "## 5. 逐场景诊断",
    "## 6. 总结",
  ]) {
    assert.ok(md.includes(heading), `缺少小节：${heading}`);
  }
  // 小节按新顺序排列（延迟在档位之前、准入在档位之前）。
  const order = [
    "## 1. 可用性与通过率",
    "## 2. 延迟",
    "## 3. 准入分项与身份纯度",
    "## 4. 按难度档位拆解",
    "## 5. 逐场景诊断",
    "## 6. 总结",
  ];
  const positions = order.map((h) => md.indexOf(h));
  for (let i = 1; i < positions.length; i++)
    assert.ok(positions[i] > positions[i - 1], `小节顺序错误：${order[i]} 应在 ${order[i - 1]} 之后`);
  // 已删除/精简：不再出现「计费与 Token 诚实度」小节、口语「挂羊头」、token 虚报话题。
  assert.ok(!md.includes("计费与 Token 诚实度"), "「计费与 Token 诚实度」小节应已删除");
  assert.ok(!md.includes("挂羊头"), "不应再出现口语「挂羊头」");
  assert.ok(!/token\s*虚报/i.test(md), "不应再出现 token 虚报话题");
  assert.ok(md.includes("test / claude-opus-4-8"));
  assert.ok(md.includes("Claude-1.3x / claude-opus-4-8"));
  // 深度内容：档位、失败原因、横向指纹应出现。
  assert.ok(md.includes("HardcoreLogic"), "缺少难度档位拆解");
  assert.ok(md.includes("HLE 化学") || md.includes("rate_limited"), "缺少逐场景失败原因");
  // 统计学深度：配对差值/CI、Cliff's δ、McNemar、bootstrap。
  assert.ok(/95% CI/.test(md), "缺少置信区间");
  assert.ok(/Cliff's δ/.test(md), "缺少效果量");
  assert.ok(/McNemar/.test(md), "缺少配对通过率检验");
  assert.ok(/bootstrap/i.test(md), "缺少延迟 bootstrap CI");
  // 结论速览新版式：一句「总评」headline + 「维度|结论|对象A|对象B」四列表格，结论列带信号图标。
  assert.ok(md.includes("**总评：**"), "结论速览应有一句话总评 headline");
  assert.ok(md.includes("| 维度 | 结论 | 对象A | 对象B |"), "结论速览应为四列（对象A/对象B 分列）表格");
  assert.ok(!md.includes("| 维度 | 结论 | 关键指标 |"), "旧「关键指标」单列已拆分");
  const overview = md.slice(md.indexOf("## 结论速览"), md.indexOf("## 1. 可用性与通过率"));
  assert.ok(/[✅≈⚠️❓ℹ️]/u.test(overview), "结论列应带信号图标（✅/≈/⚠️/❓/ℹ️）");
  assert.ok(overview.includes("稳定性成功率") && overview.includes("场景通过率"), "可用性两行始终产出");
});

test("报告正文：用「对象A/对象B」、去统计术语（仅留末节）、第3/6节无 ⚠️、支持自定义显示名", async () => {
  const a = aggregateSubject({ files: await readFolder(DIR_A), label: "甲渠道" });
  const b = aggregateSubject({ files: await readFolder(DIR_B), label: "乙渠道" });
  const md = formatCompareReportMarkdown(buildComparison(a, b), { generatedAt: "2026-07-07T00:00:00.000Z", balancedToCommon: true });

  // ① 自定义显示名：报告头与结论速览总评都用传入的 label。
  assert.ok(md.includes("对象 A：**甲渠道**") && md.includes("对象 B：**乙渠道**"), "报告头用自定义显示名");

  // ⑤ 正文用「对象A/对象B」而非裸字母作简称（表头与行内）。
  assert.ok(md.includes("| 指标 | 对象A | 对象B | 判定 |"), "第1节表头用 对象A/对象B");
  assert.ok(!md.includes("| 指标 | A | B | 判定 |"), "第1节不再用裸 A/B 表头");
  assert.ok(md.includes("对象A−对象B"), "差值列写作 对象A−对象B");
  assert.ok(!/\| A 通过率 \|/.test(md) && !/\| A 质量 \|/.test(md), "档位/逐场景表头不再用裸 A");

  // ②「方法学与免责」末节 = 报告末说明；统计方法专有名词只能出现在正文之后（末节）里。
  const footerIdx = md.indexOf("## 方法学与免责");
  assert.ok(footerIdx > 0, "应有方法学与免责末节");
  const body = md.slice(0, footerIdx);
  for (const term of ["Wilson", "McNemar", "bootstrap", "Cliff's", "Wilcoxon", "Miller 2024"]) {
    assert.ok(!body.includes(term), `正文不应出现统计术语「${term}」（应移到末节）`);
  }
  const footer = md.slice(footerIdx);
  for (const term of ["McNemar", "Cliff's δ", "bootstrap", "Wilson"]) {
    assert.ok(footer.includes(term), `末节应保留术语解释「${term}」`);
  }

  // ④ 第3、6节不含 ⚠️（结论速览的 ⚠️ 不受影响）。
  const sec3 = md.slice(md.indexOf("## 3."), md.indexOf("## 4."));
  const sec6 = md.slice(md.indexOf("## 6. 总结"), footerIdx > md.indexOf("## 6. 总结") ? footerIdx : md.length);
  assert.ok(!sec3.includes("⚠️"), "第3节不应含 ⚠️");
  assert.ok(!sec6.includes("⚠️"), "第6节不应含 ⚠️");
  assert.ok(!sec3.includes("横向指纹对照"), "第3节已删除「横向指纹对照」行");
});

test("配对统计：质量分配对差 CI 含 0→不显著；Cliff's δ；胜平负；错误型失败可区分", async () => {
  const a = aggregateSubject({ files: await readFolder(DIR_A) });
  const b = aggregateSubject({ files: await readFolder(DIR_B) });
  const cmp = buildComparison(a, b);
  const pq = cmp.pairedQuality;
  assert.equal(pq.n, 8); // 8 个配对场景
  assert.ok(pq.ci && pq.ci[0] < 0 && pq.ci[1] > 0, "配对差 95% CI 应含 0（不显著）");
  assert.equal(pq.win + pq.tie + pq.loss, 8);
  assert.ok(pq.cliff.delta != null && Math.abs(pq.cliff.delta) < 0.15, "效果量应可忽略");
  // 错误型失败可识别：A 的 HLE 化学是 timeout。
  const chem = a.scenarios.find((s) => s.name.includes("HLE 化学"));
  assert.equal(chem.errored, true);
  // 延迟 bootstrap：成功轮次样本存在。
  assert.ok(cmp.latency.aN >= 3 && cmp.latency.bN >= 3);
  assert.ok(cmp.latency.median.point != null);
});

test("enriched 解析：错误分布 / 基线回归 / token 虚报 / 横向指纹 / 准入分项", async () => {
  const runA = parseRunReport(await read(DIR_A, "test_claude-opus-4-8_run_20260707_114113_a959.md"));
  assert.deepEqual(runA.errorCounts, { rate_limited: 2 });
  assert.equal(runA.baselineRegressed, true);
  assert.ok(runA.tokenInflation > 60); // ×69.205

  const admA = parseAdmissionReport(await read(DIR_A, "test_claude-opus-4-8_admission_20260707_100037_33d5.md"));
  assert.equal(admA.crossChannelMismatch, true); // 疑似挂羊头卖狗肉
  assert.equal(admA.selfFamily, "unknown");
  assert.equal(admA.items["工具调用结构"], "通过");
  assert.ok(admA.upstreamMultiplier > 1); // 23 / 5

  const a = aggregateSubject({ files: await readFolder(DIR_A) });
  assert.ok(a.tiers.some((t) => t.tier.startsWith("HardcoreLogic")));
  assert.equal(a.integrity.baselineRegressed, true);
});

test("pickRecentReports：取最新 run/admission，场景按名保留最新一份", async () => {
  const files = await readFolder(DIR_A); // 10 份：8 场景 + 1 run + 1 admission
  // 造 mtime：文件名里的日期时间 token 越大越新（用下标兜底）。
  const withMtime = files.map((f, i) => ({ ...f, mtimeMs: i + 1 }));
  const picked = pickRecentReports(withMtime);
  const types = picked.map((p) => detectReportType(p.name, p.md));
  assert.equal(types.filter((t) => t === "run").length, 1, "只保留 1 份 run");
  assert.equal(types.filter((t) => t === "admission").length, 1, "只保留 1 份 admission");
  // 场景按名去重后每个场景名唯一（A 有 8 份场景报告、8 个不同场景）。
  const scenPicked = picked.filter((p) => detectReportType(p.name, p.md) === "scenario");
  const names = scenPicked.map((p) => parseScenarioReport(p.md).scenarios[0]?.name);
  assert.equal(new Set(names).size, names.length, "场景名唯一（已去重）");
  assert.equal(new Set(names).size, 8);
});

test("balanceCommonReports：两方只留共有报告——同名场景取交集；run/准入需双方都有", () => {
  const runMd = "# 稳定性测试报告\n";
  const admMd = "# 准入评测报告\n";
  const scenMd = (n) => `# 场景测试报告\n\n## 场景明细\n\n| 场景 | 成功率 | 平均质量分 |\n|---|---|---|\n| ${n} | 100%(3/3) | 80 |\n`;
  // A：run + 准入 + 场景{逻辑,数学,编程}；B：run（无准入）+ 场景{逻辑,数学,翻译}。
  const A = [
    { name: "A-run", md: runMd },
    { name: "A-adm", md: admMd },
    { name: "A-s1", md: scenMd("逻辑谜题") },
    { name: "A-s2", md: scenMd("数学题") },
    { name: "A-s3", md: scenMd("编程题") },
  ];
  const B = [
    { name: "B-run", md: runMd },
    { name: "B-s1", md: scenMd("逻辑谜题") },
    { name: "B-s2", md: scenMd("数学题") },
    { name: "B-s3", md: scenMd("翻译题") },
  ];
  const [balA, balB] = balanceCommonReports(A, B);
  const names = (arr) =>
    arr
      .filter((f) => detectReportType(f.name, f.md) === "scenario")
      .map((f) => parseScenarioReport(f.md).scenarios[0]?.name)
      .sort();
  assert.equal(balA.length, balB.length, "两方报告数量相同");
  assert.equal(balA.length, 3, "run + 逻辑 + 数学 = 3（准入被丢，B 无准入）");
  assert.equal(balA.filter((f) => detectReportType(f.name, f.md) === "admission").length, 0, "准入单方独有 → 两方都不用");
  assert.equal(balA.filter((f) => detectReportType(f.name, f.md) === "run").length, 1, "run 双方都有 → 保留");
  assert.deepEqual(names(balA), ["数学题", "逻辑谜题"], "A 只留共有场景");
  assert.deepEqual(names(balB), ["数学题", "逻辑谜题"], "B 只留共有场景");

  // 无任何共有 → 两方都空（端点据此回 no_common_reports）。
  const [eA, eB] = balanceCommonReports(
    [
      { name: "A-adm", md: admMd },
      { name: "A-s3", md: scenMd("编程题") },
    ],
    [
      { name: "B-run", md: runMd },
      { name: "B-s3", md: scenMd("翻译题") },
    ],
  );
  assert.equal(eA.length, 0);
  assert.equal(eB.length, 0);
});

test("场景通过率只用共有场景：单方独有的场景不计入通过率与其判定", () => {
  // 每份场景报告一个场景（一行）；重复 3 次 → 每场景 total=3、succ=round(rate*3)。
  const scenMd = (name, pctVal) =>
    `# 场景测试报告\n\n## 专业分析摘要\n\n每个场景重复次数：3\n\n## 场景明细\n\n| 场景 | 成功率 | 平均质量分 |\n|---|---|---|\n| ${name} | ${pctVal}% | 80 |\n`;
  // A：逻辑 3/3、数学 3/3（共有）、编程 0/3（独有，全败）→ 全量 6/9；共有 6/6=100%。
  const A = aggregateSubject({
    label: "A",
    files: [
      { name: "A-s1", md: scenMd("逻辑谜题", 100) },
      { name: "A-s2", md: scenMd("数学题", 100) },
      { name: "A-s3", md: scenMd("编程题", 0) },
    ],
  });
  // B：逻辑 3/3、数学 2/3（共有）、翻译 3/3（独有）→ 全量 8/9；共有 5/6。
  const B = aggregateSubject({
    label: "B",
    files: [
      { name: "B-s1", md: scenMd("逻辑谜题", 100) },
      { name: "B-s2", md: scenMd("数学题", 67) },
      { name: "B-s3", md: scenMd("翻译题", 100) },
    ],
  });
  // 聚合层仍是各自全量（编程/翻译在内）。
  assert.equal(A.scenarioPass.total, 9, "聚合层 A 全量 9");
  assert.equal(B.scenarioPass.total, 9, "聚合层 B 全量 9");
  const cmp = buildComparison(A, B);
  // 对比后：场景通过率只用共有的 逻辑 + 数学（各 3 次）→ 分母 6，独有场景被剔除。
  assert.equal(cmp.a.scenarioPass.total, 6, "A 通过率分母只含共有场景");
  assert.equal(cmp.a.scenarioPass.succ, 6, "A 共有场景全过 6/6");
  assert.equal(cmp.b.scenarioPass.total, 6, "B 通过率分母只含共有场景");
  assert.equal(cmp.b.scenarioPass.succ, 5, "B 共有场景 5/6（数学 2/3）");
  // 报告展示（passCell）与判定同口径：显示 6/6 与 5/6，而非 9 分母。
  const md = formatCompareReportMarkdown(cmp, { generatedAt: "2026-07-09T00:00:00Z" });
  assert.match(md, /场景通过率 \| 100\.0%（6\/6）/, "A 展示共有口径 6/6");
  assert.match(md, /（5\/6）/, "B 展示共有口径 5/6");
  assert.ok(!md.includes("（6/9）") && !md.includes("（8/9）"), "不出现全量口径");
});

test("commonScenarioNames：取两方共有场景（多场景/份也精确，口径 == 报告 matched）", () => {
  // 关键回归：一份场景报告可含【多个】场景行。曾经按 scenarios[0] 每份只计一名 → 界面少数（10）、
  // 报告按全部行取交集多数（19）。commonScenarioNames 现按聚合后的场景行取交集，二者一致。
  const runMd = "# 稳定性测试报告\n";
  const scenMd = (...rows) =>
    `# 场景测试报告\n\n## 场景明细\n\n| 场景 | 成功率 | 平均质量分 |\n|---|---|---|\n` +
    rows.map((n) => `| ${n} | 100% | 80 |`).join("\n") +
    "\n";
  // A：一份报告含 逻辑谜题+数学题，另一份含 编程题；B：一份含 逻辑谜题+数学题+翻译题。
  const filesA = [
    { name: "a-run", md: runMd },
    { name: "a-s12", md: scenMd("逻辑谜题", "数学题") },
    { name: "a-s3", md: scenMd("编程题") },
  ];
  const filesB = [
    { name: "b-run", md: runMd },
    { name: "b-s123", md: scenMd("逻辑谜题", "数学题", "翻译题") },
  ];
  const common = commonScenarioNames(filesA, filesB)
    .map((s) => s.name)
    .sort();
  assert.deepEqual(common, ["数学题", "逻辑谜题"], "共有 = 两方场景行交集（编程题/翻译题各为单方独有）");
  // 与报告口径一致：buildComparison 的 matched 名集应与 commonScenarioNames 完全相同。
  const cmp = buildComparison(aggregateSubject({ files: filesA }), aggregateSubject({ files: filesB }));
  assert.deepEqual(cmp.scenarioQuality.matched.map((m) => m.name).sort(), common, "报告 matched 与界面共有场景同口径");
});

test("exclusiveScenarioNames：取两方单方独有场景（供「补齐单方场景」用），口径与 commonScenarioNames 互补", () => {
  const runMd = "# 稳定性测试报告\n";
  const scenMd = (...rows) =>
    `# 场景测试报告\n\n## 场景明细\n\n| 场景 | 成功率 | 平均质量分 |\n|---|---|---|\n` +
    rows.map((n) => `| ${n} | 100% | 80 |`).join("\n") +
    "\n";
  // A：逻辑谜题+数学题（共有）、编程题（A 独有）；B：逻辑谜题+数学题（共有）、翻译题（B 独有）。
  const filesA = [
    { name: "a-run", md: runMd },
    { name: "a-s12", md: scenMd("逻辑谜题", "数学题") },
    { name: "a-s3", md: scenMd("编程题") },
  ];
  const filesB = [
    { name: "b-run", md: runMd },
    { name: "b-s123", md: scenMd("逻辑谜题", "数学题", "翻译题") },
  ];
  const { onlyA, onlyB } = exclusiveScenarioNames(filesA, filesB);
  assert.deepEqual(onlyA.map((s) => s.name), ["编程题"], "onlyA = A 测过但 B 没测过");
  assert.deepEqual(onlyB.map((s) => s.name), ["翻译题"], "onlyB = B 测过但 A 没测过");
  // 互补校验：共有 + 单方独有(各自) 应覆盖两方场景全集，且共有/独有不重叠。
  const common = new Set(commonScenarioNames(filesA, filesB).map((s) => s.name));
  assert.ok(!common.has("编程题") && !common.has("翻译题"), "独有场景不应出现在共有集合里");
});

test("exclusiveScenarioNames：两方场景完全相同 → 双方 onlyA/onlyB 均为空", () => {
  const scenMd = `# 场景测试报告\n\n## 场景明细\n\n| 场景 | 成功率 | 平均质量分 |\n|---|---|---|\n| 逻辑谜题 | 100% | 80 |\n`;
  const files = [{ name: "s1", md: scenMd }];
  const { onlyA, onlyB } = exclusiveScenarioNames(files, files);
  assert.deepEqual(onlyA, []);
  assert.deepEqual(onlyB, []);
});

test("aggregateSubject(scenarioFilter)：行级筛选，多场景/份也能只算被选场景", () => {
  const scenMd =
    `# 场景测试报告\n\n## 专业分析摘要\n\n每个场景重复次数：2\n\n## 场景明细\n\n| 场景 | 成功率 | 平均质量分 |\n|---|---|---|\n` +
    `| 逻辑谜题 | 100% | 80 |\n| 数学题 | 50% | 60 |\n| 翻译题 | 0% | 40 |\n`;
  const files = [{ name: "s", md: scenMd }];
  const all = aggregateSubject({ files });
  assert.equal(all.scenarios.length, 3, "不过滤：三个场景全在");
  const filtered = aggregateSubject({ files, scenarioFilter: new Set(["逻辑谜题", "数学题"]) });
  assert.deepEqual(filtered.scenarios.map((s) => s.name).sort(), ["数学题", "逻辑谜题"], "只保留被选场景行");
  // 通过率随之只算被选：逻辑谜题 2/2 + 数学题 1/2 = 3/4（翻译题 0/2 被排除）。
  assert.equal(filtered.scenarioPass.succ, 3);
  assert.equal(filtered.scenarioPass.total, 4);
});

test("formatCompareReportMarkdown(balancedToCommon)：附「仅采用共有报告」的说明", async () => {
  const a = aggregateSubject({ files: await readFolder(DIR_A) });
  const b = aggregateSubject({ files: await readFolder(DIR_B) });
  const cmp = buildComparison(a, b);
  assert.match(formatCompareReportMarkdown(cmp, { balancedToCommon: true }), /仅采用\*\*共有\*\*的报告|仅采用共有的报告|共有\*\*的报告/);
  assert.ok(!formatCompareReportMarkdown(cmp, {}).includes("仅采用"), "未开启时不加说明");
});

test("buildCompareAnalysisPrompt + formatCompareReportMarkdown(aiNarrative)", async () => {
  const a = aggregateSubject({ files: await readFolder(DIR_A) });
  const b = aggregateSubject({ files: await readFolder(DIR_B) });
  const cmp = buildComparison(a, b);
  const prompt = buildCompareAnalysisPrompt(cmp);
  assert.ok(prompt.includes("对比数据") && prompt.includes("难度档位"), "提示词含对比数据");
  // 启用 AI 时：AI 叙述直接作为「结论速览」内容，替换掉机械速览（无「总评」与维度表）；不再单列「AI 叙述分析」节。
  const md = formatCompareReportMarkdown(cmp, { generatedAt: "2026-07-07T00:00:00.000Z", aiNarrative: "这是一段测试用 AI 叙述。" });
  const overview = md.slice(md.indexOf("## 结论速览"), md.indexOf("## 1."));
  assert.ok(overview.includes("这是一段测试用 AI 叙述。"), "AI 叙述作为结论速览内容");
  assert.ok(!overview.includes("| 维度 | 结论 |") && !overview.includes("**总评：**"), "启用 AI 时不出机械速览表");
  assert.ok(!md.includes("## AI 叙述分析"), "AI 叙述不再单列小节");
  // 未启用 AI 时：结论速览回到机械速览（总评 + 维度表），且不含 AI 文本。
  const md2 = formatCompareReportMarkdown(cmp, { generatedAt: "2026-07-07T00:00:00.000Z" });
  const overview2 = md2.slice(md2.indexOf("## 结论速览"), md2.indexOf("## 1."));
  assert.ok(overview2.includes("**总评：**") && overview2.includes("| 维度 | 结论 |"), "未启用 AI 时用机械速览");
  assert.ok(!md2.includes("这是一段测试用 AI 叙述。"));
});
