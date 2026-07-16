import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("executeTestRequest：模型拒绝自定义 temperature（400）→ 去掉后重试成功，且同模型后续首发即不带", async () => {
  // 模拟 OpenAI 推理 / GPT-5 系模型：带 temperature 一律 400，去掉后正常返回。
  let temperatureRejections = 0; // 携带 temperature 被拒的次数
  await withMockUpstream(
    (req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch {
          json = null;
        }
        const hasTemperature = json && Object.prototype.hasOwnProperty.call(json, "temperature");
        if (hasTemperature) {
          temperatureRejections += 1;
          sendJson(res, 400, {
            error: {
              message: "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.",
              param: "temperature",
              code: "unsupported_value",
            },
          });
        } else {
          sendJson(res, 200, { choices: [{ message: { content: "工作正常。" } }], usage: { prompt_tokens: 4, completion_tokens: 2 } });
        }
      });
    },
    async (baseUrl) => {
      // 用固定 model/baseUrl 保证两次调用命中同一 memo key。
      const profile = await probeProfile(baseUrl, { defaultModel: "gpt-5-temp-test" });
      const first = await executeTestRequest(profile, "hi", { writeLog: false });
      assert.equal(first.success, true, "去掉 temperature 后应重试成功");
      assert.equal(first.responseText, "工作正常。");
      assert.equal(first.statusCode, 200);
      assert.ok(first.attempts >= 2, "首次应经历一次去 temperature 的重试");
      assert.equal(temperatureRejections, 1, "只应有一次携带 temperature 被拒");

      // 第二次同模型：memo 生效，首发即不带 temperature，无额外拒绝、单次成功。
      const second = await executeTestRequest(profile, "hi", { writeLog: false });
      assert.equal(second.success, true);
      assert.equal(second.attempts, 1, "同模型后续应首发成功、不再多一次往返");
      assert.equal(temperatureRejections, 1, "后续请求不应再携带 temperature 被拒");
    },
  );
});

// 与 temperature 同一故障类：中转不认我方可选参数 → 400。stream_options 只用来取 usage，
// 拒收时必须摘掉重试，否则「勾了流式」的场景题会被误判失败、压测整轮 0% 成功率。
test("executeTestRequest(stream)：中转不认 stream_options（400）→ 摘掉后重试成功，同模型后续首发即不带", async () => {
  let rejections = 0; // 携带 stream_options 被拒的次数
  const sse = [`data: ${JSON.stringify({ choices: [{ delta: { content: "在的" }, finish_reason: "stop" }] })}`, "", "data: [DONE]", "", ""].join("\n");
  await withMockUpstream(
    (req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch {
          json = null;
        }
        if (json && Object.prototype.hasOwnProperty.call(json, "stream_options")) {
          rejections += 1;
          sendJson(res, 400, { error: { message: "Unrecognized request argument supplied: stream_options", type: "invalid_request_error" } });
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse);
      });
    },
    async (baseUrl) => {
      const profile = await probeProfile(baseUrl, { defaultModel: "relay-no-stream-options" });
      const first = await executeTestRequest(profile, "hi", { writeLog: false, stream: true });
      assert.equal(first.success, true, "摘掉 stream_options 后应重试成功，而不是判 invalid_response");
      assert.equal(first.responseText, "在的", "SSE 经 coalesce 拼回文本");
      assert.ok(first.attempts >= 2, "首次应经历一次摘参重试");
      assert.equal(rejections, 1, "只应有一次携带 stream_options 被拒");

      const second = await executeTestRequest(profile, "hi", { writeLog: false, stream: true });
      assert.equal(second.success, true);
      assert.equal(second.attempts, 1, "memo 生效：同模型后续首发即不带，省掉注定失败的往返");
      assert.equal(rejections, 1, "后续请求不应再携带 stream_options 被拒");
    },
  );
});

// 压测走 noRetry（避免重试吞掉 429/5xx 这些正要测的负载信号）。但「摘掉上游不认的可选参数」
// 是修我方请求体、零退避，不是负载信号——必须放行，否则压测首批请求全部白白判失败。
test("executeTestRequest(stream + noRetry)：压测模式下仍放行确定性摘参重试", async () => {
  const sse = [`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}`, "", "data: [DONE]", "", ""].join("\n");
  await withMockUpstream(
    (req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch {
          json = null;
        }
        if (json && Object.prototype.hasOwnProperty.call(json, "stream_options")) {
          sendJson(res, 400, { error: { message: "Unknown parameter: 'stream_options'" } });
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse);
      });
    },
    async (baseUrl) => {
      const profile = await probeProfile(baseUrl, { defaultModel: "relay-noretry-stream-options" });
      const r = await executeTestRequest(profile, "hi", { writeLog: false, stream: true, noRetry: true });
      assert.equal(r.success, true, "noRetry 不应挡住确定性摘参重试");
      assert.equal(r.responseText, "ok");
    },
  );
});

