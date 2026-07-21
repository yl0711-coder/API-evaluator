// server/load-test.mjs
// 「压力测试」：对目标模型/上游中转施加负载，测吞吐(QPS)、延迟分位(p50–p99)、成功率与错误构成。
// 支持两种工作负载模型 + 自动负载扫描（找容量拐点）：
//
//   闭环(closed / 固定并发)：正好 N 个 worker「发一个→记录→立刻发下一个」，并发恒定 N。
//     缺点：上游一慢 worker 就等，发包速率自动降 → 会「自限流」掩盖过载；且同步等待导致
//     coordinated omission（尾延迟被低报）。适合「固定并发下的持续吞吐/稳定性」。
//   开环(open / 固定速率)：按目标速率 rateRps 定时发包，不等上游完成（带在飞上限 maxInFlight）。
//     到达率恒定，能把排队堆积/延迟指数恶化暴露出来 → 更适合「找容量上限/断点」。
//
//   coordinated omission 纠正(B)：开环下每个请求的延迟按「计划发起时刻 intendedAt」计，而非实际
//     发出时刻——当发生器落后/在飞打满时，这段等待被算进延迟，尾延迟不再被低报（wrk2/HdrHistogram 同理）。
//   负载扫描(D)：一次跑多个负载点（并发或速率序列），产出「负载→吞吐/尾延迟」曲线并自动定位饱和拐点。
//
// 复用现成执行器 executeTestRequest（协议/鉴权/fetch/每请求超时/解析）+ percentile()。压测传
// writeLog:false（不写库、只存指标，内存与请求数无关）+ noRetry:true（不重试，才不吞 429/5xx 信号）。
import { performance } from "node:perf_hooks";
import { executeTestRequest, buildReportId, reportTargetSlug } from "./test-runner.mjs";
import { clampNumber, mean, percentile } from "./utils.mjs";
import { loadRunnableProfiles } from "./run-targets.mjs";
import { saveReportFiles } from "./report-files.mjs";
import { assertTaskNotCancelled, updateTaskProgress } from "./task-manager.mjs";
import { CODING_SCENARIOS } from "./scenarios/coding.mjs";
import { estimateTokens } from "./tokenizer-fingerprint.mjs";

// 三档负载 profile（文档 §3.4）：max_tokens 同时控内存(响应体不膨胀)与成本(输出封顶)。
const LOAD_PROFILES = {
  simple: { label: "简单", maxTokens: 64, base: "你好，请用一句话说明你现在能正常工作。" },
  think: {
    label: "轻思考",
    maxTokens: 256,
    base: "一个笼子里关着若干鸡和兔，共有 35 个头、94 只脚。请分别求出鸡和兔各多少只，并简要给出推理过程。",
  },
  coding: {
    label: "编程",
    maxTokens: 800,
    base: CODING_SCENARIOS?.[0]?.prompt || "请用 JavaScript 实现一个带超时(AbortController)的 fetch 包装函数，并解释其中的竞态与清理处理。",
  },
};

const MAX_TOTAL_REQUESTS = 100000; // 单点请求数硬顶：防手滑把上游/额度打爆
const MAX_POINTS = 8; // 扫描点数上限
const DEFAULT_MAX_IN_FLIGHT = 300; // 开环在飞上限默认值
const THROUGHPUT_PLATEAU_RATIO = 1.05; // 吞吐较前点上升不足 5% 视为「持平」（与饱和判定一致）
const P99_SATURATION_RATIO = 1.3; // 吞吐持平时，p99 较前点抬升达此倍数 → 判为上游饱和

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);
const safeMax = (arr) => (arr.length ? arr.reduce((m, v) => (v > m ? v : m), arr[0]) : null);

// 网络错误侧别：从底层 errno（executor 已把 error.cause.code 附进 rawError）区分是
// 本机/链路侧(local) 还是上游主动断连(upstream)。拿不到明确 errno 则 unknown。
export function classifyNetwork(rawError) {
  const t = String(rawError || "").toUpperCase();
  // 上游/网关在高负载下主动重置或挂断连接
  if (/ECONNRESET|EPIPE|HANG UP|OTHER SIDE CLOSED|UND_ERR_SOCKET/.test(t)) return "upstream";
  // 本机/链路侧：DNS、拒连、连接超时、端口/文件描述符耗尽、路由不可达、TLS/证书
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EMFILE|ENFILE|EADDRNOTAVAIL|EADDRINUSE|ENETUNREACH|EHOSTUNREACH|EPROTO|CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(t)) return "local";
  return "unknown";
}

// 每请求输出 token 数：优先上游 usage(completion_tokens，精确)；缺失时用零依赖本地分词器
// estimateTokens(近似) 兜底。返回 { tok, est }——est=true 表示这条是本地估算，用于统计覆盖率。导出供单测。
export function deriveOutputTokens(rec) {
  const up = Number(rec?.outputTokens);
  if (Number.isFinite(up) && up > 0) return { tok: up, est: false };
  const text = rec?.responseText || "";
  if (text) return { tok: estimateTokens(text), est: true };
  return { tok: null, est: false };
}

// 可中断 sleep：到点或 abortSignal 触发即返回（用于闭环思考时间，取消时不必等满）。
function interruptibleSleep(ms, abortSignal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener?.("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    abortSignal?.addEventListener?.("abort", done, { once: true });
  });
}

