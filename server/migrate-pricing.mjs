// server/migrate-pricing.mjs
// 一次性数据迁移：把「最大输出/超时/单价」从渠道层下沉到模型目标层后，
// 把各渠道已配的这些值复制到其名下每个模型目标作起点，避免升级后旧配置丢失。
//
// 幂等：靠 target.maxTokens === undefined 识别「旧形状」（拆分后、下沉前的模型目标从没有过这些字段）。
//   迁移后字段变数字、之后经 normalizeModelTarget 新建的目标都已带这些字段，故不会被再次命中——无需额外标志位。
// 经 store 层读写，SQLite 与 JSON 两种持久化都覆盖。best-effort：不阻塞启动。
import { loadModelTargets, saveModelTargets } from "./model-target-store.mjs";
import { loadChannels } from "./channel-store.mjs";

// 纯逻辑（无 I/O，便于单测）：把各渠道现值复制到「旧形状」模型目标（原地改 targets），返回改动条数。
// 旧形状判据：t.maxTokens === undefined —— 只有下沉前建的目标才没有这些字段，故天然幂等。
export function applyPricingMigration(targets, channels) {
  const list = Array.isArray(targets) ? targets : [];
  const needs = list.filter((t) => t && t.maxTokens === undefined);
  if (!needs.length) return { targets: list, migrated: 0 };
  const byId = new Map((Array.isArray(channels) ? channels : []).map((c) => [c.id, c]));
  for (const t of needs) {
    const c = byId.get(t.channelId) || {};
    t.maxTokens = c.maxTokens ?? 512;
    t.timeoutMs = c.timeoutMs ?? 300000;
    t.inputPricePerMTokens = c.inputPricePerMTokens ?? null;
    t.outputPricePerMTokens = c.outputPricePerMTokens ?? null;
    t.inputSellPricePerMTokens = c.inputSellPricePerMTokens ?? null;
    t.outputSellPricePerMTokens = c.outputSellPricePerMTokens ?? null;
  }
  return { targets: list, migrated: needs.length };
}

// I/O 包装：读模型目标 + 渠道，套迁移，仅在有改动时落盘。
export async function migratePricingToTargetsOnce() {
  const { targets, migrated } = applyPricingMigration(await loadModelTargets(), await loadChannels());
  if (migrated) await saveModelTargets(targets);
  return { migrated };
}
