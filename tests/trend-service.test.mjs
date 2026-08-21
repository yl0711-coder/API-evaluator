// tests/trend-service.test.mjs
// buildProfileTrend 的集成测试：确保从数据库查询到组装 rounds 的完整链路中 runId 被正确保留。
import assert from "node:assert/strict";
import { test } from "node:test";
import { recordRequest, recordTestRun } from "../server/db.mjs";
import { buildProfileTrend } from "../server/trend-service.mjs";

// 测试使用真实数据库文件路径（每个测试独立隔离，通过 profileId 区分）。
// 不使用 :memory: 是因为 buildProfileTrend 内部调用多个数据库函数，
// 它们都需要访问同一个数据库实例，而 :memory: 在不同调用间无法共享状态。

test("rounds 中的 runId 必须保留：CSV 导出靠它关联「历次运行」与「逐轮请求」两张表", async () => {
  // 用时间戳确保每次测试的 profileId 完全独立，避免数据库残留污染
  const profileId = "test-profile-runid-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const runId1 = "run-alpha-" + Date.now();
  const runId2 = "run-beta-" + Date.now();
  const now = new Date("2026-08-20T10:00:00Z");
  const later = new Date("2026-08-20T11:00:00Z");

  // 录两轮稳定性运行，每轮 2 个请求。
  // 注意：必须提供 successRate 且非 null，否则 buildProfileTrend 的第 18 行
  // 过滤 `p.successRate !== null` 会把这个 runId 排除，导致其轮次被过滤掉。
  await recordTestRun({
    runId: runId1,
    profileId,
    type: "stability",
    model: "test-model",
    startedAt: now.toISOString(),
    endedAt: now.toISOString(),
    sampleSize: 2,
    successCount: 2,
    successRate: 1.0,
    totalMs: 3000,
  });
  await recordRequest({
    runId: runId1,
    profileId,
    model: "test-model",
    success: true,
    totalMs: 1200,
    startedAt: now.toISOString(),
  });
  await recordRequest({
    runId: runId1,
    profileId,
    model: "test-model",
    success: true,
    totalMs: 1800,
    startedAt: new Date(now.getTime() + 2000).toISOString(),
  });

  await recordTestRun({
    runId: runId2,
    profileId,
    type: "stability",
    model: "test-model",
    startedAt: later.toISOString(),
    endedAt: later.toISOString(),
    sampleSize: 2,
    successCount: 1,
    successRate: 0.5,
    totalMs: 31000,
  });
  await recordRequest({
    runId: runId2,
    profileId,
    model: "test-model",
    success: true,
    totalMs: 1000,
    startedAt: later.toISOString(),
  });
  await recordRequest({
    runId: runId2,
    profileId,
    model: "test-model",
    success: false,
    totalMs: 30000,
    normalizedError: "timeout",
    startedAt: new Date(later.getTime() + 1500).toISOString(),
  });

  const trend = await buildProfileTrend(profileId);

  // series 应有 2 个点（2 个 test_runs 行）。
  assert.equal(trend.series.length, 2);
  assert.equal(trend.series[0].runId, runId1);
  assert.equal(trend.series[1].runId, runId2);

  // rounds 应有 4 条（2+2 个 test_requests 行），每条必须带 runId。
  assert.equal(trend.rounds.length, 4);
  for (const r of trend.rounds) {
    assert.ok(r.runId, `rounds 的每一条必须有 runId，实际: ${JSON.stringify(r)}`);
    assert.ok([runId1, runId2].includes(r.runId), `runId 必须是已录入的 ${runId1} 或 ${runId2}，实际: ${r.runId}`);
  }

  // 前两条属于 runId1，后两条属于 runId2。
  assert.equal(trend.rounds[0].runId, runId1);
  assert.equal(trend.rounds[1].runId, runId1);
  assert.equal(trend.rounds[2].runId, runId2);
  assert.equal(trend.rounds[3].runId, runId2);

  // 回归：改前 runId 被丢弃，导致 CSV 导出的「运行ID」列全是空单元格。
  // 现在每条 round 都应该能通过 runId 关联回 series 里的对应运行。
  const runIdSet = new Set(trend.rounds.map((r) => r.runId));
  for (const pt of trend.series) {
    if (pt.runId) {
      assert.ok(runIdSet.has(pt.runId), `series 点 ${pt.runId} 应该能在 rounds 里找到对应的请求记录`);
    }
  }
});

test("场景运行的基础轮 rounds 同样保留 runId", async () => {
  // 用时间戳确保每次测试的 profileId 完全独立
  const profileId = "test-profile-scenario-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const runId = "run-scenario-basic-" + Date.now();
  const now = new Date("2026-08-20T12:00:00Z");

  // 录一个场景运行。注意：必须提供完整的 scenarios 数组（含 group 和 id），
  // collectBasicScenarioCaseIds 才能识别出其属于「基础」组。
  await recordTestRun({
    runId,
    profileId,
    type: "scenario",
    model: "test-model",
    startedAt: now.toISOString(),
    endedAt: now.toISOString(),
    sampleSize: 1,
    successCount: 1,
    successRate: 1.0,
    totalMs: 1500,
    scenarios: [{ id: "case-basic-1", group: "基础", name: "基础场景1", success: true, totalMs: 1500 }],
  });
  await recordRequest({
    runId,
    profileId,
    model: "test-model",
    caseId: "case-basic-1",
    success: true,
    totalMs: 1500,
    startedAt: now.toISOString(),
  });

  const trend = await buildProfileTrend(profileId);

  // 场景运行的基础轮应该进入 rounds，且带 runId。
  assert.equal(trend.rounds.length, 1);
  assert.equal(trend.rounds[0].runId, runId);
  assert.equal(trend.rounds[0].ms, 1500);
  assert.equal(trend.rounds[0].ok, 1);
});
