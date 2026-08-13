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

// rows: [[场景名, 成功率, 平均质量分], ...]。质量分传 "-" 表示该场景没有质量分
// （真实情形：该场景全部请求失败 / 未判分），用于验证基准列不被某个 peer 的缺口带偏。
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
  // 场景乙没有质量分（全部失败/未判分）。基准与 peer1/peer2 在场景乙上都有分，
  // 故这个 peer 一旦被勾上，「两方共有且均有质量分」的分母就只剩场景甲——
  // 若基准列沿用两列口径，基准数字会随它是否在勾选内、排第几位而变。
  peerGap: {
    label: "丙渠道 / model-x",
    files: [
      { name: `peergap_model-x_run_${D}`, md: runReportMd("90% (9/10)", 1500) },
      {
        name: `peergap_model-x_scenario_${D}`,
        md: scenarioReportMd([
          ["场景甲", "100% (3/3)", "60"],
          ["场景乙", "0% (0/3)", "-"],
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

// 上一条用例的 peer 在每个共享场景上都有质量分，因此走不到「两方过滤」与「N 方过滤」分母不同的
// 那条路。peerGap 的场景乙缺质量分，才真正区分两种口径。此前基准列的平均质量分取自 pairs[0] 的
// A 侧（=「基准 ∩ pairs[0]」的口径），于是：换序换掉 pairs[0] → 基准数字变；少勾一个 peer →
// 基准数字变，且高亮列随之乱跳。
test("基准列不被某个 peer 的指标缺口带偏：含缺质量分的 peer 时，换序 / 增减勾选均不改变基准列", () => {
  const withGapFirst = buildView(["peerGap", "peer1"]);
  const withGapLast = buildView(["peer1", "peerGap"]);
  const soloGap = buildView(["peerGap"]);
  const soloPeer1 = buildView(["peer1"]);
  const baseQuality = (view) => rowOf(view, "scenario-quality").values[0].value;

  assert.equal(baseQuality(withGapFirst), baseQuality(withGapLast), "仅调换勾选顺序不得改变基准列的平均质量分");
  assert.equal(baseQuality(soloGap), baseQuality(withGapFirst), "基准列必须只由「各列共有」口径决定，与 peer 排序无关");

  // N 方口径：勾了 peerGap 后共有且各列都有质量分的场景只剩场景甲 → 基准列取场景甲的 90。
  assert.equal(baseQuality(withGapFirst), 90);
  assert.equal(rowOf(withGapFirst, "scenario-quality").detail, "仅计各列共有且均有质量分的场景（1 个）");
  // 不勾 peerGap 时两个场景都算 → 基准列 (90+80)/2=85。分母确实随勾选的 peer 集合变化，
  // 但那是 N 方共享场景集的固有性质，且已写进 detail，不是列间口径不一致。
  assert.equal(baseQuality(soloPeer1), 85);

  // 高亮不得随顺序漂移：三列都在场景甲上比（基准 90 / peerGap 60 / peer1 70）→ 基准最优。
  assert.equal(rowOf(withGapFirst, "scenario-quality").bestIndex, 0);
  assert.equal(rowOf(withGapLast, "scenario-quality").bestIndex, 0);
});

test("各列同分母：平均质量分的每一列都在同一批场景上聚合", () => {
  const view = buildView(["peerGap", "peer1"]);
  const row = rowOf(view, "scenario-quality");
  // 场景甲：基准 90、peerGap 60、peer1 70。三列都只算场景甲，故值恰为各自的场景甲分数；
  // 若哪一列偷偷把场景乙也算进去（如 peer1 取 (70+60)/2=65），这里就会红。
  assert.deepEqual(
    row.values.map((v) => v.value),
    [90, 60, 70],
  );
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