// 解析压测目标：优先 profileId（经 loadRunnableProfiles 还原成可运行 profile，与稳定性测试同源）；
// 或裸 { baseUrl, model, protocol }（压中转地址，key 走环境变量 EVALUATOR_LOAD_TEST_KEY，不入库）。
async function resolveTarget(target) {
  if (target && typeof target === "object" && target.profileId) {
    const profiles = await loadRunnableProfiles();
    const found = profiles.find((p) => p.id === target.profileId);
    if (!found) throw new Error("没有找到被测 API 配置（渠道可能已删除/停用）。");
    return found;
  }
  if (target && target.baseUrl && target.model) {
    return {
      id: "adhoc",
      name: `${String(target.channel || "adhoc")} / ${target.model}`,
      baseUrl: String(target.baseUrl).replace(/\/+$/, ""),
      defaultModel: target.model,
      protocol: target.protocol || "openai_chat",
      provider: target.provider || "adhoc",
      apiKey: process.env.EVALUATOR_LOAD_TEST_KEY || "",
    };
  }
  throw new Error("压测目标无效：请提供 profileId 或 { baseUrl, model }。");
}

// —— 闭环负载点：固定并发 N（load=并发数）。延迟取执行器测得的响应时间（send→receive）。——
// thinkMs>0 时为「闭环 + 思考时间」：每个 worker 收到响应后停顿 thinkMs 再发下一条（模拟真实用户节奏）。
async function runClosedPoint(cfg) {
  const { execute, probeTarget, dispatch, runId, load, warmupMs, thinkMs, deadline, runStart, abortSignal, stream, taskContext } = cfg;
  const samples = [];
  let stopped = false;
  const worker = async () => {
    while (!stopped && performance.now() < deadline) {
      try {
        assertTaskNotCancelled(taskContext);
      } catch {
        stopped = true;
        break;
      }
      if (samples.length >= MAX_TOTAL_REQUESTS) {
        stopped = true;
        break;
      }
      const { prompt, caseId } = dispatch();
      let rec;
      try {
        rec = await execute(probeTarget, prompt, { runId, caseId, writeLog: false, noRetry: true, stream, abortSignal });
      } catch {
        rec = { success: false, statusCode: null, totalMs: null, normalizedError: "network_error" };
      }
      const doneRelMs = performance.now() - runStart;
      const out = deriveOutputTokens(rec);
      samples.push({
        ms: rec.success && Number.isFinite(rec.totalMs) ? rec.totalMs : null,
        // 首 token 延迟：仅流式测得到（非流式整体返回，执行器保持 null）。
        ttft: rec.success && Number.isFinite(rec.firstTokenMs) ? rec.firstTokenMs : null,
        ok: Boolean(rec.success),
        status: rec.statusCode ?? null,
        statusText: rec.statusText || "", // 上游实际返回的原因短语（HTTP/1.1 可自定义）
        err: rec.normalizedError || "",
        netSide: rec.normalizedError === "network_error" ? classifyNetwork(rec.rawError) : undefined,
        outTok: out.tok, // 输出 token 数（成功时）
        outTokEst: out.est, // 是否本地估算（供覆盖率）
        warmup: doneRelMs < warmupMs,
      });
      // 思考时间：停顿 thinkMs 再发下一条；clamp 到剩余时长、可被取消打断，避免收尾/取消时多等。
      if (thinkMs > 0 && !stopped) {
        const remaining = deadline - performance.now();
        if (remaining > 0) await interruptibleSleep(Math.min(thinkMs, remaining), abortSignal);
      }
    }
  };
  const rampGapMs = warmupMs > 0 ? warmupMs / load : 0;
  const workers = Array.from({ length: load }, (_, i) =>
    (async () => {
      if (rampGapMs) await sleep(Math.round(rampGapMs * i));
      await worker();
    })(),
  );
  await Promise.all(workers);
  return samples;
}

// —— 开环负载点：固定到达率 load=rateRps，不等上游完成；在飞打满(maxInFlight)则记 gen_saturated。——
// coordinated omission 纠正(B)：延迟 = 完成时刻 − 计划发起时刻(intendedAt)，把发生器侧排队算进去。
// 发送周期 burstMs>1000 时为「间歇/突发」：每 burstMs 毫秒只在前 1 秒按速率匀速发满，其余时间静默。
async function runOpenPoint(cfg) {
  const { execute, probeTarget, dispatch, runId, load, maxInFlight, warmupMs, burstMs, deadline, runStart, abortSignal, stream, taskContext } = cfg;
  const samples = [];
  const intervalMs = 1000 / load;
  let inFlight = 0;
  let stopped = false;
  const pending = new Set();
  let nextAt = runStart;

  while (!stopped && performance.now() < deadline) {
    try {
      assertTaskNotCancelled(taskContext);
    } catch {
      stopped = true;
      break;
    }
    const now = performance.now();
    if (now < nextAt) {
      await sleep(Math.min(nextAt - now, 5));
      continue;
    }
    const intendedAt = nextAt;
    // 间歇发送：本拍若落在周期的静默段（前 1 秒之后），跳到下一周期起点，不发、不记。
    if (burstMs > 1000) {
      const posInCycle = (intendedAt - runStart) % burstMs;
      if (posInCycle >= 1000) {
        nextAt = intendedAt - posInCycle + burstMs;
        continue;
      }
    }
    nextAt += intervalMs; // 恒定到达率：即便本轮落后，下一拍仍按计划推进（追平 = 开环语义）
    const warmup = intendedAt - runStart < warmupMs;
    if (samples.length >= MAX_TOTAL_REQUESTS) {
      stopped = true;
      break;
    }
    if (inFlight >= maxInFlight) {
      // 发生器已达在飞上限：该速率下的在飞需求(≈速率×延迟, Little 定律)超过上限 → 客户端侧饱和信号。
      samples.push({ ms: null, ok: false, status: null, err: "gen_saturated", warmup });
      continue;
    }
    inFlight += 1;
    const { prompt, caseId } = dispatch();
    const p = (async () => {
      let rec;
      try {
        rec = await execute(probeTarget, prompt, { runId, caseId, writeLog: false, noRetry: true, stream, abortSignal });
      } catch {
        rec = { success: false, statusCode: null, totalMs: null, normalizedError: "network_error" };
      }
      const ms = performance.now() - intendedAt; // B：按计划发起时刻计，纠正 coordinated omission
      const out = deriveOutputTokens(rec);
      samples.push({
        ms: rec.success ? ms : null,
        // TTFT 同样纠正 coordinated omission：执行器测的是「实发→首片」，这里补上
        // 「计划发起→实发」的排队延迟（≈ ms − totalMs），与上面 ms 的口径保持一致；
        // 否则开环高负载下 TTFT 会漏掉发生器排队、系统性偏乐观。
        ttft:
          rec.success && Number.isFinite(rec.firstTokenMs) && Number.isFinite(rec.totalMs)
            ? Math.max(0, rec.firstTokenMs + (ms - rec.totalMs))
            : null,
        ok: Boolean(rec.success),
        status: rec.statusCode ?? null,
        statusText: rec.statusText || "", // 上游实际返回的原因短语（HTTP/1.1 可自定义）
        err: rec.normalizedError || "",
        netSide: rec.normalizedError === "network_error" ? classifyNetwork(rec.rawError) : undefined,
        outTok: out.tok, // 输出 token 数（成功时）
        outTokEst: out.est, // 是否本地估算（供覆盖率）
        warmup,
      });
    })().finally(() => {
      inFlight -= 1;
    });
    pending.add(p);
    p.finally(() => pending.delete(p));
  }
  await Promise.allSettled([...pending]);
  return samples;
}

