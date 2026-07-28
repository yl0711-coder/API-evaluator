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
  parseLoadReport,
  aggregateSubject,
  balanceCommonReports,
  buildComparison,
  commonScenarioNames,
  exclusiveScenarioNames,
  formatCompareReportMarkdown,
  pickRecentReports,
  buildCompareAnalysisPrompt,
  interpolateLoadPoint,
  simpleKnee,
  computeOverallScore,
} from "../server/report-compare.mjs";
import { aggregate, formatSinglePointReport, formatSweepReport, findKnee } from "../server/load-test.mjs";

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
  // 新顺序：结论速览 → 可用性 → 延迟 → 准入身份 → 档位 → 逐场景 → 压测 → 总结。
  for (const heading of [
    "# 模型对比报告",
    "## 结论速览",
    "## 1. 可用性与通过率",
    "## 2. 延迟",
    "## 3. 准入分项与身份纯度",
    "## 4. 按难度档位拆解",
    "## 5. 逐场景诊断",
    "## 6. 压力测试对比",
    "## 7. 总结",
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
    "## 6. 压力测试对比",
    "## 7. 总结",
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

test("报告正文：用「对象A/对象B」、去统计术语（仅留末节）、第3/7节无 ⚠️、支持自定义显示名", async () => {
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

  // ④ 第3、7节不含 ⚠️（结论速览的 ⚠️ 不受影响）。
  const sec3 = md.slice(md.indexOf("## 3."), md.indexOf("## 4."));
  const sec7 = md.slice(md.indexOf("## 7. 总结"), footerIdx > md.indexOf("## 7. 总结") ? footerIdx : md.length);
  assert.ok(!sec3.includes("⚠️"), "第3节不应含 ⚠️");
  assert.ok(!sec7.includes("⚠️"), "第7节不应含 ⚠️");
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

test("pickRecentReports 回归：两份多场景报告共享【首条】场景名时，旧文件里的其余场景不得被整份连坐丢弃", () => {
  // 复现的真实缺陷：旧写法用 scenarios[0] 当整份文件的去重身份，两份多场景报告只要首条场景名相同，
  // 较旧那份里除首条外的场景就被整份丢弃、从此在共有/差集里彻底消失。
  const scenMd = (...names) =>
    `# 场景测试报告\n\n## 场景明细\n\n| 场景 | 成功率 | 平均质量分 |\n|---|---|---|\n` +
    names.map((n) => `| ${n} | 100% | 80 |`).join("\n") +
    "\n";
  // 旧文件（较旧）：批量测了 首场景 + 场景B + 场景C；新文件（较新）：批量测了 首场景 + 场景D。
  const files = [
    { name: "batch_old", md: scenMd("连通性：基础响应", "场景B", "场景C"), mtimeMs: 1 },
    { name: "batch_new", md: scenMd("连通性：基础响应", "场景D"), mtimeMs: 2 },
  ];
  const picked = pickRecentReports(files);
  // 两份都应保留（旧文件仍带来 场景B/场景C 这两个新名字）。
  assert.equal(picked.length, 2, "旧文件因含独有场景 B/C 必须保留，不能被首条场景名连坐");
  // 聚合后 5 个场景名一个不少。
  const agg = aggregateSubject({ files: picked });
  const got = agg.scenarios.map((s) => s.name).sort();
  assert.deepEqual(got, ["场景B", "场景C", "场景D", "连通性：基础响应"].sort(), "五条场景行去重后应得 4 个场景名，无一丢失");
});

test("commonScenarioNames/exclusiveScenarioNames 回归：多场景报告共享首条场景名时，共有与差集计数不得偏低", () => {
  const scenMd = (...names) =>
    `# 场景测试报告\n\n## 场景明细\n\n| 场景 | 成功率 | 平均质量分 |\n|---|---|---|\n` +
    names.map((n) => `| ${n} | 100% | 80 |`).join("\n") +
    "\n";
  // A：两份报告都以「首场景」开头 —— 若按首条去重，A 的 数学题/编程题 会被连坐丢弃。
  const filesA = [
    { name: "a_batch1", md: scenMd("首场景", "数学题"), mtimeMs: 1 },
    { name: "a_batch2", md: scenMd("首场景", "编程题"), mtimeMs: 2 },
  ];
  // B：也测了 首场景 + 数学题 + 编程题（与 A 共有全部三个）。
  const filesB = [{ name: "b_batch", md: scenMd("首场景", "数学题", "编程题"), mtimeMs: 1 }];
  const common = commonScenarioNames(filesA, filesB)
    .map((s) => s.name)
    .sort();
  assert.deepEqual(common, ["数学题", "编程题", "首场景"].sort(), "共有场景应含全部三个，不因首条去重而偏少");
  const { onlyA, onlyB } = exclusiveScenarioNames(filesA, filesB);
  assert.deepEqual(onlyA, [], "A 没有 B 未测的场景");
  assert.deepEqual(onlyB, [], "B 没有 A 未测的场景");
});

test("行级授权回归：旧文件因独有场景被保留时，其与新文件重名的场景行不得混入聚合稀释最新结果", () => {
  // 场景：用户先批量测了 [X, B]（X 质量分 20，当时渠道有问题），修好后重测了 [X]（质量分 90）。
  // 贪心覆盖会保留旧文件（它带来独有场景 B），但旧文件里 X=20 的陈旧行绝不能与新文件 X=90 池化
  // ——否则 X 均分变 55，用户"重测覆盖旧结果"的意图被静默打折。X 必须只由含它的最新文件供数。
  const scenMd = (rows) =>
    `# 场景测试报告\n\n## 场景明细\n\n| 场景 | 成功率 | 平均质量分 |\n|---|---|---|\n` +
    rows.map(([n, q]) => `| ${n} | 100% | ${q} |`).join("\n") +
    "\n";
  const files = [
    {
      name: "old_batch",
      md: scenMd([
        ["场景X", 20],
        ["场景B", 70],
      ]),
      mtimeMs: 1,
    },
    { name: "new_single", md: scenMd([["场景X", 90]]), mtimeMs: 2 },
  ];
  const picked = pickRecentReports(files);
  assert.equal(picked.length, 2, "旧文件因独有场景 B 保留");
  // 行级授权：旧文件只被授权供数 场景B；新文件供数 场景X。
  const oldPicked = picked.find((f) => f.name === "old_batch");
  assert.deepEqual(oldPicked.scenarioAllow, ["场景B"], "旧文件的授权应只含其独家贡献的场景");
  const agg = aggregateSubject({ files: picked });
  const x = agg.scenarios.find((s) => s.name === "场景X");
  assert.equal(x.quality, 90, "场景X 质量分必须来自最新文件（90），不得与旧文件的 20 池化成 55");
  assert.equal(x.runs, 1, "场景X 只由 1 份文件供数");
  const b = agg.scenarios.find((s) => s.name === "场景B");
  assert.equal(b.quality, 70, "场景B 正常由旧文件供数");
  // 授权要能穿过 balanceCommonReports 存活（否则白标）：对侧也测过 X 和 B 时，X 仍只取最新值。
  const filesOther = [
    {
      name: "other",
      md: scenMd([
        ["场景X", 50],
        ["场景B", 50],
      ]),
      mtimeMs: 1,
    },
  ];
  const [balA] = balanceCommonReports(picked, pickRecentReports(filesOther));
  const aggBal = aggregateSubject({ files: balA });
  assert.equal(aggBal.scenarios.find((s) => s.name === "场景X").quality, 90, "经 balance 后授权仍生效，X 不被陈旧行稀释");
});

test("行级授权口径回归：挂 DB summary 后行名来自库（可能含换行/首尾空白），规范化匹配不得误丢；无人认领的名字放行", () => {
  // 背景：授权名来自 md 表格解析（写入时换行渲染成空格、单元格被 trim），而挂了 DB summary 的文件
  // 行名走库里的原始 scenarioName——名字含换行时两边字面不同。规范化匹配前，这类行会被判"授权外"误丢。
  const scenMd = (rows) =>
    `# 场景测试报告\n\n## 专业分析摘要\n\n- 每个场景重复次数：1\n\n## 场景明细\n\n| 场景 | 成功率 | 平均质量分 |\n|---|---|---|\n` +
    rows.map(([n, q]) => `| ${n} | 100% | ${q} |`).join("\n") +
    "\n";
  const mkSummary = (rows) => ({
    repeats: 1,
    results: [
      {
        scenarios: rows.map(([name, q]) => ({
          scenarioName: name,
          successRate: 1,
          avgQualityScore: q,
          avgTotalMs: 1000,
          p95TotalMs: 1200,
          issues: [],
        })),
      },
    ],
  });
  // 新文件测了 场景X；旧文件测了 场景X + 「换行 场景」（DB 原始名带 \n，md 里渲染成空格）。
  const files = [
    {
      name: "old",
      md: scenMd([
        ["场景X", 20],
        ["换行 场景", 70],
      ]),
      mtimeMs: 1,
    },
    { name: "new", md: scenMd([["场景X", 90]]), mtimeMs: 2 },
  ];
  const picked = pickRecentReports(files);
  // 模拟 attachSummaries：给旧文件挂 DB summary，行名用【原始】带换行的名字。
  const oldPicked = picked.find((f) => f.name === "old");
  oldPicked.summary = mkSummary([
    ["场景X", 20],
    ["换行\n场景", 70],
  ]);
  const agg = aggregateSubject({ files: picked });
  const wrapped = agg.scenarios.find((s) => s.name.includes("换行"));
  assert.ok(wrapped, "DB 原始名含换行的场景不得因 md/DB 名字字面不同而被授权过滤误丢");
  assert.equal(wrapped.quality, 70);
  assert.equal(agg.scenarios.find((s) => s.name === "场景X").quality, 90, "陈旧的 场景X=20（DB 行）仍被正确排除");

  // 无人认领的名字放行（保底）：DB 行名与任何 md 授权名都对不上（如名字含 |，md 表格解析已碎）——
  // 此时没有任何更新文件在供数同名场景，丢掉它就是纯数据丢失，必须保留。
  const files2 = [{ name: "only", md: scenMd([["正常场景", 80]]), mtimeMs: 1 }];
  const picked2 = pickRecentReports(files2);
  picked2[0].summary = mkSummary([
    ["正常场景", 80],
    ["带|管道的场景", 60],
  ]);
  const agg2 = aggregateSubject({ files: picked2 });
  assert.ok(
    agg2.scenarios.some((s) => s.name === "带|管道的场景"),
    "DB 独有、无人认领的场景名应放行（fail-open），不得静默丢弃",
  );
});

test("buildComparison：同键重复负载点显式去重（保留首个），两侧同一规则、不静默吞行", () => {
  const mkAgg = (pts) => ({
    label: "x",
    scenarios: [],
    tiers: [],
    latency: { samples: [] },
    quality: { mean: null, n: 0 },
    loadPoints: pts,
  });
  // A 侧重复 closed/30（用户输入 "30,30" 时 runLoadTest 不去重）；B 侧也重复。
  const a = mkAgg([
    { mode: "closed", offered: 30, qps: 5, successRate: 1, p95: 500, p99: 600 },
    { mode: "closed", offered: 30, qps: 7, successRate: 1, p95: 550, p99: 650 },
  ]);
  const b = mkAgg([
    { mode: "closed", offered: 30, qps: 4, successRate: 1, p95: 700, p99: 800 },
    { mode: "closed", offered: 30, qps: 9, successRate: 1, p95: 750, p99: 850 },
  ]);
  const cmp = buildComparison(a, b);
  assert.equal(cmp.loadComparison.matched.length, 1, "重复键去重后只产出一行配对，不得出现重复行");
  assert.equal(cmp.loadComparison.matched[0].a.qps, 5, "A 侧保留首个（报告顺序）");
  assert.equal(cmp.loadComparison.matched[0].b.qps, 4, "B 侧同规则保留首个（旧实现 Map 会静默留最后一个）");
  assert.deepEqual(cmp.loadComparison.onlyA, []);
  assert.deepEqual(cmp.loadComparison.onlyB, []);
});

test("parseLoadReport 边界：offered 解析失败的单点报告 → 空点集（与扫描护栏同规则）；错误短语含冒号不少计", () => {
  // 单点报告缺「并发」行 → offered 无法解析 → 不产出 offered:null 的废点（那会与对侧的 null 互相"配对"）。
  const brokenMd = [
    "# 压力测试报告",
    "",
    "- 模式：闭环（固定并发） · 负载档 简单",
    "",
    "## 吞吐与成功率",
    "",
    "- 成功：2（100%）　吞吐 QPS：0.2 req/s",
    "",
  ].join("\n");
  const broken = parseLoadReport(brokenMd);
  assert.deepEqual(broken.points, [], "offered 解析失败 → 空点集");

  // 上游 statusText 可自带冒号（HTTP/1.1 原因短语上游可控）：计数取行尾的「：数字」，不得整行匹配失败少计。
  const colonMd = [
    "# 压力测试报告",
    "",
    "- 模式：闭环（固定并发） · 负载档 简单",
    "- 并发：10",
    "",
    "## 吞吐与成功率",
    "",
    "- 成功：1（25%）　吞吐 QPS：0.4 req/s",
    "",
    "## 延迟分布（仅成功请求）",
    "",
    "| p50 | p90 | p95 | p99 | max | avg |",
    "|---|---|---|---|---|---|",
    "| 0.10s | 0.10s | 0.10s | 0.10s | 0.10s | 0.10s |",
    "",
    "## 错误构成",
    "",
    "- 成功：1",
    "- HTTP 429 Too Many: Requests（上游限流）：3",
    "",
  ].join("\n");
  const parsed = parseLoadReport(colonMd);
  assert.equal(parsed.points[0].http429, 3, "原因短语含冒号时 429 计数仍应取行尾数字");
});

test("balanceCommonReports：两方只留共有报告——同名场景取交集；run/准入需双方都有；load 单方独有仍放行", () => {
  const runMd = "# 稳定性测试报告\n";
  const admMd = "# 准入评测报告\n";
  const loadMd = "# 压力测试报告\n\n- 模式：闭环（固定并发）\n\n## 吞吐与成功率\n\n- 成功：1（100%）　吞吐 QPS：1 req/s\n";
  const scenMd = (n) => `# 场景测试报告\n\n## 场景明细\n\n| 场景 | 成功率 | 平均质量分 |\n|---|---|---|\n| ${n} | 100%(3/3) | 80 |\n`;
  // A：run + 准入 + 压测 + 场景{逻辑,数学,编程}；B：run（无准入、无压测）+ 场景{逻辑,数学,翻译}。
  const A = [
    { name: "A-run", md: runMd },
    { name: "A-adm", md: admMd },
    { name: "A-load", md: loadMd },
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
  assert.equal(balA.length, 4, "run + 压测 + 逻辑 + 数学 = 4（准入被丢，B 无准入；压测单方独有仍放行）");
  assert.equal(balB.length, 3, "run + 逻辑 + 数学 = 3（B 没有压测报告，自然没有）");
  assert.equal(balA.filter((f) => detectReportType(f.name, f.md) === "admission").length, 0, "准入单方独有 → 两方都不用");
  assert.equal(balA.filter((f) => detectReportType(f.name, f.md) === "run").length, 1, "run 双方都有 → 保留");
  assert.equal(balA.filter((f) => detectReportType(f.name, f.md) === "load").length, 1, "压测单方独有 → 放行，不像 run/准入那样两边都不用");
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
  assert.deepEqual(
    onlyA.map((s) => s.name),
    ["编程题"],
    "onlyA = A 测过但 B 没测过",
  );
  assert.deepEqual(
    onlyB.map((s) => s.name),
    ["翻译题"],
    "onlyB = B 测过但 A 没测过",
  );
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

// —— 压力测试(load)报告：解析、聚合、配对对比 ——
// 用 load-test.mjs 的真实 aggregate()/formatSinglePointReport()/formatSweepReport() 产出 md，
// 而非手写字符串——这样测的是「parseLoadReport 能不能读懂 runner 实际产出的报告」，不是自证。
const loadMeta = (over = {}) => ({
  mode: "closed",
  model: "m1",
  profileName: "渠道 / m1",
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
  startedAt: "2026-07-20T00:00:00.000Z",
  endedAt: "2026-07-20T00:00:10.000Z",
  ...over,
});
const okSample = (ms) => ({ ms, ok: true, status: 200, err: "", warmup: false });
const failSample = (status, err) => ({ ms: null, ok: false, status, err, warmup: false });

test("parseLoadReport：单点报告往返（closed 模式），数字与 aggregate() 原始值一致", () => {
  const samples = [okSample(100), okSample(200), okSample(300), okSample(400), failSample(429, "rate_limited")];
  const point = aggregate({ samples, mode: "closed", offered: 30, durationSec: 10 });
  const md = formatSinglePointReport(loadMeta(), point);
  const parsed = parseLoadReport(md);

  assert.equal(parsed.type, "load");
  assert.equal(parsed.mode, "closed");
  assert.equal(parsed.points.length, 1);
  const p = parsed.points[0];
  assert.equal(p.offered, 30, "并发数往返一致");
  assert.equal(p.qps, point.qps);
  assert.equal(p.successRate, point.successRate);
  assert.equal(p.p50, point.latency.p50);
  assert.equal(p.p95, point.latency.p95);
  assert.equal(p.p99, point.latency.p99);
  assert.equal(p.http429, 1, "错误构成里的 429 计数往返一致");
});

test("parseLoadReport：单点报告往返（open 模式，速率单位），mode 正确识别为 open", () => {
  const samples = [okSample(50), okSample(60), okSample(70)];
  const point = aggregate({ samples, mode: "open", offered: 20, durationSec: 10 });
  const md = formatSinglePointReport(loadMeta({ mode: "open" }), point);
  const parsed = parseLoadReport(md);
  assert.equal(parsed.mode, "open");
  assert.equal(parsed.points[0].offered, 20);
  assert.equal(parsed.points[0].mode, "open");
});

test("parseLoadReport：扫描报告往返，逐负载点数字与 aggregate() 一致", () => {
  const points = [
    aggregate({ samples: [okSample(100), okSample(150), okSample(200)], mode: "closed", offered: 10, durationSec: 10 }),
    aggregate({ samples: [okSample(300), okSample(350), okSample(400)], mode: "closed", offered: 20, durationSec: 10 }),
    aggregate({ samples: [okSample(900), okSample(950), failSample(429, "rate_limited")], mode: "closed", offered: 40, durationSec: 10 }),
  ];
  const knee = findKnee(points);
  const md = formatSweepReport(loadMeta(), points, knee);
  const parsed = parseLoadReport(md);

  assert.equal(parsed.type, "load");
  assert.equal(parsed.points.length, 3);
  for (let i = 0; i < points.length; i++) {
    assert.equal(parsed.points[i].offered, points[i].offered, `第${i}点负载值往返一致`);
    assert.equal(parsed.points[i].qps, points[i].qps, `第${i}点 QPS 往返一致`);
    // 扫描表格的成功率列是整数百分比（load-test.mjs 的 pct() 四舍五入），往返有 <1% 的精度损失——
    // 这是报告格式本身的取舍，不是解析器的锅，故用容差比较而非严格相等。
    assert.ok(
      Math.abs(parsed.points[i].successRate - points[i].successRate) < 0.01,
      `第${i}点成功率往返一致（容差<1%）：解析出 ${parsed.points[i].successRate}，原始 ${points[i].successRate}`,
    );
    assert.equal(parsed.points[i].p95, points[i].latency.p95, `第${i}点 p95 往返一致`);
    assert.equal(parsed.points[i].p99, points[i].latency.p99, `第${i}点 p99 往返一致`);
  }
  assert.equal(parsed.points[2].http429, 1, "第三点 429 计数（扫描表格列）往返一致");
});

test("aggregateSubject：load 报告聚合出 loadPoints，reportCounts.load 计数正确", () => {
  const point = aggregate({ samples: [okSample(100), okSample(200)], mode: "closed", offered: 30, durationSec: 10 });
  const md = formatSinglePointReport(loadMeta(), point);
  const agg = aggregateSubject({ files: [{ name: "x_load_20260720", md }] });
  assert.equal(agg.reportCounts.load, 1);
  assert.equal(agg.loadPoints.length, 1);
  assert.equal(agg.loadPoints[0].offered, 30);
  assert.equal(agg.loadPoints[0].mode, "closed");
});

test("端到端回归：一方有压测报告、另一方完全没有压测报告时，压测数据不得在 balanceCommonReports 被静默丢弃", () => {
  // 复现的真实缺陷：load 若像 run/admission 一样要求「双方都有该类型才保留整份报告」，
  // A 的压测报告会在 balanceCommonReports 这一步就被整份删掉，buildComparison 里
  // onlyA/onlyB 的「仅一方测过」判断永远轮不到执行，报告还会误报「两个对象都没有压力测试报告」。
  // 走完整链路（而非直接手造 aggregateSubject 的返回值喂给 buildComparison）才能测到这个缺口。
  const point = aggregate({ samples: [okSample(100), okSample(200)], mode: "closed", offered: 30, durationSec: 10 });
  const loadMd = formatSinglePointReport(loadMeta(), point);
  const filesA = [{ name: "a_load_20260101", md: loadMd, mtimeMs: 1 }];
  const filesB = []; // B 完全没有任何报告

  const pickedA = pickRecentReports(filesA);
  const pickedB = pickRecentReports(filesB);
  const [balA, balB] = balanceCommonReports(pickedA, pickedB);
  assert.equal(balA.length, 1, "A 的压测报告不应在平衡阶段被整份丢弃");
  assert.equal(balB.length, 0);

  const aggA = aggregateSubject({ files: balA, label: "A" });
  const aggB = aggregateSubject({ files: balB, label: "B" });
  assert.equal(aggA.loadPoints.length, 1, "A 的负载点应能传到聚合层");

  const cmp = buildComparison(aggA, aggB);
  assert.equal(cmp.loadComparison.onlyA.length, 1, "A 独有的负载点应出现在 onlyA，而非被前置过滤吃掉");
  assert.equal(cmp.loadComparison.onlyA[0].offered, 30);

  const md = formatCompareReportMarkdown(cmp, { generatedAt: "2026-01-01T00:00:00Z" });
  assert.ok(!md.includes("两个对象都没有压力测试报告"), "A 明明有压测报告，不得声称双方都没有");
  assert.match(md, /仅对象A 测过、且无法插值估计的负载点/);
});

test("buildComparison：负载点按 (mode, offered) 精确配对；不同 mode 不互相配对；单方独有归入 onlyA/onlyB（除非能插值）", () => {
  const mkAgg = (pts) => ({
    label: "x",
    scenarios: [],
    tiers: [],
    latency: { samples: [] },
    quality: { mean: null, n: 0 },
    loadPoints: pts,
  });
  const a = mkAgg([
    { mode: "closed", offered: 10, qps: 5, successRate: 1, p95: 500, p99: 600 },
    { mode: "closed", offered: 20, qps: 8, successRate: 0.9, p95: 900, p99: 1000 },
    { mode: "open", offered: 10, qps: 9, successRate: 1, p95: 400, p99: 450 }, // 与闭环同数值但不同 mode
  ]);
  const b = mkAgg([
    { mode: "closed", offered: 10, qps: 4, successRate: 0.95, p95: 550, p99: 650 },
    { mode: "closed", offered: 30, qps: 6, successRate: 1, p95: 700, p99: 800 }, // B 独有
  ]);
  const cmp = buildComparison(a, b);
  assert.equal(cmp.loadComparison.matched.length, 1, "只有 closed/10 两边都有，唯一精确配对");
  const m = cmp.loadComparison.matched[0];
  assert.equal(m.mode, "closed");
  assert.equal(m.offered, 10);
  assert.equal(m.qpsDelta, 1, "5-4=1");
  assert.equal(m.p95Delta, -50, "500-550=-50");
  // closed/20 落在 B 的 closed 区间 [10,30] 内 → 应被插值收编，不再算 onlyA。
  assert.equal(cmp.loadComparison.interpolatedMatched.length, 1, "closed/20 应被插值配对");
  const im = cmp.loadComparison.interpolatedMatched[0];
  assert.equal(im.offered, 20);
  assert.equal(im.interpolatedSide, "b", "是 B 侧被插值出来的虚拟点");
  // B 在 closed 上是 10→30 之间线性插值：offered=20 是中点，qps=(4+6)/2=5，p95=(550+700)/2=625。
  assert.equal(im.b.qps, 5);
  assert.equal(im.b.p95, 625);
  // A 独有：open/10（B 侧没有任何 open 点，插不出来，只能留在 onlyA）。
  const onlyAKeys = cmp.loadComparison.onlyA.map((p) => `${p.mode}:${p.offered}`).sort();
  assert.deepEqual(onlyAKeys, ["open:10"], "open/10 无法在只有 closed 点的 B 曲线上插值");
  // B 的 closed:30 落在 A 的 closed 区间 [10,20] 之外（30>20），不外推，仍留在 onlyB。
  assert.deepEqual(
    cmp.loadComparison.onlyB.map((p) => `${p.mode}:${p.offered}`),
    ["closed:30"],
  );
});

test("interpolateLoadPoint：范围外不外推、单点不插值、精确落点直接复用", () => {
  const pts = [
    { mode: "closed", offered: 10, qps: 5, successRate: 1, p95: 500, p99: 600 },
    { mode: "closed", offered: 30, qps: 9, successRate: 0.9, p95: 900, p99: 1000 },
  ];
  assert.equal(interpolateLoadPoint(pts, 5), null, "5 < min(10)，不外推");
  assert.equal(interpolateLoadPoint(pts, 35), null, "35 > max(30)，不外推");
  assert.equal(interpolateLoadPoint([pts[0]], 20), null, "只有 1 个真实点，无法确定斜率");
  const mid = interpolateLoadPoint(pts, 20);
  assert.equal(mid.qps, 7, "(5+9)/2=7，20 是中点");
  assert.equal(mid.p95, 700, "(500+900)/2=700");
  assert.deepEqual(mid.interpFrom, { left: 10, right: 30 });
  const exact = interpolateLoadPoint(pts, 10);
  assert.equal(exact.qps, 5, "精确落在真实点上，直接复用而非重新插值");
});

test("simpleKnee：全程健康取最后一点；首点即不健康返回 -1；中途转坏取前一点", () => {
  const healthy = [
    { offered: 10, successRate: 1, http429: 0 },
    { offered: 20, successRate: 1, http429: 0 },
  ];
  assert.equal(simpleKnee(healthy).index, 1);
  assert.equal(simpleKnee(healthy).point.offered, 20);

  const badBaseline = [
    { offered: 10, successRate: 0.5, http429: 0 },
    { offered: 20, successRate: 1, http429: 0 },
  ];
  assert.equal(simpleKnee(badBaseline).index, -1);
  assert.equal(simpleKnee(badBaseline).point, null);

  const turnsBad = [
    { offered: 10, successRate: 1, http429: 0 },
    { offered: 20, successRate: 1, http429: 0 },
    { offered: 30, successRate: 0.5, http429: 2 },
  ];
  assert.equal(simpleKnee(turnsBad).index, 1);
  assert.equal(simpleKnee(turnsBad).point.offered, 20);
});

test("buildComparison：跨 mode（一方开环一方闭环）退化为曲线汇总对比 summary", () => {
  const mkAgg = (pts) => ({
    label: "x",
    scenarios: [],
    tiers: [],
    latency: { samples: [] },
    quality: { mean: null, n: 0 },
    loadPoints: pts,
  });
  const a = mkAgg([
    { mode: "closed", offered: 10, qps: 5, successRate: 1, p95: 500, p99: 600 },
    { mode: "closed", offered: 20, qps: 8, successRate: 1, p95: 700, p99: 800 },
  ]);
  const b = mkAgg([
    { mode: "open", offered: 5, qps: 4, successRate: 1, p95: 400, p99: 450 },
    { mode: "open", offered: 15, qps: 0.5, successRate: 0.8, p95: 900, p99: 1200 },
  ]);
  const cmp = buildComparison(a, b);
  assert.equal(cmp.loadComparison.matched.length, 0);
  assert.equal(cmp.loadComparison.interpolatedMatched.length, 0, "跨 mode 不互相插值");
  assert.ok(cmp.loadComparison.summary, "无法逐点/插值比较时应退化为 summary");
  assert.equal(cmp.loadComparison.summary.a.knee.point.offered, 20, "A 全程健康，推荐点取最后一点");
  assert.equal(cmp.loadComparison.summary.a.peakQps, 8);
  assert.equal(cmp.loadComparison.summary.b.knee.point.offered, 5, "B 第二点成功率跌破 99%，推荐点取前一点");
  assert.equal(cmp.loadComparison.summary.b.peakQps, 4);
});

function mkFullAgg(overrides = {}) {
  return {
    label: "x",
    channel: null,
    model: null,
    reportCounts: { run: 0, scenario: 0, admission: 0, load: 0, total: 0 },
    stability: null,
    integrity: { errorCounts: {} },
    latency: { samples: [], rounds: [], stats: {} },
    scenarioPass: { succ: 0, total: 0, rate: null },
    quality: { mean: null, n: 0 },
    scenarios: [],
    tiers: [],
    admission: null,
    tokens: { input: 0, output: 0 },
    loadPoints: [],
    ...overrides,
  };
}

test("computeOverallScore：三维皆有数据 → 手算效应量与合成分一致", () => {
  const a = mkFullAgg({
    label: "A",
    stability: { succ: 9, total: 10 },
    scenarios: [{ name: "s1", quality: 80, rate: 1, succ: 1, total: 1 }],
    loadPoints: [{ mode: "closed", offered: 10, qps: 10, successRate: 1, p95: 100, p99: 120 }],
  });
  const b = mkFullAgg({
    label: "B",
    stability: { succ: 7, total: 10 },
    scenarios: [{ name: "s1", quality: 30, rate: 1, succ: 1, total: 1 }],
    loadPoints: [{ mode: "closed", offered: 10, qps: 2.5, successRate: 1, p95: 300, p99: 400 }],
  });
  const cmp = buildComparison(a, b);
  const os = computeOverallScore(cmp);
  // 可用性：稳定性 9/10 vs 7/10 的 Cohen's h（场景通过率两边都是 1/1，h=0，均值只受稳定性拉动）。
  const phi = (p) => 2 * Math.asin(Math.sqrt(p));
  const hStab = (phi(0.9) - phi(0.7)) / Math.PI;
  assert.ok(Math.abs(os.dims.availability.effect - hStab / 2) < 1e-6, "可用性效应量=稳定性h与通过率h(=0)的均值");
  // 质量：仅 1 对配对场景，n<2，质量维度应为 null（不参与合成）。
  assert.equal(os.dims.quality.effect, null, "配对样本 n=1 时质量维度样本不足，不参与合成");
  // 压测：goodput A=10*1=10，B=2.5*1=2.5，比值4倍 → tanh(ln4/ln4)=tanh(1)。
  assert.ok(Math.abs(os.dims.load.effect - Math.tanh(1)) < 1e-6, "压测效应量=tanh(ln(10/2.5)/ln4)=tanh(1)");
  // 权重按比例重新归一化到 availability+load（quality 缺失）。
  const wSum = 0.35 + 0.35;
  assert.ok(Math.abs(os.dims.availability.weight - 0.35 / wSum) < 1e-6);
  assert.ok(Math.abs(os.dims.load.weight - 0.35 / wSum) < 1e-6);
  assert.equal(os.dims.quality.weight, 0);
  const expectedE = (0.35 * (hStab / 2) + 0.35 * Math.tanh(1)) / wSum;
  assert.ok(Math.abs(os.effect - expectedE) < 1e-6);
  assert.equal(os.scoreA, Math.round(50 + 50 * expectedE));
  assert.equal(os.scoreA + os.scoreB, 100, "两分数之和恒为100");
});

test("computeOverallScore：压测数据双方均缺失 → load 维度为 null，权重归一化到可用性+质量", () => {
  const a = mkFullAgg({
    label: "A",
    stability: { succ: 9, total: 10 },
    scenarios: [
      { name: "s1", quality: 80, rate: 1, succ: 1, total: 1 },
      { name: "s2", quality: 70, rate: 1, succ: 1, total: 1 },
    ],
  });
  const b = mkFullAgg({
    label: "B",
    stability: { succ: 6, total: 10 },
    scenarios: [
      { name: "s1", quality: 50, rate: 1, succ: 1, total: 1 },
      { name: "s2", quality: 40, rate: 0, succ: 0, total: 1 },
    ],
  });
  const cmp = buildComparison(a, b);
  const os = computeOverallScore(cmp);
  assert.equal(os.dims.load.effect, null, "双方都没有压测数据，load 维度不参与");
  assert.equal(os.dims.load.weight, 0);
  const wSum = 0.35 + 0.3;
  assert.ok(Math.abs(os.dims.availability.weight - 0.35 / wSum) < 1e-6);
  assert.ok(Math.abs(os.dims.quality.weight - 0.3 / wSum) < 1e-6);
  assert.ok(Math.abs(os.dims.availability.weight + os.dims.quality.weight - 1) < 1e-6, "剩余权重之和为1");
  assert.equal(os.scoreA + os.scoreB, 100);
});

test("computeOverallScore：压测一方 goodput=0（基准点即不健康）、另一方>0 → 效应量为满值±1，非 NaN/Infinity", () => {
  const a = mkFullAgg({
    label: "A",
    loadPoints: [{ mode: "closed", offered: 10, qps: 5, successRate: 0.5, http429: 0 }], // 基准点不健康 → goodput=0
  });
  const b = mkFullAgg({
    label: "B",
    loadPoints: [{ mode: "closed", offered: 10, qps: 5, successRate: 1, http429: 0 }],
  });
  const cmp = buildComparison(a, b);
  const os = computeOverallScore(cmp);
  assert.equal(os.dims.load.effect, -1, "A goodput=0、B>0 → A 处于劣势，效应量应为 -1");
  assert.ok(Number.isFinite(os.dims.load.effect));

  const cmp2 = buildComparison(b, a); // 调换顺序，验证方向对称
  const os2 = computeOverallScore(cmp2);
  assert.equal(os2.dims.load.effect, 1);
});

test("computeOverallScore：三维皆样本不足 → 整体返回 null，不编造 50/50", () => {
  const a = mkFullAgg({ label: "A" });
  const b = mkFullAgg({ label: "B" });
  const cmp = buildComparison(a, b);
  const os = computeOverallScore(cmp);
  assert.equal(os.scoreA, null);
  assert.equal(os.scoreB, null);
  assert.equal(os.effect, null);
});

test("formatCompareReportMarkdown：综合评分小节渲染——有分数时显示表格，数据不足时给出说明", () => {
  const a = mkFullAgg({
    label: "A",
    stability: { succ: 9, total: 10 },
    scenarios: [{ name: "s1", quality: 80, rate: 1, succ: 1, total: 1 }],
  });
  const b = mkFullAgg({
    label: "B",
    stability: { succ: 6, total: 10 },
    scenarios: [{ name: "s1", quality: 40, rate: 1, succ: 1, total: 1 }],
  });
  const cmp = buildComparison(a, b);
  const md = formatCompareReportMarkdown(cmp, { generatedAt: "2026-07-28T00:00:00Z" });
  assert.match(md, /## 综合评分（相对分，A \+ B = 100）/);
  assert.match(md, /对象A：\d+ 分　对象B：\d+ 分/);
  assert.match(md, /压力测试 \| 35%（未参与：样本不足） \| - \| - \|/);
  // 综合评分小节必须在结论速览之后、第1节之前。
  const idxOverview = md.indexOf("## 结论速览");
  const idxScore = md.indexOf("## 综合评分");
  const idxSec1 = md.indexOf("## 1. 可用性与通过率");
  assert.ok(idxOverview < idxScore && idxScore < idxSec1, "综合评分小节应位于结论速览之后、第1节之前");

  const emptyCmp = buildComparison(mkFullAgg({ label: "A" }), mkFullAgg({ label: "B" }));
  const mdEmpty = formatCompareReportMarkdown(emptyCmp, { generatedAt: "2026-07-28T00:00:00Z" });
  assert.match(mdEmpty, /数据不足，无法给出综合评分/);
  assert.ok(!mdEmpty.includes("对象A：") || !/对象A：\d+ 分/.test(mdEmpty), "数据不足时不应渲染出分数");
});

test("formatCompareReportMarkdown：压力测试对比节——有数据时出表格，无数据时给说明而非空表格", () => {
  const mkAgg = (pts) => ({
    label: "x",
    channel: null,
    model: null,
    reportCounts: { run: 0, scenario: 0, admission: 0, load: pts.length ? 1 : 0, total: 0 },
    stability: null,
    integrity: { errorCounts: {} },
    latency: { samples: [], rounds: [], stats: {} },
    scenarioPass: { succ: 0, total: 0, rate: null },
    quality: { mean: null, n: 0 },
    scenarios: [],
    tiers: [],
    admission: null,
    tokens: { input: 0, output: 0 },
    loadPoints: pts,
  });
  const withLoad = buildComparison(
    mkAgg([{ mode: "closed", offered: 10, qps: 5, successRate: 1, p95: 500, p99: 600 }]),
    mkAgg([{ mode: "closed", offered: 10, qps: 4, successRate: 0.9, p95: 600, p99: 700 }]),
  );
  const mdWith = formatCompareReportMarkdown(withLoad, { generatedAt: "2026-07-20T00:00:00Z" });
  assert.match(mdWith, /## 6\. 压力测试对比/);
  assert.match(mdWith, /\| 模式 \| 负载 \| QPS\(A\)/);
  assert.match(mdWith, /闭环 \| 10 并发/);

  const withoutLoad = buildComparison(mkAgg([]), mkAgg([]));
  const mdWithout = formatCompareReportMarkdown(withoutLoad, { generatedAt: "2026-07-20T00:00:00Z" });
  assert.match(mdWithout, /## 6\. 压力测试对比/);
  assert.match(mdWithout, /两个对象都没有压力测试报告，跳过压测对比/);
  assert.ok(!mdWithout.includes("| 模式 | 负载 |"), "无压测数据时不应出现空表格");
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
