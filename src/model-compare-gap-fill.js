import { estimateScenarioCost } from "./cost-estimates.js";

function optionalInt(value, min, max) {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

// 温度：0-2 的小数，留空 undefined（走协议默认）。不能复用 optionalInt——它会取整并把 0 判为无效，
// 而 0（完全确定性输出）和 0.7 都是合法温度。非法值同样返回 undefined，交由后端做权威校验并报 400。
function optionalTemperature(value) {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) return undefined;
  return parsed;
}

function selectedNumber(value, allowed, fallback) {
  const parsed = Number(value);
  return allowed.includes(parsed) ? parsed : fallback;
}

function isEnabled(value) {
  return (
    value === true ||
    ["1", "true", "on", "yes"].includes(
      String(value ?? "")
        .trim()
        .toLowerCase(),
    )
  );
}

// 与「复杂场景测试」高级设置同口径。补齐任务始终只有一个目标模型，故不含 maxParallelProfiles。
export function normalizeGapFillOptions(raw = {}) {
  return {
    maxTokens: optionalInt(raw.maxTokens, 1, 32768),
    timeoutMs: optionalInt(raw.timeoutMs, 1000, 600000),
    temperature: optionalTemperature(raw.temperature),
    repeats: selectedNumber(raw.repeats, [1, 2, 3], 1),
    requestConcurrency: selectedNumber(raw.requestConcurrency, [1, 2], 1),
    fullResponseInReport: isEnabled(raw.fullResponseInReport),
    streamRequest: isEnabled(raw.streamRequest),
  };
}

export function gapFillOptionSignature(options) {
  return [
    options.maxTokens ?? "default",
    options.timeoutMs ?? "default",
    // 必须参与签名：温度会实质改变输出，否则换温度重跑会被幂等键判成同一次任务而直接复用旧结果。
    options.temperature ?? "default",
    options.repeats,
    options.requestConcurrency,
    options.fullResponseInReport ? 1 : 0,
    options.streamRequest ? 1 : 0,
  ].join("-");
}

export function buildGapFillTaskPayload({ targetId, scenarioId, rawOptions, scenarios }) {
  const options = normalizeGapFillOptions(rawOptions);
  const payload = {
    profileIds: [targetId],
    scenarioIds: [scenarioId],
    repeats: options.repeats,
    requestConcurrency: options.requestConcurrency,
    fullResponseInReport: options.fullResponseInReport,
    streamRequest: options.streamRequest,
    idempotencyKey: `mc-gap-fill:v2:${encodeURIComponent(targetId)}:${encodeURIComponent(scenarioId)}:${gapFillOptionSignature(options)}`,
  };
  if (options.maxTokens !== undefined) payload.maxTokens = options.maxTokens;
  if (options.timeoutMs !== undefined) payload.timeoutMs = options.timeoutMs;
  if (options.temperature !== undefined) payload.temperature = options.temperature;
  payload.predicted = estimateScenarioCost(payload, scenarios || []);
  return payload;
}

export function summarizeGapFillEstimates(payloads) {
  const totals = (payloads || []).reduce(
    (sum, payload) => {
      const estimate = payload?.predicted || {};
      sum.requests += Number(estimate.requests) || 0;
      sum.lowTokens += Number(estimate.lowTokens) || 0;
      sum.highTokens += Number(estimate.highTokens) || 0;
      return sum;
    },
    { requests: 0, lowTokens: 0, highTokens: 0 },
  );
  const risk = totals.highTokens >= 100000 ? "高" : totals.highTokens >= 20000 ? "中高" : "中";
  return { ...totals, risk };
}

export async function runGapFillQueue({ jobs, onJobStart, runJob, isCancellationRequested }) {
  const failures = [];
  let completed = 0;

  for (let index = 0; index < jobs.length; index += 1) {
    if (isCancellationRequested()) {
      return { cancelled: true, completed, failures };
    }
    const job = jobs[index];
    onJobStart(job, index);
    try {
      await runJob(job);
      completed += 1;
    } catch (error) {
      if (isCancellationRequested()) {
        return { cancelled: true, completed, failures };
      }
      failures.push({ job, error });
    }
  }

  return { cancelled: false, completed, failures };
}