// 反向保险：noRetry 的本职（不吞负载信号）不能被上面的例外破坏。
test("executeTestRequest(noRetry)：5xx 仍只测一次，不重试（负载信号不得被吞）", async () => {
  let hits = 0;
  await withMockUpstream(
    (req, res) => {
      hits += 1;
      sendJson(res, 503, { error: { message: "overloaded" } });
    },
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { writeLog: false, noRetry: true });
      assert.equal(r.success, false);
      assert.equal(r.normalizedError, "upstream_5xx");
      assert.equal(hits, 1, "5xx 是要测的负载信号，noRetry 下必须只打一次");
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

// keepRawResponse（「在报告中完整显示返回」）：rawError 在采集处就被 summarizeText 砍到 500 字并压平换行，
// 而空响应/流式异常恰恰只能靠完整响应体排查。用真实遇到过的形状复现：一串空 delta + 末尾 usage 帧。
const emptyDeltaSse = [
  ...Array.from({ length: 40 }, (_, i) =>
    `data: ${JSON.stringify({ id: `msg_${i}`, object: "chat.completion.chunk", choices: [{ delta: { content: "", role: "assistant" }, index: i }], usage: null })}\n`,
  ),
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 143, completion_tokens: 0 } })}\n`,
  "data: [DONE]\n",
].join("\n");

test("keepRawResponse：空响应时保留未截断的原始响应体；不开启则不留", async () => {
  assert.ok(emptyDeltaSse.length > 500, "样本须长过 summarizeText 上限，否则测不出截断");
  await withMockUpstream(
    (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(emptyDeltaSse);
    },
    async (baseUrl) => {
      const profile = await probeProfile(baseUrl);
      const on = await executeTestRequest(profile, "hi", { writeLog: false, stream: true, keepRawResponse: true });
      assert.equal(on.success, false);
      assert.equal(on.normalizedError, "empty_response");
      assert.equal(on.rawError.length, 500, "rawError 仍是截断摘要（日志用）");
      assert.match(on.rawResponse, /"completion_tokens":0/, "完整体必须含流尾部的 usage");
      assert.match(on.rawResponse, /data: \[DONE\]/, "完整体未被截断");
      assert.ok(on.rawResponse.length > on.rawError.length);

      // 默认不开：不额外占内存/不进 result.json
      const off = await executeTestRequest(profile, "hi", { writeLog: false, stream: true });
      assert.equal(off.rawResponse, "");
      assert.equal(off.rawError.length, 500, "摘要行为不受影响");
    },
  );
});

test("keepRawResponse：成功时不留原始体（responseText 已是全文）；且完整体绝不进 requests.jsonl", async () => {
  await withMockUpstream(
    (req, res) => sendJson(res, 200, { choices: [{ message: { content: "答案是 121626。" } }] }),
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { writeLog: false, keepRawResponse: true });
      assert.equal(r.success, true);
      assert.equal(r.rawResponse, "", "有文本就不必留原始体");
    },
  );

  // 日志侧：完整体与回答全文一样，只随记录进报告，不得写进 requests.jsonl（否则日志被响应体撑爆）。
  const src = await readFile(new URL("../server/test-runner.mjs", import.meta.url), "utf8");
  const logBlock = src.slice(src.indexOf("if (options.writeLog !== false)"), src.indexOf("return record;"));
  assert.match(logBlock, /delete logRecord\.rawResponse/);
});

// stream 字段取自真正发出的请求体，不取调用方声明——诊断时不必再拿 firstTokenMs 反推
// （流式但没吐出可见 token 时它也是 null，反推会误判成非流式，正是踩过的坑）。
test("记录如实标明 stream：流式/非流式各自落值，且与 firstTokenMs 解耦", async () => {
  await withMockUpstream(
    (req, res) => sendJson(res, 200, { choices: [{ message: { content: "ok" } }] }),
    async (baseUrl) => {
      const profile = await probeProfile(baseUrl);
      const plain = await executeTestRequest(profile, "hi", { writeLog: false });
      assert.equal(plain.stream, false);
      assert.equal(plain.firstTokenMs, null);
    },
  );
  // 流式但一个可见 token 都没吐 → firstTokenMs 仍是 null，stream 必须照样为 true
  await withMockUpstream(
    (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(emptyDeltaSse);
    },
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { writeLog: false, stream: true });
      assert.equal(r.stream, true, "这正是 firstTokenMs 反推法失灵的情形");
      assert.equal(r.firstTokenMs, null, "无可见 token → 不给假 TTFT");
      assert.equal(r.normalizedError, "empty_response");
    },
  );
});

test("断流：保留断开前已收到的半截响应体并标记不完整；错误归类不变", async () => {
  // 复现 terminated UND_ERR_SOCKET：发一半 SSE 就把 socket 掐了。
  await withMockUpstream(
    (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "半截" } }] })}\n\n`);
      res.write("data: {\"choices\":[{\"delta\":{\"content\":\"就断\"");
      setTimeout(() => res.destroy(), 20); // 不 end，直接掐断
    },
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", {
        writeLog: false,
        stream: true,
        keepRawResponse: true,
        noRetry: true,
      });
      assert.equal(r.success, false);
      assert.equal(r.normalizedError, "network_error", "错误归类不因保留残体而改变");
      assert.match(r.rawResponse, /半截/, "断开前收到的内容必须留下——这常是唯一证据");
      assert.equal(r.rawResponsePartial, true, "必须标记为残体，不能冒充完整响应");
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