// 聚合单个负载点：延迟分位只统计「稳态且成功」的样本；错误按 status/err 分桶（含 gen_saturated）。导出供单测。
export function aggregate(ctx) {
  const { samples, mode, offered, durationSec } = ctx;
  const steady = samples.filter((s) => !s.warmup);
  const sent = steady.filter((s) => s.err !== "gen_saturated"); // 真正打到上游的（开环丢弃的不算）
  const okSamples = sent.filter((s) => s.ok);
  const latencies = okSamples.map((s) => s.ms).filter((v) => Number.isFinite(v));
  // TTFT 仅流式有值；非流式该数组为空 → 下面各分位数为 null，报告据此整节省略。
  const ttfts = okSamples.map((s) => s.ttft).filter((v) => Number.isFinite(v));
  const genSaturated = steady.length - sent.length;

  // 聚合桶（供扫描表格/前端摘要/拐点判定）：429、5xx 聚合。
  const errors = { ok: okSamples.length, http_429: 0, http_5xx: 0, timeout: 0, network_error: 0, gen_saturated: genSaturated, other: 0 };
  // 逐状态码明细（供报告「错误构成」）：每个失败的 HTTP 状态码单独一项。
  const statusCounts = {}; // { [httpStatus]: count }，仅非成功的 HTTP 响应
  const statusPhrases = {}; // { [httpStatus]: 原因短语 }，取该码首个非空 statusText（上游可自定义，故用实测值）
  // { [httpStatus]: { [normalizedError]: 次数 } }。压测不写 requests.jsonl，报告是唯一产物：
  // 失败原因若在这里被状态码盖掉就永久丢失了。2xx 判失败时（成功＝2xx 且有输出）尤其要靠它——
  // 状态码本身说明不了任何问题。
  const statusReasons = {};
  const network = { local: 0, upstream: 0, unknown: 0 }; // 网络错误按侧别细分
  let noStatusOther = 0; // 无状态码、且非 timeout/network 的失败（罕见）
  for (const s of sent) {
    if (s.ok) continue;
    if (typeof s.status === "number") {
      statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
      if (s.statusText && !statusPhrases[s.status]) statusPhrases[s.status] = s.statusText;
      if (s.err) {
        const byReason = (statusReasons[s.status] ||= {});
        byReason[s.err] = (byReason[s.err] || 0) + 1;
      }
      if (s.status === 429) errors.http_429 += 1;
      else if (s.status >= 500) errors.http_5xx += 1;
      else errors.other += 1;
    } else if (s.err === "timeout") errors.timeout += 1;
    else if (s.err === "network_error") {
      errors.network_error += 1;
      network[s.netSide || "unknown"] += 1;
    } else {
      errors.other += 1;
      noStatusOther += 1;
    }
  }

  // 输出 token 吞吐（仅成功样本）：宏观 = 总输出 / 时长；单请求均速 = 各请求 outTok/(耗时) 的均值。
  const tokSamples = okSamples.filter((s) => Number.isFinite(s.outTok)); // 拿到 token 数的成功样本
  const outputTokens = tokSamples.reduce((sum, s) => sum + s.outTok, 0);
  const perReqRates = tokSamples.filter((s) => Number.isFinite(s.ms) && s.ms > 0).map((s) => s.outTok / (s.ms / 1000));
  const estCount = tokSamples.filter((s) => s.outTokEst).length; // 走本地估算的样本数
  const tokenUsageCoverage = tokSamples.length ? 1 - estCount / tokSamples.length : null; // 上游 usage 覆盖率

  return {
    mode,
    offered, // 闭环=并发数；开环=目标速率 req/s
    totalRequests: samples.length,
    warmupRequests: samples.length - steady.length,
    steadyRequests: steady.length,
    sentRequests: sent.length,
    genSaturated,
    successCount: okSamples.length,
    successRate: sent.length ? okSamples.length / sent.length : 0,
    qps: round2(durationSec > 0 ? sent.length / durationSec : 0), // 每秒完成(返回)的请求数，含错误响应、不含发生器丢弃
    outputTokens, // 稳态成功请求的输出 token 总和
    tokensPerSecond: round2(durationSec > 0 ? outputTokens / durationSec : 0), // 宏观输出吞吐
    perReqTokensPerSec: perReqRates.length ? round2(perReqRates.reduce((a, b) => a + b, 0) / perReqRates.length) : null, // 单请求平均生成速率
    tokenUsageCoverage, // 1=全部来自上游 usage；<1 表示部分为本地估算；null=无 token 数据
    latency: {
      p50: percentile(latencies, 0.5),
      p90: percentile(latencies, 0.9),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: safeMax(latencies),
      avg: mean(latencies),
    },
    // 首 token 延迟（TTFT）：仅流式采得到；ttftCount=0 表示本点无 TTFT 数据（非流式或全失败）。
    ttftCount: ttfts.length,
    ttft: {
      p50: percentile(ttfts, 0.5),
      p90: percentile(ttfts, 0.9),
      p95: percentile(ttfts, 0.95),
      p99: percentile(ttfts, 0.99),
      max: safeMax(ttfts),
      avg: mean(ttfts),
    },
    errors,
    statusCounts,
    statusPhrases,
    statusReasons,
    network,
    noStatusOther,
  };
}

