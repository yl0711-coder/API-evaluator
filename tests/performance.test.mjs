import assert from "node:assert/strict";
import test from "node:test";
import { createProcessPerformanceSnapshot, recordUpstreamTiming, resetPerformanceForTests } from "../server/performance.mjs";

test("performance snapshot exposes resource, queue, and upstream metrics", () => {
  resetPerformanceForTests();
  recordUpstreamTiming({
    statusCode: 200,
    attemptStatuses: [429, 200],
    attemptErrors: ["upstream_429", ""],
    attempts: 2,
    retryWaitMs: 125,
    endToEndMs: 240,
  });
  recordUpstreamTiming({
    statusCode: 200,
    attemptStatuses: [503, 503, 200],
    attemptErrors: ["upstream_5xx", "upstream_5xx", ""],
    attempts: 3,
    retryWaitMs: 300,
    endToEndMs: 500,
  });
  recordUpstreamTiming({ normalizedError: "timeout", attemptStatuses: [null], attemptErrors: ["timeout"], attempts: 1, endToEndMs: 1000 });
  recordUpstreamTiming({
    normalizedError: "network_error",
    attemptStatuses: [null, null],
    attemptErrors: ["network_error", "network_error"],
    attempts: 2,
    retryWaitMs: 50,
    endToEndMs: 80,
  });

  const snapshot = createProcessPerformanceSnapshot({
    limiter: { getStatus: () => ({ maxConcurrent: 2, active: 2, queued: 3 }) },
    scheduler: { getStatus: () => ({ enabled: true, running: 1, queued: 0 }) },
  });

  assert.deepEqual(snapshot.execution, { maxConcurrent: 2, active: 2, queued: 3 });
  assert.equal(snapshot.upstream.requests, 8);
  assert.equal(snapshot.upstream.rateLimited, 1);
  assert.equal(snapshot.upstream.serverErrors, 2);
  assert.equal(snapshot.upstream.timeouts, 1);
  assert.equal(snapshot.upstream.networkErrors, 2);
  assert.equal(snapshot.upstream.retries, 4);
  assert.equal(snapshot.upstream.retryWaitMs, 475);
  assert.equal(snapshot.upstream.avgEndToEndMs, 455);
  assert.equal(typeof snapshot.cpu.percentSinceLastSample, "number");
  assert.equal(typeof snapshot.memory.rss, "number");
  assert.equal(typeof snapshot.eventLoop.p99Ms, "number");
});
