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

export function recordUpstreamTiming(sample) {
  if (!sample || typeof sample !== "object") return;
  upstreamWindow.push({ ...sample, at: Date.now() });
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

export function resetPerformanceForTests() {
  upstreamWindow.length = 0;
  eventLoop.reset();
  cpuSample = process.cpuUsage();
  cpuSampleAt = process.hrtime.bigint();
}
