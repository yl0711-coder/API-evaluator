// src/model-test-status.js
// 「模型管理」卡片的「上次测试时间」与「需测」判定纯函数（无 DOM 依赖，便于单测）。
// 数据来源：GET /api/model-targets 注入的 target.lastTestedAt（ISO 文本或 null）+ 设置里的 testCycleDays。

// 上次测试日期（精确到天）：有值 → 本地 YYYY-MM-DD；无/不可解析 → "从未测试"。
export function formatLastTested(lastTestedAt) {
  if (!lastTestedAt) return "从未测试";
  const t = Date.parse(lastTestedAt);
  if (!Number.isFinite(t)) return "从未测试";
  const d = new Date(t);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// 是否「需测」：仅对可测(enabled)模型生效。
//   从未测过 → 始终 true（与周期无关，用户明确要求）；
//   已测过 → 仅当 cycleDays>0 且距上次测试已超过 cycleDays 天才 true。
// 已禁用 / 渠道缺失 → 始终 false（保留其原徽章）。
export function isRetestDue({ channelStatus, lastTestedAt, cycleDays, now }) {
  if (channelStatus === "disabled" || channelStatus === "missing") return false;
  if (!lastTestedAt) return true; // 从未测试 → 需测
  const last = Date.parse(lastTestedAt);
  if (!Number.isFinite(last)) return true; // 时间戳坏掉 → 视为未测
  const days = Math.trunc(Number(cycleDays) || 0);
  if (days <= 0) return false; // 未设周期 → 已测过的不催
  return now - last > days * 86400000;
}
