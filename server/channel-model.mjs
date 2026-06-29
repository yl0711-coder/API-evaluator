// server/channel-model.mjs
// v0.3.0 数据模型：把原先 url+key+model 捆在一起的 profile 拆成两层——
//   - channel（渠道）：连接信息（url + key + 协议 + 供应商 + 价格 + 超时 + 状态 + 已知模型清单），
//     超管维护、持 key；
//   - model-target（测试模型）：引用某 channel + 一个模型名，管理员维护、永不见 key。
// 运行 / 报告层不改：resolveTestTarget 把 (model-target + channel) 还原成等价的 profile 形状，
// 直接喂给现有 test-runner，避免大面积改动。
// 本文件全是纯函数、无 I/O，便于单测；凭证（apiKeyRef/keyHash 等）由 channel-store 调 secret-store 维护。
import crypto from "node:crypto";
import { normalizePricePerMillion } from "./costing.mjs";
import { normalizeProtocol } from "./profile-store.mjs";
import { requiredString } from "./utils.mjs";

const CHANNEL_STATUSES = new Set(["enabled", "disabled"]);
const normalizeBaseUrl = (url) => String(url || "").trim().replace(/\/+$/, "");
// 数字兜底：Number("abc")=NaN 不触发 ??，这里确保非有限值回落默认。
const toFinite = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export function normalizeChannelStatus(status) {
  return CHANNEL_STATUSES.has(status) ? status : "enabled";
}

