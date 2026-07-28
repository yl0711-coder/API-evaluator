// tests/protocols-coalesce.test.mjs
// coalesceSseResponse：上游无视 stream:false 直接回 SSE 时的兜底——把流式事件拼回「非流式响应」形状，
// 使 extractOutputText / extractUsage / extractToolCall / extractFinishReason 无需分流即可复用。
// 这里按 test-runner 的真实用法（coalesce → 四个 extractor）端到端断言，而非只看中间结构。
// 另覆盖 isStreamOptionsUnsupportedError：流式取 usage 的可选参数被中转拒收时的识别口径。
import assert from "node:assert/strict";
import test from "node:test";
import {
  coalesceSseResponse,
  extractFinishReason,
  extractOutputText,
  extractToolCall,
  extractUsage,
  firstTokenPatternFor,
  isStreamOptionsUnsupportedError,
  isTemperatureUnsupportedError,
} from "../server/protocols.mjs";

// SSE 载荷拼装：每个事件之间空行分隔（与真实 text/event-stream 一致）。
const sse = (...lines) => lines.join("\n");

test("OpenAI 流式：文本增量拼接 + 末尾 choices:[] 的 usage 被捕获", () => {
  const raw = sse(
    `data: {"choices":[{"delta":{"role":"assistant","content":"你好"},"finish_reason":null}]}`,
    ``,
    `data: {"choices":[{"delta":{"content":"世界"},"finish_reason":null}]}`,
    ``,
    `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
    ``,
    // include_usage 的最后一帧：choices 为空数组，usage 挂在顶层——必须在 choices 短路前取到。
    `data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}`,
    ``,
    `data: [DONE]`,
    ``,
  );
  const parsed = coalesceSseResponse("openai_compatible", raw);
  assert.equal(extractOutputText("openai_compatible", parsed), "你好世界");
  assert.equal(extractFinishReason("openai_compatible", parsed), "stop");
  const usage = extractUsage(parsed);
  assert.equal(usage.inputTokens, 10);
  assert.equal(usage.outputTokens, 5);
});

test("OpenAI 流式：tool_call 的 arguments 分片按 index 拼回完整 JSON 字符串", () => {
  const raw = sse(
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"ci"}}]},"finish_reason":null}]}`,
    ``,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"北京\\"}"}}]},"finish_reason":null}]}`,
    ``,
    `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
    ``,
    `data: [DONE]`,
    ``,
  );
  const parsed = coalesceSseResponse("openai_compatible", raw);
  const call = extractToolCall("openai_compatible", parsed);
  assert.equal(call.name, "get_weather");
  // 非流式响应里 arguments 同样是 JSON 字符串，形状必须一致。
  assert.equal(call.arguments, '{"city":"北京"}');
  assert.equal(extractFinishReason("openai_compatible", parsed), "tool_calls");
});

test("Claude 流式：文本增量拼接；usage 由 message_delta 覆盖 message_start", () => {
  const raw = sse(
    `event: message_start`,
    `data: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}`,
    ``,
    `event: content_block_start`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
    ``,
    `event: content_block_delta`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}`,
    ``,
    `event: content_block_delta`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"世界"}}`,
    ``,
    `event: message_delta`,
    `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}`,
    ``,
    `event: message_stop`,
    `data: {"type":"message_stop"}`,
    ``,
  );
  const parsed = coalesceSseResponse("claude_messages", raw);
  assert.equal(extractOutputText("claude_messages", parsed), "你好世界");
  assert.equal(extractFinishReason("claude_messages", parsed), "end_turn");
  const usage = extractUsage(parsed);
  assert.equal(usage.inputTokens, 12, "input 来自 message_start，不能被 message_delta 抹掉");
  assert.equal(usage.outputTokens, 7, "output 以 message_delta 的终值为准");
});

test("Claude 流式：thinking 块不计入可见文本（与非流式 content 口径一致）", () => {
  const raw = sse(
    `event: message_start`,
    `data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}`,
    ``,
    `event: content_block_start`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}`,
    ``,
    `event: content_block_delta`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"内部推理"}}`,
    ``,
    `event: content_block_start`,
    `data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`,
    ``,
    `event: content_block_delta`,
    `data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"最终答案"}}`,
    ``,
    `event: message_stop`,
    `data: {"type":"message_stop"}`,
    ``,
  );
  const parsed = coalesceSseResponse("claude_messages", raw);
  assert.equal(extractOutputText("claude_messages", parsed), "最终答案", "思考内容绝不能混进可见输出");
});

test("Claude 流式：tool_use 的 input_json_delta 分片拼回对象", () => {
  const raw = sse(
    `event: message_start`,
    `data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}`,
    ``,
    `event: content_block_start`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"get_weather"}}`,
    ``,
    `event: content_block_delta`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}`,
    ``,
    `event: content_block_delta`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"北京\\"}"}}`,
    ``,
    `event: message_stop`,
    `data: {"type":"message_stop"}`,
    ``,
  );
  const parsed = coalesceSseResponse("claude_messages", raw);
  assert.deepEqual(extractToolCall("claude_messages", parsed), { name: "get_weather", arguments: { city: "北京" } });
});

