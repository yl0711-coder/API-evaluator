// server/newapi-token-plan.mjs
// 「从 new-api 上游渠道导入测试分组」的纯映射 + 编排（无 I/O，便于单测）。
// 数据由 newapi-token-import.mjs 取回，本文件只负责：new-api 令牌行 -> 我们的渠道/模型目标。
//
// 与 newapi-import.mjs（读 new-api 的 channels 表）的本质区别：
//   - newapi-import：建出的渠道**直连上游厂商**（baseUrl=api.openai.com，key=上游 key）。
//   - 本文件：建出的渠道**指回 new-api 自己**（baseUrl=用户填的 new-api 地址，key=令牌 sk-xxx，
//     走它的 /v1 中继）。
// 两者渠道来源不同、不该互相覆盖，故用独立的 source("newapi-token") 与独立的 id 前缀。
import crypto from "node:crypto";
import { TEST_TOKEN_KEYWORD, isTestTokenName } from "../shared/newapi-token-keyword.mjs";
import { deterministicModelTargetId } from "./channel-model.mjs";

// 筛选口径：固定「名称包含『测试』」，定义在 shared/ 供前端复用（见该文件的说明）。
export { TEST_TOKEN_KEYWORD };
export const isTestToken = isTestTokenName;

// 令牌的分组。new-api 里 Token.group 默认是空字符串，语义是「跟随用户自身的分组」，
// 不是「无分组」——空值必须回落到用户的 group，否则会按空分组去查模型、一个也查不到。
export function resolveTokenGroup(token, userGroup = "") {
  const g = String(token?.group ?? "").trim();
  return g || String(userGroup || "").trim();
}

