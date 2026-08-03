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

// 回归：准入摘要必须给出【双口径】成功率。此前准入侧只把 attempts 用于计费求和，
// 双口径只有稳定性/压测路径有（server/summaries.mjs），准入报告因此只有「重试后最终成功率」
// 一个数——一个靠重试才成功的渠道，和一次就成的长得一模一样，而这恰恰是准入决策要看的差。
// 这里让上游第一次返回 429（retry-after: 0，重试瞬时发生，不拖慢用例）、之后全部 200：
// 最终成功率应为 100%，但首次成功率必须 < 100% 且能指出有 1 次是靠重试救回来的。
test("runAdmissionTest：首次成功率与重试后成功率分开统计", async () => {
  let upstreamCalls = 0;
  await withMockUpstream(
    (req, res) => {
      upstreamCalls += 1;
      if (upstreamCalls === 1) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
        res.end(JSON.stringify({ error: { message: "rate limited" } }));
        return;
      }
      sendJson(res, 200, { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 3 } });
    },
    async (baseUrl) => {
      const channel = await channelStore.attachChannelKey(
        {
          id: "ch-attempts-1",
          name: "重试统计渠道",
          provider: "Anthropic",
          baseUrl,
          protocol: "openai_chat",
          status: "enabled",
        },
        "sk-mock",
      );
      await channelStore.saveChannels([channel]);

      const result = await runAdmissionTest({ channelId: "ch-attempts-1", model: "claude-opus-4-8", packageLevel: "quick" });

      assert.notEqual(result.firstAttemptSuccessRate, null, "记录带 attempts 时不应退化为「未能统计」");
      // 关键是【两个口径拉开差距】，不是绝对值：这个朴素 mock 不满足流式/工具调用用例，
      // 本来就有几条过不了（既有用例也只断言 successRate > 0）。
      assert.ok(
        result.firstAttemptSuccessRate < result.successRate,
        `首次成功率应低于重试后成功率，实际 ${result.firstAttemptSuccessRate} vs ${result.successRate}`,
      );
      assert.equal(result.recoveredCount, 1, `应指出恰有 1 次靠重试救回，实际 ${result.recoveredCount}`);
    },
  );
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
