// server/newapi-tag-writer.mjs
// 把本平台为「模型目标」授予的能力标签批量写入 new-api 模型广场（models 表 tags 字段）。
// 严格遵循 new-api 管理 API 约定（见《AI批量写入模型标签指南.md》）：
//   - 鉴权双头：Authorization=系统访问令牌（不带 Bearer）、New-Api-User=管理员用户ID。
//   - 分页：参数名 p（从 1 起），page_size 上限 100，按 total 翻页拉全。
//   - 写回：必须「整条读出 → 只改 tags → 整条 PUT 回去」，否则 Select 强制覆盖那批列会损坏模型。
//   - tags 为英文逗号分隔字符串；这里与 new-api 已有标签合并去重，不覆盖用户原有标签。
import { envCompat } from "./env-compat.mjs";

const PAGE_SIZE = 100;
const PAGE_CAP = 100; // 最多 1 万个模型，防无界翻页

// 复用导入用的 new-api 配置；New-Api-User 默认管理员 1，可用 EVALUATOR_NEWAPI_USER_ID 覆盖。
// 容错：去掉可能误带入的行内注释（空白后的 #...）与首尾空白，避免把注释/全角符号塞进 HTTP 头。
// 导出供只读校验/还原脚本复用（scripts/newapi-tag-writer-live.mjs）。运行时主流程仍内部调用。
export function readConfig() {
  const clean = (v) => String(v || "").replace(/\s+#.*$/, "").trim();
  return {
    base: clean(envCompat("NEWAPI_BASE_URL")).replace(/\/+$/, ""),
    token: clean(envCompat("NEWAPI_IMPORT_TOKEN")),
    userId: clean(envCompat("NEWAPI_USER_ID")) || "1",
  };
}

export function isNewapiTagWriterConfigured() {
  const { base, token } = readConfig();
  return Boolean(base && token);
}

// HTTP 头只接受 Latin-1（码点 ≤255）。令牌/用户ID 若含中文/全角符号（多因复制时带入了注释或全角括号），
// fetch 会抛 "Cannot convert argument to a ByteString"。这里提前给出可操作的中文报错，便于排查 .env。
function assertHeaderSafe(envName, value) {
  const bad = [...String(value)].find((ch) => ch.codePointAt(0) > 255);
  if (bad !== undefined) {
    throw new Error(
      `${envName} 含非 ASCII 字符「${bad}」，HTTP 请求头不支持。请检查 .env.evaluator 里该项的值（应为纯英文/数字，` +
        `不要把注释、全角括号「（）」或中文复制进去），改正后重启服务。`,
    );
  }
}

// 导出供渠道推送脚本/模块复用（scripts、newapi-channel-sync.mjs）。
export function authHeaders({ token, userId }) {
  return { Authorization: token, "New-Api-User": userId };
}

function splitTags(s) {
  return String(s || "").split(/[，,]/).map((x) => x.trim()).filter(Boolean);
}

// 合并标签：保留 new-api 已有标签，并入我方标签，去重、保序、英文逗号连接。
function mergeTags(existing, incoming) {
  const seen = new Set();
  const out = [];
  for (const t of [...splitTags(existing), ...incoming]) {
    const v = String(t).trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out.join(",");
}

// 翻页拉取全部模型（返回完整 model 对象，供整条回写）。
// 导出供只读校验/快照脚本复用（scripts/newapi-tag-writer-live.mjs），运行时主流程仍内部调用。
export async function fetchAllModels(cfg) {
  const out = [];
  for (let p = 1; p <= PAGE_CAP; p += 1) {
    const res = await fetch(`${cfg.base}/api/models/?p=${p}&page_size=${PAGE_SIZE}`, { headers: authHeaders(cfg) });
    if (!res.ok) throw new Error(`new-api 模型列表接口返回 ${res.status}（确认系统访问令牌与 New-Api-User 有管理员权限）。`);
    const body = await res.json().catch(() => null);
    const items = Array.isArray(body?.data?.items) ? body.data.items : Array.isArray(body?.data) ? body.data : [];
    out.push(...items);
    const total = Number(body?.data?.total) || 0;
    if (!items.length || items.length < PAGE_SIZE || (total && out.length >= total)) break;
  }
  return out;
}

// 拉取 new-api 模型广场的「模型名 → 标签数组」映射，供导入时把标签一并并到本地模型目标上。
// 未配置则返回空对象（best-effort，由调用方吞错）。
export async function fetchNewapiModelTagMap() {
  const cfg = readConfig();
  if (!cfg.base || !cfg.token) return {};
  const models = await fetchAllModels(cfg);
  const map = {};
  for (const m of models) {
    const tags = splitTags(m.tags);
    if (m.model_name && tags.length) map[String(m.model_name)] = tags;
  }
  return map;
}

// 主流程。tagMap: { 模型名 -> string[] 标签 }。返回写入汇总（不抛分项错误，逐条收集）。
export async function pushModelTagsToNewapi(tagMap) {
  const cfg = readConfig();
  if (!cfg.base || !cfg.token) {
    return { configured: false, error: "未配置 EVALUATOR_NEWAPI_BASE_URL + EVALUATOR_NEWAPI_IMPORT_TOKEN（new-api 系统访问令牌）。" };
  }
  // 提前校验请求头安全，把 fetch 的 ByteString 报错换成可操作的中文提示。
  assertHeaderSafe("EVALUATOR_NEWAPI_IMPORT_TOKEN", cfg.token);
  assertHeaderSafe("EVALUATOR_NEWAPI_USER_ID", cfg.userId);
  const models = await fetchAllModels(cfg);
  const summary = { configured: true, totalModels: models.length, matched: 0, updated: 0, unchanged: 0, errors: [] };
  for (const model of models) {
    const incoming = tagMap[model.model_name];
    if (!incoming || !incoming.length) continue;
    summary.matched += 1;
    const newTags = mergeTags(model.tags, incoming);
    if (newTags === String(model.tags || "")) {
      summary.unchanged += 1;
      continue;
    }
    try {
      // 整条回写、仅改 tags；UTF-8 字节发送防中文乱码。
      const put = { ...model, tags: newTags };
      const res = await fetch(`${cfg.base}/api/models/`, {
        method: "PUT",
        headers: { ...authHeaders(cfg), "Content-Type": "application/json" },
        body: Buffer.from(JSON.stringify(put), "utf8"),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (body && body.success === false) throw new Error(body.message || "new-api 返回 success=false");
      summary.updated += 1;
    } catch (error) {
      summary.errors.push({ model: model.model_name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return summary;
}
