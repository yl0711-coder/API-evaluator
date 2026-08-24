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
import { requiredString, safeEntityId, safeUpstreamNumericId } from "./utils.mjs";

const CHANNEL_STATUSES = new Set(["enabled", "disabled"]);

const normalizeBaseUrl = (url) =>
  String(url || "")
    .trim()
    .replace(/\/+$/, "");
// 数字兜底：Number("abc")=NaN 不触发 ??，这里确保非有限值回落默认。
const toFinite = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export function normalizeChannelStatus(status) {
  return CHANNEL_STATUSES.has(status) ? status : "enabled";
}

/**
 * 导入链路生成渠道名的唯一入口。三条导入链路（newapi-import / newapi-token-plan /
 * sub2api-plan）都必须走这里，**不要再各自写 `String(上游名 || 兜底名)`**。
 *
 * 【为什么必须与 normalizeChannel 同口径】normalizeChannel 对 name 走 requiredString（会 trim），
 * 而 saveChannels 不做归一化、导入路径原样落库。两边口径一旦不一致，就会出两个真实缺陷
 * （都实测复现过，见 tests/import-merge.test.mjs 末尾两个用例）：
 *
 *   1) **上游改名永久同步不过来**。上游名带首尾空格时，导入落库 "名字 "、importSnapshot 也是 "名字 "；
 *      用户在 UI 里保存一次（哪怕什么都没改）→ normalizeChannel 把 name trim 成 "名字"，快照仍是
 *      "名字 " → 下次导入三方比对判定 `prev !== snapshot` = "用户改过名字" → 永久保留本地值，
 *      上游此后再改名都同步不过来，且导入汇总把这个字段计入 preserved（"保留了 N 个"），
 *      削弱该提示的可信度。这正是 import-merge.mjs 通篇警告的"三方合并退化"，只是触发点在 trim。
 *   2) **全空白名的渠道无法在 UI 里保存**。上游名是 "   " 时落库就是 "   "，用户之后编辑该渠道，
 *      requiredString trim 后为空 → 抛 400「渠道名称 不能为空」，该渠道再也存不了任何修改。
 *
 * 故先 trim 再判空回落兜底名：trim 后为空视同没给名字，用兜底名（而不是留下一个存不了的空白名）。
 */