// 分组 -> 模型名清单。/api/pricing 的每条带 enable_groups；出现 "all" 表示对所有分组开放，
// 过滤时不能漏掉这种（new-api 的 controller/pricing.go 有专门的短路判断）。
export function modelsForGroup(pricing, group) {
  const g = String(group || "").trim();
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(pricing) ? pricing : []) {
    const groups = Array.isArray(row?.enable_groups) ? row.enable_groups.map((x) => String(x)) : [];
    const open = groups.includes("all") || (g !== "" && groups.includes(g));
    const name = String(row?.model_name || "").trim();
    if (open && name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

// 协议按模型名推断（口径由用户指定）。一个渠道只能有一个协议，但同一分组下可能既有 claude 又有 gpt，
// 故按多数票取值，并把票数写进 notes 供人工核对。
//
// 注意（重要，勿当成 bug 改）：这些渠道走的是 new-api 的 /v1 中继，它对外统一是 OpenAI 兼容协议，
// 即使被测模型是 Claude，走 openai_compatible 才通。按模型名猜会让纯 Claude 分组被判成
// claude_messages -> 打 /v1/messages，new-api 若未开该路由会 404。这是已知取舍：
// 口径由用户明确指定，实现照办，但在 notes 与 UI 里写明，用户可自行改协议。
export function guessProtocol(models) {
  const list = Array.isArray(models) ? models : [];
  let claude = 0;
  for (const m of list) {
    if (String(m).toLowerCase().includes("claude")) claude += 1;
  }
  const other = list.length - claude;
  return {
    protocol: claude > other ? "claude_messages" : "openai_compatible",
    claude,
    other,
    mixed: claude > 0 && other > 0,
  };
}

// 渠道 notes：写清协议怎么来的，混合时追加告警。
export function buildProtocolNote({ claude, other, mixed }) {
  const base = `协议按模型名推断（claude ${claude} 个 / 其他 ${other} 个）。`;
  const mix = mixed ? "本组模型协议不一致，另一半模型可能不可用，请核对或拆分渠道。" : "";
  // 走 new-api /v1 中继时 OpenAI 兼容协议才通，这句对纯 Claude 分组尤其要紧。
  const relay = "注意：本渠道指向 new-api 的 /v1 中继，中继对外通常是 OpenAI 兼容协议；若测试报 404 请把协议改为 OpenAI Compatible。";
  return `${base}${mix}${relay}`;
}

// 本地渠道 id：掺 base 的哈希——令牌 id 只在单个 new-api 实例内唯一，
// 同时导入两个上游（都有 token id=3）会撞成同一个本地渠道。
// 安全：id 会被前端拼进 `data-edit-channel="${channel.id}"`（渠道 id 按约定是后端生成的安全值、不转义），
// 而 tokenId 来自上游 new-api —— 恶意/被攻陷的上游给个 `7" onmouseover=...` 就能打破属性。
// 故这里把它收窄成纯数字：非数字一律走 sanitized 分支，任何情况下 id 都只含 [a-z0-9-]。
const safeTokenIdPart = (tokenId) => {
  const s = String(tokenId ?? "");
  return /^\d+$/.test(s) ? s : `x${crypto.createHash("sha1").update(s).digest("hex").slice(0, 12)}`;
};

export function newapiTokenChannelLocalId(base, tokenId) {
  // 哈希仍用原始 tokenId：保证不同的异常 id 不会被 sanitize 成同一个渠道。
  const h = crypto
    .createHash("sha1")
    .update(`${String(base || "").replace(/\/+$/, "")}|${String(tokenId ?? "")}`)
    .digest("hex")
    .slice(0, 8);
  return `newapi-token-${h}-${safeTokenIdPart(tokenId)}`;
}

// 令牌 status：1=启用，2=禁用，3=过期，4=耗尽 -> 我们只分 enabled/disabled。
export function mapTokenStatus(status) {
  return Number(status) === 1 ? "enabled" : "disabled";
}

// 编排：令牌行 -> 渠道（每个令牌一个）+ 模型目标（按令牌分组下的模型展开）。纯函数。
// 返回 { channels, targets, keys:{channelId:明文key}, summary }。明文 key 只在 keys 里短暂带出，
// 端点负责存进加密库并丢弃，绝不落入 channels（不进库、不下发浏览器）。
export function buildTokenImportPlan({
  tokens = [],
  keys: keyById = {},
  pricing = [],
  userGroup = "",
  base = "",
  existingChannels = [],
  existingTargets = [],
} = {}) {
  const channels = existingChannels.map((c) => ({ ...c }));
  const targets = existingTargets.map((t) => ({ ...t }));
  const indexById = new Map(channels.map((c, i) => [c.id, i]));
  const targetKeys = new Set(targets.map((t) => `${t.channelId}|${t.model}`));
  const baseUrl = String(base || "").replace(/\/+$/, "");
  const keys = {};
  const now = new Date().toISOString();
  let imported = 0;
  let updated = 0;
  let newTargets = 0;
  let disabled = 0;
  let noGroup = 0;
  let noModels = 0;
  let mixedProtocol = 0;

  for (const token of tokens) {
    const localId = newapiTokenChannelLocalId(baseUrl, token.id);
    const group = resolveTokenGroup(token, userGroup);
    const models = modelsForGroup(pricing, group);
    const guess = guessProtocol(models);
    const status = mapTokenStatus(token.status);
    if (status === "disabled") disabled += 1;
    if (!group) noGroup += 1;
    if (!models.length) noModels += 1;
    if (guess.mixed) mixedProtocol += 1;

    const mapped = {
      id: localId,
      name: String(token.name || `new-api 令牌 ${token.id}`),
      provider: "",
      baseUrl,
      protocol: guess.protocol,
      models,
      status,
      source: "newapi-token",
      newapiTokenId: Number(token.id),
      newapiTokenGroup: group,
      notes: buildProtocolNote(guess),
    };

    const idx = indexById.get(localId);
    let channelId;
    if (idx === undefined) {
      channels.push({ ...mapped, createdAt: now, updatedAt: now });
      indexById.set(localId, channels.length - 1);
      channelId = localId;
      imported += 1;
    } else {
      // 保留已存在渠道的 id 与创建时间；凭证字段（apiKeyRef/keyHash/hasKey）由端点重新附上。
      const prev = channels[idx];
      channels[idx] = { ...prev, ...mapped, id: prev.id, createdAt: prev.createdAt || now, updatedAt: now };
      channelId = prev.id;
      updated += 1;
    }

    const plain = keyById?.[String(token.id)] ?? keyById?.[token.id];
    if (plain) keys[channelId] = String(plain);

    for (const model of models) {
      const key = `${channelId}|${model}`;
      if (targetKeys.has(key)) continue;
      targets.push({
        id: deterministicModelTargetId(channelId, model),
        channelId,
        model,
        note: "",
        maxTokens: 512,
        timeoutMs: 300000,
        inputPricePerMTokens: null,
        outputPricePerMTokens: null,
        inputSellPricePerMTokens: null,
        outputSellPricePerMTokens: null,
        source: "newapi-token",
        createdAt: now,
        updatedAt: now,
      });
      targetKeys.add(key);
      newTargets += 1;
    }
  }

  return {
    channels,
    targets,
    keys,
    summary: { total: tokens.length, imported, updated, newTargets, disabled, noGroup, noModels, mixedProtocol },
  };
}