// 某负载点相对前一点的健康度分类。区分「上游服务器饱和」与「客户端发生器受限」——
// 文献判定上游饱和的特征是「吞吐不再上升 且 尾延迟(p99)显著抬升」（NVIDIA / arXiv 测量偏差论文）；
// 而 gen_saturated 是本机在飞打满、发不出去，证明不了上游到顶，二者不能混为一谈。
// LLM 下吞吐优先用 tok/s 斜率，无 token 数据时退回 QPS。prev=null（首点）恒为基准。
function tputOf(p) {
  return p.tokensPerSecond > 0 ? p.tokensPerSecond : p.qps;
}
// sentRequests=0 时 successRate 是 0/0 造出来的 0，不是测量值——发生器把请求全丢了、
// 一个都没发出去，拿它判「上游出错」就是甩锅。字段缺失（老数据/测试夹具）时按原样信任 successRate。
function measuredSuccessRate(p) {
  return p.sentRequests === 0 ? null : p.successRate;
}
export function classifyPointStatus(prev, cur) {
  if (!prev) return { tag: "baseline", label: "基准" };
  if (cur.errors.http_429 > 0) return { tag: "throttled", label: "上游限流" };
  const success = measuredSuccessRate(cur);
  if (success !== null && success < 0.99) return { tag: "errors", label: "出错/失败" };
  if (cur.genSaturated > 0) return { tag: "client_saturated", label: "客户端受限" };
  const plateau = tputOf(cur) < tputOf(prev) * THROUGHPUT_PLATEAU_RATIO; // 吞吐较前点持平
  const p99Spiked = Number.isFinite(cur.latency.p99) && Number.isFinite(prev.latency.p99) && cur.latency.p99 >= prev.latency.p99 * P99_SATURATION_RATIO;
  if (plateau && p99Spiked) return { tag: "server_saturated", label: "上游饱和" };
  return { tag: "healthy", label: "健康" };
}

// 饱和拐点检测(D)：负载点按 offered 升序，逐点分类，取「首个非健康点」的前一点为推荐容量。
// reason 按饱和类型分别措辞——尤其把「上游饱和」与「客户端受限」讲清，避免误判上游是否还有余量。
// 基准点(points[0])的体检：classifyPointStatus 对首点恒返回 baseline（无前点可比），
// 而下面的循环从 i=1 起判、返回 i-1——于是基准点自己从没被验过。「Key 填错 → 全部点 401」时，
// 一个 0% 成功率的点就会被当「最后一个健康点」推荐出去。返回不可用的原因，null=可用。
function baselineProblem(p) {
  if (p.errors.http_429 > 0) return `一上来就被限流（429=${p.errors.http_429}）`;
  const success = measuredSuccessRate(p);
  if (success !== null && success < 0.99) return `成功率仅 ${(success * 100).toFixed(1)}%`;
  if (success === null && p.genSaturated > 0) return `发生器在飞打满，一个请求都没发出去（gen_saturated=${p.genSaturated}）`;
  return null;
}
export function findKnee(points) {
  const first = points[0];
  const problem = first ? baselineProblem(first) : null;
  if (problem) {
    return {
      index: -1, // 无任何可用点：调用方须据此渲染「无可推荐容量」，不得去取 points[-1]
      reason: `基准点（最低负载 ${first.offered}）本身就不可用：${problem} → 无可推荐容量。这不是容量问题，请先排查鉴权 / 连通性 / 模型名后重测`,
      tag: "unusable_baseline",
    };
  }
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const cur = points[i];
    const st = classifyPointStatus(prev, cur);
    if (st.tag === "healthy" || st.tag === "baseline") continue;
    let reason;
    if (st.tag === "server_saturated") {
      reason = `负载 ${cur.offered} 处上游饱和：吞吐不再随负载上升（${tputOf(cur)} ≤ 前点 ${tputOf(prev)} 的 ${THROUGHPUT_PLATEAU_RATIO}×）而 p99 由 ${fmtMs(prev.latency.p99)} 抬升至 ${fmtMs(cur.latency.p99)} → 已触及上游产能上限`;
    } else if (st.tag === "client_saturated") {
      reason = `负载 ${cur.offered} 处客户端受限：发生器在飞打满（gen_saturated=${cur.genSaturated}），未能证明上游是否还有余量，建议提高在飞上限 / 换更强压测机后复测`;
    } else if (st.tag === "throttled") {
      reason = `负载 ${cur.offered} 处出现上游限流（429=${cur.errors.http_429}，成功率 ${(cur.successRate * 100).toFixed(1)}%）`;
    } else {
      reason = `负载 ${cur.offered} 处出现错误/失败（成功率 ${(cur.successRate * 100).toFixed(1)}%）`;
    }
    return { index: i - 1, reason, tag: st.tag };
  }
  return { index: points.length - 1, reason: "扫描范围内未见饱和拐点，上游仍有余量，可继续加压确认上限", tag: "healthy" };
}

