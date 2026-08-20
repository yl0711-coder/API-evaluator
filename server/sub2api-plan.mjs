// server/sub2api-plan.mjs
// 「从 sub2api 上游渠道导入测试分组」的纯映射 + 编排（无 I/O，便于单测）。
// 数据由 sub2api-import.mjs 取回，本文件只负责：sub2api 密钥行 -> 我们的渠道/模型目标。
//
// 与 newapi-token-plan.mjs 的关系：形态相同（一个上游凭据 = 一个渠道 + 其分组下的模型），
// 但上游协议完全不同，故独立成文件而非加分支。三点关键差异：
//   1. sub2api 的密钥列表**直接返回明文 key**（new-api 要另调 batch/keys 取明文）。
//   2. 分组自带 platform 字段（上游声明的平台），**不必像 new-api 那样猜模型名**——
//      上回 new-api 那边实测 120 个渠道 60 个协议混合，正是只能投票所致；这里没有该问题。
//   3. source 用 "sub2api"，与 "newapi" / "newapi-token" 三者互不覆盖。
import crypto from "node:crypto";
import { deterministicModelTargetId } from "./channel-model.mjs";
import { finalizeImportedNotes, importSnapshotOf, mergeImportedChannel } from "./import-merge.mjs";

// 分组的 platform -> 我们的协议。这是上游**声明**的平台，比按模型名投票可靠。
// 只有 anthropic 走 Claude Messages；openai / gemini / 其它一律按 OpenAI 兼容
// （sub2api 的 /v1 中继对外就是 OpenAI 兼容形态）。
export function platformToProtocol(platform) {
  return String(platform || "").toLowerCase() === "anthropic" ? "claude_messages" : "openai_compatible";
}

// model-plaza 的 groups[] -> Map<groupId, {name, platform, models[]}>。
// 模型名去重保序；分组 id 统一成字符串键，避免 Number/String 键取不到。
export function buildGroupIndex(plaza) {
  const index = new Map();
  const groups = Array.isArray(plaza?.groups) ? plaza.groups : [];
  for (const g of groups) {
    if (!g || g.id == null) continue;
    const seen = new Set();
    const models = [];
    for (const m of Array.isArray(g.models) ? g.models : []) {
      const name = String(m?.name || "").trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        models.push(name);
      }
    }
    index.set(String(g.id), {
      name: String(g.name || "").trim(),
      platform: String(g.platform || "").trim(),
      models,
    });
  }
  return index;
}

// 安全：id 会被前端拼进 `data-edit-channel="${channel.id}"`（渠道 id 按约定是后端生成的安全值、
// 不转义），而 keyId 来自上游 sub2api —— 恶意/被攻陷的上游给个 `7" onmouseover=...` 就能打破属性。
// 这是 new-api 那条链路上真实踩到过的 XSS，此处沿用同一处理：收窄成纯数字，非数字走哈希分支，
// 任何输入下 id 都只含 [a-z0-9-]。
const safeKeyIdPart = (keyId) => {
  const s = String(keyId ?? "");
  return /^\d+$/.test(s) ? s : `x${crypto.createHash("sha1").update(s).digest("hex").slice(0, 12)}`;
};

export function sub2apiChannelLocalId(base, keyId) {
  // 哈希用原始 keyId：保证不同的异常 id 不会被 sanitize 成同一个渠道。
  const h = crypto
    .createHash("sha1")
    .update(`${String(base || "").replace(/\/+$/, "")}|${String(keyId ?? "")}`)
    .digest("hex")
    .slice(0, 8);
  return `sub2api-key-${h}-${safeKeyIdPart(keyId)}`;
}

// sub2api 密钥 status 是字符串：active / inactive。
export function mapKeyStatus(status) {
  return String(status || "").toLowerCase() === "active" ? "enabled" : "disabled";
}

// 渠道 notes：写明协议来源，并保留中继协议的提示。
// platform 缺失（走 /v1/models 回落时拿不到分组元信息）要如实说明，别假装知道。
export function buildSub2apiNote({ platform, groupName, viaFallback }) {
  const src = platform
    ? `协议按分组声明的 platform=${platform} 判定（非猜测）。`
    : "上游未提供分组 platform（模型广场未启用，已按密钥回落 /v1/models），协议按 OpenAI 兼容处理。";
  const grp = groupName ? `分组：${groupName}。` : "";
  const fb = viaFallback ? "模型清单来自 /v1/models（该密钥实际可调模型）。" : "";
  const relay = "注意：本渠道指向 sub2api 的 /v1 中继；若测试报 404，说明中继未开该协议端点，请改用 OpenAI Compatible。";
  return `${src}${grp}${fb}${relay}`;
}

