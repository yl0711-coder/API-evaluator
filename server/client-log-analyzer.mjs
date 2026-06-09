import { countErrors, buildErrorDiagnostics, buildRecommendation } from "./reporting.mjs";
import { formatPercent, mean, percentile, redactSensitiveText, safeJson, summarizeText, sumNullable } from "./utils.mjs";

const MAX_RECORDS = 2000;
const MAX_REPLAY_CANDIDATES = 20;
const REPLAY_SAFE_HEADERS = new Set([
  "accept",
  "anthropic-beta",
  "anthropic-version",
  "content-type",
]);

export function extractClientLogRecords(payload = {}) {
  if (Array.isArray(payload.records)) {
    return payload.records.slice(0, MAX_RECORDS);
  }

  const text = String(payload.logText || payload.rawText || "").trim();
  if (!text) return [];

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const parsed = [];
  for (const line of lines.slice(0, MAX_RECORDS)) {
    const json = safeJson(line);
    if (json) {
      parsed.push(json);
      continue;
    }
    const inferred = parsePlainLogLine(line);
    if (inferred) parsed.push(inferred);
  }
  return parsed;
}

export function analyzeClientLogs(records = [], options = {}) {
  const normalizedRecords = records.map((record, index) => normalizeClientLogRecord(record, index));
  const failures = normalizedRecords.filter((record) => !record.success);
  const durations = normalizedRecords.map((record) => record.durationMs).filter((value) => Number.isFinite(value));
  const statusCounts = countBy(normalizedRecords, (record) => String(record.statusCode || "unknown"));
  const clientCounts = countBy(normalizedRecords, (record) => record.client || "unknown");
  const modelCounts = countBy(normalizedRecords, (record) => record.model || "unknown");
  const pathCounts = countBy(normalizedRecords, (record) => record.path || "unknown");
  const streamStatusCounts = countBy(normalizedRecords, (record) => record.streamStatus || "unknown");
  const errorCounts = countErrors(failures);
  const successCount = normalizedRecords.length - failures.length;
  const successRate = normalizedRecords.length ? successCount / normalizedRecords.length : 0;
  const startedAt = normalizedRecords.map((record) => record.startedAt).filter(Boolean).sort()[0] || options.startedAt || null;
  const endedAt = normalizedRecords.map((record) => record.endedAt || record.startedAt).filter(Boolean).sort().at(-1) || null;
  const p95DurationMs = percentile(durations, 0.95);

  return {
    type: "client-replay",
    runId: options.runId || `client-replay-${Date.now()}`,
    sourceName: String(options.sourceName || "客户端代理日志"),
    generatedAt: new Date().toISOString(),
    startedAt,
    endedAt,
    recordCount: normalizedRecords.length,
    successCount,
    failureCount: failures.length,
    successRate,
    successRateText: formatPercent(successRate),
    avgDurationMs: mean(durations),
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs,
    maxDurationMs: durations.length ? Math.max(...durations) : null,
    inputTokens: sumNullable(normalizedRecords.map((record) => record.inputTokens)),
    outputTokens: sumNullable(normalizedRecords.map((record) => record.outputTokens)),
    cacheReadTokens: sumNullable(normalizedRecords.map((record) => record.cacheReadTokens)),
    cacheCreateTokens: sumNullable(normalizedRecords.map((record) => record.cacheCreateTokens)),
    clientCounts,
    modelCounts,
    pathCounts,
    statusCounts,
    streamStatusCounts,
    errorCounts,
    diagnostics: buildErrorDiagnostics(errorCounts),
    recommendation: buildRecommendation(successRate, p95DurationMs, errorCounts),
    riskFlags: buildClientLogRiskFlags({ normalizedRecords, failures, errorCounts, p95DurationMs }),
    abnormalRecords: failures.slice(0, 30),
    records: normalizedRecords,
  };
}

