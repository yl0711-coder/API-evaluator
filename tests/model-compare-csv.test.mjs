import assert from "node:assert/strict";
import test from "node:test";

import { buildComparisonCsv } from "../src/model-compare.js";
import { buildComparisonXlsx } from "../src/model-compare-excel.js";

test("buildComparisonCsv exports summary and scenario usage fields with spreadsheet-safe text", () => {
  const csv = buildComparisonCsv({
    subjects: { a: { label: "=渠道 A" }, b: { label: "渠道 B" } },
    summary: [
      { label: "场景输出 Token（含思考）", valueA: 800, valueB: 900, unit: "Token", format: "tokens", detail: "仅计共同场景" },
      { label: "场景通过率", valueA: 0.8, valueB: 0.9, unit: "%", format: "percent", detail: "共同场景" },
    ],
    scenarios: [
      {
        name: "场景甲",
        tier: "中等",
        a: { quality: 80, passRate: 0.8, avgMs: 1000, p50FirstTokenMs: 200, outputTokens: 80, cacheReadTokens: 20, issue: "-" },
        b: { quality: 90, passRate: 0.9, avgMs: 900, p50FirstTokenMs: 180, outputTokens: 90, cacheReadTokens: 30, issue: "" },
      },
    ],
  });

  assert.match(csv, /"对象 A","'=渠道 A"/);
  assert.match(csv, /"摘要","场景输出 Token（含思考）","","800","900","Token","仅计共同场景"/);
  assert.match(csv, /"逐场景","场景甲","中等"/);
  assert.match(csv, /"80","90","80.0%","90.0%","1000","900","200","180","80","90","20","30","'-",""/);
});

test("buildComparisonCsv includes per-scenario token coverage", () => {
  const csv = buildComparisonCsv({
    subjects: { a: { label: "A" }, b: { label: "B" } },
    scenarios: [
      {
        name: "scenario",
        a: { outputTokens: 80, outputTokenReportedCount: 1, outputTokenTotalCount: 2 },
        b: { outputTokens: 90, outputTokenReportedCount: 2, outputTokenTotalCount: 2 },
      },
    ],
  });

  assert.match(csv, /"1\/2","2\/2","",""/);
});

test("buildComparisonXlsx creates a styled two-sheet workbook with comparison usage fields", () => {
  const bytes = buildComparisonXlsx({
    subjects: { a: { label: "渠道 A" }, b: { label: "渠道 B" } },
    summary: [{ label: "场景通过率", valueA: 0.8, valueB: 0.9, format: "percent", winner: "b", detail: "共有场景" }],
    scenarios: [
      {
        name: "场景甲",
        tier: "中等",
        winner: "a",
        a: { quality: 90, passRate: 0.9, avgMs: 800, p50FirstTokenMs: 120, outputTokens: 120, cacheReadTokens: 30 },
        b: { quality: 80, passRate: 0.8, avgMs: 900, p50FirstTokenMs: 180, outputTokens: 100, cacheReadTokens: 20 },
      },
    ],
  });

  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const contents = new TextDecoder().decode(bytes);
  assert.match(contents, /<sheet name="概览"/);
  assert.match(contents, /<sheet name="逐场景明细"/);
  assert.match(contents, /P50 首 Token/);
  assert.match(contents, /Token 用量/);
  assert.match(contents, /对象 B 更优/);
});