test("Claude 流式：tool_use 参数被截断 → input 退回空对象，不抛错", () => {
  const raw = sse(
    `event: content_block_start`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"get_weather"}}`,
    ``,
    `event: content_block_delta`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"北"}}`,
    ``,
  );
  const parsed = coalesceSseResponse("claude_messages", raw);
  assert.deepEqual(extractToolCall("claude_messages", parsed), { name: "get_weather", arguments: {} });
});

test("Claude 流式：delta 落在从未 start 的 index（content_block_dropped）仍能收到文本", () => {
  // 大输出时中转丢 content_block_start 是已知故障；兜底不应连文本一起丢。
  const raw = sse(
    `event: content_block_delta`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"孤儿增量"}}`,
    ``,
  );
  const parsed = coalesceSseResponse("claude_messages", raw);
  assert.equal(extractOutputText("claude_messages", parsed), "孤儿增量");
});

test("非 SSE 输入 → null，交回上层按原逻辑判错（不得误吞成空回复）", () => {
  for (const protocol of ["openai_compatible", "claude_messages"]) {
    assert.equal(coalesceSseResponse(protocol, ""), null, "空串");
    assert.equal(coalesceSseResponse(protocol, "Internal Server Error"), null, "纯文本错误体");
    assert.equal(coalesceSseResponse(protocol, `{"error":{"message":"model not found"}}`), null, "JSON 错误体");
  }
});

test("SSE 只有 [DONE] → 拼出空文本（上层据此判 empty_response）", () => {
  const parsed = coalesceSseResponse("openai_compatible", "data: [DONE]\n\n");
  assert.ok(parsed, "识别为 SSE，不是 null");
  assert.equal(extractOutputText("openai_compatible", parsed), "");
});

// —— TTFT 打点口径：必须命中「首个可见输出 token」，而非任意首帧 ——
// 否则 Claude 的 message_start / 中转保活帧会让 TTFT 系统性偏快，且与 OpenAI 口径不对等。
test("firstTokenPatternFor(claude)：只认 text_delta / input_json_delta", () => {
  const re = firstTokenPatternFor("claude_messages");
  // 不该命中的无内容首帧
  assert.equal(re.test(`data: {"type":"message_start","message":{"usage":{"input_tokens":12}}}`), false, "message_start 不是 token");
  assert.equal(
    re.test(`data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`),
    false,
    "block start 无文本",
  );
  assert.equal(re.test(`data: {"type":"ping"}`), false, "保活帧");
  assert.equal(re.test(`: ping`), false, "SSE 注释保活");
  assert.equal(
    re.test(`data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"想"}}`),
    false,
    "thinking 不进可见输出",
  );
  // 该命中的首个可见产出
  assert.equal(re.test(`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}`), true);
  assert.equal(re.test(`data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{"}}`), true);
});

