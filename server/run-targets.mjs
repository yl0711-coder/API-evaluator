// server/run-targets.mjs
// 运行入口的“可运行目标”解析：把 模型目标(model-target) + 其渠道 还原成 profile 形状，
// 与老 profile 合并成一个列表，喂给现有 test-runner 的各 run 函数（它们都按 id 查找）。
// 过渡期同时返回两者：迁移后的渠道经 model-target 可运行，老 profile 也仍可用，互不破坏。
import { loadProfiles } from "./profile-store.mjs";
import { loadChannels } from "./channel-store.mjs";
import { loadModelTargets } from "./model-target-store.mjs";
import { resolveTestTarget } from "./channel-model.mjs";

// 临时（不落库）目标：复用某渠道的 baseUrl/Key/协议，但模型名任填——不需要先在「模型管理」
// 建一条正式的 model-target 记录。用于「标准评测」对渠道下尚未登记的模型做一次性探测
// （如新上线的 Claude 档位快速核验），跑完即弃、不出现在模型管理列表里。
// 找不到渠道 / 渠道已禁用 → 返回 null，调用方据此报错（与 loadRunnableProfiles 找不到目标同等对待）。
export async function resolveAdhocTarget({ channelId, model }) {
  const channels = await loadChannels();
  const channel = channels.find((item) => item.id === channelId);
  if (!channel || channel.status === "disabled") return null;
  const modelName = String(model || "").trim();
  if (!modelName) return null;
  return resolveTestTarget(
    { id: `adhoc:${channelId}:${modelName}`, channelId, model: modelName, maxTokens: 512, timeoutMs: 300000 },
    channel,
  );
}

export async function loadRunnableProfiles() {
  const [profiles, channels, targets] = await Promise.all([loadProfiles(), loadChannels(), loadModelTargets()]);
  const byChannel = new Map(channels.map((channel) => [channel.id, channel]));
  const channelIds = new Set(channels.map((channel) => channel.id));
  const resolved = targets.map((target) => resolveTestTarget(target, byChannel.get(target.channelId))).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const item of resolved) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      out.push(item);
    }
  }
  // 过渡期：只补“未被迁移成渠道”的老 profile（其 id 不是任何渠道 id），
  // 避免迁移后同一目标既以渠道/模型目标、又以老 profile 重复出现。与前端 renderRunTargetSelectOptions 同源。
  for (const profile of profiles) {
    if (channelIds.has(profile.id)) continue;
    if (!seen.has(profile.id)) {
      seen.add(profile.id);
      out.push(profile);
    }
  }
  return out;
}
