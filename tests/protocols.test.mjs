import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProtocolRequest,
  buildProtocolStreamRequest,
  buildProtocolToolRequest,
  extractOutputText,
  extractToolCall,
  extractUsage,
  normalizeEmptyResponse,
  normalizeHttpError,
  summarizeStreamStructure,
} from "../server/protocols.mjs";

test("builds OpenAI-compatible chat completion requests", () => {
  const request = buildProtocolRequest(
    {
      baseUrl: "https://api.example.com/",
      apiKey: "sk-test",
      protocol: "openai_compatible",
      defaultModel: "gpt-test",
      maxTokens: 256,
    },
    "hello",
  );

  assert.equal(request.url, "https://api.example.com/v1/chat/completions");
  assert.equal(request.headers.authorization, "Bearer sk-test");
  assert.equal(request.body.model, "gpt-test");
  assert.equal(request.body.messages[0].content, "hello");
  assert.equal(request.body.stream, false);
});

test("builds Claude Messages requests", () => {
  const request = buildProtocolRequest(
    {
      baseUrl: "https://api.example.com",
      apiKey: "sk-claude",
      protocol: "claude_messages",
      defaultModel: "claude-test",
      maxTokens: 512,
    },
    "hello claude",
  );

  assert.equal(request.url, "https://api.example.com/v1/messages");
  assert.equal(request.headers["x-api-key"], "sk-claude");
  assert.equal(request.headers["anthropic-version"], "2023-06-01");
  assert.equal(request.body.messages[0].content, "hello claude");
});

test("builds tool call requests for OpenAI-compatible and Claude Messages protocols", () => {
  const openaiRequest = buildProtocolToolRequest({
    baseUrl: "https://api.example.com/",
    apiKey: "sk-test",
    protocol: "openai_compatible",
    defaultModel: "gpt-test",
    maxTokens: 256,
  });
  assert.equal(openaiRequest.url, "https://api.example.com/v1/chat/completions");
  assert.equal(openaiRequest.body.tools[0].type, "function");
  assert.equal(openaiRequest.body.tool_choice.function.name, "get_weather");

  const claudeRequest = buildProtocolToolRequest({
    baseUrl: "https://api.example.com",
    apiKey: "sk-claude",
    protocol: "claude_messages",
    defaultModel: "claude-test",
    maxTokens: 512,
  });
  assert.equal(claudeRequest.url, "https://api.example.com/v1/messages");
  assert.equal(claudeRequest.headers["x-api-key"], "sk-claude");
  assert.equal(claudeRequest.body.tools[0].input_schema.type, "object");
  assert.equal(claudeRequest.body.tool_choice.name, "get_weather");
});

test("builds stream requests for OpenAI-compatible and Claude Messages protocols", () => {
  const openaiRequest = buildProtocolStreamRequest(
    {
      baseUrl: "https://api.example.com/",
      apiKey: "sk-test",
      protocol: "openai_compatible",
      defaultModel: "gpt-test",
      maxTokens: 128,
    },
    "stream hello",
  );
  assert.equal(openaiRequest.url, "https://api.example.com/v1/chat/completions");
  assert.equal(openaiRequest.body.stream, true);
  assert.equal(openaiRequest.body.messages[0].content, "stream hello");

  const claudeRequest = buildProtocolStreamRequest(
    {
      baseUrl: "https://api.example.com",
      apiKey: "sk-claude",
      protocol: "claude_messages",
      defaultModel: "claude-test",
      maxTokens: 128,
    },
    "stream claude",
  );
  assert.equal(claudeRequest.url, "https://api.example.com/v1/messages");
  assert.equal(claudeRequest.body.stream, true);
  assert.equal(claudeRequest.headers["x-api-key"], "sk-claude");
});