test("firstTokenPatternFor(openai)：只认非空 content / tool_calls", () => {
  const re = firstTokenPatternFor("openai_compatible");
  // 不该命中的无内容首帧
  assert.equal(re.test(`data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}`), false, "角色帧无内容");
  assert.equal(re.test(`data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}`), false, "空串 content");
  assert.equal(re.test(`data: {"choices":[{"delta":{"content":null},"finish_reason":null}]}`), false, "content 为 null");
  assert.equal(re.test(`: keep-alive`), false, "SSE 注释保活");
  assert.equal(re.test(`data: {"choices":[{"delta":{"reasoning_content":"想"}}]}`), false, "reasoning_content 不得误命中 content");
  // 该命中的首个可见产出
  assert.equal(re.test(`data: {"choices":[{"delta":{"content":"你"},"finish_reason":null}]}`), true);
  assert.equal(re.test(`data: {"choices":[{"delta":{"content":"\\u4f60"},"finish_reason":null}]}`), true, "转义字符也算内容");
  assert.equal(re.test(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1"}]}}]}`), true);
});

test("firstTokenPatternFor：正则无 /g，重复 test 结果稳定（不受 lastIndex 影响）", () => {
  for (const protocol of ["claude_messages", "openai_compatible"]) {
    const re = firstTokenPatternFor(protocol);
    const hit = protocol === "claude_messages" ? `{"delta":{"type":"text_delta","text":"a"}}` : `{"delta":{"content":"a"}}`;
    assert.equal(re.test(hit), true, `${protocol} 首次`);
    assert.equal(re.test(hit), true, `${protocol} 重复调用必须仍为 true`);
  }
});

test("isStreamOptionsUnsupportedError：点名 stream_options 且含拒收词才认", () => {
  const yes = [
    "Unrecognized request argument supplied: stream_options",
    "Unknown parameter: 'stream_options'",
    "stream_options is not supported with this model",
    `{"error":{"message":"Unsupported parameter: stream_options"}}`,
    "stream_options: Extra inputs are not permitted",
  ];
  for (const raw of yes) assert.equal(isStreamOptionsUnsupportedError(raw), true, raw);

  const no = [
    "", // 空
    "rate limit exceeded", // 无关 400/429
    `{"error":{"message":"model not found"}}`, // 无关错误
    "temperature does not support 0.2 with this model", // 是 temperature 的锅，别抢
    "stream_options accepted", // 点名了但不是拒收
  ];
  for (const raw of no) assert.equal(isStreamOptionsUnsupportedError(raw), false, raw);
});

// ── 回显请求体不得被当成「上游点名拒收该参数」 ──────────────────────────
// 上游报 400 时经常把我方请求体原样回显（不少中转带 request 字段，LiteLLM 直接 dump kwargs）。
// 一旦误判，模型会被永久加进进程级摘参名单（test-runner 的 *_UNSUPPORTED_MODELS，重启才清），
// 此后静默丢 usage / 丢 temperature——报告数字变错却毫无提示。
// 定级取向：宁可漏判也不能误判。漏判只是这次请求照旧 400（用户看得见真实报错），误判是静默的永久污染。

test("isStreamOptionsUnsupportedError：无关 400 回显了请求体 → 不得误判（invalid_request_error 不是拒收 stream_options）", () => {
  const echoed = [
    // 错的是 max_tokens，stream_options 只是躺在回显的请求体里。
    `{"error":{"message":"max_tokens is too large: 512","type":"invalid_request_error","param":"max_tokens"},"request":{"model":"gpt-x","stream":true,"stream_options":{"include_usage":true}}}`,
    // LiteLLM 风格：错的是 tools schema，kwargs 里带着 stream_options。
    `litellm.BadRequestError: OpenAIException - Invalid schema for function 'get_weather'. Received request kwargs: {'model':'x','temperature':0.2,'stream_options':{'include_usage':True}}`,
  ];
  for (const raw of echoed) assert.equal(isStreamOptionsUnsupportedError(raw), false, raw);
});

test("isTemperatureUnsupportedError：错的是别的参数、temperature 只在回显里 → 不得误判", () => {
  // 真正被拒的是 stream_options；temperature 只是躺在回显的请求体里。
  // test-runner 里 temperature 分支排在 stream_options 之前，误判会稳定获胜、把锅甩给 temperature。
  const raw = `{"error":{"message":"Unsupported parameter: 'stream_options' is not supported with this model.","type":"invalid_request_error"},"request":{"model":"gpt-x","temperature":0.2,"stream":true,"stream_options":{"include_usage":true}}}`;
  assert.equal(isTemperatureUnsupportedError(raw), false, "temperature 只出现在回显请求体里，不能算被拒");
  assert.equal(isStreamOptionsUnsupportedError(raw), true, "真正被点名的 stream_options 仍要认出来");
});

test("isTemperatureUnsupportedError：真被拒时仍要认出来（防止修过头）", () => {
  const yes = [
    // OpenAI 推理 / GPT-5 系的真实措辞
    "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.",
    "'temperature' is not supported with this model",
    `{"error":{"message":"Unsupported parameter: 'temperature'","type":"invalid_request_error"}}`,
    // 注：temperature 的拒收词表刻意窄于 stream_options（不含 pydantic 的 "Extra inputs are not permitted"）。
    // temperature 是 OpenAI 标准字段，不会被 pydantic 当额外字段拒；词表越宽误判面越大，故不扩。
  ];
  for (const raw of yes) assert.equal(isTemperatureUnsupportedError(raw), true, raw);

  const no = [
    "",
    "rate limit exceeded",
    `{"error":{"message":"model not found"}}`,
    "temperature accepted", // 点名了但不是拒收
  ];
  for (const raw of no) assert.equal(isTemperatureUnsupportedError(raw), false, raw);
});
