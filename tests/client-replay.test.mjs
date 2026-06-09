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
