// server/scenario-tag-award.mjs
// 场景测验「夺标」纯逻辑：从一次测试 summary 推导每个模型目标应新增的能力标签，并合并进目标列表。
// 与 I/O 解耦（不读设置、不落库、不取时间），供 test-runner.awardScenarioTags 编排并单测。
// 标签语义：能力标签只增不撤（并集去重），某模型在某场景达阈值即获该场景的标签。

// 场景测验夺标阈值：逐场景质量分达到此值（含）即授予该场景的能力标签。
export const TAG_AWARD_MIN_SCORE = 90;

// 从 summary.results 推导 profileId -> 应得标签集合。
//   - 仅统计有 profileId 的结果；
//   - 场景 avgQualityScore >= minScore 且该场景配了 tag 时计入；
//   - 仅返回确有所得的 profile（空集合不入表）。
// selectedScenarios: [{ id, tag }]；scenario.id 对应 record 里的 sc.scenarioId。
export function computeEarnedTags(summary, selectedScenarios, minScore = TAG_AWARD_MIN_SCORE) {
  const tagByScenarioId = new Map(
    (Array.isArray(selectedScenarios) ? selectedScenarios : []).map((s) => [s?.id, s?.tag]).filter(([, t]) => t),
  );
  const earnedByProfile = new Map();
  for (const r of summary?.results || []) {
    if (!r?.profileId) continue;
    const earned = new Set();
    for (const sc of r.scenarios || []) {
      if (Number(sc.avgQualityScore) >= minScore) {
        const tag = tagByScenarioId.get(sc.scenarioId);
        if (tag) earned.add(tag);
      }
    }
    if (earned.size) earnedByProfile.set(r.profileId, earned);
  }
  return earnedByProfile;
}

// 把 earnedByProfile 合并进 targets（按 target.id === profileId 匹配）。并集去重、只增不撤。
// 原地修改命中的 target（写入并集后的 tags 与 updatedAt=nowIso），返回是否有改动。
// 只有「真的新增了标签」才标记改动并刷新 updatedAt——重复夺已有标签不应无谓回写。
export function applyEarnedTags(targets, earnedByProfile, nowIso) {
  let changed = false;
  for (const t of Array.isArray(targets) ? targets : []) {
    const earned = earnedByProfile.get(t.id);
    if (!earned) continue;
    const cur = new Set(Array.isArray(t.tags) ? t.tags : []);
    const before = cur.size;
    earned.forEach((x) => cur.add(x));
    if (cur.size !== before) {
      t.tags = [...cur];
      t.updatedAt = nowIso;
      changed = true;
    }
  }
  return changed;
}
