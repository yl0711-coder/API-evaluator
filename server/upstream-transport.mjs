// server/upstream-transport.mjs
// 上游探测的传输骨架：HTTP 请求 / 重试退避 / 超时 / 字节截断 / TTFT。
//
// 从 server/test-runner.mjs 整块搬出（16 号报告 B1）。代码逐字未改——纯搬运。
// 协议相关部分（buildRequest / interpret / computeSuccess）通过回调注入，传输层对协议一无所知。
// finalizeRecord 回调也由调用方注入（持久化逻辑留在 test-runner.mjs）。
import crypto from "node:crypto";
import { readProfileApiKey } from "./secret-store.mjs";
import { assertPublicTarget } from "./egress-guard.mjs";
import {
  firstTokenPatternFor,
  isClaudeEffortUnsupportedError,
  isMaxTokensRenameRequiredError,
  isReasoningEffortUnsupportedError,
  isStreamOptionsUnsupportedError,
  isTemperatureUnsupportedError,
  normalizeHttpError,
} from "./protocols.mjs";
import { summarizeText } from "./utils.mjs";
import { envInt } from "./env-config.mjs";
import { recordUpstreamTiming } from "./performance.mjs";

export const MAX_UPSTREAM_RESPONSE_BYTES = 2 * 1024 * 1024;
// 流式 SSE 每个 token 单独成帧、外裹一层 JSON 信封（Claude 更是每 token 多个事件），体积是同等纯
// 文本的 50–100 倍；长输出（maxTokens override ≥ ~8k 或推理模型长思考）流式下轻松 5–7MB。若沿用上面
// 2MB 上限，健康渠道的长流式响应会在 2MB 处被截断、误判 response_too_large → 判 F（好渠道判成坏渠道）。
// 故流式单独放大上限；仍有硬顶（+每请求超时兜底），不会因坏上游无界缓冲。可用 env 覆盖。
// 走 envInt：旧写法的 `> 0` 已挡住 NaN，但收下 "Infinity"——那等于把这个硬顶取消，坏上游
// 一路吐流就能把评测机的内存吃干（这个上限存在的唯一目的就是防这件事）。上限 512MB 是形式约束（P1-04）。
// min 同样保持 1（只拒无意义的值，不替运维定"多小算太小"）；测试若要压出截断分支会配很小的上限。
export const MAX_UPSTREAM_STREAM_RESPONSE_BYTES = envInt("EVALUATOR_MAX_STREAM_RESPONSE_BYTES", 24 * 1024 * 1024, {
  max: 512 * 1024 * 1024,
});

// 流式完整性：只在「流被截断 / 出错帧 / 内容块损坏」这些**确定**的不完整信号上判失败。
// 刻意不采纳 summarizeStreamStructure 的全部 issue（如 invalid_json_chunk、event_order_invalid 等
// 软信号）——那些在健康但怪癖的中转上会误触发，把好流判失败，是评测工具最不该犯的错。
// finish_reason=length 这类「内容被 max_tokens 截断」不在此列：那种流仍有完整终止帧，属正常截断，
// 由 isTruncatedFinish 另行处理，不当失败。
const FATAL_STREAM_ISSUES = new Set([
  "empty_stream", // 2xx 却一个事件都没有
  "missing_done", // OpenAI SSE 无 [DONE] 终止帧 → 半截流
  "missing_message_stop", // Claude SSE 无 message_stop 终止帧 → 半截流
  "missing_content_block_stop", // Claude 内容块未收尾
  "stream_error_event", // 吐到一半改口报错帧
  "content_block_not_found", // Claude 已知的块错位崩溃
  "content_block_dropped", // delta 落在从未 start 的块 → 内容丢失
]);

export function streamCompletenessError(streamValidation) {
  if (!streamValidation || streamValidation.passed) return "";
  const fatal = (streamValidation.issues || []).filter((issue) => FATAL_STREAM_ISSUES.has(issue));
  if (!fatal.length) return "";
  return fatal.includes("stream_error_event") ? "stream_error" : "stream_incomplete";
}