const fmtMs = (v) => (Number.isFinite(v) ? `${(v / 1000).toFixed(2)}s` : "—");
const pct = (v) => `${Math.round((v || 0) * 100)}%`;

function reportHeaderLines(meta) {
  return [
    `- 目标：${meta.profileName || meta.model}（模型 ${meta.model}，协议 ${meta.protocol}）`,
    `- 模式：${meta.mode === "open" ? `开环（固定到达率 req/s，含 coordinated omission 纠正${meta.burstPeriodSec > 1 ? `；每 ${meta.burstPeriodSec}s 突发发送 1s` : ""}）` : `闭环（固定并发${meta.intervalSec ? `，思考时间 ${meta.intervalSec}s` : ""}）`} · 负载档 ${meta.promptProfile}`,
    `- 参数：稳态 ${meta.durationSec}s · ramp-up ${meta.warmupSec}s · max_tokens ${meta.maxTokens} · 每请求超时 ${meta.timeoutSec}s · 请求方式 ${meta.stream ? "流式 SSE" : "非流式"}${meta.mode === "open" ? ` · 在飞上限 ${meta.maxInFlight}${meta.burstPeriodSec > 1 ? ` · 发送周期 ${meta.burstPeriodSec}s` : ""}` : meta.intervalSec ? ` · 测试间隔 ${meta.intervalSec}s` : ""}`,
    `- 时间：${meta.startedAt} → ${meta.endedAt}`,
  ];
}

// 2xx 却算失败：成功判定是「2xx 且能提取到输出文本」，所以这里必然是没拿到文本。
// 状态码此时说明不了任何问题，得靠 normalizedError（normalizeEmptyResponse 按响应体细分）出文案。
// 有些中转会用 200 包一个错误返回，故限流/模型错误也可能出现在 2xx 上。
const EMPTY_2XX_REASONS = {
  empty_response: {
    label: "无输出",
    note: "上游以 2xx 返回，但响应体里没有可提取的文本。常见于上游空响应、流式中断或中转的协议转换异常。对用户等同于「没有回答」，故计为失败。",
  },
  content_block_not_found: {
    label: "无输出（内容块缺失）",
    note: "上游以 2xx 返回但报 content block not found，多见于中转做流式协议转换时出错。",
  },
  rate_limited: {
    label: "上游限流（2xx 包错误）",
    note: "上游用 2xx 包了一个限流错误，未按 429 返回。需与上游核对配额或降低负载。",
  },
  model_not_found: {
    label: "模型不可用（2xx 包错误）",
    note: "上游用 2xx 包了一个模型错误：模型名有误，或渠道未开通该模型。",
  },
};

// 把 HTTP 状态码归到「短标签 + 说明」，供错误构成逐码列项与说明。
// reason：该码下最主要的 normalizedError；2xx 必须靠它，否则只能说出「200」这种废话。
function classifyStatus(code, reason = "") {
  // 放在最前：2xx 绝不能落到底部那条「非常规状态码」兜底——200 恰恰是最常规的状态码，
  // 那句话会把排查方向带偏。
  if (code >= 200 && code < 300) return EMPTY_2XX_REASONS[reason] || EMPTY_2XX_REASONS.empty_response;
  if (code === 401 || code === 403) return { label: "认证失败", note: "Key 无效 / 无权限 / 欠费，或鉴权头不被上游接受。" };
  if (code === 404) return { label: "模型不可用", note: "模型名错误，或渠道未开通该模型。" };
  if (code === 429) return { label: "上游限流", note: "触发配额 / 速率限制，需与上游核对或降低负载。" };
  if (code === 400) return { label: "请求被拒", note: "参数或协议不被上游接受（如不支持的字段）。" };
  if (code >= 500) return { label: "上游服务错误", note: "上游模型服务 / 中转网关 / 协议转换链路异常。" };
  if (code >= 400) return { label: "请求错误", note: "上游以 4xx 拒绝了该请求。" };
  return { label: "异常状态", note: "非常规状态码。" };
}

// 出现的 HTTP 状态码升序。
function sortedStatusCodes(p) {
  return Object.keys(p.statusCounts || {})
    .map(Number)
    .sort((a, b) => a - b);
}

// 该状态码下最主要的失败原因（normalizedError）。同码多因时取占比最高的一种——报告的
// 「原因短语」列仍给上游原话，无需逐因铺开。
function dominantReason(p, code) {
  const byReason = (p.statusReasons || {})[code] || {};
  let top = "";
  let max = 0;
  for (const [reason, count] of Object.entries(byReason)) {
    if (count > max) {
      max = count;
      top = reason;
    }
  }
  return top;
}

// 上游实际返回的原因短语（reason phrase）；无（HTTP/2 或上游未给）则空串。
function statusPhrase(p, code) {
  return (p.statusPhrases && p.statusPhrases[code]) || "";
}
// 「状态码 + 原因短语」组合，如 `429 Too Many Requests`；无短语则仅状态码。
function codeWithPhrase(p, code) {
  const phrase = statusPhrase(p, code);
  return phrase ? `${code} ${phrase}` : String(code);
}

