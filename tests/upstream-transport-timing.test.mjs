import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 全程 127.0.0.1，关掉私网出站拦截保持确定性。
process.env.EVALUATOR_DATA_DIR = mkdtempSync(join(tmpdir(), "transport-timing-test-"));
process.env.EVALUATOR_SECRET_STORE = "memory";
process.env.EVALUATOR_EGRESS_DENY_PRIVATE = "false";

const { executeUpstreamRequest } = await import("../server/upstream-transport.mjs");

// 回归：被 abort 的请求必须记【真实耗时】，不能拿 timeoutMs 顶替。
// 真超时场景两者本来就≈相等，问题出在「用户取消」——请求是提前中断的，实际可能只跑了 1-2 秒，
// 却被写成 total_ms = timeoutMs（默认 300000）。这些行会进 test_requests，喂给趋势图 / 回归判定的
// 延迟序列（server/db.mjs 按 total_ms IS NOT NULL 取点），一条假的 5 分钟足以把 P95 拉飞。
// 真实渠道上复现过：取消准入任务后落库的那条 abort 记录 ms=300000，实际耗时约 1-2 秒。
test("executeUpstreamRequest：被取消的请求记真实耗时，不是 timeoutMs", async () => {
  // 永不响应的上游：唯一的终止途径就是外部 abort。
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);

    const profile = {
      id: "p-timing-1",
      baseUrl,
      apiKey: "sk-mock",
      protocol: "openai_chat",
      defaultModel: "m",
      timeoutMs: 300000, // 5 分钟：远大于本用例的实际耗时，修复前会被原样记进 totalMs
    };

    const record = await executeUpstreamRequest(
      profile,
      { abortSignal: controller.signal },
      {
        buildRequest: (p) => ({
          url: `${p.baseUrl}/v1/chat/completions`,
          headers: { "content-type": "application/json" },
          body: { model: p.defaultModel, messages: [{ role: "user", content: "hi" }] },
        }),
        interpret: () => {},
        computeSuccess: () => false,
        finalizeRecord: (x) => x,
      },
    );

    assert.equal(record.normalizedError, "timeout", "外部取消归一化为 timeout（止损不重试）");
    // 300ms 后取消，宽松给到 30s 也远低于 timeoutMs；修复前这里恰好等于 300000。
    assert.ok(record.totalMs < 30000, `取消应记真实耗时，实际记了 ${record.totalMs}ms（timeoutMs=${profile.timeoutMs}）`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
  }
});

// 回归：发生过重试之后再被取消，totalMs 必须是【最后一次尝试】的真实耗时。
// 上一条只覆盖了「第 1 次尝试就被取消」，于是这条路径漏了：每次尝试开头的字段重置清单里
// 没有 totalMs，而 catch 分支写的是 `r.totalMs ?? 实测值` —— `??` 会保住第 1 次尝试留下的旧值。
// 后果和上一条同源：一条假延迟进 test_requests，喂给 P50/P95、趋势图与回归判定。
// 这里第 1 次尝试慢慢回一个 429（retry-after: 0，不退避），第 2 次挂住不响应、由测试主动取消。
test("executeUpstreamRequest：重试后被取消，totalMs 记最后一次尝试的耗时而非上一次", async () => {
  const SLOW_FIRST_MS = 800;
  const CANCEL_AFTER_MS = 120;
  let hits = 0;
  let notifySecondHit;
  const secondHit = new Promise((resolve) => {
    notifySecondHit = resolve;
  });

  const server = createServer((_req, res) => {
    hits += 1;
    if (hits === 1) {
      setTimeout(() => {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
        res.end(JSON.stringify({ error: { message: "rate limited" } }));
      }, SLOW_FIRST_MS);
      return;
    }
    // 第 2 次尝试：永不响应，等测试 abort（不能用 sleep 等它开始，靠请求落地事件驱动）。
    notifySecondHit();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const controller = new AbortController();
    secondHit.then(() => setTimeout(() => controller.abort(), CANCEL_AFTER_MS));

    const record = await executeUpstreamRequest(
      {
        id: "p-timing-2",
        baseUrl,
        apiKey: "sk-mock",
        protocol: "openai_chat",
        defaultModel: "m",
        timeoutMs: 300000,
      },
      { abortSignal: controller.signal },
      {
        buildRequest: (p) => ({
          url: `${p.baseUrl}/v1/chat/completions`,
          headers: { "content-type": "application/json" },
          body: { model: p.defaultModel, messages: [{ role: "user", content: "hi" }] },
        }),
        interpret: () => {},
        computeSuccess: () => false,
        finalizeRecord: (x) => x,
      },
    );

    assert.equal(hits, 2, "应真的发生了第 2 次尝试，否则本用例没测到重试路径");
    assert.equal(record.normalizedError, "timeout", "外部取消归一化为 timeout");
    // 第 2 次尝试实际只跑了 ~120ms。阈值取第 1 次尝试耗时的一半：修复前这里记的是 ~800ms。
    assert.ok(
      record.totalMs < SLOW_FIRST_MS / 2,
      `totalMs 应≈最后一次尝试的真实耗时(约 ${CANCEL_AFTER_MS}ms)，实际记了 ${record.totalMs}ms（疑似沿用第 1 次尝试的 ${SLOW_FIRST_MS}ms）`,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
  }
});
