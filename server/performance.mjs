// 进程与上游调用的性能诊断快照。
//
// ⚠️ 消费方是 /api/health，而该端点在免登录白名单里（server/api-access.mjs 的
// PUBLIC_API_PATHS，容器健康检查必须能无凭据调用）。**本模块的输出因此是公开的。**
// 这是有意的设计，完整理由与代价见那份注释。
//
// 由此得出一条硬约束：这里只能产出**聚合数值**，绝不能带 API key、baseUrl、渠道名、
// 模型名、prompt、响应正文或任何可定位到具体用户/渠道的标识。
// 具体地，recordUpstreamTiming 只取样本里的时延与错误【计数】字段
// （attempts / statusCode / normalizedError / endToEndMs / retryWaitMs），
// 哪怕调用方传进来一整个 record，也不要把其余字段带进 upstreamWindow 之外的输出。
// 需要带标识的排障数据请走 /api/support-bundle（仅超管）。
import { monitorEventLoopDelay } from "node:perf_hooks";

const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();
const cpuStart = process.cpuUsage();
let cpuSample = process.cpuUsage();
let cpuSampleAt = process.hrtime.bigint();
const upstreamWindow = [];
const UPSTREAM_WINDOW_SIZE = 200;

function summarizeUpstream() {
  const counts = { requests: 0, timeouts: 0, rateLimited: 0, serverErrors: 0, networkErrors: 0, retries: 0, retryWaitMs: 0 };
  let totalMs = 0;
  let measured = 0;
  for (const item of upstreamWindow) {
    const attempts = Math.max(1, Number(item.attempts || 1));
    counts.requests += attempts;
    counts.retries += attempts - 1;
    const statuses = Array.isArray(item.attemptStatuses) ? item.attemptStatuses : [item.statusCode];
    const errors = Array.isArray(item.attemptErrors) ? item.attemptErrors : [item.normalizedError];
    counts.rateLimited += statuses.filter((status) => Number(status) === 429).length;
    counts.serverErrors += statuses.filter((status) => Number(status) >= 500).length;
    counts.timeouts += errors.filter((error) => error === "timeout").length;
    counts.networkErrors += errors.filter((error) => error === "network_error").length;
    counts.retryWaitMs += Math.max(0, Number(item.retryWaitMs || 0));
    if (Number.isFinite(item.endToEndMs)) {
      totalMs += item.endToEndMs;
      measured += 1;
    }
  }
  return { ...counts, avgEndToEndMs: measured ? Math.round(totalMs / measured) : null };
}

// 只留白名单字段，不 {...sample} 整体收下。
//
// 原因见文件头：本模块的输出经 /api/health 公开。唯一的生产调用方
// （server/upstream-transport.mjs）今天恰好只传这几个字段，但那是**调用方的自觉**，
// 不是这里的约束——将来谁顺手把整个 record 传进来（record 里有 prompt、响应正文、
// profile 标识），就会被存进 upstreamWindow。虽然 summarizeUpstream 目前不读那些字段、
// 不至于立刻泄露，但「安全只靠下游恰好没读」是不能接受的。
// 在入口处收窄，让「公开的东西里没有标识信息」成为本模块自己保证的性质。
export function recordUpstreamTiming(sample) {
  if (!sample || typeof sample !== "object") return;
  upstreamWindow.push({
    statusCode: sample.statusCode,
    normalizedError: sample.normalizedError,
    attempts: sample.attempts,
    attemptStatuses: Array.isArray(sample.attemptStatuses) ? [...sample.attemptStatuses] : undefined,
    attemptErrors: Array.isArray(sample.attemptErrors) ? [...sample.attemptErrors] : undefined,
    retryWaitMs: sample.retryWaitMs,
    endToEndMs: sample.endToEndMs,
    at: Date.now(),
  });
  if (upstreamWindow.length > UPSTREAM_WINDOW_SIZE) upstreamWindow.splice(0, upstreamWindow.length - UPSTREAM_WINDOW_SIZE);
}

export function createProcessPerformanceSnapshot({ limiter, scheduler } = {}) {
  const cpu = process.cpuUsage(cpuStart);
  const now = process.hrtime.bigint();
  const intervalUs = Number(now - cpuSampleAt) / 1000;
  const intervalCpu = process.cpuUsage(cpuSample);
  const cpuPercent = intervalUs > 0 ? Math.round(((intervalCpu.user + intervalCpu.system) / intervalUs) * 1000) / 10 : 0;
  cpuSample = process.cpuUsage();
  cpuSampleAt = now;
  const toMs = (value) => (Number.isFinite(value) ? Math.round((value / 1e6) * 10) / 10 : null);
  return {
    cpu: { userMs: Math.round(cpu.user / 1000), systemMs: Math.round(cpu.system / 1000), percentSinceLastSample: cpuPercent },
    memory: process.memoryUsage(),
    eventLoop: { p50Ms: toMs(eventLoop.percentile(50)), p99Ms: toMs(eventLoop.percentile(99)), maxMs: toMs(eventLoop.max) },
    execution: limiter?.getStatus?.() || null,
    autoTest: scheduler?.getStatus?.() || null,
    upstream: summarizeUpstream(),
  };
}

// 仅供测试：读回内部样本窗口，用于断言 recordUpstreamTiming 真的在入口处收窄了字段。
//
// 为什么需要它：summarizeUpstream 只输出一组固定的计数器，所以「窗口里存了什么」在
// createProcessPerformanceSnapshot 的输出里看不出来——只对快照做断言的测试是空转的
// （实测：把入口改回 {...sample} 也照样通过）。要把这条安全性质真正钉住，必须能看到窗口本身。
export function readUpstreamWindowForTests() {
  return upstreamWindow.map((item) => ({ ...item }));
}

export function resetPerformanceForTests() {
  upstreamWindow.length = 0;
  eventLoop.reset();
  cpuSample = process.cpuUsage();
  cpuSampleAt = process.hrtime.bigint();
}
