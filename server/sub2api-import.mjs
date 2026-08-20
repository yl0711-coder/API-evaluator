// server/sub2api-import.mjs
// 「从 sub2api 上游渠道导入测试分组」的出站 I/O：用调用者的**邮箱+密码**代为登录取 JWT，
// 读其名下名称含「测试」的 API 密钥、分组与模型清单。纯映射在 sub2api-plan.mjs。
//
// 为什么是邮箱+密码而不是让用户填 token（这不只是易用性，是技术必需）：
// sub2api 签发 JWT 时记录客户端 IP + User-Agent，后续请求任一变化即撤销会话返回 401。
// 用户把浏览器里的 token 复制到服务端用几乎必然 401，所以必须**服务端自己登录、自己使用**
// （同一进程、同一 UA）。见 USER_API_EXPORT_GUIDE.md 第 1 节「会话绑定」。
//
// 与 newapi-token-import.mjs 的协议差异（勿照搬那边的写法）：
//   - 信封是 { code, message, data }，code:0 成功；出错时 HTTP 状态码本身就非 200。
//   - 分页 page 从 1 起、page_size 上限 1000，且响应回 pages 总页数（据此翻页，不靠猜）。
//   - 密钥列表**直接返回明文 key**，无需像 new-api 那样再调 batch/keys。
//
// 出站三件套与本仓其它出站点一致：assertPublicTarget（挡内网/元数据地址）
// + redirect:"error"（挡 302 绕守卫）+ AbortSignal 超时（undici 的 fetch 无默认响应超时）。
import { envInt } from "./env-config.mjs";
import { assertPublicTarget } from "./egress-guard.mjs";
import { isTestTokenName } from "../shared/newapi-token-keyword.mjs";

const PAGE_SIZE = 1000; // 文档：page_size 上限 1000，建议一次拿完而非小分页循环
const PAGE_CAP = 20; // 最多 20000 个密钥，防无界翻页
const FALLBACK_GAP_MS = 200; // 逐密钥调 /v1/models 时的间隔（面板/网关都有按用户限流）
// 回落路径的密钥上限：串行 + 200ms 间隔，150 个约 30 秒已是可接受等待的上限。
// 超过就报错让用户改用模型广场，而不是让请求挂上几十分钟（详见 fetchModelsPerKey 的说明）。
const FALLBACK_MAX_KEYS = 150;

function timeoutMs() {
  return envInt("EVALUATOR_SUB2API_IMPORT_TIMEOUT_MS", 15_000, { max: 600_000 });
}

export function normalizeBase(base) {
  return String(base || "")
    .trim()
    .replace(/\/+$/, "");
}

