import assert from "node:assert/strict";
import test from "node:test";
import {
  createProcessPerformanceSnapshot,
  readUpstreamWindowForTests,
  recordUpstreamTiming,
  resetPerformanceForTests,
} from "../server/performance.mjs";

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

// 本快照经 /api/health 对**未登录者**公开（server/api-access.mjs 的 PUBLIC_API_PATHS，
// 容器健康检查必须能无凭据调用）。所以「输出里只有聚合数值、没有可定位到具体渠道/模型/
// 用户的标识」是一条安全性质，必须由代码保证而不是靠调用方自觉。
// 这里把 recordUpstreamTiming 的入口收窄钉住：哪怕调用方塞进整个 record，也不得渗进快照。
test("公开的性能快照不含任何标识信息（recordUpstreamTiming 在入口处收窄字段）", () => {
  resetPerformanceForTests();
  // 模拟「有人顺手把整个 record 传进来」——record 里带 key、baseUrl、prompt、响应正文、profile 标识
  recordUpstreamTiming({
    statusCode: 200,
    attempts: 1,
    endToEndMs: 100,
    apiKey: "sk-live-SHOULD-NOT-LEAK",
    baseUrl: "https://relay.example.com/v1",
    profileId: "mt_secret_target",
    profileName: "某渠道 / 某模型",
    model: "claude-opus-4-8",
    prompt: "用户的私密提问",
    responseText: "模型的完整回答",
  });

  // 关键：对【存进窗口的样本】断言，而不是只对快照断言。
  // summarizeUpstream 只输出固定的计数器，所以泄露字段在快照里看不出来——
  // 只测快照的版本在「入口改回 {...sample}」时依然通过，是空转的。
  const snapshot = createProcessPerformanceSnapshot({});
  const serialized = JSON.stringify({ snapshot, window: readUpstreamWindowForTests() });
  for (const needle of [
    "sk-live-SHOULD-NOT-LEAK",
    "relay.example.com",
    "mt_secret_target",
    "某渠道",
    "claude-opus-4-8",
    "用户的私密提问",
    "模型的完整回答",
  ]) {
    assert.equal(serialized.includes(needle), false, `公开快照里出现了标识/内容字段：${needle}`);
  }
  // 该样本本身仍要被统计到（收窄字段 ≠ 丢弃样本）
  assert.equal(snapshot.upstream.requests, 1);
  assert.equal(snapshot.upstream.avgEndToEndMs, 100);
});
