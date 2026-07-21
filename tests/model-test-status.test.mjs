// tests/model-test-status.test.mjs
// 「模型管理」卡片「上次测试 / 需测」纯函数：formatLastTested + isRetestDue。
import assert from "node:assert/strict";
import test from "node:test";

import { formatLastTested, isRetestDue } from "../src/model-test-status.js";

const DAY = 86400000;
const NOW = Date.parse("2026-07-02T12:00:00Z");

test("formatLastTested：有值 → YYYY-MM-DD；空/坏值 → 从未测试", () => {
  assert.equal(formatLastTested("2026-06-15T08:30:00Z").length, 10); // YYYY-MM-DD（本地时区，长度稳定）
  assert.match(formatLastTested("2026-06-15T08:30:00Z"), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(formatLastTested(null), "从未测试");
  assert.equal(formatLastTested(""), "从未测试");
  assert.equal(formatLastTested("not-a-date"), "从未测试");
});

test("isRetestDue：从未测过 → 恒为需测（cycleDays=0 也是）", () => {
  assert.equal(isRetestDue({ channelStatus: "enabled", lastTestedAt: null, cycleDays: 0, now: NOW }), true);
  assert.equal(isRetestDue({ channelStatus: "enabled", lastTestedAt: null, cycleDays: 7, now: NOW }), true);
});

test("isRetestDue：已测过 + cycleDays=0 → 不催（可测）", () => {
  const lastTestedAt = new Date(NOW - 100 * DAY).toISOString();
  assert.equal(isRetestDue({ channelStatus: "enabled", lastTestedAt, cycleDays: 0, now: NOW }), false);
});

test("isRetestDue：已测过 + cycleDays=7 → 今天测过=false、8 天前=true、正好 7 天=false（含端点）", () => {
  const today = new Date(NOW - 1 * DAY).toISOString();
  assert.equal(isRetestDue({ channelStatus: "enabled", lastTestedAt: today, cycleDays: 7, now: NOW }), false);
  const overdue = new Date(NOW - 8 * DAY).toISOString();
  assert.equal(isRetestDue({ channelStatus: "enabled", lastTestedAt: overdue, cycleDays: 7, now: NOW }), true);
  const exactly7 = new Date(NOW - 7 * DAY).toISOString();
  assert.equal(isRetestDue({ channelStatus: "enabled", lastTestedAt: exactly7, cycleDays: 7, now: NOW }), false, "正好 7 天未超过，不催");
});

test("isRetestDue：已禁用 / 渠道缺失 → 恒 false（即使从未测过）", () => {
  assert.equal(isRetestDue({ channelStatus: "disabled", lastTestedAt: null, cycleDays: 7, now: NOW }), false);
  assert.equal(isRetestDue({ channelStatus: "missing", lastTestedAt: null, cycleDays: 7, now: NOW }), false);
});

test("isRetestDue：坏时间戳 → 视为未测（需测）", () => {
  assert.equal(isRetestDue({ channelStatus: "enabled", lastTestedAt: "garbage", cycleDays: 0, now: NOW }), true);
});
