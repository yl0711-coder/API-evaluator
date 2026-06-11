// 单一事实源：把"渠道 + 模型目标"还原成可运行测试目标列表，并合并未迁移的孤儿老 profile。
// 总览计数(app.js)、运行下拉(profile-view)、引导(workflow-guide)都调这里，
// 避免同一套"还原 + 跳过已迁移老 profile"逻辑散落多处、改一处漏一处导致数字与下拉对不上。
// 与后端 server/run-targets.mjs:loadRunnableProfiles 语义对齐。
export function resolveRunnableTargets({ channels = [], modelTargets = [], profiles = [] } = {}) {
  const byChannel = new Map(channels.map((channel) => [channel.id, channel]));
  const channelIds = new Set(channels.map((channel) => channel.id));
  const out = [];
  for (const target of modelTargets) {
    const channel = byChannel.get(target.channelId);
    if (!channel) continue; // 渠道已删 -> 不可运行
    out.push({ id: target.id, name: `${channel.name} / ${target.model}`, model: target.model, source: "target", channelStatus: channel.status });
  }
  // 未被迁移成渠道的老 profile（孤儿）本身是"渠道+模型"二合一，作为遗留可运行目标补入；
  // 其 id 若等于某渠道 id 说明已迁移，跳过避免重复。
  for (const profile of profiles) {
    if (profile.role !== "target" && profile.role !== "baseline") continue;
    if (channelIds.has(profile.id)) continue;
    out.push({ id: profile.id, name: profile.name, model: profile.defaultModel, source: "legacy", role: profile.role });
  }
  return out;
}
