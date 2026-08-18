// server/client-replay.mjs
// 客户端回放：把从客户端日志还原的请求重新打到被测渠道，复现线上报错并归类，
// 用于排障对照（注意会真实消耗上游额度）。
import { performance } from "node:perf_hooks";
import { classifyClientError, normalizeClientLogRecord } from "./client-log-analyzer.mjs";
import { readProfileApiKey } from "./secret-store.mjs";
import { readBoundedResponseText } from "./test-runner.mjs";
import { buildProtocolUrl } from "./protocols.mjs";
import { assertPublicTarget } from "./egress-guard.mjs";
import { redactSensitiveText, safeJson, summarizeText } from "./utils.mjs";

const MAX_REPLAY_RESPONSE_BYTES = 2 * 1024 * 1024;
const SAFE_HEADER_NAMES = new Set(["accept", "anthropic-beta", "anthropic-version", "content-type"]);

export async function runClientReplay(profile, replayPayload = {}) {
  const apiKey = await readProfileApiKey(profile);
  const startedAt = new Date();
  const timeoutMs = Number(replayPayload.timeoutMs || profile.timeoutMs || 120000);
  const requestId = replayPayload.requestId || `client-replay-${Date.now()}`;

  if (!apiKey) {
    return normalizeClientLogRecord({
      requestId,
      client: "Replay",
      model: replayPayload.request?.body?.model || profile.defaultModel,
      path: replayPayload.request?.path || inferDefaultPath(profile),
      statusCode: null,
      success: false,
      rawError: "API Key 未配置或无法从密钥存储读取。",
      normalizedError: "auth_failed",
      durationMs: 0,
      startedAt,
    });
  }

  const replayRequest = buildReplayRequest(profile, replayPayload, apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let statusCode = null;
  let responseText = "";
  let rawError = "";
  let durationMs = null;
  let firstByteMs = null;

  try {
    const started = performance.now();
    await assertPublicTarget(replayRequest.url);
    const response = await fetch(replayRequest.url, {
      method: replayRequest.method,
      headers: replayRequest.headers,
      body: JSON.stringify(replayRequest.body),
      signal: controller.signal,
      redirect: "error",
    });
    firstByteMs = Math.round(performance.now() - started);
    statusCode = response.status;
    const rawResult = await readBoundedResponseText(response, MAX_REPLAY_RESPONSE_BYTES, controller);
    durationMs = Math.round(performance.now() - started);
    if (rawResult.truncated) {
      rawError = `上游响应超过 ${MAX_REPLAY_RESPONSE_BYTES} bytes，已停止读取。`;
    } else {
      responseText = rawResult.text;
      if (!response.ok) rawError = summarizeText(rawResult.text);
    }
  } catch (error) {
    durationMs = durationMs ?? timeoutMs;
    rawError = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }

  const parsed = safeJson(responseText);
  const usage = parsed?.usage || null;
  const rawRecord = {
    requestId,
    client: "Replay",
    request: {
      method: replayRequest.method,
      url: replayRequest.url,
      path: replayRequest.path,
      headers: replayRequest.headers,
      body: replayRequest.body,
    },
    response: {
      statusCode,
      body: rawError || summarizeText(responseText),
    },
    model: replayRequest.body?.model || profile.defaultModel,
    path: replayRequest.path,
    statusCode,
    success: Boolean(statusCode && statusCode >= 200 && statusCode < 400 && !rawError),
    rawError: rawError ? redactSensitiveText(rawError) : "",
    responseSummary: summarizeText(responseText),
    durationMs,
    firstByteMs,
    inputTokens: usage?.prompt_tokens ?? usage?.input_tokens ?? null,
    outputTokens: usage?.completion_tokens ?? usage?.output_tokens ?? null,
    startedAt,
    endedAt: new Date(),
  };
  const normalized = normalizeClientLogRecord(rawRecord);
  if (!normalized.success && !normalized.normalizedError) {
    normalized.normalizedError = classifyClientError({ statusCode, rawError, record: rawRecord });
  }
  return {
    ...normalized,
    replay: true,
    replayUrl: redactSensitiveText(replayRequest.url),
    responseSummary: summarizeText(responseText || rawError),
  };
}

export function buildReplayRequest(profile, replayPayload = {}, apiKey = "[api-key]") {
  const request = normalizeReplayInput(replayPayload);
  const baseUrl = String(profile.baseUrl || "").replace(/\/+$/, "");
  const path = normalizeReplayPath(request.path || request.url || inferDefaultPath(profile), profile);
  const body = normalizeReplayBody(request.body || request.requestBody || replayPayload.body, profile);
  const headers = buildReplayHeaders(profile, request.headers, apiKey);
  return {
    method: String(request.method || "POST").toUpperCase(),
    url: joinReplayUrl(baseUrl, path),
    path,
    headers,
    body,
  };
}

// baseUrl + 捕获到的 path 拼绝对 URL。
//
// 原来是直接 `${baseUrl}${path}`，隐含假设「baseUrl 只有 origin、没有路径」。openai_path_prefix
// 渠道打破了这个假设：baseUrl 含 /api/paas/v4，而客户端日志里的 path 是【从根算起】的完整
// pathname（也含 /api/paas/v4），直接相接会得到 /api/paas/v4/api/paas/v4/chat/completions。
// 规则：path 已经带上了 baseUrl 的前缀就不再重复（按 origin 拼），否则保持原样把前缀补上。
// 于是 origin-only 的老渠道行为逐字不变，带网关前缀的老渠道（如 .../gw）也不变。
function joinReplayUrl(baseUrl, path) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return `${baseUrl}${path}`; // baseUrl 非法：保持原行为，交由后续 assertPublicTarget/fetch 报错
  }
  const prefix = parsed.pathname.replace(/\/+$/, "");
  if (!prefix) return `${parsed.origin}${path}`;
  if (path === prefix || path.startsWith(`${prefix}/`)) return `${parsed.origin}${path}`;
  return `${parsed.origin}${prefix}${path}`;
}

