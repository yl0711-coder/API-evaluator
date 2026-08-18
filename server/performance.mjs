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
//
// ── 现状：本模块的产出【没有任何前端展示入口】，日后再做 ───────────────────────
// createProcessPerformanceSnapshot 的唯一生产调用点是 server.mjs 的 handleHealth，
// 也就是说这些指标只出现在 /api/health 的 JSON 里；要看得手动
// `curl -s http://127.0.0.1:5180/api/health | jq .performance`。
// src/ 下没有一处读取 /api/health 或 eventLoop / cpuPercent / p99Ms 等字段
// （任务中心页只读 /api/tasks/*，其「排队/执行/收尾」耗时来自单任务 timing，与本模块无关）。
//
// 补前端展示时请连带解决下面四条口径限制，否则页面上的数字会被当成实时 SLA 读（见
// 「18-v0.7.10 性能诊断与上线风险说明.md」R-05，P2）——现在没界面反而使误读风险低，
// 一旦上了看板就必须在 UI 上标注清楚，或改成固定窗口采样：
//   1. eventLoop 的 p50/p99/max 是**进程启动后的累计值**（enable() 后从不 reset），
//      一次历史卡顿会永久留在 max 里，不代表"当前"。
//   2. cpu.percentSinceLastSample 的采样区间 =「上次有人调 health」到本次，
//      而 Docker healthcheck、人工刷新都在调 → 区间长度不固定，两个数字之间不可比。
//   3. upstream 是**最近 200 条**、按条数滚动不按时间：高峰可能只覆盖几分钟，
//      低峰可能横跨数天，故「429 有 N 次」脱离窗口时长无法解读。
//   4. upstream.requests 数的是**上游尝试次数**（429 重试一次计两次），不等于用户请求数，
//      当 QPS 用会系统性偏高。
// 另：上看板前先落实 R-01（反代层限源 /api/health）。当前无前端消费，摘掉或改挂到
// 需登录端点都是零成本的；有了页面之后就得先给它换一个需登录的数据源。
// ──────────────────────────────────────────────────────────────────────────────
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

// 唯一生产调用点：server.mjs 的 handleHealth。下面四个字段目前**只有接口输出、没有前端展示**，
// 日后补看板时先读文件头那段口径限制（累计值 / 采样区间不定 / 按条数滚动 / 尝试数≠请求数）。
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
