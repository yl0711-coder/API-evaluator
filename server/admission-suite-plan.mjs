// server/admission-suite-plan.mjs
// 一键准入复合任务的【步骤计划】。单独成文件只有一个原因：打破 import 环。
//
// task-manager 建任务时要先算进度总单元数（estimateTaskUnits），而 admission-suite 执行时要用
// task-manager 的 assertTaskNotCancelled/updateTaskProgress——两边互相 import 就成环
// （tests/no-cycles.test.mjs 会红）。把计划抽到这个零依赖模块，两边都只依赖它，环就断了。
//
// 也不能在 task-manager 里另写一份单元数公式：进度条和「模型 × 步骤」网格一旦按两套口径算，
// 就会出现"进度 100% 但还有步骤是 pending"这种自相矛盾的画面。计划只有这一处。

/**
 * 组装步骤计划。计划由【服务端】拥有——前端只提交"测哪些模型"，不再决定执行顺序，
 * 否则刷新页面后没人知道原定要跑什么。
 */
export function buildSuitePlan(payload = {}) {
  const profileIds = (Array.isArray(payload.profileIds) ? payload.profileIds : []).map((id) => String(id || "").trim()).filter(Boolean);
  const modelNames = Array.isArray(payload.modelNames) ? payload.modelNames : [];
  const groups = profileIds.map((profileId, index) => ({
    key: profileId,
    label: modelNames[index] || profileId,
    profileId,
    isTierProbe: false,
    steps: [
      { name: "quick", label: "快速测试" },
      { name: "stability", label: "稳定性测试（3 组 × 3 轮 = 9 轮）" },
      { name: "admission", label: "标准准入" },
    ],
  }));

  // Claude 新档位探测：非阻断观察项，只在必选模型全部跑完后执行（PRD 7.7）。
  const tierModels = Array.isArray(payload.tierProbeModels) ? payload.tierProbeModels.filter(Boolean) : [];
  const channelId = String(payload.claudeChannelId || "").trim();
  if (channelId && tierModels.length) {
    for (const model of tierModels) {
      groups.push({
        key: `tier:${model}`,
        label: `${model}（新档位探测）`,
        isTierProbe: true,
        channelId,
        model,
        steps: [{ name: "admission-quick", label: "快速准入" }],
      });
    }
  }
  return groups;
}

/** 进度单元 = 全部步骤数。用于 task.progress 百分比。 */
export function countSuiteUnits(payload = {}) {
  return buildSuitePlan(payload).reduce((sum, group) => sum + group.steps.length, 0) || 1;
}
