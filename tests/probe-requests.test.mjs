import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { buildApiKeyRef, saveProfileApiKey } from "../server/secret-store.mjs";
import {
  executeStreamStructureTestRequest,
  executeTestRequest,
  executeToolCallTestRequest,
} from "../server/test-runner.mjs";

// 三个上游探测共用 runUpstreamProbe 骨架，这里用本地 mock 上游做端到端集成测试，
// 锁定重构后各分支的字段路由（尤其：非流式 firstTokenMs 恒为 null、流式才捕获真 TTFT）。
// 全程 127.0.0.1：关掉私网出站拦截即可放行本地，无 DNS、无外网，保持测试确定性。
process.env.EVALUATOR_SECRET_STORE = "memory";
process.env.EVALUATOR_EGRESS_DENY_PRIVATE = "false";

async function withMockUpstream(responder, run) {
  const server = createServer(responder);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function probeProfile(baseUrl, over = {}) {
  await saveProfileApiKey("probe-test", "sk-mock");
  return {
    id: "probe-test",
    name: "Mock",
    protocol: "openai",
    baseUrl,
    apiKeyRef: buildApiKeyRef("probe-test"),
    defaultModel: "gpt-4o-mini",
    timeoutMs: 5000,
    ...over,
  };
}

const sendJson = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

test("executeTestRequest：2xx + 输出 → success，usage 提取，非流式 firstTokenMs 恒为 null", async () => {
  await withMockUpstream(
    (req, res) => sendJson(res, 200, { choices: [{ message: { content: "工作正常。" } }], usage: { prompt_tokens: 11, completion_tokens: 5 } }),
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { writeLog: false });
      assert.equal(r.success, true);
      assert.equal(r.responseText, "工作正常。");
      assert.equal(r.inputTokens, 11);
      assert.equal(r.outputTokens, 5);
      assert.equal(r.tokenSource, "upstream");
      assert.equal(r.statusCode, 200);
      assert.ok(Number.isInteger(r.firstByteMs));
      assert.equal(r.firstTokenMs, null); // 非流式无 token 级时序
      assert.equal(r.toolCall, null);
      assert.equal(r.streamValidation, null);
    },
  );
});

test("executeTestRequest：5xx → success=false，normalizedError=upstream_5xx", async () => {
  await withMockUpstream(
    (req, res) => sendJson(res, 503, { error: { message: "upstream down" } }),
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { writeLog: false });
      assert.equal(r.success, false);
      assert.equal(r.statusCode, 503);
      assert.equal(r.normalizedError, "upstream_5xx");
    },
  );
});

test("executeTestRequest：2xx 但空回复 → success=false（空回复归一）", async () => {
  await withMockUpstream(
    (req, res) => sendJson(res, 200, { choices: [{ message: { content: "" } }] }),
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { writeLog: false });
      assert.equal(r.success, false);
      assert.equal(r.responseText, "");
      assert.ok(r.normalizedError);
    },
  );
});

test("executeToolCallTestRequest：拿到 tool_call → success；缺失 → tool_call_missing", async () => {
  await withMockUpstream(
    (req, res) => sendJson(res, 200, { choices: [{ message: { tool_calls: [{ function: { name: "get_weather", arguments: "{}" } }] } }], usage: { prompt_tokens: 8, completion_tokens: 3 } }),
    async (baseUrl) => {
      const r = await executeToolCallTestRequest(await probeProfile(baseUrl), { writeLog: false });
      assert.equal(r.success, true);
      assert.equal(r.toolCall.name, "get_weather");
      assert.equal(r.responseText, "tool_call:get_weather");
      assert.equal(r.firstTokenMs, null); // 工具调用也是非流式
    },
  );

  await withMockUpstream(
    (req, res) => sendJson(res, 200, { choices: [{ message: { content: "no tool" } }] }),
    async (baseUrl) => {
      const r = await executeToolCallTestRequest(await probeProfile(baseUrl), { writeLog: false });
      assert.equal(r.success, false);
      assert.equal(r.normalizedError, "tool_call_missing");
    },
  );
});

test("executeStreamStructureTestRequest：流式 → 捕获真 TTFT（firstTokenMs 非空）+ streamValidation 落地", async () => {
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" } }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: { content: "!" }, finish_reason: "stop" }] })}`,
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n");
  await withMockUpstream(
    (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse);
    },
    async (baseUrl) => {
      const r = await executeStreamStructureTestRequest(await probeProfile(baseUrl), "hi", { writeLog: false });
      assert.equal(r.statusCode, 200);
      assert.notEqual(r.streamValidation, null); // 结构校验已执行
      assert.ok(Number.isInteger(r.firstTokenMs)); // 流式：捕获真 TTFT（对比非流式恒为 null）
    },
  );
});

test("auth_failed：profile 无可读 Key → success=false 且不发请求", async () => {
  const r = await executeTestRequest(
    { id: "no-key", name: "x", protocol: "openai", baseUrl: "http://127.0.0.1:9", defaultModel: "m", timeoutMs: 1000 },
    "hi",
    { writeLog: false },
  );
  assert.equal(r.success, false);
  assert.equal(r.normalizedError, "auth_failed");
  assert.equal(r.firstByteMs, null); // 未发请求
});
