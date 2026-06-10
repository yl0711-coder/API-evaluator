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

// 规范化一个测试模型目标：引用渠道 + 模型名。
export function normalizeModelTarget(body, existing = null) {
  const now = new Date().toISOString();
  return {
    id: String(body.id || existing?.id || crypto.randomUUID()),
    channelId: requiredString(body.channelId ?? existing?.channelId, "渠道"),
    model: requiredString(body.model ?? existing?.model, "模型名"),
    note: String(body.note ?? existing?.note ?? "").trim(),
    source: body.source || existing?.source || "manual",
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
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
