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
// 【为什么这里没有响应体大小上限】——刻意的取舍，不是漏了（与 sub2api-import.mjs 同理）。
// PAGE_CAP 只限页数、不限单页体积：上游若单页返回几十 MB 就会照吃，解析后建出等量渠道。
// 对照 upstream-transport.mjs 的 MAX_UPSTREAM_STREAM_RESPONSE_BYTES —— 那里必须设限，
// 因为被测上游是【任意用户填进来的第三方 API】，行为不可信也不可控。
// 而本链路读的是**测试人员自己名下的令牌**（用他自己的个人令牌调 new-api 管理接口，
// 只能看到自己的东西），这些令牌就是他自己在 new-api 上建的；要触发这个路径，
// 等于他先给自己建出上万个名字含「测试」的令牌，再对自己发起导入——收益端与攻击端是同一个人。
// 故风险很低，不值得为它把 fetch().json() 改写成手写 chunk 累加 + 提前中止。
// 若哪天本链路要面向"不完全信任的上游"开放（公共服务化、或允许非超管发起导入），必须回来补上限。
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

// 凭据进请求头前先自检。不这么做的话，含 CR/LF 的令牌会让 undici 的 Headers.append 抛 TypeError，
// 而它的 message 里【带着令牌原文】——该 message 一路经端点的 catch 变成 userMessage 回到浏览器，
// 凭据就这样被回显了（实测复现过）。这里主动挡掉并给出不含凭据的错误信息。
// 顺带也是正确的输入校验：new-api 的令牌本身不含控制字符，带了就是用户粘贴时把换行也复制进来了。
function assertHeaderSafe(value, label) {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`${label}含换行或控制字符（可能是复制粘贴时多带了内容），请重新复制后再试。`);
  }
  // eslint-disable-next-line no-control-regex -- 刻意匹配控制字符
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label}含不可见的控制字符，请重新复制后再试。`);
  }
}

function authHeaders({ token, userId }) {
  const t = String(token || "");
  const u = String(userId || "");
  assertHeaderSafe(t, "个人令牌");
  assertHeaderSafe(u, "用户ID");
  // Authorization 不加 Bearer 前缀（new-api 的管理接口要令牌原文）。
  return { Authorization: t, "New-Api-User": u };
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