// 错误构成：每个出现的状态码单独一项 + 无状态码类（超时/网络/发生器受限/其它）。成功始终列。
function errorComposition(p) {
  const e = p.errors;
  const lines = [`- 成功：${e.ok}`];
  for (const code of sortedStatusCodes(p)) {
    lines.push(`- HTTP ${codeWithPhrase(p, code)}（${classifyStatus(code, dominantReason(p, code)).label}）：${p.statusCounts[code]}`);
  }
  if (e.timeout > 0) lines.push(`- 超时：${e.timeout}`);
  if (e.network_error > 0) {
    const n = p.network || {};
    if (n.local) lines.push(`- 网络·本机侧：${n.local}`);
    if (n.upstream) lines.push(`- 网络·服务器端：${n.upstream}`);
    if (n.unknown) lines.push(`- 网络·未判明：${n.unknown}`);
    if (!n.local && !n.upstream && !n.unknown) lines.push(`- 网络：${e.network_error}`);
  }
  if (e.gen_saturated > 0) lines.push(`- 发生器受限：${e.gen_saturated}`);
  if (p.noStatusOther > 0) lines.push(`- 其它（无状态码）：${p.noStatusOther}`);
  return lines;
}

// 详细错误构成表：四列「错误类型 | 错误码 | 原因短语 | 数量」，每个 HTTP 状态码一行；原因短语取上游
// 实际返回的 reason phrase（HTTP/1.1 可自定义、HTTP/2 无则填「—」）。无状态码类（超时/网络/发生器
// 受限/其它）错误码与短语列均填「—」。仅列数量>0 的行；全无错误则一句无错误。
function detailedErrorTable(p) {
  const e = p.errors;
  const n = p.network || {};
  const rows = [];
  for (const code of sortedStatusCodes(p)) {
    rows.push(`| ${classifyStatus(code, dominantReason(p, code)).label} | ${code} | ${statusPhrase(p, code) || "—"} | ${p.statusCounts[code]} |`);
  }
  if (e.timeout > 0) rows.push(`| 超时 | — | — | ${e.timeout} |`);
  if (n.local) rows.push(`| 网络·本机侧 | — | — | ${n.local} |`);
  if (n.upstream) rows.push(`| 网络·服务器端 | — | — | ${n.upstream} |`);
  if (n.unknown) rows.push(`| 网络·未判明 | — | — | ${n.unknown} |`);
  if (e.gen_saturated > 0) rows.push(`| 发生器受限 | — | — | ${e.gen_saturated} |`);
  if (p.noStatusOther > 0) rows.push(`| 其它（无状态码） | — | — | ${p.noStatusOther} |`);
  if (!rows.length) return ["本轮无错误。"];
  return ["| 错误类型 | 错误码 | 原因短语 | 数量 |", "|---|---|---|---|", ...rows];
}

// 「说明」栏：对每个出现的状态码、以及无状态码类，逐项给简要说明。全无错误则一句无错误。
function errorNotes(meta, p) {
  const e = p.errors;
  const notes = [];
  for (const code of sortedStatusCodes(p)) {
    const c = classifyStatus(code, dominantReason(p, code));
    notes.push(`- HTTP ${codeWithPhrase(p, code)}（${c.label}）：${c.note}`);
  }
  if (e.timeout > 0) notes.push(`- 超时：请求未在每请求超时（${meta.timeoutSec}s）内返回，通常是上游在该负载下延迟过高。`);
  if (e.network_error > 0) {
    const n = p.network || {};
    if (n.local) notes.push("- 网络·本机侧：连接被本机/链路侧中断（端口或文件描述符耗尽、DNS、代理/VPN、TLS 等）——多为压测机自身或网络环境所致，非上游；降并发或排查本机代理后复测。");
    if (n.upstream) notes.push("- 网络·服务器端：连接被上游/网关主动重置或挂断（ECONNRESET / socket hang up 等）——上游在高负载下直接断连，属上游侧容量/稳定性问题。");
    if (n.unknown) notes.push("- 网络·未判明：未取得明确底层错误码，暂无法判定本机侧还是上游侧。");
    if (!n.local && !n.upstream && !n.unknown) notes.push("- 网络：连接层错误（断连 / DNS / TLS 等）。");
  }
  if (e.gen_saturated > 0) notes.push(`- 发生器受限：同时在飞的请求打满上限（${meta.maxInFlight}），新请求发不出而被丢弃——客户端侧饱和信号，多因上游变慢致积压。`);
  if (p.noStatusOther > 0) notes.push("- 其它（无状态码）：未归入上述类别的失败。");
  return notes.length ? notes : ["- 本轮无错误。"];
}

// 输出吞吐行（tokens/s）：无 token 数据时返回 null（不显示）。覆盖率<100% 时标注本地估算占比。
function tokenThroughputLine(p) {
  if (!(p.outputTokens > 0)) return null;
  const cov =
    Number.isFinite(p.tokenUsageCoverage) && p.tokenUsageCoverage < 1
      ? `（其中 ${pct(1 - p.tokenUsageCoverage)} 为本地分词估算）`
      : "";
  return `- 输出吞吐：${p.tokensPerSecond} tok/s（总输出 ${p.outputTokens} tokens · 单请求均速 ${p.perReqTokensPerSec ?? "—"} tok/s · 受 max_tokens 上限影响；单请求均速为**端到端**含排队/网络，非纯服务端 decode 速率）${cov}`;
}

