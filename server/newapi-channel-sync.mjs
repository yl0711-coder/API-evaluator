// server/newapi-channel-sync.mjs
// 把本平台的「渠道 / 模型」反向推送到 new-api（与 newapi-source 导入方向相反）。
//   - 渠道推送：POST /api/channel/ 新建（带上游 key + models 列表），或 PUT 更新已关联渠道。
//   - 模型推送：把模型名并入其渠道在 new-api 的 models 列表（GET 整条 → 改 models → PUT 回写）。
// 严格遵循《AI配置模型与渠道操作指南.md》：双头鉴权、UTF-8 字节发送、渠道 PUT 为 patch 语义。
// 复用 newapi-tag-writer 的配置/鉴权（同一套 EVALUATOR_NEWAPI_* 与系统访问令牌）。
import { readConfig, authHeaders } from "./newapi-tag-writer.mjs";

// provider → new-api 渠道 type（int）。表与 newapi-import.mjs 的 TYPE_PROVIDER 反转一致。
// 未知 provider 回退：claude_messages→14(Anthropic)，其余→1(OpenAI，自定义 base_url 即通用中转)。
const PROVIDER_TYPE = {
  OpenAI: 1,
  Anthropic: 14,
  Baidu: 15,
  Zhipu: 16,
  Alibaba: 17,
  Google: 24,
  Moonshot: 25,
  DeepSeek: 43,
  xAI: 48,
};

export function channelType(channel) {
  const byProvider = PROVIDER_TYPE[String(channel.provider || "").trim()];
  if (byProvider) return byProvider;
  return channel.protocol === "claude_messages" ? 14 : 1;
}

// HTTP 头只接受 Latin-1；令牌/用户ID 含中文/全角会让 fetch 抛 ByteString，提前给可操作中文报错。
function assertHeaderSafe(name, value) {
  const bad = [...String(value)].find((ch) => ch.codePointAt(0) > 255);
  if (bad !== undefined) {
    throw new Error(`${name} 含非 ASCII 字符「${bad}」，HTTP 请求头不支持。请检查 .env.evaluator 该项（应为纯英文/数字）。`);
  }
}

// 统一发请求：UTF-8 字节体、双头鉴权、解析 {success,message,data}，失败抛中文错误。
async function callNewapi(cfg, method, path, bodyObj) {
  assertHeaderSafe("EVALUATOR_NEWAPI_IMPORT_TOKEN", cfg.token);
  assertHeaderSafe("EVALUATOR_NEWAPI_USER_ID", cfg.userId);
  const init = { method, headers: { ...authHeaders(cfg) } };
  if (bodyObj !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = Buffer.from(JSON.stringify(bodyObj), "utf8");
  }
  const res = await fetch(`${cfg.base}${path}`, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`new-api ${path} 返回 HTTP ${res.status}（确认系统访问令牌与 New-Api-User 有管理员权限）。`);
  if (body && body.success === false) throw new Error(body.message || `new-api ${path} 返回 success=false`);
  return body;
}

// 逗号分隔模型串 → 去空白去重数组。
function splitModels(s) {
  const seen = new Set();
  const out = [];
  for (const m of String(s || "").split(",")) {
    const v = m.trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

// 兜底：建渠道接口可能不回新 id，则按名搜索取回。
async function findChannelIdByName(cfg, name) {
  const body = await callNewapi(cfg, "GET", `/api/channel/search?keyword=${encodeURIComponent(name)}`);
  const items = Array.isArray(body?.data?.items) ? body.data.items : Array.isArray(body?.data) ? body.data : [];
  // 只认精确同名命中。search 是关键词模糊匹配，items[0] 可能是名字仅「包含」该词的别的渠道；
  // 若回退 items[0]，会把那条生产渠道误记成本渠道的 newapiChannelId，后续模型推送/删除同步全作用到错渠道。
  const hit = items.find((c) => String(c.name) === String(name));
  return hit ? hit.id : null;
}

// 渠道推送：新建或更新。channel 为本平台渠道对象，key 为明文上游 Key（调用方从密钥库取）。
// 返回 { action:"created"|"updated", newapiChannelId, name }。
export async function pushChannelToNewapi(channel, key) {
  const cfg = readConfig();
  const name = String(channel.name || "").trim();
  const payload = {
    type: channelType(channel),
    name,
    base_url: String(channel.baseUrl || ""),
    key: String(key || ""),
    models: (Array.isArray(channel.models) ? channel.models : []).join(","),
    group: "internal_test", // 推送到 new-api 的渠道默认归入「内部测试」分组
  };
  if (channel.newapiChannelId) {
    // 已关联：整条 patch 更新（带 id + key）。
    await callNewapi(cfg, "PUT", "/api/channel/", { ...payload, id: channel.newapiChannelId });
    return { action: "updated", newapiChannelId: channel.newapiChannelId, name };
  }
  // 新建：mode=single。
  const body = await callNewapi(cfg, "POST", "/api/channel/", { mode: "single", channel: payload });
  const data = body?.data;
  let newId = typeof data === "number" ? data : data && typeof data === "object" ? data.id ?? null : null;
  if (newId == null) newId = await findChannelIdByName(cfg, name);
  return { action: "created", newapiChannelId: newId, name };
}

// 模型推送：把 modelName 并入 new-api 渠道(newapiChannelId)的 models 列表。
// 返回 { added:bool, models:string }；已存在则 added=false（unchanged）。
export async function addModelToNewapiChannel(newapiChannelId, modelName) {
  const cfg = readConfig();
  const got = await callNewapi(cfg, "GET", `/api/channel/${encodeURIComponent(newapiChannelId)}`);
  const current = got?.data || {};
  const models = splitModels(current.models);
  const model = String(modelName || "").trim();
  if (!model) throw new Error("模型名为空，无法推送。");
  if (models.includes(model)) {
    return { added: false, models: models.join(",") };
  }
  models.push(model);
  const next = models.join(",");
  // patch 回写：只带 id + models，避免把 GET 到的掩码 key 写坏渠道。
  await callNewapi(cfg, "PUT", "/api/channel/", { id: newapiChannelId, models: next });
  return { added: true, models: next };
}

// 删除同步：整条删除 new-api 渠道。返回 { deleted:true }。
export async function deleteNewapiChannel(newapiChannelId) {
  const cfg = readConfig();
  await callNewapi(cfg, "DELETE", `/api/channel/${encodeURIComponent(newapiChannelId)}`);
  return { deleted: true };
}

// 删除同步：把 modelName 从 new-api 渠道(newapiChannelId)的 models 列表移除。
// 返回 { removed:bool, models:string }；本就不在则 removed=false（不发 PUT）。
export async function removeModelFromNewapiChannel(newapiChannelId, modelName) {
  const cfg = readConfig();
  const got = await callNewapi(cfg, "GET", `/api/channel/${encodeURIComponent(newapiChannelId)}`);
  const current = got?.data || {};
  const models = splitModels(current.models);
  const model = String(modelName || "").trim();
  if (!models.includes(model)) {
    return { removed: false, models: models.join(",") };
  }
  const next = models.filter((m) => m !== model).join(",");
  // patch 回写：只带 id + models，不带 key。
  await callNewapi(cfg, "PUT", "/api/channel/", { id: newapiChannelId, models: next });
  return { removed: true, models: next };
}