// 统一解包 sub2api 信封。注意与 new-api 的差别：这里出错时 HTTP 状态码本身非 200，
// 但仍要判 code —— 两道都判才既不漏网络层错误、也不漏业务层错误。
async function callSub2api(url, { token = "", method = "GET", body = null, apiKey = "" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  const headers = {};
  // /v1/* 网关接口用**明文 API 密钥**认证；/api/v1/* 面板接口用登录得到的 JWT。
  const bearer = apiKey || token;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(url, { method, headers, body, redirect: "error", signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`sub2api 接口超时（${timeoutMs()}ms 未响应）：请确认网址可达。`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const json = await res.json().catch(() => null);
  if (res.status === 429) {
    throw new Error("sub2api 触发限流（429）：请稍等一会儿再导入。");
  }
  if (!res.ok) {
    // 404 交由调用方按语义处理（模型广场未启用也是 404），这里只带出状态码与信息。
    const err = new Error(`sub2api 接口返回 ${res.status}${json?.message ? `：${json.message}` : ""}`);
    err.status = res.status;
    throw err;
  }
  if (json && json.code !== undefined && json.code !== 0) {
    throw new Error(`sub2api 返回失败：${json.message || `code=${json.code}`}`);
  }
  return json?.data;
}

// 登录取 JWT。账号开了 TOTP 时 /auth/login 不直接回 token，而是回 requires_2fa + temp_token，
// 需再调 /auth/login/2fa。密码与验证码绝不进日志或错误信息。
export async function login({ base, email, password, totpCode = "" }) {
  const b = normalizeBase(base);
  await assertPublicTarget(`${b}/api/v1/auth/login`);
  let data;
  try {
    data = await callSub2api(`${b}/api/v1/auth/login`, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  } catch (error) {
    if (error?.status === 401 || error?.status === 400) {
      throw new Error("登录失败：邮箱或密码不正确。");
    }
    throw error;
  }
  if (data?.requires_2fa) {
    const code = String(totpCode || "").trim();
    if (!code) {
      throw new Error("该账号开启了两步验证（TOTP），请在弹窗里填写 6 位验证码后重试。");
    }
    data = await callSub2api(`${b}/api/v1/auth/login/2fa`, {
      method: "POST",
      body: JSON.stringify({ temp_token: data.temp_token, totp_code: code }),
    });
  }
  const token = String(data?.access_token || "");
  if (!token) throw new Error("登录成功但未取到 access_token：sub2api 响应结构可能有变。");
  return token;
}

// 拉取名称含「测试」的 API 密钥。只取 status=active（接口支持服务端过滤）。
// 按响应里的 pages 翻页，而不是靠「少于一页即结束」猜。
export async function fetchTestKeys({ base, token }) {
  const b = normalizeBase(base);
  const all = [];
  let pages = 1;
  for (let page = 1; page <= PAGE_CAP; page += 1) {
    const data = await callSub2api(`${b}/api/v1/keys?page=${page}&page_size=${PAGE_SIZE}&status=active`, { token });
    const items = Array.isArray(data?.items) ? data.items : [];
    const total = Number(data?.total);
    // 形状兜底：total 说有数据却一条都没解析出来 -> 是解析失败，不是「没有密钥」。
    // 静默返回空会让用户去怀疑自己的密钥命名，而真因可能是上游改了字段名。
    if (!items.length && page === 1 && Number.isFinite(total) && total > 0) {
      throw new Error(`无法解析 sub2api 的密钥列表：接口称共有 ${total} 个密钥，却没能读出任何一条（上游响应结构可能有变）。`);
    }
    all.push(...items);
    pages = Number.isFinite(Number(data?.pages)) ? Number(data.pages) : 1;
    if (page >= pages) break;
    if (page === PAGE_CAP) {
      console.warn(`[sub2api-import] 密钥分页命中 ${PAGE_CAP} 页上限（共 ${pages} 页），可能未取全。`);
    }
  }
  return all.filter((k) => isTestTokenName(k?.name));
}

// 模型广场：一次拿到「分组 -> 模型 -> platform」的完整视图。
// 需管理员开启，未开启返回 404 —— 那是**功能未启用**而非错误，返回 null 让上层回落。
export async function fetchModelPlaza({ base, token }) {
  const b = normalizeBase(base);
  try {
    return await callSub2api(`${b}/api/v1/model-plaza`, { token });
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

// 回落路径：用**明文密钥**（非 JWT）调网关的 /v1/models，拿该密钥实际可调的模型。
// 路径没有 /api/v1 前缀。串行 + 间隔，避免撞按用户限流。
// 单个密钥失败不应中断整体导入（可能只是该密钥被禁用），记空清单继续。
//
// 有条数上限（FALLBACK_MAX_KEYS）：本路径是**串行 + 每次间隔**，耗时随密钥数线性增长
// （实测 120 个约 25 秒，若放开到分页上限 20000 个会跑一个多小时），期间前端只显示「导入中…」
// 且请求一直挂着。超过上限直接报错、让用户去启用模型广场（那条路一次请求拿完全部映射），
// 而不是让请求无声地跑到不知何时——宁可明确失败，不要不确定的长挂起。
export async function fetchModelsPerKey({ base }, keyRows) {
  const b = normalizeBase(base);
  const out = {};
  const rows = Array.isArray(keyRows) ? keyRows : [];
  if (rows.length > FALLBACK_MAX_KEYS) {
    throw new Error(
      `该站点未启用「模型广场」，需逐个密钥查询模型，但符合条件的密钥有 ${rows.length} 个（上限 ${FALLBACK_MAX_KEYS}）——` +
        `逐个查询会耗时过长。请让站点管理员启用「模型广场」后重试，或减少名称含「测试」的密钥数量。`,
    );
  }
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row?.key) continue;
    if (i > 0) await new Promise((r) => setTimeout(r, FALLBACK_GAP_MS));
    try {
      const data = await callSub2api(`${b}/v1/models`, { apiKey: String(row.key) });
      // /v1/models 是 OpenAI 形态：{ data: [{ id }] }。信封解包后可能已是该结构。
      const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
      const names = list.map((m) => String(m?.id || m?.name || "").trim()).filter(Boolean);
      out[String(row.id)] = [...new Set(names)];
    } catch {
      out[String(row.id)] = [];
    }
  }
  return out;
}
