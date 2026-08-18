import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

process.env.EVALUATOR_SECRET_STORE = "memory";
process.env.EVALUATOR_EGRESS_DENY_PRIVATE = "false";

const { createProcessPerformanceSnapshot, resetPerformanceForTests } = await import("../server/performance.mjs");
const { buildApiKeyRef, saveProfileApiKey } = await import("../server/secret-store.mjs");
const { executeTestRequest } = await import("../server/test-runner.mjs");

async function withUpstream(responder, run) {
  const server = createServer(responder);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("a recovered 429 remains visible in the health upstream summary", async () => {
  resetPerformanceForTests();
  let hits = 0;
  await withUpstream(
    (_req, res) => {
      hits += 1;
      if (hits === 1) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "0.1" });
        res.end(JSON.stringify({ error: { message: "rate limited" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    },
    async (baseUrl) => {
      await saveProfileApiKey("performance-e2e", "sk-mock");
      const result = await executeTestRequest(
        {
          id: "performance-e2e",
          name: "Performance E2E",
          protocol: "openai",
          baseUrl,
          apiKeyRef: buildApiKeyRef("performance-e2e"),
          defaultModel: "gpt-4o-mini",
          timeoutMs: 5000,
        },
        "hi",
        { writeLog: false },
      );

      assert.equal(result.success, true);
      assert.deepEqual(result.attemptStatuses, [429, 200]);
      assert.deepEqual(result.attemptErrors, ["rate_limited", ""]);
      const upstream = createProcessPerformanceSnapshot().upstream;
      assert.equal(upstream.rateLimited, 1);
      assert.equal(upstream.requests, 2);
      assert.equal(upstream.retries, 1);
    },
  );
});
