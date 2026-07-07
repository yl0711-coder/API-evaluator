// tests/report-compare.test.mjs
// 模型对比内核（server/report-compare.mjs）的纯函数测试：用 Evaluation Report/ 下真实样例作夹具，
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
  buildComparison,
  formatCompareReportMarkdown,
} from "../server/report-compare.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const EVAL = join(root, "Evaluation Report");
const DIR_A = join(EVAL, "新建文件夹");
const DIR_B = join(EVAL, "新建文件夹 (2)");

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
  assert.equal(a.reportCounts.scenario, 10);
  assert.equal(a.reportCounts.run, 1);
  assert.equal(a.reportCounts.admission, 1);
  // 稳定性来自那份 run 报告（8/10）。
  assert.equal(a.stability.succ, 8);
  assert.equal(a.stability.total, 10);
  // 10 份场景报告里有同名重复 → 去重后 9 个场景，但通过率池化 total 仍为 10。
  assert.equal(a.scenarios.length, 9);
  assert.equal(a.scenarioPass.total, 10);
  assert.equal(a.admission.grade, "A");
});

test("buildComparison：小样本→差异不显著；配对场景匹配", async () => {
  const a = aggregateSubject({ files: await readFolder(DIR_A) });
  const b = aggregateSubject({ files: await readFolder(DIR_B) });
  const cmp = buildComparison(a, b);
  // 8/10 vs 10/10，Wilson CI 重叠 → 不显著。
  assert.equal(cmp.verdicts.stability.significant, false);
  assert.equal(cmp.verdicts.stability.verdict, "差异不显著");
  // 两文件夹场景名一致 → 9 个配对，无独有。
  assert.equal(cmp.scenarioQuality.matched.length, 9);
  assert.equal(cmp.scenarioQuality.onlyA.length, 0);
  assert.equal(cmp.scenarioQuality.onlyB.length, 0);
});

test("formatCompareReportMarkdown 含各对比小节", async () => {
  const a = aggregateSubject({ files: await readFolder(DIR_A) });
  const b = aggregateSubject({ files: await readFolder(DIR_B) });
  const md = formatCompareReportMarkdown(buildComparison(a, b), { generatedAt: "2026-07-07T00:00:00.000Z" });
  for (const heading of [
    "# 模型对比报告",
    "## 结论速览",
    "## 1. 可用性与通过率",
    "## 2. 按难度档位拆解",
    "## 3. 逐场景诊断",
    "## 4. 延迟",
    "## 5. 计费与 Token 诚实度",
    "## 6. 准入分项与身份纯度",
    "## 7. 总体结论",
  ]) {
    assert.ok(md.includes(heading), `缺少小节：${heading}`);
  }
  assert.ok(md.includes("test / claude-opus-4-8"));
  assert.ok(md.includes("Claude-1.3x / claude-opus-4-8"));
  // 深度内容：档位、失败原因、token 虚报、横向指纹应出现。
  assert.ok(md.includes("HardcoreLogic"), "缺少难度档位拆解");
  assert.ok(md.includes("HLE 化学") || md.includes("rate_limited"), "缺少逐场景失败原因");
  assert.ok(md.includes("×"), "缺少计费/token 膨胀信号");
  // 统计学深度：配对差值/CI、Cliff's δ、McNemar、bootstrap。
  assert.ok(/95% CI/.test(md), "缺少置信区间");
  assert.ok(/Cliff's δ/.test(md), "缺少效果量");
  assert.ok(/McNemar/.test(md), "缺少配对通过率检验");
  assert.ok(/bootstrap/i.test(md), "缺少延迟 bootstrap CI");
});

test("配对统计：质量分配对差 CI 含 0→不显著；Cliff's δ；胜平负；错误型失败可区分", async () => {
  const a = aggregateSubject({ files: await readFolder(DIR_A) });
  const b = aggregateSubject({ files: await readFolder(DIR_B) });
  const cmp = buildComparison(a, b);
  const pq = cmp.pairedQuality;
  assert.equal(pq.n, 9); // 9 个配对场景
  assert.ok(pq.ci && pq.ci[0] < 0 && pq.ci[1] > 0, "配对差 95% CI 应含 0（不显著）");
  assert.equal(pq.win + pq.tie + pq.loss, 9);
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
