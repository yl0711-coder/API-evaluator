// 回归（P2-2 / P2-3）：流式评测的完整性与体积上限。
// 不依赖真实上游——用构造的 SSE 原文喂真实决策函数，用 new Response 喂真实的读取上限函数。
import assert from "node:assert/strict";
import test from "node:test";
import { summarizeStreamStructure } from "../server/protocols.mjs";
import {
  streamCompletenessError,
  readBoundedResponseText,
  MAX_UPSTREAM_RESPONSE_BYTES,
  MAX_UPSTREAM_STREAM_RESPONSE_BYTES,
} from "../server/test-runner.mjs";

// —— 构造 SSE 原文 —— 每个事件之间必须空行分隔（SSE 规范），故各 frame 自带尾随 "\n"，join 再补 "\n"。
const sse = (frames) => frames.join("\n") + "\n\n";

// OpenAI 风格：每帧一个 data 行 + 尾随 "\n"
const oaFrame = (obj) => `data: ${JSON.stringify(obj)}\n`;
const oaDelta = (text) => oaFrame({ choices: [{ delta: { content: text } }] });
function oaStream({ done = true, errorFrame = false } = {}) {
  const parts = [oaDelta("你"), oaDelta("好")];
  if (errorFrame) parts.push(oaFrame({ error: { message: "上游中途报错" } }));
  if (done) parts.push("data: [DONE]\n");
  return sse(parts);
}

// Claude 风格
const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n`;
function claudeStream({ messageStop = true, contentStop = true } = {}) {
  const parts = [
    ev("message_start", {}),
    ev("content_block_start", { index: 0, content_block: { type: "text" } }),
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "你好" } }),
  ];
  if (contentStop) parts.push(ev("content_block_stop", { index: 0 }));
  parts.push(ev("message_delta", {}));
  if (messageStop) parts.push(ev("message_stop", {}));
  return sse(parts);
}

const decide = (protocol, raw) => streamCompletenessError(summarizeStreamStructure(protocol, raw));

// ——— P2-2：半截流 / error 帧必须判失败 ———

test("完整的健康流 → 判成功（不误伤）", () => {
  assert.equal(decide("openai_compatible", oaStream({ done: true })), "");
  assert.equal(decide("claude_messages", claudeStream({ messageStop: true })), "");
});

test("OpenAI 流缺 [DONE] 终止帧（半截流）→ stream_incomplete", () => {
  assert.equal(decide("openai_compatible", oaStream({ done: false })), "stream_incomplete");
});

test("Claude 流缺 message_stop（半截流）→ stream_incomplete", () => {
  assert.equal(decide("claude_messages", claudeStream({ messageStop: false })), "stream_incomplete");
});

test("Claude 流缺 content_block_stop（内容块未收尾）→ stream_incomplete", () => {
  assert.equal(decide("claude_messages", claudeStream({ contentStop: false })), "stream_incomplete");
});

test("流中途出现 error 帧 → stream_error（即便有 [DONE] 也不算成功）", () => {
  assert.equal(decide("openai_compatible", oaStream({ done: true, errorFrame: true })), "stream_error");
});

test("2xx 但零事件（空流）→ stream_incomplete", () => {
  assert.equal(decide("openai_compatible", ""), "stream_incomplete");
});

test("不因软信号误杀：完整流即使夹一个非 JSON 分片也仍判成功", () => {
  // invalid_json_chunk 是软信号（健康怪癖中转会有），不在致命集合里
  const raw = sse([oaDelta("你"), "data: <not-json>\n", oaDelta("好"), "data: [DONE]\n"]);
  const s = summarizeStreamStructure("openai_compatible", raw);
  assert.ok(s.issues.includes("invalid_json_chunk"), "该流确实带软信号");
  assert.equal(streamCompletenessError(s), "", "软信号不应判失败");
});

test("streamCompletenessError 对 null / passed 输入返回空", () => {
  assert.equal(streamCompletenessError(null), "");
  assert.equal(streamCompletenessError({ passed: true, issues: [] }), "");
});

// ——— P2-3：流式响应体积上限必须比非流式大 ———

test("流式字节上限显著大于非流式上限", () => {
  assert.equal(MAX_UPSTREAM_RESPONSE_BYTES, 2 * 1024 * 1024);
  assert.ok(MAX_UPSTREAM_STREAM_RESPONSE_BYTES > MAX_UPSTREAM_RESPONSE_BYTES);
  assert.ok(MAX_UPSTREAM_STREAM_RESPONSE_BYTES >= 8 * 1024 * 1024, "至少要能容下 5–7MB 的长流式响应");
});

test("同一份 3MB 响应：2MB 上限截断，流式上限不截断（P2-3 直接证据）", async () => {
  const bytes = 3 * 1024 * 1024;
  const big = "x".repeat(bytes);

  const truncated = await readBoundedResponseText(new Response(big), MAX_UPSTREAM_RESPONSE_BYTES, new AbortController());
  assert.equal(truncated.truncated, true, "2MB 上限下 3MB 响应应被截断（这正是长流式被误判 F 的根因）");

  const full = await readBoundedResponseText(new Response(big), MAX_UPSTREAM_STREAM_RESPONSE_BYTES, new AbortController());
  assert.equal(full.truncated, false, "流式上限下同一响应应完整读入");
  assert.equal(full.text.length, bytes);
});
