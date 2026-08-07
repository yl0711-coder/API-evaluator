// tests/multi-comparison-view.test.mjs
// buildMultiComparisonView（server/report-compare.mjs）的纯函数测试：N 列并排对比视图。
//
// 夹具走「合成报告 markdown → 真的 aggregateSubject → 真的 buildComparison」这条链，
// 而不是手搓聚合对象：手搓的对象一旦与 aggregateSubject 的真实输出形状脱节，测试会绿着
// 而端点在线上炸。这里的输入形状与 handleReportsCompareMulti 的 Pass 2 完全同源。
import assert from "node:assert/strict";
import test from "node:test";

import { aggregateSubject, buildComparison, buildMultiComparisonView } from "../server/report-compare.mjs";

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

// rows: [[场景名, 成功率, 平均质量分], ...]
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

const D = "20260801";
// 三个对象：基准（100% 稳定、质量 90/80）、peer1（80% 稳定、质量 70/60）、peer2（100% 稳定、质量 90/95）。
// 基准另有一个独有场景「场景丙」，用于验证共享场景过滤真的生效。
const SUBJECTS = {
  base: {
    label: "基准渠道 / model-x",
    files: [
      { name: `base_model-x_run_${D}`, md: runReportMd("100% (10/10)", 1200) },
      {
        name: `base_model-x_scenario_${D}`,
        md: scenarioReportMd([
          ["场景甲", "100% (3/3)", "90"],
          ["场景乙", "100% (3/3)", "80"],
          ["场景丙", "100% (3/3)", "75"],
        ]),
      },
    ],
  },
  peer1: {
    label: "甲渠道 / model-x",
    files: [
      { name: `peer1_model-x_run_${D}`, md: runReportMd("80% (8/10)", 1600) },
      {
        name: `peer1_model-x_scenario_${D}`,
        md: scenarioReportMd([
          ["场景甲", "100% (3/3)", "70"],
          ["场景乙", "67% (2/3)", "60"],
        ]),
      },
    ],
  },
  peer2: {
    label: "乙渠道 / model-x",
    files: [
      { name: `peer2_model-x_run_${D}`, md: runReportMd("100% (10/10)", 1400) },
      {
        name: `peer2_model-x_scenario_${D}`,
        md: scenarioReportMd([
          ["场景甲", "100% (3/3)", "90"],
          ["场景乙", "100% (3/3)", "95"],
        ]),
      },
    ],
  },
};

const SHARED = new Set(["场景甲", "场景乙"]);

// 镜像 handleReportsCompareMulti 的 Pass 2：基准只聚合一次，各 peer 各聚合一次。
function buildView(peerKeys) {
  const baseAgg = aggregateSubject({ files: SUBJECTS.base.files, label: SUBJECTS.base.label, scenarioFilter: SHARED });
  const pairs = peerKeys.map((key) => {
    const agg = aggregateSubject({ files: SUBJECTS[key].files, label: SUBJECTS[key].label, scenarioFilter: SHARED });
    return { agg, cmp: buildComparison(baseAgg, agg) };
  });
  return buildMultiComparisonView({ baseAgg, pairs, sharedScenarios: [...SHARED] });
}

const rowOf = (view, id) => view.summary.find((r) => r.id === id);

test("subjects：第一列是基准且带 isBase，其后按传入顺序排列 peer", () => {
  const view = buildView(["peer1", "peer2"]);
  assert.deepEqual(
    view.subjects.map((s) => s.label),
    ["基准渠道 / model-x", "甲渠道 / model-x", "乙渠道 / model-x"],
  );
  assert.equal(view.subjects[0].isBase, true);
  assert.equal(view.subjects[1].isBase, false);
  assert.equal(view.subjects[2].isBase, false);
});

test("每一行的 values 长度都等于列数（前端按 subjects.length 生成 td，长度不齐会串列）", () => {
  const view = buildView(["peer1", "peer2"]);
  assert.ok(view.summary.length > 0, "摘要行不应为空");
  for (const row of view.summary) {
    assert.equal(row.values.length, view.subjects.length, `摘要行「${row.label}」的 values 长度不等于列数`);
  }
  for (const row of view.scenarios) {
    assert.equal(row.values.length, view.subjects.length, `场景行「${row.name}」的 values 长度不等于列数`);
  }
});

test("综合相对分：基准列固定 50，peer 列为各自相对基准的分数，并注明不具传递性", () => {
  const view = buildView(["peer1", "peer2"]);
  const row = rowOf(view, "overall-score");
  assert.equal(row.values[0].value, 50, "基准列必须是 50（打平锚点）");
  assert.match(row.detail, /不具传递性/, "必须注明跨列比较不具传递性");
  // peer1 全面弱于基准 → 低于 50；peer2 质量更高 → 高于 50。
  assert.ok(row.values[1].value < 50, `peer1 应低于 50，实为 ${row.values[1].value}`);
  assert.ok(row.values[2].value > 50, `peer2 应高于 50，实为 ${row.values[2].value}`);
});