test("validates OpenAI-compatible stream structure", () => {
  const raw = [
    'data: {"choices":[{"delta":{"content":"hello"}}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const summary = summarizeStreamStructure("openai_compatible", raw);
  assert.equal(summary.passed, true);
  assert.equal(summary.flags.delta, true);
  assert.equal(summary.flags.done, true);
});

test("validates Claude Messages stream structure", () => {
  const raw = [
    "event: message_start",
    'data: {"type":"message_start"}',
    "",
    "event: content_block_start",
    'data: {"type":"content_block_start"}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
    "",
    "event: content_block_stop",
    'data: {"type":"content_block_stop"}',
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
    "",
  ].join("\n");
  const summary = summarizeStreamStructure("claude_messages", raw);
  assert.equal(summary.passed, true);
  assert.equal(summary.flags.contentBlockStart, true);
  assert.equal(summary.flags.messageStop, true);
});

test("detects missing Claude content block start", () => {
  const raw = [
    "event: message_start",
    'data: {"type":"message_start"}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
    "",
  ].join("\n");
  const summary = summarizeStreamStructure("claude_messages", raw);
  assert.equal(summary.passed, false);
  assert.equal(summary.issues.includes("missing_content_block_start"), true);
  assert.equal(summary.issues.includes("event_order_invalid"), true);
});

test("extracts output text and usage from common response formats", () => {
  assert.equal(
    extractOutputText("openai_compatible", {
      choices: [{ message: { content: "OpenAI text" } }],
    }),
    "OpenAI text",
  );
  assert.equal(
    extractOutputText("claude_messages", {
      content: [{ type: "text", text: "Claude text" }],
    }),
    "Claude text",
  );
  assert.deepEqual(extractUsage({ usage: { prompt_tokens: 12, completion_tokens: 7 } }), {
    inputTokens: 12,
    outputTokens: 7,
    cacheCreationTokens: null,
    cacheReadTokens: null,
    reasoningTokens: null,
  });
});

test("extractUsage captures Anthropic cache fields", () => {
  assert.deepEqual(
    extractUsage({
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 70,
      },
    }),
    {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 30,
      cacheReadTokens: 70,
      reasoningTokens: null,
    },
  );
});

test("extractUsage captures OpenAI detail fields (cached + reasoning)", () => {
  assert.deepEqual(
    extractUsage({
      usage: {
        prompt_tokens: 200,
        completion_tokens: 80,
        prompt_tokens_details: { cached_tokens: 120 },
        completion_tokens_details: { reasoning_tokens: 40 },
      },
    }),
    {
      inputTokens: 200,
      outputTokens: 80,
      cacheCreationTokens: null,
      cacheReadTokens: 120,
      reasoningTokens: 40,
    },
  );
});

test("extractUsage returns null when usage is absent", () => {
  assert.equal(extractUsage({ choices: [] }), null);
  assert.equal(extractUsage(null), null);
});

test("extracts tool call structures from common response formats", () => {
  assert.deepEqual(
    extractToolCall("openai_compatible", {
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "get_weather",
                  arguments: "{\"city\":\"北京\"}",
                },
              },
            ],
          },
        },
      ],
    }),
    {
      name: "get_weather",
      arguments: "{\"city\":\"北京\"}",
    },
  );
  assert.deepEqual(
    extractToolCall("claude_messages", {
      content: [
        {
          type: "tool_use",
          name: "get_weather",
          input: { city: "北京" },
        },
      ],
    }),
    {
      name: "get_weather",
      arguments: { city: "北京" },
    },
  );
});

test("normalizes common upstream errors", () => {
  assert.equal(normalizeHttpError(401, "bad key"), "auth_failed");
  assert.equal(normalizeHttpError(404, "model not found"), "model_not_found");
  assert.equal(normalizeHttpError(429, "too many requests"), "rate_limited");
  assert.equal(normalizeHttpError(502, "bad gateway"), "upstream_5xx");
  assert.equal(normalizeHttpError(200, "Content block not found"), "content_block_not_found");
  assert.equal(normalizeEmptyResponse("unknown model"), "model_not_found");
  assert.equal(normalizeEmptyResponse(""), "empty_response");
});
