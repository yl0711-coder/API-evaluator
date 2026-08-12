// server/upstream-transport.mjs
// 上游探测的传输骨架：HTTP 请求 / 重试退避 / 超时 / 字节截断 / TTFT。
//
// 从 server/test-runner.mjs 整块搬出（16 号报告 B1）。代码逐字未改——纯搬运。
// 协议相关部分（buildRequest / interpret / computeSuccess）通过回调注入，传输层对协议一无所知。
// finalizeRecord 回调也由调用方注入（持久化逻辑留在 test-runner.mjs）。
import crypto from "node:crypto";
import { readProfileApiKey } from "./secret-store.mjs";
import { assertPublicTarget } from "./egress-guard.mjs";
import { firstTokenPatternFor, isStreamOptionsUnsupportedError, isTemperatureUnsupportedError, normalizeHttpError } from "./protocols.mjs";
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
// 本进程内记住哪些模型（baseUrl|model）拒绝自定义 temperature，后续同模型请求首发就不带，
// 省掉那次注定 400 的往返。仅内存态：模型不会中途改变是否支持，重启后从头学习即可。
const TEMPERATURE_UNSUPPORTED_MODELS = new Set();
// 同款记忆：本进程内曾因 stream_options 被 400 的模型，后续流式请求首发就不带，省掉注定失败的往返。
const STREAM_OPTIONS_UNSUPPORTED_MODELS = new Set();

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
  const tempKey = `${profile.baseUrl}|${profile.defaultModel}`;
  if (request.body?.temperature !== undefined && TEMPERATURE_UNSUPPORTED_MODELS.has(tempKey)) {
    delete request.body.temperature;
    // 这条记忆是进程级的，无法区分「上次是谁填的温度」；此处按本次调用是否带了用户覆盖来判定。
    if (profile.temperatureOverride != null) r.temperatureStripped = true;
  }
  // 同上：已知不认 stream_options 的模型，流式请求首发就不带（拿不到上游 usage，调用方回退字符估算）。
  if (request.body?.stream_options !== undefined && STREAM_OPTIONS_UNSUPPORTED_MODELS.has(tempKey)) {
    delete request.body.stream_options;
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

  try {
    while (true) {
      const { done, value } = await reader.read();
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
    reader.releaseLock?.();
  }
}