test("平均质量分：基准列取共享场景均值，bestIndex 指向真正最高的那列", () => {
  const view = buildView(["peer1", "peer2"]);
  const row = rowOf(view, "scenario-quality");
  // 基准 (90+80)/2=85；peer1 (70+60)/2=65；peer2 (90+95)/2=92.5
  assert.equal(row.values[0].value, 85);
  assert.equal(row.values[1].value, 65);
  assert.equal(row.values[2].value, 92.5);
  assert.equal(row.bestIndex, 2);
});

test("并列最优不高亮任何一列（基准与 peer2 稳定性都是 100%）", () => {
  const view = buildView(["peer1", "peer2"]);
  const row = rowOf(view, "stability-rate");
  assert.equal(row.values[0].value, 1);
  assert.equal(row.values[1].value, 0.8);
  assert.equal(row.values[2].value, 1);
  assert.equal(row.bestIndex, null, "两列并列 100% 时不得点亮其中一列，否则另一列看着像输了");
});

test("基准列不随勾选了哪些 peer、以何顺序勾选而变（N 列共享同一份基准画像）", () => {
  const forward = buildView(["peer1", "peer2"]);
  const reversed = buildView(["peer2", "peer1"]);
  const soloPeer2 = buildView(["peer2"]);
  const baseColumn = (view) => view.summary.map((r) => [r.id, r.values[0].value]);
  assert.deepEqual(reversed.subjects[0], forward.subjects[0]);
  assert.deepEqual(baseColumn(reversed), baseColumn(forward), "换 peer 顺序不得改变基准列");
  assert.deepEqual(baseColumn(soloPeer2), baseColumn(forward), "少勾一个 peer 不得改变基准列");
});

test("逐场景：只列共享场景（基准独有的场景丙不出现），按名排序，bestIndex 按质量分取最优", () => {
  const view = buildView(["peer1", "peer2"]);
  assert.deepEqual(
    view.scenarios.map((r) => r.name),
    ["场景甲", "场景乙"],
  );
  assert.equal(view.sharedScenarioCount, 2);
  const yi = view.scenarios.find((r) => r.name === "场景乙");
  // 场景乙：基准 80、peer1 60、peer2 95 → peer2 最优
  assert.deepEqual(
    yi.values.map((v) => v.quality),
    [80, 60, 95],
  );
  assert.equal(yi.bestIndex, 2);
  // 场景甲：基准 90、peer1 70、peer2 90 → 基准与 peer2 并列，不高亮
  const jia = view.scenarios.find((r) => r.name === "场景甲");
  assert.equal(jia.bestIndex, null, "场景甲基准与 peer2 并列 90 分，不得点亮其中一列");
});

test("单个 peer：退化成两列，仍保持同一套结构", () => {
  const view = buildView(["peer1"]);
  assert.equal(view.subjects.length, 2);
  for (const row of view.summary) assert.equal(row.values.length, 2);
  assert.equal(rowOf(view, "overall-score").values[0].value, 50);
});

test("没有任何 peer：出空表而不是抛异常", () => {
  const baseAgg = aggregateSubject({ files: SUBJECTS.base.files, label: SUBJECTS.base.label, scenarioFilter: SHARED });
  const view = buildMultiComparisonView({ baseAgg, pairs: [], sharedScenarios: [...SHARED] });
  assert.equal(view.subjects.length, 1);
  assert.deepEqual(view.summary, []);
  assert.deepEqual(view.scenarios, []);
});

test("共享场景为空集：场景表为空、不虚构场景派生数字", () => {
  const empty = new Set();
  const baseAgg = aggregateSubject({ files: SUBJECTS.base.files, label: SUBJECTS.base.label, scenarioFilter: empty });
  const agg = aggregateSubject({ files: SUBJECTS.peer1.files, label: SUBJECTS.peer1.label, scenarioFilter: empty });
  const view = buildMultiComparisonView({ baseAgg, pairs: [{ agg, cmp: buildComparison(baseAgg, agg) }], sharedScenarios: [] });
  assert.deepEqual(view.scenarios, []);
  assert.equal(view.sharedScenarioCount, 0);
  // 质量分行必须是「数据不足」而不是 0 分——0 分会被读成「答得很差」。
  const quality = rowOf(view, "scenario-quality");
  assert.equal(quality.status, "insufficient");
  assert.equal(quality.values[0].value, null);
});