export function buildSupplierEvidence(records = [], options = {}) {
  const normalizedRecords = records.map((record, index) => normalizeClientLogRecord(record, index));
  const failures = normalizedRecords.filter((record) => !record.success);
  const sourceName = String(options.sourceName || "客户端代理日志");
  const providerName = String(options.providerName || options.supplierName || "上游服务商");
  const startedAt = normalizedRecords.map((record) => record.startedAt).filter(Boolean).sort()[0] || null;
  const endedAt = normalizedRecords.map((record) => record.endedAt || record.startedAt).filter(Boolean).sort().at(-1) || null;
  const targetRecords = failures.length ? failures : normalizedRecords;
  const evidenceRecords = targetRecords.slice(0, 50).map((record) => buildSupplierEvidenceRecord(record));
  const errorCounts = countErrors(failures);
  const statusCounts = countBy(normalizedRecords, (record) => String(record.statusCode || "unknown"));
  const modelCounts = countBy(normalizedRecords, (record) => record.model || "unknown");
  const pathCounts = countBy(normalizedRecords, (record) => record.path || "unknown");
  const upstreamIds = unique(
    evidenceRecords.flatMap((record) => [
      ...(record.upstreamTraceIds || []),
      ...(record.upstreamRequestIds || []),
    ]),
  );

  return {
    type: "supplier-evidence",
    runId: options.runId || `supplier-evidence-${Date.now()}`,
    sourceName,
    providerName,
    generatedAt: new Date().toISOString(),
    startedAt,
    endedAt,
    recordCount: normalizedRecords.length,
    failureCount: failures.length,
    successCount: normalizedRecords.length - failures.length,
    statusCounts,
    errorCounts,
    modelCounts,
    pathCounts,
    upstreamIds,
    conclusion: buildSupplierEvidenceConclusion({ failures, errorCounts, upstreamIds }),
    askList: buildSupplierAskList({ errorCounts, upstreamIds }),
    evidenceRecords,
  };
}

export function extractReplayCandidates(payload = {}) {
  const records = extractClientLogRecords(payload);
  const candidates = [];
  for (const record of records) {
    const candidate = buildReplayCandidate(record, candidates.length);
    if (candidate) candidates.push(candidate);
    if (candidates.length >= MAX_REPLAY_CANDIDATES) break;
  }
  return candidates;
}

export function normalizeClientLogRecord(record = {}, index = 0) {
  const request = record.request || {};
  const response = record.response || {};
  const headers = lowerCaseKeys(record.headers || request.headers || {});
  const responseHeaders = lowerCaseKeys(record.responseHeaders || response.headers || {});
  const body = record.body || record.requestBody || request.body || {};
  const responseBody = record.responseBody || response.body || "";
  const statusCode = toNullableNumber(
    record.statusCode ?? record.status ?? response.statusCode ?? response.status ?? record.httpStatus,
  );
  const rawError = redactSensitiveText(
    stringifyFirst(
      record.rawError,
      record.error,
      record.errorText,
      response.error,
      responseBody?.error,
      responseBody,
      record.message,
    ),
  );
  const success = inferSuccess(record, statusCode, rawError);
  const normalizedError = success ? "" : classifyClientError({ statusCode, rawError, record });
  const startedAt = normalizeTime(record.startedAt || record.timestamp || record.time || request.startedAt);
  const endedAt = normalizeTime(record.endedAt || response.endedAt);
  const model = stringifyFirst(record.model, body.model, request.model, record.requestModel);
  const path = inferPath(record.path || record.requestPath || request.path || record.url || request.url);
  const userAgent = stringifyFirst(record.userAgent, headers["user-agent"], record.client);

  return {
    index: index + 1,
    requestId: stringifyFirst(record.requestId, record.request_id, record.id, responseHeaders["x-request-id"], `record-${index + 1}`),
    client: inferClient(userAgent),
    userAgent: summarizeText(userAgent),
    model: model || "",
    path,
    method: stringifyFirst(record.method, request.method, "POST"),
    statusCode,
    success,
    normalizedError,
    rawError: summarizeText(rawError),
    streamStatus: stringifyFirst(
      record.streamStatus?.status,
      record.stream_status?.status,
      record.streamStatus,
      record.stream_status,
      record.streamEndReason,
      "",
    ),
    durationMs: toNullableNumber(record.durationMs ?? record.totalMs ?? record.elapsedMs ?? response.durationMs),
    firstByteMs: toNullableNumber(record.firstByteMs ?? record.ttfbMs ?? response.firstByteMs),
    inputTokens: toNullableNumber(record.inputTokens ?? record.promptTokens ?? record.usage?.inputTokens ?? record.usage?.prompt_tokens),
    outputTokens: toNullableNumber(
      record.outputTokens ?? record.completionTokens ?? record.usage?.outputTokens ?? record.usage?.completion_tokens,
    ),
    cacheReadTokens: toNullableNumber(record.cacheReadTokens ?? record.cache_tokens ?? record.usage?.cacheReadTokens),
    cacheCreateTokens: toNullableNumber(record.cacheCreateTokens ?? record.cache_creation_tokens ?? record.usage?.cacheCreateTokens),
    startedAt,
    endedAt,
    responseSummary: summarizeText(record.responseSummary || responseBody),
  };
}

