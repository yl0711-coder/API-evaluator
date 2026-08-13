import assert from "node:assert/strict";
import test from "node:test";
import { areAllReportIdsSelected, clearReportIds, reconcileReportIds, selectReportIds } from "../src/report-selection.js";

test("report selection supports cross-page additions and all-selected state", () => {
  const selection = new Set(["page-one"]);
  selectReportIds(selection, [{ id: "page-two" }, { id: "page-three" }]);
  assert.deepEqual([...selection], ["page-one", "page-two", "page-three"]);
  assert.equal(areAllReportIdsSelected(selection, [{ id: "page-two" }, { id: "page-three" }]), true);
});

test("report selection clears explicitly and removes reports deleted during refresh", () => {
  const selection = new Set(["kept", "deleted"]);
  reconcileReportIds(selection, [{ id: "kept" }, { id: "new" }]);
  assert.deepEqual([...selection], ["kept"]);
  clearReportIds(selection);
  assert.equal(selection.size, 0);
});
