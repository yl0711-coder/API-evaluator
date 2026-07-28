export { ERROR_DIAGNOSTICS } from "./diagnostics.mjs";
export { TEST_SCENARIOS, getTestScenarios } from "./scenarios/index.mjs";

export const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

// P95 总延迟三档分类阈值（ms）：≤15s 好 / ≤45s 观察 / >45s 慢
export const P95_LATENCY_OK_MS = 15000;
export const P95_LATENCY_SLOW_MS = 45000;
