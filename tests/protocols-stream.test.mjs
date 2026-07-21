import assert from "node:assert/strict";
import test from "node:test";

import { summarizeStreamStructure } from "../server/protocols.mjs";

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

// ── OpenAI 路径的结构校验 ───────────────────────────────────────────────
// 这两条守的是评测工具最不能犯的两类错：把健康中转判成坏的（假失败），把坏中转放行（假通过）。
// Claude 路径本就容忍保活帧、且会认 error 帧；OpenAI 路径此前两样都没有。

const okDelta = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
const done = "data: [DONE]\n\n";

test("OpenAI 流式：保活空帧不算解析失败——健康的流不得被判结构异常", () => {
  // 无 data 的帧有两种常见形态：只有 event 行的（`event: ping`），和空 `data:` 的。
  // 它们不是 JSON 分片，计入 invalid_json_chunk 会让健康中转被误报「SSE 结构坏了」。
  // 注：`: ping` 注释帧本就被 parseSseEvents 跳过，这里补的是另外两种。
  for (const [label, keepalive] of [
    ["event 行无 data", "event: ping\n\n"],
    ["空 data 行", "data:\n\n"],
  ]) {
    const s = summarizeStreamStructure("openai_compatible", keepalive + okDelta + done);
    assert.equal(s.passed, true, `${label} 的保活帧不该让健康流判失败，实际 issues=${s.issues.join(",")}`);
    assert.equal(s.flags.invalidJsonChunks, 0, `${label}：保活帧不是解析失败`);
    assert.equal(s.flags.delta, true);
    assert.equal(s.flags.done, true);
  }
});

test("OpenAI 流式：真正的非法 JSON 分片仍要被抓——容忍保活不等于放过坏数据", () => {
  const s = summarizeStreamStructure("openai_compatible", 'data: {"choices":[\n\n' + okDelta + done);
  assert.equal(s.flags.invalidJsonChunks, 1, "半截 JSON 仍应计为解析失败");
  assert.equal(s.issues.includes("invalid_json_chunk"), true);
  assert.equal(s.passed, false);
});

test("OpenAI 流式：中途 error 帧 → stream_error_event（放行等于给坏中转背书）", () => {
  // 上游吐了一半改口报错：delta 有、[DONE] 有，光看结构完整性会误判「通过」，
  // 但输出其实被截断了。Claude 路径一直有这道检查（stream_error_event），这里对齐。
  const raw = okDelta + 'data: {"error":{"message":"upstream disconnected","type":"server_error"}}\n\n' + done;
  const s = summarizeStreamStructure("openai_compatible", raw);
  assert.equal(s.issues.includes("stream_error_event"), true, "中途报错必须被记为问题");
  assert.equal(s.passed, false, "有 error 帧的流不得判通过");
});

test("OpenAI 流式：event: error 形态的错误帧同样被抓", () => {
  const raw = okDelta + 'event: error\ndata: {"message":"boom"}\n\n' + done;
  const s = summarizeStreamStructure("openai_compatible", raw);
  assert.equal(s.issues.includes("stream_error_event"), true);
  assert.equal(s.passed, false);
});

test("OpenAI 流式：error:null 的常规帧不算错误帧（不得误报）", () => {
  // 有中转会在每帧带 "error":null。把它当错误帧就会把健康流全判失败。
  const raw = 'data: {"error":null,"choices":[{"delta":{"content":"hi"}}]}\n\n' + done;
  const s = summarizeStreamStructure("openai_compatible", raw);
  assert.equal(s.issues.includes("stream_error_event"), false, "error:null 是空字段，不是错误帧");
  assert.equal(s.passed, true);
});

test("OpenAI 流式：健康的普通流仍然通过（防回归）", () => {
  const s = summarizeStreamStructure("openai_compatible", okDelta + done);
  assert.equal(s.passed, true);
  assert.deepEqual(s.issues, []);
});