// 单点报告（对照文档 §6.7）。导出供报告格式单测。
export function formatSinglePointReport(meta, p) {
  const L = p.latency;
  const e = p.errors;
  const sent = p.sentRequests || 0;
  const notReturned = e.timeout + e.http_5xx + e.network_error + e.other; // 已发出但未成功返回（未计入延迟）
  const lines = [
    "# 压力测试报告",
    "",
    ...reportHeaderLines(meta),
    `- ${meta.mode === "open" ? "目标速率" : "并发"}：${p.offered}${meta.mode === "open" ? " req/s" : ""}`,
    "",
    "## 吞吐与成功率",
    "",
    `- 稳态完成请求：${sent}（另有 ${p.warmupRequests} 条 ramp-up 不计${p.genSaturated ? `；发生器受限丢弃 ${p.genSaturated} 条` : ""}）`,
    `- 成功：${p.successCount}（${pct(p.successRate)}）　吞吐 QPS：${p.qps} req/s`,
    ...(tokenThroughputLine(p) ? [tokenThroughputLine(p)] : []),
    "",
    "## 延迟分布（仅成功请求）",
    "",
  ];
  if (notReturned > 0) {
    lines.push(
      `> ⚠️ 幸存者偏差：下表仅基于 ${p.successCount} 条**成功**请求；另有 ${notReturned} 条（占已发出 ${pct(sent ? notReturned / sent : 0)}）超时/失败未返回、未计入。**真实尾延迟远比下表严重**——超时的请求实际都卡到了 ${meta.timeoutSec}s 上限。`,
      "> 注：高负载下即便成功请求，延迟也常分快/慢两簇（双峰），单一 p99 不代表典型体验。",
      "",
    );
  }
  lines.push(
    "| p50 | p90 | p95 | p99 | max | avg |",
    "|---|---|---|---|---|---|",
    `| ${fmtMs(L.p50)} | ${fmtMs(L.p90)} | ${fmtMs(L.p95)} | ${fmtMs(L.p99)} | ${fmtMs(L.max)} | ${fmtMs(L.avg)} |`,
    "",
  );
  // TTFT 只有流式测得到；非流式整节省略，不留空表误导。
  if (p.ttftCount > 0) {
    const T = p.ttft;
    lines.push(
      "## 首 token 延迟（TTFT · 仅流式）",
      "",
      `> 用户感知的「反应快不快」看这里，而非上面的端到端耗时。取首个**可见输出 token** 所在分片的到达时刻（已排除 Claude 的 message_start、中转保活帧等无内容首帧，故可跨协议横评），基于 ${p.ttftCount} 条成功请求。${meta.mode === "open" ? "已按计划发起时刻计，纠正 coordinated omission。" : ""}`,
      "",
      "| p50 | p90 | p95 | p99 | max | avg |",
      "|---|---|---|---|---|---|",
      `| ${fmtMs(T.p50)} | ${fmtMs(T.p90)} | ${fmtMs(T.p95)} | ${fmtMs(T.p99)} | ${fmtMs(T.max)} | ${fmtMs(T.avg)} |`,
      "",
    );
  }
  lines.push(
    "## 错误构成",
    "",
    ...errorComposition(p),
    "",
    "## 详细错误构成",
    "",
    ...detailedErrorTable(p),
    "",
    "## 说明",
    "",
    ...errorNotes(meta, p),
    "",
  );
  return lines.join("\n");
}

// 扫描报告(D)：负载→吞吐/尾延迟曲线（表格）+ 饱和拐点。
export function formatSweepReport(meta, points, knee) {
  const unit = meta.mode === "open" ? "速率(req/s)" : "并发";
  const rows = points.map((p, i) => {
    const st = classifyPointStatus(i > 0 ? points[i - 1] : null, p);
    // TTFT p95：非流式（或该点无成功样本）无数据，显示「—」而非 0，避免被当成「极快」。
    const ttftP95 = p.ttftCount > 0 ? fmtMs(p.ttft.p95) : "—";
    return `| ${p.offered} | ${p.qps} | ${p.tokensPerSecond} | ${pct(p.successRate)} | ${ttftP95} | ${fmtMs(p.latency.p95)} | ${fmtMs(p.latency.p99)} | ${p.errors.http_429} | ${p.errors.timeout + p.errors.http_5xx} | ${p.genSaturated} | ${st.label} |`;
  });
  // knee.index=-1：基准点自己就不可用，没有任何点可推荐（points[-1] 是 undefined，不能去取）。
  const kneePoint = knee.index >= 0 ? points[knee.index] : null;
  const capacityLine = kneePoint
    ? `- 推荐可用容量（最后一个健康点）：**${unit} = ${kneePoint.offered}**（QPS ${kneePoint.qps}，成功率 ${pct(kneePoint.successRate)}，p99 ${fmtMs(kneePoint.latency.p99)}）`
    : "- 推荐可用容量：**无可推荐容量** —— 最低负载点就已不可用，本次压测测不出容量上限（先按上面「判定」排查）";
  return [
    "# 压力测试报告（负载扫描）",
    "",
    ...reportHeaderLines(meta),
    `- 扫描负载序列：${points.map((p) => p.offered).join(", ")}`,
    "",
    "## 负载 → 吞吐 / 尾延迟曲线",
    "",
    `| ${unit} | QPS | tok/s | 成功率 | TTFT p95 | p95 | p99 | 429 | 超时+5xx | 发生器受限 | 状态 |`,
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    "## 饱和拐点",
    "",
    `- 判定：${knee.reason}`,
    capacityLine,
    "",
    "> 判定参考：成功率≥99% 且 429=0 → 该负载下容量充足；出现 429 → 上游/中转在限流；",
    "> **上游饱和** = 吞吐持平（tok/s 或 QPS 不再随负载上升）且 p99 抬升 → 上游产能到顶；",
    "> **客户端受限** = 发生器在飞打满（是压测机自己发不出去，非上游能力上限），需提高在飞上限 / 换更强压测机后复测——二者别混。",
    "> ⚠️ 表中 p95/p99 仅统计成功请求：某行「超时+5xx」较高时，其延迟被幸存者偏差低估，真实体验更差；",
    "> 且饱和点的成功请求延迟常呈**双峰**（快/慢两簇），单一 p95/p99 不代表典型体验。",
    "",
  ].join("\n");
}

