// server/newapi-import.mjs
// 从 new-api 导入渠道的纯映射 + 编排（无 I/O，便于单测）。数据来源（A1 管理 API / A2 只读 DB）
// 在 newapi-source.mjs 里取行，本文件只负责：new-api 渠道行 -> 我们的渠道/模型目标。
// 明文 key 不进渠道记录：buildImportPlan 单独把 key 收进 keys 映射，由端点存进加密库后丢弃。
import { deterministicModelTargetId, normalizeModelList } from "./channel-model.mjs";

// new-api 渠道 type（见其 constant/channel.go）。14=Anthropic 走 Claude Messages，其余按 OpenAI 兼容。
const TYPE_PROVIDER = { 1: "OpenAI", 14: "Anthropic", 15: "Baidu", 16: "Zhipu", 17: "Alibaba", 24: "Google", 25: "Moonshot", 43: "DeepSeek", 48: "xAI" };
const TYPE_DEFAULT_URL = { 1: "https://api.openai.com", 14: "https://api.anthropic.com", 43: "https://api.deepseek.com", 25: "https://api.moonshot.cn", 48: "https://api.x.ai" };

export function newapiTypeToProtocol(type) {
  return Number(type) === 14 ? "claude_messages" : "openai_compatible";
}

// new-api status：1=启用，2=手动禁用，3=自动禁用 -> 我们只分 enabled/disabled。
export function mapNewapiStatus(status) {
  return Number(status) === 1 ? "enabled" : "disabled";
}

// 本地渠道 id 由 new-api 渠道 id 派生，保证重复导入幂等（同一渠道 upsert 而非重复），
// 且 apiKeyRef（profile:newapi-<id>:api-key）稳定。
export function newapiChannelLocalId(newapiId) {
  return `newapi-${newapiId}`;
}

// new-api 渠道行 -> 我们的渠道（不含 key）。
export function mapNewapiChannel(row) {
  const type = Number(row.type);
  const baseUrl = String(row.base_url ?? row.baseUrl ?? "").trim().replace(/\/+$/, "") || TYPE_DEFAULT_URL[type] || "";
  const protocol = newapiTypeToProtocol(type);
  // type 1(OpenAI)/14(Anthropic) 协议确定；其余按 OpenAI 兼容自动推断 —— 非原生兼容的上游
  // （如 Baidu/Gemini 原生）导入后可能不可用，给个提示让超管人工核对/改协议。
  const inferred = type !== 1 && type !== 14;
  return {
    id: newapiChannelLocalId(row.id),
    name: String(row.name || `new-api 渠道 ${row.id}`),
    provider: TYPE_PROVIDER[type] || "",
    baseUrl,
    protocol,
    models: normalizeModelList(row.models),
    status: mapNewapiStatus(row.status),
    source: "newapi",
    newapiChannelId: Number(row.id),
    notes: inferred ? `协议按 OpenAI 兼容自动推断（new-api type=${type}）。若该上游非 OpenAI 兼容协议，请改协议或核对。` : "",
  };
}

// 编排：把 new-api 行 upsert 进现有渠道、按 models 拆出模型目标。纯函数。
// 返回 { channels, targets, keys:{channelId:明文key}, summary }。明文 key 只在 keys 里短暂带出，
// 端点负责存进加密库并丢弃，绝不落入 channels（不进库、不下发浏览器）。
export function buildImportPlan({ rows = [], existingChannels = [], existingTargets = [], syncModels = true, modelTags = null } = {}) {
  const channels = existingChannels.map((c) => ({ ...c }));
  const targets = existingTargets.map((t) => ({ ...t }));
  const indexById = new Map(channels.map((c, i) => [c.id, i]));
  // 也按 newapiChannelId 建索引：识别「已推送到 new-api 的本地渠道」（其本地 id 是 UUID、非 newapi-<id>），
  // 避免导入时把同一渠道当成新渠道再建一份 → 重复渠道 + 重复模型。
  const indexByNewapiId = new Map();
  channels.forEach((c, i) => {
    if (c.newapiChannelId != null) indexByNewapiId.set(Number(c.newapiChannelId), i);
  });
  const targetKeys = new Set(targets.map((t) => `${t.channelId}|${t.model}`));
  const keys = {};
  const now = new Date().toISOString();
  let imported = 0;
  let updated = 0;
  let newTargets = 0;
  let disabled = 0;
  let taggedTargets = 0;
  const touchedChannelIds = new Set(); // 本次导入涉及的渠道 id，标签只并到这些渠道下的模型目标

  for (const row of rows) {
    const mapped = mapNewapiChannel(row);
    if (mapped.status === "disabled") disabled += 1;

    // 命中已存在渠道：优先按 newapiChannelId（含已推送的本地渠道），其次按派生 id（已导入过的）。
    const idx = indexByNewapiId.has(Number(row.id)) ? indexByNewapiId.get(Number(row.id)) : indexById.get(mapped.id);
    let channelId; // 实际使用的本地渠道 id（命中时保留已存在渠道的 id，别改成 newapi-<id> 否则其下模型目标成孤儿）。
    if (idx === undefined) {
      channels.push({ ...mapped, createdAt: now, updatedAt: now });
      const i = channels.length - 1;
      indexById.set(mapped.id, i);
      indexByNewapiId.set(Number(row.id), i);
      channelId = mapped.id;
      imported += 1;
    } else {
      // 同步元信息/状态/模型清单；保留已存在渠道的 id、凭证(apiKeyRef/keyHash/hasKey)与创建时间。
      const prev = channels[idx];
      channels[idx] = { ...prev, ...mapped, id: prev.id, createdAt: prev.createdAt || now, updatedAt: now };
      channelId = prev.id;
      updated += 1;
    }

    if (row.key) keys[channelId] = String(row.key); // A2(DB) 带 key；A1(API) 不带。用实际 channelId 存。
    touchedChannelIds.add(channelId);

    if (syncModels) {
      for (const model of mapped.models) {
        const key = `${channelId}|${model}`;
        if (!targetKeys.has(key)) {
          targets.push({ id: deterministicModelTargetId(channelId, model), channelId, model, note: "", source: "newapi", createdAt: now, updatedAt: now });
          targetKeys.add(key);
          newTargets += 1;
        }
      }
    }
  }

  // 把 new-api 模型广场标签（按模型名）并到本次导入涉及渠道下的模型目标上：并集去重、保留本地已有标签、只增不撤。
  if (modelTags) {
    for (const t of targets) {
      if (!touchedChannelIds.has(t.channelId)) continue;
      const incoming = modelTags[t.model];
      if (!Array.isArray(incoming) || !incoming.length) continue;
      const cur = new Set(Array.isArray(t.tags) ? t.tags : []);
      const before = cur.size;
      incoming.forEach((x) => cur.add(x));
      if (cur.size !== before) {
        t.tags = [...cur];
        t.updatedAt = now;
        taggedTargets += 1;
      }
    }
  }

  return { channels, targets, keys, summary: { total: rows.length, imported, updated, newTargets, disabled, taggedTargets } };
}