// —— 端到端接线（P2-2 / P2-3）：证明 executeTestRequest 真的调用了流式完整性校验与放大后的字节上限，
//    而不只是「辅助函数单测通过」。用本地 mock 上游返回真实 SSE。 ——
const sendSse = (res, body) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(body);
};
const oaFrame = (obj) => `data: ${JSON.stringify(obj)}\n`;
const oaDelta = (text) => oaFrame({ choices: [{ delta: { content: text } }] });
const joinSse = (frames) => frames.join("\n") + "\n\n";

test("流式接线：完整 SSE（含 [DONE]）→ success，且 streamValidation 被填充（P2-2）", async () => {
  await withMockUpstream(
    (req, res) => sendSse(res, joinSse([oaDelta("你"), oaDelta("好"), "data: [DONE]\n"])),
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { stream: true, writeLog: false });
      assert.equal(r.success, true);
      assert.equal(r.responseText, "你好");
      assert.ok(r.streamValidation, "流式路必须产出 streamValidation（此前场景/压测路为 null）");
      assert.equal(r.streamValidation.passed, true);
    },
  );
});

test("流式接线：半截流（无 [DONE]）→ success=false, stream_incomplete（P2-2 核心回归）", async () => {
  await withMockUpstream(
    (req, res) => sendSse(res, joinSse([oaDelta("你"), oaDelta("好")])), // 干净断流，缺终止帧
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { stream: true, writeLog: false });
      assert.equal(r.success, false, "半截流即便拼出了文本也不能判成功");
      assert.equal(r.normalizedError, "stream_incomplete");
    },
  );
});

test("流式接线：中途 error 帧 → success=false, stream_error（P2-2）", async () => {
  await withMockUpstream(
    (req, res) => sendSse(res, joinSse([oaDelta("你"), oaFrame({ error: { message: "上游中途报错" } }), "data: [DONE]\n"])),
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { stream: true, writeLog: false });
      assert.equal(r.success, false);
      assert.equal(r.normalizedError, "stream_error");
    },
  );
});

test("字节上限接线：非流式 >2MB → response_too_large；流式同尺寸完整流 → 不截断、判成功（P2-3）", async () => {
  const bigText = "x".repeat(3 * 1024 * 1024); // 3MB，超非流式 2MB 上限、在流式 24MB 上限内

  // 非流式：3MB JSON body → 被 2MB 上限截断
  await withMockUpstream(
    (req, res) => sendJson(res, 200, { choices: [{ message: { content: bigText } }] }),
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { writeLog: false });
      assert.equal(r.normalizedError, "response_too_large", "非流式 3MB 应触发 2MB 上限");
      assert.equal(r.success, false);
    },
  );

  // 流式：同样 3MB 的完整流 → 放大上限放行，判成功（旧代码会在 2MB 处误判 F）
  await withMockUpstream(
    (req, res) => {
      const frames = [];
      // 拆成多帧 delta，凑够 3MB，最后带 [DONE]
      const chunk = "x".repeat(64 * 1024);
      for (let i = 0; i < 48; i += 1) frames.push(oaDelta(chunk)); // 48 * 64KB ≈ 3MB
      frames.push("data: [DONE]\n");
      sendSse(res, joinSse(frames));
    },
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { stream: true, writeLog: false });
      assert.notEqual(r.normalizedError, "response_too_large", "流式 3MB 不应被截断");
      assert.equal(r.success, true, "健康的长流式响应应判成功，而非误判 F");
    },
  );
});