// 把外部取消信号（任务级 AbortController）接到单请求的 controller：取消时立即
// abort 在飞的 fetch，不必等当前请求超时/自然结束。返回解绑函数，在 finally 调用。
export function linkExternalAbort(controller, signal) {
  if (!signal) return () => {};
  if (signal.aborted) {
    controller.abort();
    return () => {};
  }
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

// 上游探测的统一骨架：三类探测（普通生成 / 工具调用 / 流式结构）只在
//   ① buildRequest 构造请求 ② interpret 解释成功响应 ③ computeSuccess 成功判定 三处不同；
// 其余（超时 / 外部中止 / 截断保护 / 计时 / auth-fail / finalize 落库）完全一致。
// 瞬时失败退避重试参数：限流型中转最常见的就是 429，单次不重试会整轮判 F。
const RETRY_MAX_ATTEMPTS = 3; // 含首次：最多 1 + 2 次重试
const RETRY_BASE_DELAY_MS = 600; // 指数退避基数
const RETRY_MAX_DELAY_MS = 20000; // 单次退避上限（同时钳制 Retry-After，避免被上游要求长睡）
// 本进程内记住哪些「协议|baseUrl|model」拒绝自定义 temperature，后续同键请求首发就不带，
// 省掉那次注定 400 的往返。仅内存态：模型不会中途改变是否支持，重启后从头学习即可。
// 键含协议的理由见下方 tempKey 的构造处（跨协议误学习实测复现过）。
const TEMPERATURE_UNSUPPORTED_MODELS = new Set();
// 同款记忆：本进程内曾因 stream_options 被 400 的模型，后续流式请求首发就不带，省掉注定失败的往返。
const STREAM_OPTIONS_UNSUPPORTED_MODELS = new Set();
// 同款记忆：曾因思考强度被 400 的模型。两种协议形状（OpenAI 扁平 reasoning_effort / Claude 嵌套
// output_config.effort）共用这一个 Set，但**键里带协议**故互不污染——曾有一版注释断言
// 「同一个 baseUrl+model 只会走一种协议」，那条已被实测推翻（中转同时暴露两种端点是常态），
// 见 tempKey 构造处。
//
// 【键里还必须带请求形状】——这是与上面两个名单的关键差异，不是多余的谨慎：
// GPT-5.6 系在 chat/completions 上「带 function tools 时」才拒收 reasoning_effort，普通生成请求
// 完全接受。若沿用 `baseUrl|model` 作键，工具题那一次 400 会让**后续所有生成探测**也首发就不带档位，
// 于是用户选了 high、报告显示 high，实际却在模型默认档上跑——静默失真，正是本仓库最忌讳的那种。
// 故按 `协议|baseUrl|model|hasTools` 记忆：各形状各自学习，互不污染。
const REASONING_EFFORT_UNSUPPORTED_MODELS = new Set();

// 同款记忆：本进程内曾被要求把 max_tokens 改名成 max_completion_tokens 的模型
//（OpenAI o 系 / GPT-5 系），后续同模型请求首发就用新名，省掉那次注定 400 的往返。
//
// 键用 `协议|baseUrl|model`，不像 REASONING_EFFORT 那样还要把请求形状（tools）编进去：
// 「这个模型用哪个字段名」与带不带 tools、是否流式都无关。但**协议维度仍要留**——
// 同址同模型换协议时 URL 与请求形状都不同（如 openai_path_prefix 打 baseUrl/chat/completions、
// openai_compatible 打 baseUrl/v1/chat/completions），拿另一条协议学到的字段名去发注定不对。
// 与 renameMaxTokens 的 claude_messages 门禁是两层独立防护：门禁挡「绝不能改名」的那一族，
// 协议分区挡「同族不同端点」的误学习。
//
// 【刻意不做全局换名】——首发仍发 max_tokens，只在被 400 点名后才改。理由是反向危险同样真实：
// 大量中转、非 OpenAI 厂商（智谱 / DashScope / 月之暗面 / 火山）、旧版 Azure 部署只认 max_tokens，
// 收到 max_completion_tokens 会回 "Unrecognized request argument supplied: max_completion_tokens"。
// 而「经中转测」恰恰是本工具最主要的使用场景：全局换名等于拿现在能用的多数去换现在不能用的少数。
// 按 400 学习的另一个好处：若某模型其实两个都收（或官方日后回退），本策略零成本——
// 不多发请求、不多花额度，行为与改动前完全一致。
const MAX_TOKENS_RENAME_MODELS = new Set();

// max_tokens → max_completion_tokens 就地改名。返回是否真的改了。
// 【必须按协议门禁】Claude 分支绝不能改：Anthropic 的 max_tokens 是**必填**字段，
// 改名会让原生 Claude 渠道从「好的」变成「坏的」——本工具最主要的两类渠道之一直接全灭。
function renameMaxTokens(profile, body) {
  if (profile.protocol === "claude_messages") return false;
  if (body?.max_tokens === undefined) return false;
  body.max_completion_tokens = body.max_tokens;
  delete body.max_tokens;
  return true;
}

// 思考强度在两种协议里的落点不同：OpenAI 系是扁平 reasoning_effort，Claude 是嵌套
// output_config.effort。以下三个小工具把这个差异收在一处，免得「判断有没有」「删掉」这两件事
// 在预检、400 摘参两个分支里各写两遍字段路径——漏改一处就是静默失真。
function requestHasEffort(body) {
  return body?.reasoning_effort !== undefined || body?.output_config?.effort !== undefined;
}

function deleteRequestEffort(body) {
  if (!body) return;
  delete body.reasoning_effort;
  if (body.output_config && typeof body.output_config === "object") {
    delete body.output_config.effort;
    // effort 是我们唯一会写进 output_config 的子字段；删空后连壳一起去掉。
    // 留一个空对象在请求体里，对「不认 output_config 这个顶层字段」的上游（拒收原因 ①）
    // 等于没摘参，重试会再吃一个同样的 400、白烧一次往返。
    if (Object.keys(body.output_config).length === 0) delete body.output_config;
  }
}

// 该协议下「上游确实点名了思考强度」的判定。字段名不同 → 探测器也必须分开选，
// 用错一边永远判不出来（按 reasoning_effort 去查 Claude 的报错必然查不到），摘参重试就永不触发。
function isEffortUnsupportedFor(protocol, raw) {
  return protocol === "claude_messages" ? isClaudeEffortUnsupportedError(raw) : isReasoningEffortUnsupportedError(raw);
}

// Retry-After（秒数或 HTTP 日期）→ 毫秒。无法解析 → null。
function parseRetryAfter(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

// 退避睡眠，可被外部取消打断。返回 true=被取消，false=正常睡完。
function sleepUnlessAborted(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(true);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      resolve(true);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

// API key 仅请求时读取，绝不进日志/报告（finalizeRecord 只写脱敏元数据）。
// 429 / 5xx / 瞬时网络错误会指数退避重试；超时与用户取消止损不重试。
export async function executeUpstreamRequest(
  profile,
  options,
  { buildRequest, interpret, computeSuccess, captureFirstToken = false, finalizeRecord },
) {
  const requestId = crypto.randomUUID();
  const startedAt = new Date();
  const timeoutMs = Number(profile.timeoutMs || 300000);

  // 贯穿各 finalize 分支的可变结果（含变体特有字段 toolCall / streamValidation / firstTokenMs）。
  const r = {
    firstByteMs: null,
    firstTokenMs: null,
    totalMs: null,
    retryWaitMs: 0,
    attemptStatuses: [],
    attemptErrors: [],
    // 端到端耗时（修 ADM-010）：含被重试掉的失败尝试与它们之间的退避等待。
    // totalMs 只是【最后一次】尝试的耗时——一个"首次 503、退避 2s、二次 800ms 成功"的请求，
    // totalMs 记 800ms，报告里的 P95 因此系统性优于用户真实体感，而准入决策看的正是这个数。
    // 两个口径都保留、都进报告：totalMs 答"上游一次请求有多快"，endToEndMs 答"用户等了多久"。
    // 【刻意不含】确定性重配（temperature / stream_options 被拒后就地删参重试）：那是修我方
    // 请求体、零退避、且同模型只会发生一次（TEMPERATURE_UNSUPPORTED_MODELS 记住后首发就不带），
    // 计进去只会让每个模型的第一条记录凭空变慢，反而制造新的失真。见下方 endToEndStartedAt。
    endToEndMs: null,
    statusCode: null,
    statusText: "", // HTTP reason phrase（原因短语）；HTTP/1.1 可自定义，HTTP/2 无、为空
    responseText: "",
    usage: null,
    finishReason: null,
    rawError: "",
    // 未截断的原始响应体；仅 options.keepRawResponse 时填充（见下方采集点）。
    rawResponse: "",
    rawResponsePartial: false, // 上面那份是断流残体（非完整响应），报告须如实标注
    normalizedError: "",
    toolCall: null,
    streamValidation: null,
    // 「用户手填的 temperature 被本层摘掉了」。只在 profile.temperatureOverride 非空时才置位——
    // 摘掉工具自己的默认 0.2 属于内部自愈、无需惊动用户；摘掉用户明确填的值必须如实上报，
    // 否则报告里的数字来自一个和用户所填不同的温度，却毫无痕迹。
    temperatureStripped: false,
    // 同上：用户选的思考强度被本层摘掉了（上游拒收该字段/该档位，或与 function tools 冲突）。
    // 这个字段【只有】用户明确选档时才可能置位——留空时我们根本不发 reasoning_effort。
    reasoningEffortStripped: false,
    // max_tokens 被改名成 max_completion_tokens 发出（OpenAI o 系 / GPT-5 系要求）。
    // 与上面两个标记不同，这【不是】失真：同一个数值上限，只是字段名不同，无需惊动用户，
    // 故只落进 requests.jsonl 供诊断，不出提示卡、不进报告正文。
    // 留它的理由是一处真实差异：新字段的预算【含推理 token】，而老 max_tokens 在非推理模型上
    // 只约束可见输出。于是推理模型可能把预算烧在不可见的思考上、回一个空串或截断——
    // 排查「为什么这条记录空响应/被截断」时，这个标记是关键线索。
    maxTokensRenamed: false,
  };
  let attempts = 0; // 实际发出的请求次数（含重试），写进记录便于诊断
  // 端到端计时起点（ADM-010）。在真正开始发请求前赋值；确定性重配会把它【重置】到重配后的那次
  // 尝试——被拒的那次不是用户会遇到的等待（同模型只发生一次，之后首发就不带该参数）。
  // 负载性重试（429 / 5xx / 网络错误）不重置：那正是要计入的真实等待。
  // 声明在此是为了让 finalize() 能读到它——多个 break 出口各自赋值容易漏，统一在 finalize 里算。
  let endToEndStartedAt = null;
  // 是否流式：取自【真正发出去的请求体】，不取调用方声明，两者不会脱节。
  // 之前没这个字段，只能拿 firstTokenMs 是否有值反推——而流式请求若一个可见 token 都没吐到
  // （空响应、上游中途死掉），它同样是 null，反推会把这类请求误判成非流式。
  let streaming = false;
  const finalize = async () => {
    // 统一在这里算端到端：循环有多个 break 出口（成功、不可重试、超上限、退避中被取消），
    // 逐个出口赋值必然漏掉某条。endToEndStartedAt 为 null 表示一次请求都没发出去
    // （Key 缺失 / buildRequest 抛错 / egress 阻断），此时端到端无意义，保持 null 而不是记 0。
    if (endToEndStartedAt != null) {
      r.endToEndMs = Math.round(performance.now() - endToEndStartedAt);
      // 只有一次尝试时两者本应相等；取 max 是为了兜住 endToEndMs 因舍入比 totalMs 小 1ms
      // 的情形——「端到端比单次还快」在报告里是说不通的。
      if (r.totalMs != null) r.endToEndMs = Math.max(r.endToEndMs, r.totalMs);
    }
    const result = await finalizeRecord({
      options,
      profile,
      requestId,
      startedAt,
      firstByteMs: r.firstByteMs,
      firstTokenMs: r.firstTokenMs,
      stream: streaming,
      totalMs: r.totalMs,
      endToEndMs: r.endToEndMs,
      retryWaitMs: r.retryWaitMs,
      attemptStatuses: r.attemptStatuses,
      attemptErrors: r.attemptErrors,
      statusCode: r.statusCode,
      statusText: r.statusText,
      responseText: r.responseText,
      usage: r.usage,
      finishReason: r.finishReason,
      rawError: r.rawError,
      rawResponse: r.rawResponse,
      rawResponsePartial: r.rawResponsePartial,
      normalizedError: r.normalizedError,
      toolCall: r.toolCall,
      streamValidation: r.streamValidation,
      temperatureStripped: r.temperatureStripped,
      reasoningEffortStripped: r.reasoningEffortStripped,
      maxTokensRenamed: r.maxTokensRenamed,
      attempts,
      successOverride: computeSuccess(r),
    });
    recordUpstreamTiming({
      statusCode: result.statusCode,
      normalizedError: result.normalizedError,
      attempts: result.attempts,
      attemptStatuses: result.attemptStatuses,
      attemptErrors: result.attemptErrors,
      retryWaitMs: result.retryWaitMs,
      endToEndMs: result.endToEndMs,
    });
    return result;
  };

  const apiKey = await readProfileApiKey(profile);
  if (!apiKey) {
    r.rawError = "API Key 未配置或无法从密钥存储读取。";
    r.normalizedError = "auth_failed";
    r.totalMs = 0;
    return await finalize();
  }
  let request;
  try {
    request = buildRequest({ ...profile, apiKey });
    streaming = request.body?.stream === true;
    await assertPublicTarget(request.url); // egress 阻断等确定性失败：不重试
  } catch (error) {
    r.totalMs = 0;
    r.rawError = error instanceof Error ? error.message : String(error);
    r.normalizedError = "network_error";
    return await finalize();
  }
  // 已知拒绝自定义 temperature 的模型（本进程内曾被 400 过）：首发就不带，省掉那次注定失败的往返。
  //
  // 【键里必须带协议】——同一个 baseUrl + model 完全可能同时存在两种协议的渠道：中转
  // （new-api / one-api / sub2api）常同时暴露 /v1/chat/completions 与 /v1/messages，而渠道判重键是
  // `baseUrl|keyHash`（不含协议）、sub2api 导入又是「每个密钥建一个渠道、协议按分组 platform 各判」，
  // 于是「同址同模型、协议不同」是本工具的常见形态而非边缘情况。
  // 不带协议的后果已实测复现：Claude 渠道因拒收某参数写进名单后，OpenAI 渠道**首发就丢掉**
  // 用户填的那个值——而那个端点本来是接受的。报告虽会标注"未生效"，但用户选的档位/温度实际没跑，
  // 且归因指向错误的方向。故四个名单统一按 `协议|baseUrl|model` 分区：两种形状各自学习。
  // 代价是同址同模型换协议时要各吃一次 400（每种形状一次），有界且值得。
  const tempKey = `${profile.protocol || "openai"}|${profile.baseUrl}|${profile.defaultModel}`;
  if (request.body?.temperature !== undefined && TEMPERATURE_UNSUPPORTED_MODELS.has(tempKey)) {
    delete request.body.temperature;
    // 这条记忆是进程级的，无法区分「上次是谁填的温度」；此处按本次调用是否带了用户覆盖来判定。
    if (profile.temperatureOverride != null) r.temperatureStripped = true;
  }
  // 同上：已知不认 stream_options 的模型，流式请求首发就不带（拿不到上游 usage，调用方回退字符估算）。
  if (request.body?.stream_options !== undefined && STREAM_OPTIONS_UNSUPPORTED_MODELS.has(tempKey)) {
    delete request.body.stream_options;
  }
  // 同上：已知拒收 reasoning_effort 的「模型 + 请求形状」，首发就不带。
  // 键带 hasTools（见名单定义处的注释）：工具请求与普通请求各自学习，一次工具题被拒不会
  // 让后续生成探测也悄悄丢档位。
  const effortKey = `${tempKey}|tools:${request.body?.tools ? "1" : "0"}`;
  if (requestHasEffort(request.body) && REASONING_EFFORT_UNSUPPORTED_MODELS.has(effortKey)) {
    deleteRequestEffort(request.body);
    r.reasoningEffortStripped = true; // 只有用户明确选档才会走到这里（留空时字段根本不存在）
  }
  // 协议层就地丢弃了用户选的档位（Claude 不认 none / minimal——不在其取值域里，发出去注定 400，
  // 见 protocols.mjs 的 applyClaudeEffort）。请求体里本来就没有该字段，无需再删，
  // 但必须在这里转成 reasoningEffortStripped：否则用户选了 none、报告一声不响，
  // 读者会把「模型默认档（=high）的表现」当成「不思考时的表现」——两者差别极大。
  if (request.effortDropped) r.reasoningEffortStripped = true;
  // 已知要求新字段名的模型（本进程内曾被 400 过）：首发就用 max_completion_tokens。
  if (MAX_TOKENS_RENAME_MODELS.has(tempKey) && renameMaxTokens(profile, request.body)) {
    r.maxTokensRenamed = true;
  }

  endToEndStartedAt = performance.now();
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    // 每次尝试独立的超时控制器；外部取消（options.abortSignal）贯穿所有尝试。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const unlinkAbort = linkExternalAbort(controller, options.abortSignal);
    // 重置本次尝试的瞬时字段，避免上次失败残留泄漏到下一次。
    // totalMs 也必须清：catch 分支写的是 `r.totalMs ?? 实测值`，不清就会被上一次尝试的旧值
    // 拦住（第 1 次慢 429 → 第 2 次被取消，记的却是第 1 次的耗时），把假延迟喂进 P50/P95。
    r.totalMs = null;
    // endToEndMs 刻意【不】在这里重置：它跨尝试累计，每轮末尾按 endToEndStartedAt 重算。
    r.firstByteMs = null;
    r.firstTokenMs = null;
    r.statusCode = null;
    r.statusText = "";
    r.responseText = "";
    r.usage = null;
    r.finishReason = null;
    r.rawError = "";
    r.rawResponse = "";
    r.rawResponsePartial = false;
    r.normalizedError = "";
    r.toolCall = null;
    r.streamValidation = null;
    // temperatureStripped / reasoningEffortStripped 刻意【不】在这里重置：它们记录的是
    // 「本次调用最终发出的请求体少了用户填的参数」，跨尝试有效。清掉会让摘参后成功的那次
    // 报告里不留痕迹——正是这个标记要防的事。
    let retryable = false;
    let retryAfterMs = null;
    // 确定性重配：上游拒收某个我方可选参数（temperature / stream_options），已就地删掉并原样重试。
    // 这不是负载信号、也不退避，故 noRetry（压测）也应放行——否则压测首批请求会白白判失败。
    let reconfigured = false;
    // 计时起点提到 try 外：catch 分支也要拿它算真实耗时（见下方 r.totalMs）。
    const started = performance.now();
    try {
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
        redirect: "error",
      });
      r.firstByteMs = Math.round(performance.now() - started);
      r.statusCode = response.status;
      r.attemptStatuses.push(response.status);
      // 原因短语：直接取上游实际返回的 statusText（HTTP/1.1 可被上游自定义），不套用标准短语。
      r.statusText = typeof response.statusText === "string" ? response.statusText : "";
      // 流式响应体积远大于纯文本（每 token 独立成帧），用放大后的上限，避免长流式被误截断判 F。
      const responseByteCap = streaming ? MAX_UPSTREAM_STREAM_RESPONSE_BYTES : MAX_UPSTREAM_RESPONSE_BYTES;
      const rawResult = await readBoundedResponseText(response, responseByteCap, controller, {
        firstTokenPattern: captureFirstToken ? firstTokenPatternFor(profile.protocol) : null,
      });
      r.totalMs = Math.round(performance.now() - started);
      // 真 TTFT：首个「可见输出 token」所在分片的到达时刻。仅流式可测；非流式 JSON 整体返回、
      // 无 token 级时序，故 captureFirstToken=false 时保持 null。
      // 刻意不退回 firstChunkAt：首帧可能是 Claude 的 message_start / 中转保活帧，
      // 用它会让 TTFT 系统性偏快且跨协议不可比——测不到就留 null（报告按「—」省略），不给假数字。
      if (captureFirstToken && rawResult.firstTokenAt != null) {
        r.firstTokenMs = Math.max(0, Math.round(rawResult.firstTokenAt - started));
      }
      if (rawResult.truncated) {
        r.rawError = `上游响应超过 ${responseByteCap} bytes，已停止读取。`;
        r.normalizedError = "response_too_large";
        break; // finally 会清理；不重试
      }
      const raw = rawResult.text;
      if (!response.ok) {
        r.rawError = summarizeText(raw);
        r.normalizedError = normalizeHttpError(response.status, raw);
        if (response.status === 429 || response.status >= 500) {
          retryable = true; // 限流 / 上游 5xx：可重试
          retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        } else if (response.status === 400 && request.body?.temperature !== undefined && isTemperatureUnsupportedError(raw)) {
          // 部分 OpenAI 系模型（o 系 / GPT-5 系）拒绝自定义 temperature：去掉后立即原样重试。
          // 就地删掉，本次调用后续尝试都不再带 temperature（guard 保证只触发一次，不会死循环）；
          // 并记住该模型，让后续请求首发就不带。
          TEMPERATURE_UNSUPPORTED_MODELS.add(tempKey);
          delete request.body.temperature;
          // 同上：只有用户明确填过温度才算「被摘」，摘默认值是内部自愈、不必上报。
          if (profile.temperatureOverride != null) r.temperatureStripped = true;
          retryable = true;
          reconfigured = true;
          retryAfterMs = 0; // 确定性重配，不退避
        } else if (response.status === 400 && request.body?.stream_options !== undefined && isStreamOptionsUnsupportedError(raw)) {
          // 同 temperature：部分中转不认 stream_options（我们只用它取 usage）。去掉后立即原样重试，
          // 否则「勾了流式」的场景题会被误判失败、压测（noRetry 之外的路径）整轮 0% 成功率。
          // 代价仅是没有上游 usage → 调用方回退按字符估算输出 token。
          STREAM_OPTIONS_UNSUPPORTED_MODELS.add(tempKey);
          delete request.body.stream_options;
          retryable = true;
          reconfigured = true;
          retryAfterMs = 0; // 确定性重配，不退避
        } else if (response.status === 400 && requestHasEffort(request.body) && isEffortUnsupportedFor(profile.protocol, raw)) {
          // 同 temperature：上游拒收思考强度（非推理模型 / 不认这一档 / 与 function tools 冲突 /
          // 中转或老版本 API 不认这个字段）。去掉后原样重试，让这一题仍能测出结果，代价是它跑在
          // 模型默认档上——故必须置 reasoningEffortStripped 让报告如实标注，否则报告显示的档位与实际不符。
          // 两种协议形状都走这一支：删参与判定各自按协议分流（见 deleteRequestEffort / isEffortUnsupportedFor）。
          REASONING_EFFORT_UNSUPPORTED_MODELS.add(effortKey);
          deleteRequestEffort(request.body);
          r.reasoningEffortStripped = true;
          retryable = true;
          reconfigured = true;
          retryAfterMs = 0; // 确定性重配，不退避
        } else if (response.status === 400 && isMaxTokensRenameRequiredError(raw) && renameMaxTokens(profile, request.body)) {
          // OpenAI o 系 / GPT-5 系要求把 max_tokens 改名成 max_completion_tokens。改名后原样重试。
          // 与上面三支的差别：这是【改名】不是【摘参】——max_tokens 是输出上限，摘掉会放开到模型
          // 自己的上限（GPT-5.6 达 128K），既烧额度又会把响应顶到字节上限判 response_too_large。
          // renameMaxTokens 放在条件里：它按协议门禁（Claude 的 max_tokens 必填，不能改），
          // 返回 false 时不该进这一支——否则会白重试一次同样的请求。
          MAX_TOKENS_RENAME_MODELS.add(tempKey);
          r.maxTokensRenamed = true;
          retryable = true;
          reconfigured = true;
          retryAfterMs = 0; // 确定性重配，不退避
        }
      } else {
        interpret(r, raw);
      }
      // 「在报告中完整显示返回」：没提取到文本时（空响应 / SSE 异常 / 上游错误页），rawError 已被
      // summarizeText 砍到 500 字并压平换行，恰恰是最需要看全文的情形却只剩开头。这里留一份未截断的
      // 原始响应（已受 MAX_UPSTREAM_RESPONSE_BYTES 限长）。仅调用方明确要求时保留：全文只随记录进报告，
      // 不进 requests.jsonl（同 responseText，见 finalizeRecord）。
      if (options.keepRawResponse && !r.responseText) r.rawResponse = raw;
      r.attemptErrors.push(r.normalizedError || "");
    } catch (error) {
      // 记真实耗时，不再拿 timeoutMs 顶替：真超时两者本来就≈相等，但「用户取消」是提前中断的，
      // 一条实际 1-2 秒的记录会被写成 total_ms=300000，污染所有基于 test_requests.total_ms 的
      // 延迟统计（P50/P95、趋势、回归对比）。实测取消准入任务时复现过。
      r.totalMs = r.totalMs ?? Math.round(performance.now() - started);
      // undici 的 fetch reject 常是 "fetch failed"，真正的 errno 在 error.cause.code（如 ECONNRESET）。
      // 附到 rawError，供压测区分网络错误是本机侧还是上游侧。
      const errno = error?.cause?.code || error?.code || "";
      r.rawError = [error instanceof Error ? error.message : String(error), errno].filter(Boolean).join(" ");
      // 断流前已收到的半截 body（readBoundedResponseText 挂上来的）：标记为不完整，
      // 报告不得把它当完整响应体展示。
      if (options.keepRawResponse && typeof error?.partialText === "string" && error.partialText) {
        r.rawResponse = error.partialText;
        r.rawResponsePartial = true;
      }
      if (/abort|timeout|timed out/i.test(r.rawError)) {
        r.normalizedError = "timeout"; // 超时或用户取消：止损，不重试
      } else {
        r.normalizedError = "network_error";
        retryable = true; // 瞬时网络错误：可重试
      }
      r.attemptStatuses.push(null);
      r.attemptErrors.push(r.normalizedError);
    } finally {
      clearTimeout(timer);
      unlinkAbort();
    }

    // options.noRetry：压测模式下每请求只测一次——重试会吞掉 429/5xx（正是要测的限流/不稳信号）、
    // 并把退避 sleep 混进延迟，污染 QPS / 尾延迟 / 错误分类。见 server/load-test.mjs。
    // 例外：确定性重配（reconfigured）是修我方请求体、零退避、totalMs 按最后一次尝试计，
    // 不会污染任何负载信号，故压测也放行——不然首批请求全因可选参数被拒而误判失败。
    if (!retryable || (options.noRetry && !reconfigured) || attempt >= RETRY_MAX_ATTEMPTS) break;
    const backoffMs =
      retryAfterMs != null
        ? Math.min(retryAfterMs, RETRY_MAX_DELAY_MS)
        : Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
    // 确定性重配：把端到端起点挪到【下一次】尝试之前，丢弃被拒那次的耗时。
    // 放在退避 sleep 之前是刻意的——reconfigured 的 retryAfterMs 恒为 0，这里不会漏掉真实等待。
    if (reconfigured) endToEndStartedAt = performance.now();
    if (await sleepUnlessAborted(backoffMs, options.abortSignal)) break; // 退避中被取消则立刻收手
    r.retryWaitMs += backoffMs;
  }

  return await finalize();
}

