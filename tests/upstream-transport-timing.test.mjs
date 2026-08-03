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
