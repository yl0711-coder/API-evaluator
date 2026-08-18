import assert from "node:assert/strict";
import test from "node:test";

import { buildReplayRequest, normalizeReplayInput } from "../server/client-replay.mjs";

test("replay request uses selected profile base url and injects current Claude key", () => {
  const request = buildReplayRequest(
    {
      baseUrl: "https://api.example.com",
      protocol: "claude_messages",
      defaultModel: "claude-opus-4-7",
      maxTokens: 512,
    },
    {
      request: {
        url: "https://old.example.com/v1/messages?beta=true",
        headers: {
          "x-api-key": "old-secret",
          authorization: "Bearer old-secret",
          "anthropic-version": "2023-06-01",
          "x-danger": "drop-me",
        },
        body: {
          model: "claude-opus-4-7",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        },
      },
    },
    "new-secret",
  );

  assert.equal(request.url, "https://api.example.com/v1/messages");
  assert.equal(request.headers["x-api-key"], "new-secret");
  assert.equal(request.headers.authorization, undefined);
  assert.equal(request.headers["x-danger"], undefined);
  assert.equal(request.body.stream, true);
});

// 回归：回放的兜底路径此前独立硬编码 `/v1/chat/completions`，与 protocols.buildProtocolUrl 脱节。
// 于是 openai_path_prefix 渠道（baseUrl 已含 /api/paas/v4）被拼成 .../api/paas/v4/v1/chat/completions
// → 404，也就是测试主链路已修掉、却在回放链路原样复现的同一个双前缀 bug。
test("replay 兜底路径按协议推导，自定义前缀渠道不再补 /v1", () => {
  const glm = { baseUrl: "https://open.bigmodel.cn/api/paas/v4", protocol: "openai_path_prefix", defaultModel: "glm-4.6", maxTokens: 64 };
  // 无捕获 path（走兜底）
  assert.equal(buildReplayRequest(glm, {}).url, "https://open.bigmodel.cn/api/paas/v4/chat/completions");
  assert.equal(buildReplayRequest(glm, {}).headers.authorization, "Bearer [api-key]", "OpenAI 系鉴权头，不是 x-api-key");

  // 客户端日志里带了原始 path 时以它为准（回放要复现线上那次请求，不是重新推导）。
  // 关键：捕获的 path 是【从根算起】的完整 pathname，也含 /api/paas/v4——不能与 baseUrl 的
  // 前缀再相接一次，否则得到 /api/paas/v4/api/paas/v4/chat/completions。
  assert.equal(
    buildReplayRequest(glm, { request: { path: "/api/paas/v4/chat/completions" } }).url,
    "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  );
  // 整条 URL 形式同理（normalizeReplayPath 会取其 pathname）
  assert.equal(
    buildReplayRequest(glm, { request: { url: "https://old.example.com/api/paas/v4/chat/completions?x=1" } }).url,
    "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  );
  // path 不含该前缀时仍要把前缀补上（否则打到 origin 根上）
  assert.equal(
    buildReplayRequest(glm, { request: { path: "/chat/completions" } }).url,
    "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  );

  // 老渠道带网关前缀 + 捕获 path 也含该前缀：同样不得重复（本次重写不能改老行为）
  assert.equal(
    buildReplayRequest(
      { baseUrl: "https://api.example.com/gw", protocol: "openai_compatible", defaultModel: "m" },
      {
        request: { path: "/gw/v1/chat/completions" },
      },
    ).url,
    "https://api.example.com/gw/v1/chat/completions",
  );

  // 老协议兜底路径一字不变
  assert.equal(
    buildReplayRequest({ baseUrl: "https://api.example.com", protocol: "openai_compatible", defaultModel: "m" }, {}).url,
    "https://api.example.com/v1/chat/completions",
  );
  assert.equal(
    buildReplayRequest({ baseUrl: "https://api.example.com", protocol: "openai_chat", defaultModel: "m" }, {}).url,
    "https://api.example.com/v1/chat/completions",
  );
  assert.equal(
    buildReplayRequest({ baseUrl: "https://api.anthropic.com", protocol: "claude_messages", defaultModel: "m" }, {}).url,
    "https://api.anthropic.com/v1/messages",
  );
});

test("replay request injects bearer auth for OpenAI compatible profile", () => {
  const request = buildReplayRequest(
    {
      baseUrl: "https://api.example.com/",
      protocol: "openai_compatible",
      defaultModel: "gpt-4.1",
      maxTokens: 256,
    },
    {
      requestJson: JSON.stringify({
        path: "/v1/chat/completions",
        headers: { authorization: "Bearer old-secret" },
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
    },
    "new-openai-key",
  );

  assert.equal(request.url, "https://api.example.com/v1/chat/completions");
  assert.equal(request.headers.authorization, "Bearer new-openai-key");
  assert.equal(request.body.model, "gpt-4.1");
  assert.equal(request.body.max_tokens, 256);
});

test("normalize replay input accepts direct JSON request", () => {
  const input = normalizeReplayInput({
    requestJson: '{"path":"/v1/messages","body":{"model":"claude"}}',
  });

  assert.equal(input.path, "/v1/messages");
  assert.equal(input.body.model, "claude");
});
