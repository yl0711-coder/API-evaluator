import assert from "node:assert/strict";
import test from "node:test";

import { buildLargeOutputStreamRequest, summarizeStreamStructure } from "../server/protocols.mjs";

// 构造 Claude SSE 原文的小工具
function sse(lines) {
  return lines.join("\n") + "\n\n";
}
const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`;

function healthyStream(blocks) {
  // blocks: [{ type, deltas: [{type, text|partial_json}] }]
  const parts = [ev("message_start", { type: "message_start" })];
  blocks.forEach((block, index) => {
    parts.push(ev("content_block_start", { type: "content_block_start", index, content_block: { type: block.type } }));
    for (const d of block.deltas) {
      parts.push(ev("content_block_delta", { type: "content_block_delta", index, delta: d }));
    }
    parts.push(ev("content_block_stop", { type: "content_block_stop", index }));
  });
  parts.push(ev("message_delta", { type: "message_delta" }));
  parts.push(ev("message_stop", { type: "message_stop" }));
  return sse(parts);
}

test("healthy multi-block stream passes with per-index tracking", () => {
  const raw = healthyStream([
    { type: "text", deltas: [{ type: "text_delta", text: "你好" }] },
    { type: "tool_use", deltas: [{ type: "input_json_delta", partial_json: '{"city":' }, { type: "input_json_delta", partial_json: '"北京"}' }] },
  ]);
  const s = summarizeStreamStructure("claude_messages", raw);
  assert.equal(s.passed, true);
  assert.equal(s.flags.blockCount, 2);
  assert.equal(s.flags.toolArgsLost, false);
  assert.equal(s.flags.deltaBlockMismatch, false);
  assert.equal(s.flags.contentBlockDropped, false);
});

test("root cause 1: delta on an index that never started → content_block_dropped", () => {
  const raw = sse([
    ev("message_start", { type: "message_start" }),
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text" } }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a" } }),
    // index 1 的 start 被丢了，直接来 delta
    ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "b" } }),
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ev("message_stop", { type: "message_stop" }),
  ]);
  const s = summarizeStreamStructure("claude_messages", raw);
  assert.equal(s.flags.contentBlockDropped, true);
  assert.equal(s.issues.includes("content_block_dropped"), true);
  assert.equal(s.passed, false);
});

test("root cause 2: text_delta landing on a tool_use block → delta_block_mismatch", () => {
  const raw = healthyStream([
    { type: "tool_use", deltas: [{ type: "text_delta", text: "oops" }] },
  ]);
  const s = summarizeStreamStructure("claude_messages", raw);
  assert.equal(s.flags.deltaBlockMismatch, true);
  assert.equal(s.issues.includes("delta_block_mismatch"), true);
});

test("root cause 3: tool_use input_json_delta that does not form valid JSON → tool_args_lost", () => {
  const raw = healthyStream([
    // partial_json 被截断，拼起来不是合法 JSON
    { type: "tool_use", deltas: [{ type: "input_json_delta", partial_json: '{"city":"北' }] },
  ]);
  const s = summarizeStreamStructure("claude_messages", raw);
  assert.equal(s.flags.toolArgsLost, true);
  assert.equal(s.issues.includes("tool_args_lost"), true);
});

test("valid tool_use json does not trigger tool_args_lost", () => {
  const raw = healthyStream([
    { type: "tool_use", deltas: [{ type: "input_json_delta", partial_json: "{}" }] },
  ]);
  const s = summarizeStreamStructure("claude_messages", raw);
  assert.equal(s.flags.toolArgsLost, false);
});

test("buildLargeOutputStreamRequest asks for >400 lines and streams", () => {
  const profile = { protocol: "claude_messages", baseUrl: "https://x.test", apiKey: "k", defaultModel: "claude-x", maxTokens: 1024 };
  const req = buildLargeOutputStreamRequest(profile, 450);
  assert.equal(req.body.stream, true);
  assert.match(req.body.messages[0].content, /450/);
  // 下限保护：即便传入过小值也至少 400
  const req2 = buildLargeOutputStreamRequest(profile, 10);
  assert.match(req2.body.messages[0].content, /400/);
});