// 压测主流程。payload:
//   { target, mode:"closed"|"open", loads:[数字...], durationSec, warmupSec, timeoutSec, maxInFlight, promptProfile }
// loads 长度>1 即为扫描(D)。deps 仅供单测注入假 executeTestRequest / saveReportFiles。
export async function runLoadTest(payload = {}, taskContext = {}, deps = {}) {
  const execute = deps.executeTestRequest || executeTestRequest;
  const save = deps.saveReportFiles || saveReportFiles;

  const profile = await resolveTarget(payload.target);
  const mode = payload.mode === "open" ? "open" : "closed";
  const durationSec = clampNumber(payload.durationSec, 5, 600, 60);
  const warmupSec = clampNumber(payload.warmupSec, 0, 30, 5);
  const timeoutSec = clampNumber(payload.timeoutSec, 5, 120, 30);
  const maxInFlight = clampNumber(payload.maxInFlight, 1, 1000, DEFAULT_MAX_IN_FLIGHT);
  const intervalSec = clampNumber(payload.intervalSec, 0, 10, 0); // 闭环思考时间；0=火力全开（旧行为）
  const burstPeriodSec = clampNumber(payload.burstPeriodSec, 1, 10, 1); // 开环发送周期；1=每秒连续发（旧行为）
  const key = LOAD_PROFILES[payload.promptProfile] ? payload.promptProfile : "simple";
  const loadProfile = LOAD_PROFILES[key];
  const maxTokens = clampNumber(payload.maxTokens, 1, 4096, loadProfile.maxTokens);
  const stream = payload.stream === true; // 流式 SSE：贴近真实前端流量，且只有它测得到 TTFT

  // 负载序列：闭环夹 1..200(并发)，开环夹 1..2000(速率)。去空、取前 MAX_POINTS 个、升序。
  const loadMax = mode === "open" ? 2000 : 200;
  const loads = (Array.isArray(payload.loads) ? payload.loads : [payload.loads])
    .map((v) => clampNumber(v, 1, loadMax, mode === "open" ? 10 : 30))
    .slice(0, MAX_POINTS)
    .sort((a, b) => a - b);
  if (!loads.length) loads.push(mode === "open" ? 10 : 30);

  const runId = buildReportId("load", reportTargetSlug(profile));
  const probeTarget = { ...profile, maxTokens, timeoutMs: timeoutSec * 1000 };
  const abortSignal = taskContext?.task?.abortController?.signal;

  let counter = 0;
  const dispatch = () => {
    const n = (counter += 1);
    return { prompt: `${loadProfile.base}\n\n[压测探针 #${n} · ${runId}]`, caseId: `req-${n}` };
  };

  // 进度：时间型。总时长 = 点数 ×(warmup+duration)。跨点累计。
  const perPointSec = warmupSec + durationSec;
  const totalSec = loads.length * perPointSec;
  const progress = { done: 0, curStart: performance.now() };
  const progressTimer = setInterval(() => {
    const elapsed = Math.min(totalSec, progress.done * perPointSec + (performance.now() - progress.curStart) / 1000);
    try {
      updateTaskProgress(taskContext, Math.round(elapsed), totalSec, `压测中 ${Math.round(elapsed)}/${totalSec}s · 点 ${progress.done + 1}/${loads.length} · 已发 ${counter}`);
    } catch {
      /* 进度更新失败不影响压测 */
    }
  }, 1000);

  const startedAt = new Date();
  const points = [];
  try {
    for (const load of loads) {
      progress.curStart = performance.now();
      const runStart = performance.now();
      const cfg = {
        execute,
        probeTarget,
        dispatch,
        runId,
        load,
        maxInFlight,
        warmupMs: warmupSec * 1000,
        thinkMs: intervalSec * 1000,
        burstMs: burstPeriodSec * 1000,
        runStart,
        deadline: runStart + perPointSec * 1000,
        abortSignal,
        stream,
        taskContext,
      };
      const samples = mode === "open" ? await runOpenPoint(cfg) : await runClosedPoint(cfg);
      points.push(aggregate({ samples, mode, offered: load, durationSec }));
      progress.done += 1;
      assertTaskNotCancelled(taskContext); // 点间检查取消
    }
  } finally {
    clearInterval(progressTimer);
  }
  const endedAt = new Date();

  const meta = {
    runId,
    model: profile.defaultModel || profile.model || "",
    profileName: profile.name || "",
    channelCode: profile.channelCode || "",
    protocol: profile.protocol || "",
    mode,
    promptProfile: loadProfile.label,
    durationSec,
    warmupSec,
    maxTokens,
    timeoutSec,
    maxInFlight,
    intervalSec,
    burstPeriodSec,
    stream,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
  };

  if (points.length > 1) {
    // 扫描(D)
    const knee = findKnee(points);
    const markdown = formatSweepReport(meta, points, knee);
    const reportFiles = await save(runId, markdown, "压力测试报告（负载扫描）");
    return {
      type: "load-test",
      runId,
      ...meta,
      sweep: points,
      // index=-1（基准点即不可用）时无点可取——offered 置 null，前端已按 `?? "—"` 兜底。
      knee: { ...knee, offered: knee.index >= 0 ? points[knee.index].offered : null },
      reportPath: reportFiles.markdownPath,
      reportHtmlPath: reportFiles.htmlPath,
    };
  }

  // 单点
  const p = points[0];
  const markdown = formatSinglePointReport(meta, p);
  const reportFiles = await save(runId, markdown, "压力测试报告");
  return { type: "load-test", runId, ...meta, ...p, reportPath: reportFiles.markdownPath, reportHtmlPath: reportFiles.htmlPath };
}