// 模型清单：接受数组或逗号分隔字符串，去空白、去重、保序。
export function normalizeModelList(input) {
  const arr = Array.isArray(input) ? input : String(input || "").split(/[,，]/);
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const name = String(item || "").trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

const pricingFields = (src, existing = {}) => ({
  inputPricePerMTokens: normalizePricePerMillion(src.inputPricePerMTokens ?? existing.inputPricePerMTokens),
  outputPricePerMTokens: normalizePricePerMillion(src.outputPricePerMTokens ?? existing.outputPricePerMTokens),
  inputSellPricePerMTokens: normalizePricePerMillion(src.inputSellPricePerMTokens ?? existing.inputSellPricePerMTokens),
  outputSellPricePerMTokens: normalizePricePerMillion(src.outputSellPricePerMTokens ?? existing.outputSellPricePerMTokens),
});

// 规范化一个渠道（不含凭证字段——那些由 channel-store 维护）。
export function normalizeChannel(body, existing = null) {
  const id = String(body.id || existing?.id || crypto.randomUUID());
  const now = new Date().toISOString();
  return {
    id,
    name: requiredString(body.name ?? existing?.name, "渠道名称"),
    provider: String(body.provider ?? existing?.provider ?? "").trim(),
    baseUrl: normalizeBaseUrl(body.baseUrl ?? existing?.baseUrl),
    protocol: normalizeProtocol(body.protocol ?? existing?.protocol),
    maxTokens: toFinite(body.maxTokens ?? existing?.maxTokens, 512),
    timeoutMs: toFinite(body.timeoutMs ?? existing?.timeoutMs, 60000),
    ...pricingFields(body, existing || {}),
    models: normalizeModelList(body.models ?? existing?.models),
    status: normalizeChannelStatus(body.status ?? existing?.status),
    source: body.source || existing?.source || "manual", // manual | newapi
    newapiChannelId: body.newapiChannelId ?? existing?.newapiChannelId ?? null,
    notes: String(body.notes ?? existing?.notes ?? "").trim(),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

// 标签数组去空白、去重、保序。
function dedupeTags(input) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(input) ? input : []) {
    const v = String(item || "").trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

// 规范化一个测试模型目标：引用渠道 + 模型名。
// 标签三态：tags=存活标签；pushedTags⊆tags 为已推送/已同步（橙）；tags−pushedTags 为新增未推送（黄）；
//   removedTags 为本地已删但 new-api 仍在（灰，待手动删）。
export function normalizeModelTarget(body, existing = null) {
  const now = new Date().toISOString();
  // 场景测验夺标得到的能力标签：编辑模型目标（POST 全量覆盖）时保留，别被清空。
  const tags = dedupeTags(Array.isArray(body.tags) ? body.tags : existing?.tags);
  // 旧记录无 pushedTags → 旧标签全部按「已同步」处理（升级后显示橙色）；再并上灰名单（灰标签本就在 new-api）。
  const prevPushed = new Set([
    ...(Array.isArray(existing?.pushedTags) ? existing.pushedTags : Array.isArray(existing?.tags) ? existing.tags : []),
    ...(Array.isArray(existing?.removedTags) ? existing.removedTags : []),
  ]);
  return {
    id: String(body.id || existing?.id || crypto.randomUUID()),
    channelId: requiredString(body.channelId ?? existing?.channelId, "渠道"),
    model: requiredString(body.model ?? existing?.model, "模型名"),
    note: String(body.note ?? existing?.note ?? "").trim(),
    source: body.source || existing?.source || "manual",
    tags,
    // 仅保留仍存活且此前已推送的标签为橙；新勾选的标签不在 prevPushed → 黄。
    pushedTags: tags.filter((t) => prevPushed.has(t)),
    // 若用户在表单里重新勾回某个灰标签，则它从灰名单移除、恢复为存活标签。
    removedTags: dedupeTags(existing?.removedTags).filter((t) => !tags.includes(t)),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

// 把 new-api 上某模型的标签（incoming）合并进模型目标，返回是否有改动（原地修改 target）。
//   - 灰名单对账：new-api 已无的灰标签 → 去掉灰提示；仍在的保留为灰（不复活，尊重本地删除意图）。
//   - liveIncoming：来自 new-api 且未被本地主动删除的标签 → 并入 tags 且标橙。
export function applyNewapiTagsToTarget(target, incoming) {
  const before = JSON.stringify([target.tags, target.pushedTags, target.removedTags]);
  const incomingTags = dedupeTags(incoming);
  const incomingSet = new Set(incomingTags);
  const removed = dedupeTags(target.removedTags).filter((t) => incomingSet.has(t)); // new-api 已删则清灰
  const removedSet = new Set(removed);
  const liveIncoming = incomingTags.filter((t) => !removedSet.has(t));
  const liveSet = new Set(liveIncoming);
  const tags = dedupeTags([...(Array.isArray(target.tags) ? target.tags : []), ...liveIncoming]);
  // 旧记录无 pushedTags → 既有标签全部按已同步（橙）处理。
  const prevPushed = new Set(Array.isArray(target.pushedTags) ? target.pushedTags : Array.isArray(target.tags) ? target.tags : []);
  // 已推送 = 仍存活且此前已推送的标签 ∪ 本次来自 new-api 的标签（皆为橙）。
  const pushed = tags.filter((t) => prevPushed.has(t) || liveSet.has(t));
  target.tags = tags;
  target.pushedTags = pushed;
  target.removedTags = removed;
  const changed = JSON.stringify([target.tags, target.pushedTags, target.removedTags]) !== before;
  if (changed) target.updatedAt = new Date().toISOString();
  return changed;
}

// 「同步」：以 new-api 为准刷新模型目标标签。new-api 上该模型的标签为橙（已同步）；
// 本地「明黄（未推送）且 new-api 没有」的标签予以保留（不丢未推送的本地工作）；
// 橙色标签以 new-api 为准——不在 new-api 则移除。清空灰名单。返回是否有改动（原地修改 target）。
export function syncTagsFromNewapi(target, incoming) {
  const before = JSON.stringify([target.tags, target.pushedTags, target.removedTags]);
  const incomingTags = dedupeTags(incoming);
  const incomingSet = new Set(incomingTags);
  const prevTags = dedupeTags(target.tags);
  // 旧记录无 pushedTags → 既有标签视为已推送（橙），不当明黄保留。
  const prevPushed = new Set(Array.isArray(target.pushedTags) ? target.pushedTags : prevTags);
  // 明黄（本地未推送）且 new-api 没有的标签 → 保留为黄。
  const pending = prevTags.filter((t) => !prevPushed.has(t) && !incomingSet.has(t));
  target.tags = dedupeTags([...incomingTags, ...pending]);
  target.pushedTags = [...incomingTags]; // 仅来自 new-api 的为橙
  target.removedTags = [];
  const changed = JSON.stringify([target.tags, target.pushedTags, target.removedTags]) !== before;
  if (changed) target.updatedAt = new Date().toISOString();
  return changed;
}

// 把 canonical 的标签三态镜像到所有同名（同 model）目标，实现「改一个 → 同名全统一」。
// 返回是否改动了除 canonical 以外的目标。canonical 自身也会被赋值（幂等、无副作用）。
export function unifySameNameTags(targets, canonical) {
  let changedOthers = false;
  for (const t of targets) {
    if (t.model !== canonical.model) continue;
    const next = {
      tags: dedupeTags(canonical.tags),
      pushedTags: dedupeTags(canonical.pushedTags),
      removedTags: dedupeTags(canonical.removedTags),
    };
    const before = JSON.stringify([t.tags, t.pushedTags, t.removedTags]);
    if (before !== JSON.stringify([next.tags, next.pushedTags, next.removedTags])) {
      t.tags = next.tags;
      t.pushedTags = next.pushedTags;
      t.removedTags = next.removedTags;
      t.updatedAt = new Date().toISOString();
      if (t.id !== canonical.id) changedOthers = true;
    }
  }
  return changedOthers;
}

// 判重键：渠道按 baseUrl + keyHash（同地址同密钥即同渠道，模型不再参与）；
//   模型目标按 channelId + model。
export function channelDedupKey(channel) {
  return `${normalizeBaseUrl(channel.baseUrl)}|${channel.keyHash || ""}`;
}
export function modelTargetDedupKey(target) {
  return `${target.channelId}|${target.model}`;
}

// 把 (model-target + 其 channel) 还原成等价的 profile 形状，喂给现有 test-runner / 汇总 / 报告。
// channel 缺失或被禁用时，调用方据 channelStatus 决定是否拦截。
export function resolveTestTarget(modelTarget, channel) {
  if (!channel) return null;
  return {
    id: modelTarget.id,
    role: "target",
    name: `${channel.name} / ${modelTarget.model}`,
    provider: channel.provider,
    baseUrl: channel.baseUrl,
    apiKeyRef: channel.apiKeyRef,
    keyStorage: channel.keyStorage,
    hasKey: Boolean(channel.hasKey || channel.apiKeyRef),
    protocol: channel.protocol,
    defaultModel: modelTarget.model,
    maxTokens: channel.maxTokens,
    timeoutMs: channel.timeoutMs,
    inputPricePerMTokens: channel.inputPricePerMTokens,
    outputPricePerMTokens: channel.outputPricePerMTokens,
    inputSellPricePerMTokens: channel.inputSellPricePerMTokens,
    outputSellPricePerMTokens: channel.outputSellPricePerMTokens,
    channelId: channel.id,
    channelStatus: channel.status,
  };
}

// 确定性的 model-target id（按 channelId + model），让迁移 / 导入可重复执行而不产生重复。
export function deterministicModelTargetId(channelId, model) {
  return `mt_${crypto.createHash("sha1").update(`${channelId}|${model}`).digest("hex").slice(0, 16)}`;
}

// 一次性迁移：老 profile → 1 个 channel + 1 个 model-target。
// 复用 profile.id 作 channel.id，保持 apiKeyRef（profile:<id>:api-key）不变，无需重存密钥。
export function migrateProfileToChannelAndTarget(profile) {
  const channelId = profile.id;
  const channel = {
    id: channelId,
    name: profile.name,
    provider: profile.provider || "",
    baseUrl: normalizeBaseUrl(profile.baseUrl),
    apiKeyRef: profile.apiKeyRef || "",
    keyStorage: profile.keyStorage || "",
    hasKey: Boolean(profile.hasKey || profile.apiKeyRef),
    keyHash: profile.keyHash || null,
    protocol: normalizeProtocol(profile.protocol),
    maxTokens: Number(profile.maxTokens || 512),
    timeoutMs: Number(profile.timeoutMs || 60000),
    ...pricingFields(profile),
    models: profile.defaultModel ? [String(profile.defaultModel)] : [],
    status: "enabled",
    source: "manual",
    newapiChannelId: null,
    notes: profile.notes || "",
    createdAt: profile.createdAt || new Date().toISOString(),
    updatedAt: profile.updatedAt || new Date().toISOString(),
  };
  const target = {
    id: deterministicModelTargetId(channelId, String(profile.defaultModel || "")),
    channelId,
    model: String(profile.defaultModel || ""),
    note: "",
    createdAt: profile.createdAt || new Date().toISOString(),
    updatedAt: profile.updatedAt || new Date().toISOString(),
  };
  return { channel, target };
}
