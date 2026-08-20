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
// 【为什么这里没有响应体大小上限】——刻意的取舍，不是漏了。
// PAGE_CAP 只限页数、不限单页体积：上游若单页返回 21.9MB（实测：6 万条密钥行）就会照吃，
// 解析后堆内存约 +37MB，随后建出等量渠道（saveChannels 实测 812ms，不会崩）。
// 对照 upstream-transport.mjs 的 MAX_UPSTREAM_STREAM_RESPONSE_BYTES —— 那里必须设限，
// 因为被测上游是【任意用户填进来的第三方 API】，行为不可信也不可控。
// 而本链路的上游是**测试人员自己搭建/自己持有账号的 sub2api 站点**，密钥也是他自己在上面建的；
// 要触发这个路径，等于他先在自己的站点上造出 6 万个名字含「测试」的密钥，再对自己发起导入。
// 换言之收益端和攻击端是同一个人，且他已经把该站点的登录密码填进了本工具。
// 故风险很低，不值得为它引入流式解析（fetch().json() 拿不到增量，要改就得手写 chunk 累加 + 提前中止，
// 是对两条链路的实质改写）。
// 若哪天这两条导入链路要面向"不完全信任的第三方站点"开放（例如做成公共服务、或允许非超管发起导入），
// 这个取舍就不再成立，必须回来补上限。
const FALLBACK_GAP_MS = 200; // 逐密钥调 /v1/models 时的间隔（面板/网关都有按用户限流）
// 回落路径的密钥上限：串行 + 200ms 间隔，150 个约 30 秒已是可接受等待的上限。
// 超过就报错让用户改用模型广场，而不是让请求挂上几十分钟（详见 fetchModelsPerKey 的说明）。
const FALLBACK_MAX_KEYS = 150;
// 回落路径的【总耗时】上限。条数上限只在上游正常响应时才等于时间上限：每个密钥各自享有
// 完整的 timeoutMs（默认 15s），上游若挂起不答，150 个密钥 = 150 × 15s ≈ 38 分钟
// （实测耗时随密钥数线性增长：1/3/6 个分别 613/2240/4697ms，与 n × timeout 吻合）。
// 期间请求一直挂着、前端只显示「导入中…」，与本文件"宁可明确失败，不要不确定的长挂起"的原则相悖。
// 故再加一道按墙钟的总预算：超了就停下并报错指路。
// 走 envInt（而非写死常量）：一是让用例能把预算压到亚秒级来验证中止行为，
// 二是给运维在"上游确实慢但还能用"时留一个调大的口子。默认 2 分钟。
function fallbackBudgetMs() {
  return envInt("EVALUATOR_SUB2API_FALLBACK_BUDGET_MS", 120_000, { min: 100, max: 3_600_000 });
}

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
// 凭据进请求头前先自检。含 CR/LF 的值会让 undici 的 Headers.append 抛 TypeError，
// 而它的 message 里【带着凭据原文】——该 message 一路经端点的 catch 变成 userMessage 回到浏览器
// （在 new-api 那条链路上实测复现过凭据回显）。这里主动挡掉并给出不含凭据的错误信息。
// 本链路的 token 是上游签发的 JWT、apiKey 是上游返回的密钥：正常都不含控制字符，
// 带了说明上游响应异常或被篡改，同样该明确失败而不是把原文抛出去。
function assertHeaderSafe(value, label) {
  // eslint-disable-next-line no-control-regex -- 刻意匹配控制字符
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label}含控制字符，无法用于请求头（上游响应可能异常）。`);
  }
}

async function callSub2api(url, { token = "", method = "GET", body = null, apiKey = "" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  const headers = {};
  // /v1/* 网关接口用**明文 API 密钥**认证；/api/v1/* 面板接口用登录得到的 JWT。
  const bearer = apiKey || token;
  if (bearer) {
    assertHeaderSafe(String(bearer), apiKey ? "API 密钥" : "登录凭证");
    headers.Authorization = `Bearer ${bearer}`;
  }
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
// 两道上限，缺一不可：
//   · 条数（FALLBACK_MAX_KEYS）——挡住"密钥太多"这种一看就知道会很慢的情形，可提前拒绝、不发请求。
//   · 总耗时（FALLBACK_TOTAL_BUDGET_MS）——条数上限只在上游【正常响应】时才等于时间上限。
//     每个密钥各自享有完整的 timeoutMs，上游挂起不答时 150 个密钥能跑 38 分钟（见常量处实测数据）。
//     故必须另按墙钟兜一道：超预算就带着已拿到的部分结果停下并报错。
// 两者都指向同一句建议：让站点管理员启用「模型广场」，那条路一次请求拿完全部映射。
// 宁可明确失败，不要不确定的长挂起。
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
  const startedAt = Date.now();
  const budgetMs = fallbackBudgetMs();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row?.key) continue;
    // 预算检查放在【发请求前】：已经花掉的时间无法退回，能做的是不再往里投。
    // 报错而不是静默返回半份结果——半份结果会让上层把没查到模型的密钥建成 0 模型渠道，
    // 用户看到的是"导入成功但一半渠道没模型"，比明确失败更难排查。
    const elapsed = Date.now() - startedAt;
    if (elapsed > budgetMs) {
      throw new Error(
        `逐个密钥查询模型已耗时 ${Math.round(elapsed / 1000)} 秒（上限 ${Math.round(budgetMs / 1000)} 秒），` +
          `已处理 ${i}/${rows.length} 个，判定上游响应过慢并中止。请让站点管理员启用「模型广场」后重试` +
          `（那条路一次请求即可拿到全部分组与模型，不受本限制）。`,
      );
    }
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