export function buildReplayCandidate(record = {}, index = 0) {
  const request = record.request || {};
  const body = record.body || record.requestBody || request.body || null;
  if (!body || typeof body !== "object") return null;

  const path = record.path || record.requestPath || request.path || record.url || request.url || "";
  if (!path) return null;

  const headers = sanitizeReplayHeaders(record.headers || request.headers || {});
  const requestJson = {
    method: record.method || request.method || "POST",
    path: inferPath(path),
    headers,
    body: sanitizeReplayValue(body),
  };
  const normalized = normalizeClientLogRecord(record, index);
  return {
    index: index + 1,
    requestId: normalized.requestId,
    client: normalized.client,
    model: normalized.model || requestJson.body?.model || "",
    path: requestJson.path,
    statusCode: normalized.statusCode,
    normalizedError: normalized.normalizedError,
    request: requestJson,
    requestJson: JSON.stringify(requestJson, null, 2),
  };
}

export function classifyClientError({ statusCode, rawError = "", record = {} }) {
  const text = `${rawError} ${record.normalizedError || ""}`.toLowerCase();
  if (/content block not found/.test(text)) return "content_block_not_found";
  if (/client_gone|context canceled|499/.test(text) || statusCode === 499) return "client_gone";
  if (/524|proxy read timeout|origin took too long/.test(text) || statusCode === 524) return "upstream_timeout_524";
  if (/504|gateway time-?out/.test(text) || statusCode === 504) return "gateway_timeout";
  if (/system cpu overloaded|no available accounts|overloaded/.test(text)) return "upstream_unavailable";
  if (/permission_denied|permission denied/.test(text)) return "permission_denied";
  if (/invalid token|unauthorized|forbidden|auth/.test(text) || statusCode === 401 || statusCode === 403) return "auth_failed";
  if (/timeout|timed out/.test(text)) return "timeout";
  if (statusCode && statusCode >= 500) return "upstream_5xx";
  if (statusCode && statusCode >= 400) return "client_4xx";
  return "unknown_error";
}