export function normalizeReplayInput(payload = {}) {
  if (payload.request && typeof payload.request === "object") return payload.request;
  if (payload.record?.request && typeof payload.record.request === "object") return payload.record.request;
  if (payload.requestJson) {
    const parsed = safeJson(String(payload.requestJson));
    if (parsed?.request) return parsed.request;
    if (parsed) return parsed;
  }
  return payload;
}

function buildReplayHeaders(profile, capturedHeaders = {}, apiKey) {
  const headers = {};
  const lower = Object.fromEntries(Object.entries(capturedHeaders || {}).map(([key, value]) => [String(key).toLowerCase(), value]));
  for (const [key, value] of Object.entries(lower)) {
    if (SAFE_HEADER_NAMES.has(key) && value) headers[key] = String(value);
  }
  headers["content-type"] = headers["content-type"] || "application/json";
  if (profile.protocol === "claude_messages") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = headers["anthropic-version"] || profile.anthropicVersion || "2023-06-01";
  } else {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function normalizeReplayBody(body, profile) {
  const parsedBody = typeof body === "string" ? safeJson(body) : body;
  const source = parsedBody && typeof parsedBody === "object" ? parsedBody : {};
  return {
    ...source,
    model: source.model || profile.defaultModel,
    max_tokens: source.max_tokens ?? source.maxTokens ?? Number(profile.maxTokens || 512),
  };
}

function normalizeReplayPath(value, profile = null) {
  const text = String(value || "");
  if (!text) return profile ? inferDefaultPath(profile) : "/v1/chat/completions";
  try {
    return new URL(text).pathname;
  } catch {
    const path = text.startsWith("/") ? text : `/${text}`;
    return path.split("?")[0];
  }
}

// 回放没带原始 path 时的兜底路径。必须与 protocols.buildProtocolUrl 同源：
// 此处独立拼 `/v1/...` 曾导致 openai_path_prefix 渠道（baseUrl 已含 /api/paas/v4 这类版本前缀）
// 被拼成 `/api/paas/v4/v1/chat/completions` → 404，即测试主链路已修掉、却在回放链路复现的同一个 bug。
// buildProtocolUrl 收的是 baseUrl、返回绝对 URL；这里只要 path 部分，故用同一函数解出 pathname。
function inferDefaultPath(profile) {
  return new URL(buildProtocolUrl(profile.protocol, "https://placeholder.invalid")).pathname;
}
