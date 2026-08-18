export { ERROR_DIAGNOSTICS } from "./diagnostics.mjs";
export { TEST_SCENARIOS, getTestScenarios } from "./scenarios/index.mjs";

export const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

// P95 总延迟三档分类阈值（ms）：≤15s 好 / ≤45s 观察 / >45s 慢。
// 真身在 shared/thresholds.mjs——前端 src/operator-guidance.js 也要用同一套值，而后端不得
// import src/、前端不该 import server/，故共用值只能住 shared/（详见那里的注释与 ADM-011）。
// 这里保留再导出，后端既有的 20 多处 `from "./constants.mjs"` 一处都不用改。
export { P95_LATENCY_OK_MS, P95_LATENCY_SLOW_MS } from "../shared/thresholds.mjs";