function buildClientLogRiskFlags({ normalizedRecords, failures, errorCounts, p95DurationMs }) {
  const flags = [];
  if (failures.length > 0) {
    flags.push({
      code: "client_failures",
      severity: failures.length / Math.max(1, normalizedRecords.length) >= 0.2 ? "high" : "medium",
      title: "存在客户端真实请求失败",
      detail: `失败 ${failures.length} / ${normalizedRecords.length} 次，主要错误：${Object.keys(errorCounts)[0] || "unknown_error"}。`,
    });
  }
  if (errorCounts.content_block_not_found) {
    flags.push({
      code: "content_block_not_found",
      severity: "high",
      title: "出现 Content block not found",
      detail: "该错误通常需要结合原始 SSE 事件、协议类型和上游返回结构排查。",
    });
  }
  if (errorCounts.upstream_timeout_524 || errorCounts.gateway_timeout) {
    flags.push({
      code: "upstream_timeout",
      severity: "high",
      title: "出现上游或网关超时",
      detail: "需要核对请求大小、上游耗时、客户端重试和是否重复扣费。",
    });
  }
  if (errorCounts.client_gone) {
    flags.push({
      code: "client_gone",
      severity: "medium",
      title: "客户端主动断开或超时",
      detail: "Claude Code/Codex 等工具可能在等待过久后断开并重试，需要结合服务端日志确认计费状态。",
    });
  }
  if (Number.isFinite(p95DurationMs) && p95DurationMs > 60000) {
    flags.push({
      code: "slow_p95",
      severity: "medium",
      title: "慢请求较多",
      detail: `P95 耗时 ${p95DurationMs} ms，复杂编程场景可能影响用户体验。`,
    });
  }
  if (!flags.length) {
    flags.push({
      code: "no_major_risk",
      severity: "pass",
      title: "未发现明显异常",
      detail: "本轮日志没有出现高频失败、超时或协议结构类错误。",
    });
  }
  return flags;
}

function parsePlainLogLine(line) {
  const accessMatch = line.match(/"(?<method>GET|POST|PUT|DELETE|PATCH)\s+(?<path>\S+)\s+HTTP\/[^"]+"\s+(?<status>\d{3})/);
  if (accessMatch?.groups) {
    return {
      method: accessMatch.groups.method,
      path: accessMatch.groups.path,
      statusCode: Number(accessMatch.groups.status),
      userAgent: line.match(/"\s*"(?<ua>[^"]+)"\s*"[^"]*"\s*$/)?.groups?.ua || "",
      rawError: line,
    };
  }
  const requestId = line.match(/\|\s*(?<id>20\d{30,}[A-Za-z0-9]+)\s*\|/)?.groups?.id;
  if (/channel error|relay error|stream ended|record error log/i.test(line)) {
    return {
      requestId,
      rawError: line,
      statusCode: Number(line.match(/status code:\s*(\d{3})|status_code=(\d{3})/)?.[1] || line.match(/status code:\s*(\d{3})|status_code=(\d{3})/)?.[2] || 0) || null,
    };
  }
  return null;
}

function sanitizeReplayHeaders(headers = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = String(key).toLowerCase();
    if (!REPLAY_SAFE_HEADERS.has(lower)) continue;
    clean[lower] = sanitizeReplayValue(value);
  }
  return clean;
}

function sanitizeReplayValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeReplayValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/authorization|api[_-]?key|x-api-key|password|secret|token/i.test(key))
        .map(([key, val]) => [key, sanitizeReplayValue(val)]),
    );
  }
  if (typeof value === "string") return redactSensitiveText(value);
  return value;
}

function inferSuccess(record, statusCode, rawError) {
  if (typeof record.success === "boolean") return record.success;
  if (/stream_status.*error|client_gone|context canceled|content block not found/i.test(rawError)) return false;
  if (statusCode) return statusCode >= 200 && statusCode < 400;
  return !rawError;
}

function inferClient(userAgent) {
  const text = String(userAgent || "").toLowerCase();
  if (/claude|anthropic/.test(text)) return "Claude Code";
  if (/codex/.test(text)) return "Codex";
  if (/gemini/.test(text)) return "Gemini CLI";
  if (/cursor/.test(text)) return "Cursor";
  if (/trae/.test(text)) return "Trae";
  return userAgent ? "Other Client" : "Unknown";
}

function inferPath(value) {
  const text = String(value || "");
  if (!text) return "";
  try {
    return new URL(text).pathname;
  } catch {
    return text.split("?")[0];
  }
}

function normalizeTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function lowerCaseKeys(value) {
  return Object.fromEntries(Object.entries(value || {}).map(([key, val]) => [String(key).toLowerCase(), val]));
}

function toNullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringifyFirst(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return "";
}

