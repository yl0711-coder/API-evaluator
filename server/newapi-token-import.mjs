// server/newapi-token-import.mjs
// 「从 new-api 上游渠道导入测试分组」的出站 I/O：用**用户自己的个人令牌**调 new-api 管理接口，
// 读他名下名称含「测试」的令牌、取明文 key、查分组下的模型。纯映射在 newapi-token-plan.mjs。
//
// 与 newapi-source.mjs 的区别：那边用超管在设置页长期保存的管理员令牌导入 channels 表；
// 这里用调用者一次性填入的个人令牌读 tokens，凭据只在内存流转、不保存。
//
// 认证：new-api 管理接口要求**同时**带两个头，缺一个 401（其 middleware/auth.go）：
//   Authorization: <个人令牌>   —— 注意**不加** `Bearer ` 前缀，放令牌原文
//   New-Api-User:  <用户 ID>    —— 必须与令牌所属用户一致，否则「用户 ID 不匹配」
//
// 出站三件套与本仓其它出站点（test-runner / client-replay / newapi-source）对齐：
//   assertPublicTarget（挡内网/元数据地址）+ redirect:"error"（挡 302 绕守卫）+ AbortSignal 超时
//   （undici 的 fetch 无默认响应超时，上游挂起会把请求无限期吊住）。
import { envInt } from "./env-config.mjs";
import { assertPublicTarget } from "./egress-guard.mjs";
import { isTestToken } from "./newapi-token-plan.mjs";

const PAGE_SIZE = 100; // new-api 服务端硬上限 100（common/page_info.go），传更大会被静默截断
const PAGE_CAP = 50; // 最多 5000 个令牌；超出只取前 5000 并告警，避免无界翻页
const BATCH_KEY_LIMIT = 100; // POST /api/token/batch/keys 的 ids 上限
const BATCH_GAP_MS = 250; // 批次间隔：该端点挂了 CriticalRateLimit，别在循环里高频打

function timeoutMs() {
  return envInt("EVALUATOR_NEWAPI_IMPORT_TIMEOUT_MS", 15_000, { max: 600_000 });
}

export function normalizeBase(base) {
  return String(base || "")
    .trim()
    .replace(/\/+$/, "");
}

function authHeaders({ token, userId }) {
  // Authorization 不加 Bearer 前缀（new-api 的管理接口要令牌原文）。
  return { Authorization: String(token || ""), "New-Api-User": String(userId || "") };
}

// 单次请求：守卫已在调用方对 base 校验过一次（host 跨请求不变），这里只管超时 + 不跟随跳转 + 判 success。
async function callNewapi(url, { headers, method = "GET", body = null }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { ...headers, "content-type": "application/json" } : headers,
      body,
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`new-api 接口超时（${timeoutMs()}ms 未响应）：请确认网址可达。`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`new-api 接口返回 ${res.status}：请确认个人令牌与用户ID匹配（两者必须属于同一用户）。`);
  }
  const json = await res.json().catch(() => null);
  // 管理接口业务失败也返回 HTTP 200，成败看 body.success —— 只判 res.ok 会把
  // 「令牌无效」当成空结果静默通过（现有 newapi-source.mjs 就有这个毛病）。
  if (!json || json.success === false) {
    throw new Error(`new-api 返回失败：${json?.message || "未知错误"}（常见原因：个人令牌无效或已被重新生成覆盖）。`);
  }
  return json;
}

// 拉取名称含「测试」的令牌。分页 p 从 1 开始（new-api 的 common/page_info.go 明确 1 起）。
export async function fetchTestTokens({ base, token, userId }) {
  const b = normalizeBase(base);
  const headers = authHeaders({ token, userId });
  await assertPublicTarget(`${b}/api/token/`);
  const all = [];
  let truncated = false;
  for (let page = 1; page <= PAGE_CAP; page += 1) {
    const json = await callNewapi(`${b}/api/token/?p=${page}&page_size=${PAGE_SIZE}`, { headers });
    // 分页响应是 { data: { items, total, ... } }；也兼容直接给数组的形态。
    const items = Array.isArray(json?.data) ? json.data : Array.isArray(json?.data?.items) ? json.data.items : [];
    // 形状对不上时的兜底：total 说有数据、却一条都没解析出来 —— 那是**解析失败**，不是「没有令牌」。
    // 若静默当成空结果，用户只会看到「没有含『测试』的令牌」，从而去怀疑自己的令牌命名，
    // 而真正的原因是 new-api 改了字段名（如 items -> records）。这正是我在 newapi-source.mjs
    // 里批评过的静默失败模式，这里必须报错而不是返回空。
    const total = Number(json?.data?.total);
    if (!items.length && page === 1 && Number.isFinite(total) && total > 0) {
      throw new Error(
        `无法解析 new-api 的令牌列表：接口称共有 ${total} 个令牌，却没能读出任何一条（可能是 new-api 版本变更了响应字段名）。请反馈此问题。`,
      );
    }
    if (!items.length) break;
    all.push(...items);
    if (items.length < PAGE_SIZE) break;
    if (page === PAGE_CAP) truncated = true;
  }
  if (truncated) {
    console.warn(`[newapi-token-import] 令牌分页命中 ${PAGE_CAP * PAGE_SIZE} 条上限，可能未取全。`);
  }
  return all.filter((t) => isTestToken(t?.name));
}

// 批量取明文 key。GET 类接口返回的 key 是脱敏值（sk-1****abcd），不能直接用来跑测试。
// 该端点挂 CriticalRateLimit：切成每批 ≤100 串行请求，批次间留间隔。
export async function fetchTokenKeys({ base, token, userId }, ids) {
  const b = normalizeBase(base);
  const headers = authHeaders({ token, userId });
  const list = (Array.isArray(ids) ? ids : []).map((x) => Number(x)).filter((n) => Number.isFinite(n));
  const out = {};
  for (let i = 0; i < list.length; i += BATCH_KEY_LIMIT) {
    const batch = list.slice(i, i + BATCH_KEY_LIMIT);
    if (i > 0) await new Promise((r) => setTimeout(r, BATCH_GAP_MS));
    const json = await callNewapi(`${b}/api/token/batch/keys`, {
      headers,
      method: "POST",
      body: JSON.stringify({ ids: batch }),
    });
    // 形如 { data: { keys: { "1": "sk-aaa" } } }；也兼容 data 直接是映射的形态。
    const keys = json?.data?.keys && typeof json.data.keys === "object" ? json.data.keys : json?.data;
    if (keys && typeof keys === "object") {
      for (const [k, v] of Object.entries(keys)) {
        if (v) out[String(k)] = String(v);
      }
    }
  }
  return out;
}

// 令牌 group 为空时的回落来源：用户自身的分组。
export async function fetchSelfGroup({ base, token, userId }) {
  const b = normalizeBase(base);
  const json = await callNewapi(`${b}/api/user/self`, { headers: authHeaders({ token, userId }) });
  return String(json?.data?.group ?? "").trim();
}

// 分组 -> 模型映射来源。注意 /api/pricing 会按**调用者自己**的可用分组过滤；
// 这里用的正是用户自己的令牌，所以拿到的就是他能看到的范围，符合本功能预期。
export async function fetchPricing({ base, token, userId }) {
  const b = normalizeBase(base);
  const json = await callNewapi(`${b}/api/pricing`, { headers: authHeaders({ token, userId }) });
  return Array.isArray(json?.data) ? json.data : [];
}