// firstTokenPattern：命中即视为「首个可见输出 token 已到达」（见 protocols.firstTokenPatternFor）。
// 不传则只记 firstChunkAt，行为与旧版一致。
export async function readBoundedResponseText(response, maxBytes, controller, { firstTokenPattern = null } = {}) {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    controller.abort();
    return { text: "", truncated: true, firstChunkAt: null, firstTokenAt: null };
  }

  if (!response.body?.getReader) {
    if (!contentLength) {
      controller.abort();
      return { text: "", truncated: true, firstChunkAt: null, firstTokenAt: null };
    }
    const text = await response.text();
    return {
      text: text.slice(0, maxBytes),
      truncated: Buffer.byteLength(text, "utf8") > maxBytes,
      firstChunkAt: null,
      firstTokenAt: null,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let totalBytes = 0;
  let firstChunkAt = null; // 首个分片到达时刻（performance.now()）——含 message_start / 保活帧，不等于首 token
  let firstTokenAt = null; // 首个「可见输出 token」所在分片的到达时刻，才是 TTFT 的正确口径
  // 滑动窗：只留尾部若干字符 + 新分片，既能匹配跨分片被切断的标记，又不让正则开销随响应体线性增长。
  let matchWindow = "";
  const MATCH_WINDOW = 4096;

  // P2-5：reader.read() 不保证跟随 AbortSignal —— fetch 的 signal 作用于网络层，而响应体
  // ReadableStream 的 reader.read() 是独立 API。曾观测到「响应头已到、流挂起」时 controller.abort()
  // 中止不了读取，请求挂到 timeoutMs 耗尽才抛 AbortError（该有 15s，实测延到 5 分钟）。
  // 故用 Promise.race 竞速「实际读取」与「abort 信号」，信号先到时主动抛 AbortError 中止循环。
  // 保留这段是**跨 undici 版本的防御**：新版 undici 已会把 abort 传播到 body 流（该版本上竞速永远是
  // undici 先赢，这段不生效），但旧版/其它运行时未必，删掉就等于赌运行时行为。
  //
  // 【监听器必须在循环外注册一次】初版把 new Promise + addEventListener 写在循环【内】，于是监听器数
  // 随 read() 次数线性增长——每轮挂一个新的 abort 监听器、从不移除，各自持有一个 reject 闭包。
  // 实测 500 次读取 = 501 个监听器；按流式上限 MAX_UPSTREAM_STREAM_RESPONSE_BYTES（24MB、
  // 每次 read 约 2KB）估算，单个满额流式请求可累积上万个。AbortSignal 是 EventTarget、默认不设监听器
  // 上限，所以【不会】有 MaxListenersExceededWarning——线上只表现为容器内存偏高、无任何告警
  // （对 deploy/docker-compose 里 mem_limit 768m 是实际风险）。
  // 竞速语义与注册次数无关（一个信号只 abort 一次），故一次注册即可，**不要挪回循环内**。
  let removeAbortListener = null;
  const abortPromise = new Promise((_, reject) => {
    const fail = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (controller.signal.aborted) {
      fail();
      return;
    }
    controller.signal.addEventListener("abort", fail, { once: true });
    removeAbortListener = () => controller.signal.removeEventListener("abort", fail);
  });
  // 读取正常结束、之后外层才 abort 时，abortPromise 会 reject 而无人 await。
  // Promise.race 每轮都给它挂过处理器（故已算「已处理」），这里再显式吸收一次，
  // 确保上方任何提前 return 的分支（truncated / 累积超限）都不会留下 unhandledRejection。
  abortPromise.catch(() => {});

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), abortPromise]);
      if (done) {
        break;
      }
      if (firstChunkAt === null) firstChunkAt = performance.now();
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        controller.abort();
        return { text: chunks.join(""), truncated: true, firstChunkAt, firstTokenAt };
      }
      const piece = decoder.decode(value, { stream: true });
      chunks.push(piece);
      if (firstTokenPattern && firstTokenAt === null) {
        matchWindow = (matchWindow + piece).slice(-MATCH_WINDOW);
        if (firstTokenPattern.test(matchWindow)) firstTokenAt = performance.now();
      }
    }
    chunks.push(decoder.decode());
    return { text: chunks.join(""), truncated: false, firstChunkAt, firstTokenAt };
  } catch (error) {
    // 流中途断掉（socket 被掐断 / 超时中止）：已收到的半截 body 往往是「上游到底发出来没有」的
    // 唯一证据，不能连同异常一起丢掉。仍按原样抛出——错误归类（network_error / timeout）不变，
    // 只是把残体挂在异常上给调用方（见 executeUpstreamRequest 的 catch）。
    const partial = chunks.join("");
    if (partial) error.partialText = partial;
    throw error;
  } finally {
    // 摘掉 abort 监听器：signal 常常比本次读取活得更久（executeUpstreamRequest 里同一个
    // controller 还要走重试后续、外部 abortSignal 也可能挂着别的链路），不摘就等于把闭包
    // 留在信号上直到整个请求生命周期结束——那正是上面说的内存放大。
    removeAbortListener?.();
    reader.releaseLock?.();
  }
}
