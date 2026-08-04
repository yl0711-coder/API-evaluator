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

// 高级设置里的温度：必须真的发到上游每一道准入用例上（工具题、流式题也不例外）。
// 存在这个开关的理由是有些模型只接受特定温度（如月之暗面只认 1），不给对值整轮准入都会 400。
async function collectAdmissionBodies(over) {
  const bodies = [];
  return withMockUpstream(
    (req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        bodies.push(JSON.parse(raw));
        // 流式用例要 SSE 才判通过，但这里只关心「发出去的请求体带没带温度」，
        // 200 + 非流式响应足够：用例判失败不影响本断言。
        sendJson(res, 200, { choices: [{ message: { content: "admission ok" } }], usage: { prompt_tokens: 5, completion_tokens: 3 } });
      });
    },
    async (baseUrl) => {
      const channel = await channelStore.attachChannelKey(
        { id: "ch-temp-1", name: "温度渠道", provider: "Anthropic", baseUrl, protocol: "openai_chat", status: "enabled" },
        "sk-mock",
      );
      await channelStore.saveChannels([channel]);
      await runAdmissionTest({ channelId: "ch-temp-1", packageLevel: "quick", ...over });
      return bodies;
    },
  );
}

test("runAdmissionTest：高级设置的温度会带到每一道准入用例", async () => {
  const bodies = await collectAdmissionBodies({ model: "gpt-4o-mini", temperature: "1" });
  assert.ok(bodies.length >= 5, `快速准入应至少发 5 次请求，实际 ${bodies.length}`);
  for (const [i, body] of bodies.entries()) {
    assert.equal(body.temperature, 1, `第 ${i + 1} 次请求应带温度 1`);
  }
});

test("runAdmissionTest：温度留空则不覆盖，各用例走各自的默认（普通 0.2、工具题 0）", async () => {
  const bodies = await collectAdmissionBodies({ model: "gpt-4o-mini", temperature: "" });
  for (const body of bodies) {
    // 工具调用题默认用 0 求确定性，其余用例走 OpenAI 协议默认 0.2。
    assert.equal(body.temperature, body.tools ? 0 : 0.2);
  }
});

test("runAdmissionTest：温度非法时直接报错，不烧额度跑完再说", async () => {
  const channel = await channelStore.attachChannelKey(
    {
      id: "ch-temp-bad",
      name: "校验渠道",
      provider: "Anthropic",
      baseUrl: "http://127.0.0.1:1",
      protocol: "openai_chat",
      status: "enabled",
    },
    "sk-mock",
  );
  await channelStore.saveChannels([channel]);
  await assert.rejects(
    () => runAdmissionTest({ channelId: "ch-temp-bad", model: "gpt-4o-mini", temperature: "9" }),
    /温度必须是 0-2 之间的数字/,
  );
});

// 档位判别题刻意不吃用户手填的温度：它的结论来自「在线通过率 vs 离线参考分布」的似然比比较，
// 而离线校准默认不发 temperature。换了采样温度就不是同条件对比，会得出一个基于错基线的
// 「疑似降级」结论——那是对上游的误控告，比少覆盖一处严重得多。
test("runAdmissionTest：档位判别题不带手填温度，其余用例照带（对齐离线校准条件）", async () => {
  const { loadTierContext, buildTierProbeCases } = await import("../server/tier-admission.mjs");
  const model = "claude-sonnet-4-5";
  const tierContext = loadTierContext(model);
  assert.ok(tierContext, "仓库内置的档位参考应覆盖 sonnet 档，否则本用例测不到东西");
  const tierPrompts = new Set(buildTierProbeCases(tierContext.reference).map((c) => c.prompt));
  assert.ok(tierPrompts.size > 0);

  const bodies = await collectAdmissionBodies({ model, packageLevel: "standard", temperature: "1" });
  const promptOf = (body) => {
    const last = body.messages?.[body.messages.length - 1];
    return typeof last?.content === "string" ? last.content : "";
  };
  const tierBodies = bodies.filter((b) => tierPrompts.has(promptOf(b)));
  const otherBodies = bodies.filter((b) => !tierPrompts.has(promptOf(b)));

  assert.ok(tierBodies.length > 0, "standard 包 + Claude 应追加档位判别题");
  for (const body of tierBodies) {
    // 回到工具默认采样（本渠道走 openai_chat → 0.2），即本功能上线前档位题一直在用的条件。
    assert.equal(body.temperature, 0.2, "档位判别题不该吃用户手填的温度");
  }
  assert.ok(
    otherBodies.some((b) => b.temperature === 1),
    "其余用例仍应带上用户手填的温度",
  );
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