export function importedChannelName(upstreamName, fallback) {
  return String(upstreamName ?? "").trim() || String(fallback ?? "").trim();
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
  const id = safeEntityId(body.id, existing?.id);
  const now = new Date().toISOString();
  const name = requiredString(body.name ?? existing?.name, "渠道名称");
  // 曾用名：改名时把旧名并入（去重、排除当前名），供报告按名字匹配时归并改名前的历史。
  const aliases = dedupeTags([
    ...(Array.isArray(existing?.aliases) ? existing.aliases : []),
    ...(existing?.name && existing.name !== name ? [existing.name] : []),
  ]).filter((a) => a !== name);
  return {
    id,
    name,
    aliases,
    provider: String(body.provider ?? existing?.provider ?? "").trim(),
    baseUrl: normalizeBaseUrl(body.baseUrl ?? existing?.baseUrl),
    protocol: normalizeProtocol(body.protocol ?? existing?.protocol),
    models: normalizeModelList(body.models ?? existing?.models),
    status: normalizeChannelStatus(body.status ?? existing?.status),
    source: body.source || existing?.source || "manual", // manual | newapi | newapi-token
    // 三个上游数值 id 统一走 safeUpstreamNumericId：前端把 sub2apiKeyId 不转义拼进文本，
    // 非数字会被当 HTML 渲染（详见该函数上的说明）。另两个同类字段一并收口，不留下一个"下次
    // 谁把它拼进模板就中招"的缺口。
    newapiChannelId: safeUpstreamNumericId(body.newapiChannelId ?? existing?.newapiChannelId),
    // 「导入测试分组」带来的溯源字段：这是**白名单**，不在表里的字段编辑渠道时会被静默抹掉，
    // 所以新增来源字段必须同步加在这里（漏加的表现是：用户在 UI 里编辑过的渠道，溯源信息凭空消失）。
    newapiTokenId: safeUpstreamNumericId(body.newapiTokenId ?? existing?.newapiTokenId),
    newapiTokenGroup: body.newapiTokenGroup ?? existing?.newapiTokenGroup ?? null,
    // 「从 sub2api 导入测试分组」的溯源字段，同理必须在白名单里。
    sub2apiKeyId: safeUpstreamNumericId(body.sub2apiKeyId ?? existing?.sub2apiKeyId),
    sub2apiGroupId: safeUpstreamNumericId(body.sub2apiGroupId ?? existing?.sub2apiGroupId),
    sub2apiGroupName: body.sub2apiGroupName ?? existing?.sub2apiGroupName ?? null,
    // 上次导入时上游给的 name/protocol/models 快照。重新导入靠它三方比对出「哪些字段是用户改的」
    // 从而不覆盖（见 server/import-merge.mjs）。**必须留在白名单里**：漏掉的话用户在 UI 里编辑过一次，
    // 快照就没了，下次导入退化成全量覆盖，用户的手工修正被静默推翻——正是这个字段要解决的问题。
    importSnapshot: body.importSnapshot ?? existing?.importSnapshot ?? null,
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
// 标签为纯本地概念（单一状态）：tags=该模型在本渠道下被授予的能力标签，不再与 new-api 联动、不再跨渠道统一。
export function normalizeModelTarget(body, existing = null) {
  const now = new Date().toISOString();
  // 场景测验夺标得到的能力标签：编辑模型目标（POST 全量覆盖）时保留，别被清空。
  const tags = dedupeTags(Array.isArray(body.tags) ? body.tags : existing?.tags);
  const model = requiredString(body.model ?? existing?.model, "模型名");
  // 曾用名：改模型名时把旧名并入（去重、排除当前名），供报告按名字匹配时归并改名前的历史。
  const aliases = dedupeTags([
    ...(Array.isArray(existing?.aliases) ? existing.aliases : []),
    ...(existing?.model && existing.model !== model ? [existing.model] : []),
  ]).filter((a) => a !== model);
  return {
    id: safeEntityId(body.id, existing?.id),
    channelId: requiredString(body.channelId ?? existing?.channelId, "渠道"),
    model,
    note: String(body.note ?? existing?.note ?? "").trim(),
    // v0.3.x 后：最大输出/超时/单价从渠道层下沉到模型目标层——每个「渠道+模型」各自独立配置。
    maxTokens: toFinite(body.maxTokens ?? existing?.maxTokens, 512),
    timeoutMs: toFinite(body.timeoutMs ?? existing?.timeoutMs, 300000),
    ...pricingFields(body, existing || {}),
    source: body.source || existing?.source || "manual",
    tags,
    aliases,
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
    // 最大输出/超时/单价已下沉到模型目标层，从 modelTarget 取（不再来自 channel）。
    maxTokens: modelTarget.maxTokens,
    timeoutMs: modelTarget.timeoutMs,
    inputPricePerMTokens: modelTarget.inputPricePerMTokens,
    outputPricePerMTokens: modelTarget.outputPricePerMTokens,
    inputSellPricePerMTokens: modelTarget.inputSellPricePerMTokens,
    outputSellPricePerMTokens: modelTarget.outputSellPricePerMTokens,
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
    // 经济字段（最大输出/超时/单价）随模型目标走，跟随下沉后的数据模型。
    maxTokens: Number(profile.maxTokens || 512),
    timeoutMs: Number(profile.timeoutMs || 300000),
    ...pricingFields(profile),
    createdAt: profile.createdAt || new Date().toISOString(),
    updatedAt: profile.updatedAt || new Date().toISOString(),
  };
  return { channel, target };
}
