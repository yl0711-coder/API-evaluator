import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 准入评测支持「渠道 + 任填模型名」的临时目标（不落库），用于标准评测对渠道下尚未登记的
// 模型（如新档位 Claude）做一次性快速准入探测。全程 127.0.0.1，关掉私网出站拦截保持确定性。
const dataDir = mkdtempSync(join(tmpdir(), "admission-adhoc-test-"));
process.env.EVALUATOR_DATA_DIR = dataDir;
process.env.EVALUATOR_SECRET_STORE = "memory";
process.env.EVALUATOR_EGRESS_DENY_PRIVATE = "false";

const dataStore = await import("../server/data-store.mjs");
const channelStore = await import("../server/channel-store.mjs");
const { runAdmissionTest } = await import("../server/test-runner.mjs");
await dataStore.ensureDataDir();

async function withMockUpstream(responder, run) {
  const server = createServer(responder);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const sendJson = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

test("runAdmissionTest：channelId+model 临时目标可跑快速准入，不需要预先登记模型目标", async () => {
  await withMockUpstream(
    (req, res) =>
      sendJson(res, 200, { choices: [{ message: { content: "admission ok" } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }),
    async (baseUrl) => {
      const channel = await channelStore.attachChannelKey(
        {
          id: "ch-adhoc-1",
          name: "临时渠道",
          provider: "Anthropic",
          baseUrl,
          protocol: "openai_chat",
          status: "enabled",
        },
        "sk-mock",
      );
      await channelStore.saveChannels([channel]);

      const result = await runAdmissionTest({ channelId: "ch-adhoc-1", model: "claude-opus-4-8", packageLevel: "quick" });
      assert.equal(result.model, "claude-opus-4-8");
      assert.ok(result.requestCount > 0);
      assert.ok(result.successRate > 0);
    },
  );
});

test("runAdmissionTest：渠道不存在时报错，而不是静默通过", async () => {
  await channelStore.saveChannels([]);
  await assert.rejects(() => runAdmissionTest({ channelId: "missing-channel", model: "m" }), /没有找到被测 API 配置/);
});

// 回归：取消必须在【每轮用例开头】检查。此前只有在飞的那个请求被 abort，循环照样往下走——
// 剩余用例的 fetch 因 signal 已 abort 而瞬间 reject，几秒内刷完全部用例、写一堆 status=0 的
// 垃圾请求记录，任务最后还显示 27/27 99%。真实渠道上复现过：standard 档 Claude 模型共 27 条
// 用例，点取消后 2 秒内多写了 24 行。这里用计数式 mock 上游锁死「取消后不再发请求」。
test("runAdmissionTest：取消后立刻停止，不再向上游发请求", async () => {
  let upstreamCalls = 0;
  const taskContext = { task: { status: "running", cancelRequested: false } };

  await withMockUpstream(
    (req, res) => {
      upstreamCalls += 1;
      // 第 2 个请求落地后请求取消：模拟用户在跑到一半时点「取消当前任务」。
      if (upstreamCalls === 2) taskContext.task.cancelRequested = true;
      sendJson(res, 200, { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 3 } });
    },
    async (baseUrl) => {
      const channel = await channelStore.attachChannelKey(
        {
          id: "ch-cancel-1",
          name: "取消验证渠道",
          provider: "Anthropic",
          baseUrl,
          protocol: "openai_chat",
          status: "enabled",
        },
        "sk-mock",
      );
      await channelStore.saveChannels([channel]);

      await assert.rejects(
        () => runAdmissionTest({ channelId: "ch-cancel-1", model: "claude-opus-4-8", packageLevel: "quick" }, taskContext),
        (error) => error.name === "TaskCancelledError",
        "取消应以 TaskCancelledError 中断，而不是把剩余用例跑完",
      );

      // quick 档用例数远多于 2；若循环没在每轮开头检查取消，这里会等于总用例数。
      assert.equal(upstreamCalls, 2, `取消后不应再有上游请求，实际发出 ${upstreamCalls} 个`);
    },
  );
});
