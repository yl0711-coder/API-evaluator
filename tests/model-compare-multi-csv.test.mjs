// tests/model-compare-multi-csv.test.mjs
// buildMultiComparisonCsv（src/model-compare.js）：N 列 CSV 导出。
//
// 与 tests/model-compare-csv.test.mjs 的关系：那个钉的是【两列专用】的 buildComparisonCsv
// （列名固定「对象 A / 对象 B」）。本文件钉的是列数可变的那份——表头随 subjects 动态生成，
// 每行的单元格数必须与表头一致，否则 Excel 里会串列（最典型的失败模式）。
import assert from "node:assert/strict";
import test from "node:test";

import { buildMultiComparisonCsv } from "../src/model-compare.js";

// 三列（1 基准 + 2 对比）的最小 comparison，形状与 buildMultiComparisonView 的产出一致。
function fixture() {
  return {
    subjects: [{ label: "基准渠道 / m", isBase: true }, { label: "渠道甲 / m" }, { label: "渠道乙 / m" }],
    sharedScenarioCount: 2,
    summary: [
      {
        id: "overall-score",
        label: "综合相对分",
        detail: "基准列固定 50 分",
        format: "number",
        unit: "分",
        direction: "higher",
        values: [{ value: 50 }, { value: 38 }, { value: 61 }],
        bestIndex: 2,
      },
      {
        id: "scenario-pass-rate",
        label: "场景通过率",
        detail: "仅计共享场景",
        format: "percent",
        unit: "%",
        direction: "higher",
        values: [{ value: 1 }, { value: 0.8 }, { value: 0.95 }],
        bestIndex: 0,
      },
      {
        id: "p95-latency",
        label: "P95 总耗时",
        detail: null,
        format: "milliseconds",
        unit: "ms",
        direction: "lower",
        values: [{ value: 1200 }, { value: null }, { value: 1600 }],
        bestIndex: 0,
      },
    ],
    scenarios: [
      { name: "场景甲", tier: "基础/常识", values: [{ quality: 90 }, { quality: 70 }, { quality: 90 }], bestIndex: null },
      { name: "场景乙", tier: "HLE 专家难题", values: [{ quality: 80 }, { quality: 60 }, { quality: 95 }], bestIndex: 2 },
    ],
  };
}

const rowsOf = (csv) => csv.split("\r\n");
// 一行里的单元格数：每个单元格都被 csvCell 包成 "..."，逗号只出现在单元格之间或被转义的引号内。
// 夹具里没有含逗号的文本，故按 `","` 数即可。
const cellCount = (row) => (row === "" ? 0 : row.split('","').length);

test("表头列出全部模型名（基准在前），行首/行尾的固定列不随列数变化", () => {
  const rows = rowsOf(buildMultiComparisonCsv(fixture()));
  const header = rows.find((r) => r.startsWith('"分区"'));
  assert.ok(header, "应有表头行");
  assert.match(header, /"分区","指标\/场景","难度","基准渠道 \/ m","渠道甲 \/ m","渠道乙 \/ m","单位","说明"/);
});

test("每一行的单元格数都等于表头（列数变了也不串列）", () => {
  const rows = rowsOf(buildMultiComparisonCsv(fixture()));
  const header = rows.find((r) => r.startsWith('"分区"'));
  const expected = cellCount(header);
  assert.equal(expected, 3 + 3 + 2, "3 固定前置列 + 3 个模型列 + 2 固定后置列");
  const dataRows = rows.filter((r) => r.startsWith('"摘要"') || r.startsWith('"逐场景'));
  assert.equal(dataRows.length, 3 + 2, "3 行摘要 + 2 行场景");
  for (const row of dataRows) {
    assert.equal(cellCount(row), expected, `行单元格数与表头不一致：${row}`);
  }
});

test("列数变化时表头与数据行同步伸缩（2 列与 7 列都自洽）", () => {
  for (const peerCount of [1, 6]) {
    const base = fixture();
    const cmp = {
      ...base,
      subjects: [base.subjects[0], ...Array.from({ length: peerCount }, (_, i) => ({ label: `peer${i}` }))],
      summary: base.summary.map((row) => ({
        ...row,
        values: [row.values[0], ...Array.from({ length: peerCount }, () => ({ value: 1 }))],
      })),
      scenarios: base.scenarios.map((row) => ({
        ...row,
        values: [row.values[0], ...Array.from({ length: peerCount }, () => ({ quality: 50 }))],
      })),
    };
    const rows = rowsOf(buildMultiComparisonCsv(cmp));
    const header = rows.find((r) => r.startsWith('"分区"'));
    assert.equal(cellCount(header), 3 + (peerCount + 1) + 2, `peer=${peerCount} 时表头列数不对`);
    for (const row of rows.filter((r) => r.startsWith('"摘要"') || r.startsWith('"逐场景'))) {
      assert.equal(cellCount(row), cellCount(header), `peer=${peerCount} 时数据行与表头不齐：${row}`);
    }
  }
});

test("百分比按 format 格式化，缺值留空（不写 0，避免把「没数据」读成「0%」）", () => {
  const csv = buildMultiComparisonCsv(fixture());
  assert.match(csv, /"摘要","场景通过率","","100.0%","80.0%","95.0%","%","仅计共享场景"/);
  // P95 的 peer 甲缺值 → 空单元格，且 detail 为 null 时写空串。
  assert.match(csv, /"摘要","P95 总耗时","","1200","","1600","ms",""/);
});

test("逐场景段导出质量分并带难度档位", () => {
  const csv = buildMultiComparisonCsv(fixture());
  assert.match(csv, /"逐场景（质量分）","场景甲","基础\/常识","90","70","90","分",""/);
  assert.match(csv, /"逐场景（质量分）","场景乙","HLE 专家难题","80","60","95","分",""/);
});

test("表头区带基准 / 对比模型名与共享场景数", () => {
  const rows = rowsOf(buildMultiComparisonCsv(fixture()));
  assert.equal(rows[0], '"基准模型","基准渠道 / m"');
  assert.equal(rows[1], '"对比模型","渠道甲 / m","渠道乙 / m"');
  assert.equal(rows[2], '"共享场景数","2"');
});

test("电子表格公式注入防护：以 = + - @ 开头的模型名被前置单引号钝化", () => {
  const cmp = fixture();
  cmp.subjects[1].label = '=HYPERLINK("http://evil")';
  const csv = buildMultiComparisonCsv(cmp);
  assert.ok(csv.includes("\"'=HYPERLINK"), "危险前导字符应被 ' 钝化");
  assert.ok(!/,"=HYPERLINK/.test(csv), "不得存在未钝化的公式单元格");
});

test("空 comparison 不抛异常（前端拿到空结果也能点导出）", () => {
  const csv = buildMultiComparisonCsv({});
  assert.equal(typeof csv, "string");
  assert.ok(csv.length > 0, "至少有表头骨架");
});
