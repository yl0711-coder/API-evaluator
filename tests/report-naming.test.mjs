// tests/report-naming.test.mjs
// 报告命名：sanitizeReportBaseName 允许中文/保留连字符/防穿越；inferReportType 兼容新旧两种名。
import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeReportBaseName, inferReportType } from "../server/report-files.mjs";

test("sanitizeReportBaseName：保留中文与连字符（新格式 + 旧格式）", () => {
  const newName = "小侠_deepseek-v4-flash_quickverify_20260629_095752_3f2a";
  assert.equal(sanitizeReportBaseName(newName), newName, "新格式（含中文）原样保留");
  const oldName = "admission-20260615-183217-232baef6";
  assert.equal(sanitizeReportBaseName(oldName), oldName, "旧格式连字符必须保留，否则 /view 404");
});

test("sanitizeReportBaseName：路径分隔/非法字符 → _，且不可父目录穿越", () => {
  assert.equal(sanitizeReportBaseName("a/b\\c:d*e?f"), "a_b_c_d_e_f");
  assert.equal(sanitizeReportBaseName("../../etc/passwd").includes(".."), false, "不得保留 ..");
  assert.equal(sanitizeReportBaseName("../../etc/passwd").includes("/"), false, "不得保留 /");
  assert.equal(sanitizeReportBaseName("  "), "report"); // 空白 → 兜底
});

test("inferReportType：新格式按日期前 token 取类型", () => {
  assert.equal(inferReportType("小侠_deepseek-v4-flash_scenario_20260629_095752_3f2a"), "scenario");
  assert.equal(inferReportType("多目标_admission-batch_20260629_095752_3f2a"), "admission"); // 同旧行为
  assert.equal(inferReportType("多目标_batch_20260629_095752_3f2a"), "batch");
  assert.equal(inferReportType("小侠_m_run_20260629_095752_3f2a"), "stability");
});

test("inferReportType：旧格式（无下划线分段）仍正确", () => {
  assert.equal(inferReportType("scenario-20260615-183217-aaaa"), "scenario");
  assert.equal(inferReportType("admission-20260615-183217-aaaa"), "admission");
  assert.equal(inferReportType("admission-batch-20260615-183217-aaaa"), "admission");
  assert.equal(inferReportType("unknownthing-1"), "report");
});
