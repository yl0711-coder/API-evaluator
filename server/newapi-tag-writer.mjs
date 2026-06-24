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
function readConfig() {
  return {
    base: String(envCompat("NEWAPI_BASE_URL") || "").replace(/\/+$/, ""),
    token: String(envCompat("NEWAPI_IMPORT_TOKEN") || "").trim(),
    userId: String(envCompat("NEWAPI_USER_ID") || "1").trim(),
  };
}

export function isNewapiTagWriterConfigured() {
  const { base, token } = readConfig();
  return Boolean(base && token);
}

function authHeaders({ token, userId }) {
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
async function fetchAllModels(cfg) {
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

// 主流程。tagMap: { 模型名 -> string[] 标签 }。返回写入汇总（不抛分项错误，逐条收集）。
export async function pushModelTagsToNewapi(tagMap) {
  const cfg = readConfig();
  if (!cfg.base || !cfg.token) {
    return { configured: false, error: "未配置 EVALUATOR_NEWAPI_BASE_URL + EVALUATOR_NEWAPI_IMPORT_TOKEN（new-api 系统访问令牌）。" };
  }
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
