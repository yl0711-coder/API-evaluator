import { performance } from "node:perf_hooks";
import { classifyClientError, normalizeClientLogRecord } from "./client-log-analyzer.mjs";
import { readProfileApiKey } from "./secret-store.mjs";
import { readBoundedResponseText } from "./test-runner.mjs";
import { assertPublicTarget } from "./egress-guard.mjs";
import { redactSensitiveText, safeJson, summarizeText } from "./utils.mjs";

const MAX_REPLAY_RESPONSE_BYTES = 2 * 1024 * 1024;
const SAFE_HEADER_NAMES = new Set([
  "accept",
  "anthropic-beta",
  "anthropic-version",
  "content-type",
]);

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
  const path = normalizeReplayPath(request.path || request.url || inferDefaultPath(profile));
  const body = normalizeReplayBody(request.body || request.requestBody || replayPayload.body, profile);
  const headers = buildReplayHeaders(profile, request.headers, apiKey);
  return {
    method: String(request.method || "POST").toUpperCase(),
    url: `${baseUrl}${path}`,
    path,
    headers,
    body,
  };
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

function normalizeReplayPath(value) {
  const text = String(value || "");
  if (!text) return "/v1/chat/completions";
  try {
    return new URL(text).pathname;
  } catch {
    const path = text.startsWith("/") ? text : `/${text}`;
    return path.split("?")[0];
  }
}

function inferDefaultPath(profile) {
  return profile.protocol === "claude_messages" ? "/v1/messages" : "/v1/chat/completions";
}
