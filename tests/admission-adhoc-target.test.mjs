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
    (req, res) => sendJson(res, 200, { choices: [{ message: { content: "admission ok" } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }),
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
