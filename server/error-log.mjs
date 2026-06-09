import crypto from "node:crypto";
import { appendJsonLine, redactSensitiveText, summarizeText } from "./utils.mjs";

const SENSITIVE_KEY_PATTERN = /(api[_-]?key|authorization|password|secret|token|x-api-key)/i;
const SECRET_VALUE_PATTERN = /\b(sk-[A-Za-z0-9_-]{8,}(?:-[A-Za-z0-9_-]+)*|Bearer\s+[A-Za-z0-9._-]{12,})\b/g;

export function buildUserErrorMessage(errorId) {
  return `工具遇到一个内部问题。请重新操作一次；如果仍然失败，把错误编号 ${errorId} 发给负责人。`;
}

export async function logTechnicalError(errorLogFile, { source, error, context = {} }) {
  const errorId = `err-${compactTimestamp()}-${crypto.randomBytes(3).toString("hex")}`;
  const normalized = normalizeError(error);
  await appendJsonLine(errorLogFile, {
    id: errorId,
    loggedAt: new Date().toISOString(),
    source: source || "unknown",
    name: normalized.name,
    message: redactText(normalized.message),
    stack: redactText(normalized.stack),
    context: sanitizeContext(context),
  });
  return errorId;
}

function normalizeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message || "",
      stack: error.stack || "",
    };
  }
  return {
    name: "NonError",
    message: String(error ?? ""),
    stack: "",
  };
}

function sanitizeContext(value, depth = 0) {
  if (depth > 4) {
    return "[max-depth]";
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return redactText(summarizeText(value));
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeContext(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 50)
        .map(([key, item]) => [key, SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : sanitizeContext(item, depth + 1)]),
    );
  }
  return summarizeText(String(value));
}

function redactText(value) {
  return redactSensitiveText(String(value || "").replace(SECRET_VALUE_PATTERN, "[redacted-secret]"));
}

function compactTimestamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}
