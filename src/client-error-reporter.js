const MAX_ERROR_TEXT_LENGTH = 1200;
const SENSITIVE_KEY_PATTERN = /(api[_-]?key|authorization|password|secret|token|x-api-key)/i;
const SECRET_VALUE_PATTERN = /\b(sk-[A-Za-z0-9_-]{8,}(?:-[A-Za-z0-9_-]+)*|Bearer\s+[A-Za-z0-9._-]{12,})\b/g;

export function installClientErrorReporter() {
  window.addEventListener("error", (event) => {
    reportClientError({
      kind: "uncaught-error",
      message: event.message,
      page: currentPage(),
      stack: event.error?.stack || "",
      details: {
        filename: event.filename || "",
        line: event.lineno || 0,
        column: event.colno || 0,
      },
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = normalizeReason(event.reason);
    reportClientError({
      kind: "unhandled-rejection",
      message: reason.message,
      page: currentPage(),
      stack: reason.stack,
      details: reason.details,
    });
  });
}

export function sanitizeClientErrorPayload(payload) {
  return sanitizeValue(payload);
}

function normalizeReason(reason) {
  if (reason instanceof Error) {
    return {
      message: reason.message,
      stack: reason.stack || "",
      details: {},
    };
  }

  return {
    message: typeof reason === "string" ? reason : "Unhandled promise rejection",
    stack: "",
    details: typeof reason === "object" && reason ? reason : { reason: String(reason ?? "") },
  };
}

async function reportClientError(payload) {
  try {
    await fetch("/api/client-errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sanitizeClientErrorPayload(payload)),
    });
  } catch {
    // The local service may be unavailable; avoid creating a secondary UI error.
  }
}

function currentPage() {
  return window.location.hash || window.location.pathname;
}

function sanitizeValue(value, depth = 0) {
  if (depth > 4) {
    return "[max-depth]";
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return value.replace(SECRET_VALUE_PATTERN, "[redacted-secret]").slice(0, MAX_ERROR_TEXT_LENGTH);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 50)
        .map(([key, item]) => [key, SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : sanitizeValue(item, depth + 1)]),
    );
  }
  return String(value).slice(0, MAX_ERROR_TEXT_LENGTH);
}