function countBy(records, getKey) {
  return records.reduce((counts, record) => {
    const key = getKey(record) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function buildSupplierEvidenceRecord(record) {
  const text = redactForSupplier(`${record.rawError || ""} ${record.responseSummary || ""}`);
  return {
    index: record.index,
    platformRequestId: record.requestId,
    client: record.client || "Unknown",
    model: record.model || "",
    path: record.path || "",
    method: record.method || "POST",
    statusCode: record.statusCode,
    durationMs: record.durationMs,
    firstByteMs: record.firstByteMs,
    normalizedError: record.normalizedError || "",
    streamStatus: record.streamStatus || "",
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheReadTokens: record.cacheReadTokens,
    cacheCreateTokens: record.cacheCreateTokens,
    startedAt: record.startedAt,
    upstreamTraceIds: extractIds(text, /trace\s*id[:：]\s*([a-zA-Z0-9._-]+)/gi),
    upstreamRequestIds: extractIds(text, /\brequest[_\s-]*id[:：]?\s*\(?([a-zA-Z0-9._-]{8,})\)?/gi),
    summary: summarizeText(text),
  };
}

function buildSupplierEvidenceConclusion({ failures, errorCounts, upstreamIds }) {
  if (!failures.length) {
    return "本批日志没有发现明确失败请求，可作为正常对照样本提供。";
  }
  const mainError = Object.entries(errorCounts || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown_error";
  if (mainError === "upstream_timeout_524") {
    return "多次请求返回 524，上游在代理读超时窗口内未完成响应，需要上游按 request_id / trace_id 排查模型侧或网关侧耗时。";
  }
  if (mainError === "gateway_timeout") {
    return "多次请求返回 504，调用链路发生网关超时，需要上游核查请求是否进入模型服务以及是否存在排队或超时中断。";
  }
  if (mainError === "upstream_unavailable") {
    return "多次请求返回上游不可用类错误，需要上游核查账号池、服务负载或限流策略。";
  }
  if (mainError === "permission_denied") {
    return "多次请求返回 permission_denied，需要上游核查账号权限、模型权限和请求参数限制。";
  }
  if (upstreamIds.length) {
    return "请求失败且日志中包含上游 trace/request id，可直接请上游按这些 ID 定位。";
  }
  return "请求存在失败，需要上游结合时间窗口、模型名、状态码和错误摘要排查。";
}

function buildSupplierAskList({ errorCounts, upstreamIds }) {
  const asks = [
    "请按文档中的时间窗口、模型名和上游 request_id / trace_id 查询上游网关与模型服务日志。",
    "请确认这些请求是否进入模型服务、是否发生排队、限流、账号不可用或模型权限拒绝。",
    "请确认失败请求是否产生上游计费，以及是否存在客户端重试导致的重复计费风险。",
  ];
  if (errorCounts.upstream_timeout_524 || errorCounts.gateway_timeout) {
    asks.push("请提供超时链路的实际耗时分布和建议的最大上下文、最大输出、超时阈值。");
  }
  if (errorCounts.permission_denied) {
    asks.push("请确认该模型在当前账号或渠道下是否完整开通，以及是否有区域、工具调用、thinking 或 beta 参数限制。");
  }
  if (!upstreamIds.length) {
    asks.push("如果上游需要更精确定位，请说明还需要哪些响应头或日志字段。");
  }
  return asks;
}

function extractIds(text, pattern) {
  const ids = [];
  for (const match of String(text || "").matchAll(pattern)) {
    if (match[1]) ids.push(match[1]);
  }
  return unique(ids).slice(0, 10);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function redactForSupplier(text) {
  return redactSensitiveText(text)
    .replace(/\buserId=\d+\b/gi, "userId=[redacted]")
    .replace(/\btokenName=([^,\s}]+)/gi, "tokenName=[redacted]")
    .replace(/\btoken_id=\d+\b/gi, "token_id=[redacted]")
    .replace(/\bchannelId=\d+\b/gi, "channelId=[redacted]")
    .replace(/\bchannel #\d+\b/gi, "channel #[redacted]")
    .replace(/\bchannel_id\":\d+/gi, 'channel_id":[redacted]');
}