// 编排：密钥行 -> 渠道（每个密钥一个）+ 模型目标（按密钥所属分组下的模型展开）。纯函数。
// keyModels: { [keyId]: string[] } —— 仅在 model-plaza 不可用、逐密钥调 /v1/models 时提供。
// 返回 { channels, targets, keys, summary }。明文 key 只在 keys 里短暂带出，
// 端点负责存进加密库并丢弃，绝不落入 channels（不进库、不下发浏览器）。
export function buildSub2apiImportPlan({
  keys: keyRows = [],
  groupIndex = new Map(),
  keyModels = {},
  base = "",
  existingChannels = [],
  existingTargets = [],
} = {}) {
  const channels = existingChannels.map((c) => ({ ...c }));
  const targets = existingTargets.map((t) => ({ ...t }));
  const indexById = new Map(channels.map((c, i) => [c.id, i]));
  const targetKeys = new Set(targets.map((t) => `${t.channelId}|${t.model}`));
  const baseUrl = String(base || "").replace(/\/+$/, "");
  const plainKeys = {};
  const now = new Date().toISOString();
  let imported = 0;
  let updated = 0;
  let newTargets = 0;
  let disabled = 0;
  let noGroup = 0;
  let noModels = 0;
  let viaFallbackCount = 0;
  // 重新导入时保留了用户手工修改的渠道数（见 import-merge.mjs）。
  let preserved = 0;

  for (const row of keyRows) {
    const keyId = row?.id;
    const localId = sub2apiChannelLocalId(baseUrl, keyId);
    // group_id 可为 null（密钥未绑定分组）。绑定了但 groupIndex 里没有（模型广场未启用）
    // 也走同一分支：拿不到分组元信息，模型清单只能靠 /v1/models 回落。
    const groupId = row?.group_id ?? null;
    const group = groupId == null ? null : groupIndex.get(String(groupId)) || null;
    const fallbackModels = keyModels?.[String(keyId)] ?? keyModels?.[keyId];
    const viaFallback = !group?.models?.length && Array.isArray(fallbackModels) && fallbackModels.length > 0;
    const models = group?.models?.length ? group.models : viaFallback ? fallbackModels : [];
    // platform 只在真拿到分组时才有；回落路径下如实留空（notes 里会说明）。
    const platform = group?.platform || "";
    const status = mapKeyStatus(row?.status);

    if (status === "disabled") disabled += 1;
    if (!group) noGroup += 1;
    if (viaFallback) viaFallbackCount += 1;
    // noModels 移到合并之后再计：它驱动前端「N 个密钥没查到可用模型」这句提示，
    // 说的应是【这个渠道最终有没有模型可测】。按上游口径算会在"上游给 0 个、但用户手加过模型"时
    // 误报（实测：渠道最终 models=["我加的模型"] 却仍提示没查到模型）。

    const mapped = {
      id: localId,
      name: String(row?.name || `sub2api 密钥 ${keyId}`),
      provider: "",
      baseUrl,
      protocol: platformToProtocol(platform),
      models,
      status,
      source: "sub2api",
      sub2apiKeyId: Number.isFinite(Number(keyId)) ? Number(keyId) : null,
      sub2apiGroupId: groupId == null ? null : Number(groupId),
      sub2apiGroupName: group?.name || "",
      notes: buildSub2apiNote({ platform, groupName: group?.name || "", viaFallback }),
    };

    const idx = indexById.get(localId);
    let channelId;
    // 建模型目标要用【合并后】的模型清单：三方合并可能保留了用户手加的模型、剔除了他删掉的，
    // 用 mapped.models（上游原样）会把用户删掉的模型目标又加回来。
    let finalModels = models;
    if (idx === undefined) {
      // 首次导入也要落快照：漏了的话第二次导入会把它当成"老渠道"走保守保留，
      // 上游改名/换协议永远同步不过来（见 import-merge.mjs 的 importSnapshotOf）。
      channels.push({ ...mapped, importSnapshot: importSnapshotOf(mapped), createdAt: now, updatedAt: now });
      indexById.set(localId, channels.length - 1);
      channelId = localId;
      imported += 1;
    } else {
      // 三方合并：用户手工改过的 name/protocol/models 要保住，没动过的仍跟随上游（见 import-merge.mjs）。
      // 直接 {...prev, ...mapped} 会把产品自己在 notes 里建议的协议修正静默推翻。
      const prev = channels[idx];
      const { channel: mergedChannel, preservedFields } = mergeImportedChannel(prev, mapped);
      // notes：用户写了自己的备注就完全不碰；没写才重新生成（协议被保留时会追加说明），
      // 并同步快照——否则追加的那段文字下次会被误判成"用户改过 notes"。详见 finalizeImportedNotes。
      finalizeImportedNotes(mergedChannel, preservedFields, { upstreamNotes: mapped.notes, upstreamProtocol: mapped.protocol });
      mergedChannel.updatedAt = now;
      channels[idx] = mergedChannel;
      channelId = mergedChannel.id;
      finalModels = mergedChannel.models;
      updated += 1;
      if (preservedFields.length) preserved += 1;
    }

    // 按合并后的最终清单计（见上方 noModels 的说明）。
    if (!finalModels.length) noModels += 1;

    // sub2api 的密钥列表直接返回明文 key（无需二次请求），这里原样收进 keys 映射。
    if (row?.key) plainKeys[channelId] = String(row.key);

    for (const model of finalModels) {
      const dedupe = `${channelId}|${model}`;
      if (targetKeys.has(dedupe)) continue;
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
        source: "sub2api",
        createdAt: now,
        updatedAt: now,
      });
      targetKeys.add(dedupe);
      newTargets += 1;
    }
  }

  return {
    channels,
    targets,
    keys: plainKeys,
    summary: {
      total: keyRows.length,
      imported,
      updated,
      newTargets,
      disabled,
      noGroup,
      noModels,
      viaFallback: viaFallbackCount,
      preserved,
    },
  };
}
