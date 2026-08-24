import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { buildApiKeyRef, saveProfileApiKey } from "../server/secret-store.mjs";
import { executeTestRequest, executeToolCallTestRequest } from "../server/test-runner.mjs";

// runUpstreamProbe 的退避重试骨架：429 / 5xx / 瞬时网络错误重试，超时与用户取消止损不重试。
// 限流型中转最常见的失败就是 429——重试是它唯一的补救，却此前只有 normalizeHttpError(429) 这类
// 纯函数单测在守，整条「发出去→被拒→退避→再发」的链路无人锁定。这里用本地 mock 上游端到端测。
// 全程 127.0.0.1：关掉私网出站拦截即可放行本地，无 DNS、无外网，保持确定性。
process.env.EVALUATOR_SECRET_STORE = "memory";
process.env.EVALUATOR_EGRESS_DENY_PRIVATE = "false";

// 与产品代码保持同源的常量（server/test-runner.mjs 内未导出，此处按契约固化）：
// 最多 3 次尝试（含首次），退避基数 600ms。
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 600;

async function withMockUpstream(responder, run) {
  const server = createServer(responder);
  // 被中止/超时的请求会留下半开连接，close() 会一直等它们；显式记账并在收尾时销毁，
  // 否则测试进程在 Windows 上会挂住不退出。
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function probeProfile(baseUrl, over = {}) {
  await saveProfileApiKey("retry-test", "sk-mock");
  return {
    id: "retry-test",
    name: "Mock",
    protocol: "openai",
    baseUrl,
    apiKeyRef: buildApiKeyRef("retry-test"),
    defaultModel: "gpt-4o-mini",
    timeoutMs: 5000,
    ...over,
  };
}

const sendJson = (res, code, obj, headers = {}) => {
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
};

const okBody = { choices: [{ message: { content: "工作正常。" } }], usage: { prompt_tokens: 4, completion_tokens: 2 } };

test("429 → 退避重试后成功：只发一次就判失败会把限流型中转整轮误判为 F", async () => {
  let hits = 0;
  await withMockUpstream(
    (req, res) => {
      hits += 1;
      if (hits === 1) return sendJson(res, 429, { error: { message: "too many requests" } });
      return sendJson(res, 200, okBody);
    },
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { writeLog: false });
      assert.equal(r.success, true, "429 后应重试并最终成功");
      assert.equal(r.statusCode, 200, "记录应反映最后一次尝试的状态码");
      assert.equal(r.responseText, "工作正常。");
      assert.equal(r.normalizedError, "", "成功轮不应残留上一次 429 的错误归类");
      assert.equal(r.attempts, 2, "attempts 应如实记录实发次数");
      assert.equal(hits, 2);
    },
  );
});

test("429 持续不退 → 耗尽重试上限后放弃，如实记 rate_limited 与尝试次数", async () => {
  let hits = 0;
  await withMockUpstream(
    (req, res) => {
      hits += 1;
      sendJson(res, 429, { error: { message: "too many requests" } });
    },
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { writeLog: false });
      assert.equal(r.success, false);
      assert.equal(r.statusCode, 429);
      assert.equal(r.normalizedError, "rate_limited");
      assert.equal(r.attempts, RETRY_MAX_ATTEMPTS, "应止于上限，不无限重试");
      assert.equal(hits, RETRY_MAX_ATTEMPTS, "实发次数与记录一致");
    },
  );
});

test("Retry-After 被遵守：上游要求等 1s → 重试间隔明显长于默认 600ms 退避", async () => {
  const arrivals = [];
  await withMockUpstream(
    (req, res) => {
      arrivals.push(Date.now());
      if (arrivals.length === 1) return sendJson(res, 429, { error: { message: "slow down" } }, { "retry-after": "1" });
      return sendJson(res, 200, okBody);
    },
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { writeLog: false });
      assert.equal(r.success, true);
      assert.equal(arrivals.length, 2, "应重试一次");
      const gap = arrivals[1] - arrivals[0];
      // 只断言下界：慢机器只会让间隔更长，不会让测试变红（上界断言才是 flaky 之源）。
      // 900ms 已足以把「遵守 Retry-After(1s)」与「默认指数退避(600ms)」区分开。
      assert.ok(gap >= 900, `应等满 Retry-After 指定的 1s，实际间隔 ${gap}ms`);
      assert.ok(gap < RETRY_BASE_DELAY_MS * 10, `不应把 Retry-After 误读成秒以外的单位，实际间隔 ${gap}ms`);
    },
  );
});

test("5xx → 重试后成功：上游抖一下不该让整轮判失败", async () => {
  let hits = 0;
  await withMockUpstream(
    (req, res) => {
      hits += 1;
      if (hits === 1) return sendJson(res, 503, { error: { message: "upstream down" } });
      return sendJson(res, 200, okBody);
    },
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { writeLog: false });
      assert.equal(r.success, true);
      assert.equal(r.statusCode, 200);
      assert.equal(r.attempts, 2);
    },
  );
});

test("400 → 不重试：确定性失败重试只是白烧钱和时间", async () => {
  let hits = 0;
  await withMockUpstream(
    (req, res) => {
      hits += 1;
      sendJson(res, 400, { error: { message: "bad request" } });
    },
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { writeLog: false });
      assert.equal(r.success, false);
      assert.equal(r.attempts, 1, "确定性 4xx 应只发一次");
      assert.equal(hits, 1);
    },
  );
});

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });

// 「拒收自定义 temperature」是上一条（400 不重试）的唯一例外：摘掉该参数后重发是有意义的，
// 因为失败原因已被就地消除。这里连带钉住给用户看的那条留痕 temperatureStripped——
// 传输层的摘参名单是进程级的、无声生效（见 server/upstream-transport.mjs 的
// TEMPERATURE_UNSUPPORTED_MODELS），用户在高级设置里手填的温度被摘掉却不留痕，
// 报告数字就会被读成「我设的那个温度下的表现」，而它其实跑在模型默认温度上。
test("400 拒收自定义 temperature → 摘掉该参数重试，并如实标记「手填温度未生效」", async () => {
  const bodies = [];
  await withMockUpstream(
    async (req, res) => {
      bodies.push(JSON.parse(await readBody(req)));
      if (bodies.length === 1) {
        return sendJson(res, 400, {
          error: { message: "Unsupported value: 'temperature' does not support 1 with this model." },
        });
      }
      return sendJson(res, 200, okBody);
    },
    async (baseUrl) => {
      const profile = await probeProfile(baseUrl, { temperatureOverride: 1 });
      const r = await executeTestRequest(profile, "hi", { writeLog: false });
      assert.equal(r.success, true, "摘掉 temperature 后应重试并最终成功");
      assert.equal(r.attempts, 2, "这类 400 应恰好重试一次");
      assert.equal(bodies[0].temperature, 1, "首发应带用户手填的温度");
      assert.ok(!("temperature" in bodies[1]), "重发应彻底不带 temperature，而不是悄悄换成别的值");
      assert.equal(r.temperatureStripped, true, "手填温度被摘必须留痕，界面据此出提示卡");
    },
  );
});

// 反面：没手填温度时摘掉的是工具自己的默认 0.2，属内部自愈。若这也置位，
// 每个此类模型的每份报告都会挂一条「温度未生效」——提示会退化成人人忽略的噪音。
test("400 拒收 temperature 但用户没手填 → 摘掉工具默认值属内部自愈，不报「温度未生效」", async () => {
  const bodies = [];
  await withMockUpstream(
    async (req, res) => {
      bodies.push(JSON.parse(await readBody(req)));
      if (bodies.length === 1) {
        return sendJson(res, 400, {
          error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model." },
        });
      }
      return sendJson(res, 200, okBody);
    },
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { writeLog: false });
      assert.equal(r.success, true);
      assert.equal(bodies[0].temperature, 0.2, "未手填时发的是工具默认 0.2");
      assert.ok(!("temperature" in bodies[1]), "同样应摘干净");
      assert.equal(r.temperatureStripped, false, "摘默认值不该出提示");
    },
  );
});

// 思考强度被拒 → 同款摘参重试 + 留痕。与 temperature 的差别在于：这个字段【只有】用户
// 明确选档时才会发出去（留空时协议层根本不加），所以不存在"摘默认值属内部自愈"的对应分支——
// 一旦被摘，就一定是用户选的档位没生效，必须留痕。
test("400 拒收 reasoning_effort → 摘掉该档位重试，并如实标记「思考强度未生效」", async () => {
  const bodies = [];
  await withMockUpstream(
    async (req, res) => {
      bodies.push(JSON.parse(await readBody(req)));
      if (bodies.length === 1) {
        return sendJson(res, 400, {
          error: { message: "Invalid 'reasoning_effort' for non-reasoning model: mock-model" },
        });
      }
      return sendJson(res, 200, okBody);
    },
    async (baseUrl) => {
      // 模型名各测试独立，避免进程级摘参名单跨测试串味（名单键含 baseUrl+model，端口每次也不同）
      const profile = await probeProfile(baseUrl, { reasoningEffortOverride: "high", defaultModel: "effort-reject-1" });
      const r = await executeTestRequest(profile, "hi", { writeLog: false });
      assert.equal(r.success, true, "摘掉 reasoning_effort 后应重试并最终成功");
      assert.equal(r.attempts, 2, "这类 400 应恰好重试一次");
      assert.equal(bodies[0].reasoning_effort, "high", "首发应带用户选的档位");
      assert.ok(!("reasoning_effort" in bodies[1]), "重发应彻底不带该字段，而不是悄悄换成 none");
      assert.equal(r.reasoningEffortStripped, true, "档位被摘必须留痕，界面据此出提示卡");
    },
  );
});

// GPT-5.6 系的真实约束：chat/completions 上「function tools + reasoning_effort≠none」不支持，
// 但普通生成请求完全接受该参数。故进程级摘参名单的键必须带请求形状（hasTools）——
// 否则工具题那一次 400 会让【后续所有生成探测】也首发就不带档位：用户选了 high、报告显示 high，
// 实际却跑在模型默认档上，静默失真。这条测试就是钉这个键的粒度。
test("工具请求被拒 reasoning_effort → 不得连带让普通生成请求也丢档位", async () => {
  const bodies = [];
  await withMockUpstream(
    async (req, res) => {
      const body = JSON.parse(await readBody(req));
      bodies.push(body);
      // 只在带 tools 时拒收该参数，普通请求一律接受（复刻 GPT-5.6 的行为）
      if (body.tools && body.reasoning_effort !== undefined) {
        return sendJson(res, 400, {
          error: {
            message:
              "Function tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
          },
        });
      }
      if (body.tools) {
        return sendJson(res, 200, {
          choices: [
            {
              message: {
                role: "assistant",
                tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"北京"}' } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        });
      }
      return sendJson(res, 200, okBody);
    },
    async (baseUrl) => {
      const profile = await probeProfile(baseUrl, { reasoningEffortOverride: "high", defaultModel: "effort-tools-conflict" });

      // ① 工具题：被拒 → 摘参重试 → 成功，且留痕
      const tool = await executeToolCallTestRequest(profile, { writeLog: false });
      assert.equal(tool.success, true, "工具题摘掉档位后应成功");
      assert.equal(tool.reasoningEffortStripped, true, "工具题的档位被摘，要留痕");

      // ② 紧接着的普通生成请求：必须仍然带 high（这才是本测试的重点）
      const plain = await executeTestRequest(profile, "hi", { writeLog: false });
      assert.equal(plain.success, true);
      const lastPlain = bodies.filter((b) => !b.tools).at(-1);
      assert.equal(lastPlain.reasoning_effort, "high", "普通生成请求不得被工具题的拒收连带摘参");
      assert.equal(plain.reasoningEffortStripped, false, "没被摘就不该留痕，否则提示卡变噪音");

      // ③ 再跑一次工具题：这次应首发就不带（名单已学到「这个形状不行」），只发 1 次
      const before = bodies.length;
      const tool2 = await executeToolCallTestRequest(profile, { writeLog: false });
      assert.equal(tool2.success, true);
      assert.equal(bodies.length - before, 1, "已知不支持的形状应首发就不带该参数，省掉注定失败的往返");
      assert.equal(tool2.reasoningEffortStripped, true, "首发即摘同样要留痕");
    },
  );
});

// —— max_tokens → max_completion_tokens 改名重试 ——
// 不处理的后果实测是整轮全灭（快速准入 5 道用例全 400 → grade F → 「暂不建议接入」）。
// 与前三类摘参的关键差别：这里必须【改名】而不是【摘参】。max_tokens 是输出上限，摘掉会放开到
// 模型自己的上限（GPT-5.6 达 128K），既烧额度，又会把响应顶到传输层字节上限判 response_too_large。
test("400 要求改名 → 改成 max_completion_tokens 重试，数值上限原样保留", async () => {
  const bodies = [];
  await withMockUpstream(
    async (req, res) => {
      const body = JSON.parse(await readBody(req));
      bodies.push(body);
      // 复刻 GPT-5 系真实行为：只认新字段名
      if (body.max_tokens !== undefined) {
        return sendJson(res, 400, {
          error: {
            message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
            code: "unsupported_parameter",
          },
        });
      }
      return sendJson(res, 200, okBody);
    },
    async (baseUrl) => {
      const profile = await probeProfile(baseUrl, { defaultModel: "gpt5-rename-1", maxTokens: 777 });
      const r = await executeTestRequest(profile, "hi", { writeLog: false });
      assert.equal(r.success, true, "改名后应重试并最终成功，而不是判渠道不可用");
      assert.equal(r.attempts, 2, "这类 400 应恰好重试一次");
      assert.equal(bodies[0].max_tokens, 777, "首发仍用老字段名（绝大多数中转/厂商只认它）");
      assert.equal(bodies[1].max_completion_tokens, 777, "重发应改名且【数值原样保留】");
      assert.ok(!("max_tokens" in bodies[1]), "改名不是新增：老字段必须去掉，否则两个都在照旧 400");
      assert.equal(r.maxTokensRenamed, true, "改名要落痕，供排查空响应/截断时定位");
    },
  );
});

test("改名记忆：同模型后续请求首发就用新字段名，不再白发一趟注定 400 的请求", async () => {
  const bodies = [];
  await withMockUpstream(
    async (req, res) => {
      const body = JSON.parse(await readBody(req));
      bodies.push(body);
      if (body.max_tokens !== undefined) {
        return sendJson(res, 400, {
          error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." },
        });
      }
      return sendJson(res, 200, okBody);
    },
    async (baseUrl) => {
      const profile = await probeProfile(baseUrl, { defaultModel: "gpt5-rename-memo", maxTokens: 512 });
      await executeTestRequest(profile, "hi", { writeLog: false });
      assert.equal(bodies.length, 2, "首轮：被拒一次 + 改名重试一次");

      const before = bodies.length;
      const r2 = await executeTestRequest(profile, "hi", { writeLog: false });
      assert.equal(r2.success, true);
      assert.equal(bodies.length - before, 1, "已学到该模型只认新名，第二次应一发即中");
      assert.equal(bodies.at(-1).max_completion_tokens, 512);
      assert.equal(r2.maxTokensRenamed, true, "首发即改名同样要落痕");
    },
  );
});

// 【方向必须门禁】Anthropic 的 max_tokens 是**必填**字段。若对 Claude 协议也改名，
// 原生 Claude 渠道会从「好的」变成「坏的」——本工具最主要的两类渠道之一直接全灭。
// 这里让 mock 上游回一个「文本上符合改名要求」的 400，锁死 Claude 分支绝不跟着改。
test("Claude 协议绝不改名：Anthropic 的 max_tokens 是必填字段", async () => {
  const bodies = [];
  await withMockUpstream(
    async (req, res) => {
      bodies.push(JSON.parse(await readBody(req)));
      // 故意回一条会让 isMaxTokensRenameRequiredError 判 true 的文案
      return sendJson(res, 400, {
        error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." },
      });
    },
    async (baseUrl) => {
      const profile = await probeProfile(baseUrl, {
        protocol: "claude_messages",
        defaultModel: "claude-rename-guard",
        maxTokens: 512,
      });
      const r = await executeTestRequest(profile, "hi", { writeLog: false });
      assert.equal(r.success, false, "该 400 是 mock 无条件回的，本用例只关心请求体");
      // 关键：不得改名，也不得因此白重试——renameMaxTokens 返回 false 就不进那一支。
      for (const [i, body] of bodies.entries()) {
        assert.equal(body.max_tokens, 512, `第 ${i + 1} 次请求必须仍带 max_tokens`);
        assert.ok(!("max_completion_tokens" in body), `第 ${i + 1} 次请求不得出现 OpenAI 的新字段名`);
      }
      assert.equal(bodies.length, 1, "改名被门禁挡住时不该白重试一次同样的请求");
      assert.equal(r.maxTokensRenamed, false);
    },
  );
});

// 反向危险：大量中转 / 非 OpenAI 厂商 / 旧版 Azure 只认 max_tokens，收到新字段会回
// "Unrecognized request argument supplied: max_completion_tokens"。这类报错绝不能触发改名——
// 否则方向搞反、越改越死。这也是本仓库刻意不做「全局换名」的原因：经中转测是主要使用场景。
test("只认老字段的中转拒收新字段时，不得误触发改名（方向不能搞反）", async () => {
  const bodies = [];
  await withMockUpstream(
    async (req, res) => {
      const body = JSON.parse(await readBody(req));
      bodies.push(body);
      if (body.max_completion_tokens !== undefined) {
        return sendJson(res, 400, {
          error: { message: "Unrecognized request argument supplied: max_completion_tokens" },
        });
      }
      return sendJson(res, 200, okBody);
    },
    async (baseUrl) => {
      const profile = await probeProfile(baseUrl, { defaultModel: "legacy-relay-1", maxTokens: 512 });
      const r = await executeTestRequest(profile, "hi", { writeLog: false });
      assert.equal(r.success, true, "只认老字段的中转本就该一发即中");
      assert.equal(bodies.length, 1, "不该有任何改名重试");
      assert.equal(bodies[0].max_tokens, 512);
      assert.equal(r.maxTokensRenamed, false, "没改名就不该落痕");
    },
  );
});

// —— Claude 侧思考强度：output_config.effort ——
// 字段名与 OpenAI 系完全不同，摘参重试整条链路必须各自接通。此前的探测器只按 reasoning_effort
// 点名，拿它去查 Claude 的报错永远查不到 → 摘参永不触发 → 用户看到的是一条并不存在的
// 「渠道不可用」（真实原因只是这个模型不认某一档）。
const claudeOkBody = {
  content: [{ type: "text", text: "工作正常。" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 4, output_tokens: 2 },
};

test("400 拒收 output_config.effort → 摘掉该档位重试，并如实标记「思考强度未生效」", async () => {
  const bodies = [];
  await withMockUpstream(
    async (req, res) => {
      bodies.push(JSON.parse(await readBody(req)));
      if (bodies.length === 1) {
        // 复刻 Anthropic 的 pydantic 风格文案：老模型只到 high，不认 xhigh/max。
        return sendJson(res, 400, {
          error: { message: "output_config.effort: Input should be 'low', 'medium' or 'high'" },
        });
      }
      return sendJson(res, 200, claudeOkBody);
    },
    async (baseUrl) => {
      const profile = await probeProfile(baseUrl, {
        protocol: "claude_messages",
        reasoningEffortOverride: "max",
        defaultModel: "claude-effort-reject-1",
      });
      const r = await executeTestRequest(profile, "hi", { writeLog: false });
      assert.equal(r.success, true, "摘掉 effort 后应重试并最终成功");
      assert.equal(r.attempts, 2, "这类 400 应恰好重试一次");
      assert.equal(bodies[0].output_config.effort, "max", "首发应带用户选的档位");
      // 只删 effort、留一个空的 output_config 壳，对「不认这个顶层字段」的上游等于没摘参，
      // 重试会再吃一个同样的 400、白烧一次往返。
      assert.ok(!("output_config" in bodies[1]), "重发应连 output_config 壳一起去掉");
      assert.equal(r.reasoningEffortStripped, true, "档位被摘必须留痕，界面据此出提示卡");
    },
  );
});

test("400 拒收整个 output_config 字段（老版本 API / 中转不认）→ 同样摘参重试", async () => {
  const bodies = [];
  await withMockUpstream(
    async (req, res) => {
      bodies.push(JSON.parse(await readBody(req)));
      if (bodies.length === 1) {
        return sendJson(res, 400, { error: { message: "output_config: Extra inputs are not permitted" } });
      }
      return sendJson(res, 200, claudeOkBody);
    },
    async (baseUrl) => {
      const profile = await probeProfile(baseUrl, {
        protocol: "claude_messages",
        reasoningEffortOverride: "high",
        defaultModel: "claude-effort-reject-2",
      });
      const r = await executeTestRequest(profile, "hi", { writeLog: false });
      assert.equal(r.success, true, "不认该字段的上游同样应摘参后重试成功，而不是判渠道不可用");
      assert.equal(r.reasoningEffortStripped, true);
    },
  );
});

// none / minimal 不在 Claude 的取值域里（官方只有 low/medium/high/xhigh/max）。这是编译期已知的
// 事实，协议层就地丢弃、不发那一趟注定 400 的请求；但绝不能静默丢：用户选 none 想看的是
// 「不思考时的表现」，实际拿到的却是默认 high 档的数字，两者差别极大。
test("Claude 渠道选 none / minimal：不白发一趟注定失败的请求，但必须留痕", async () => {
  for (const level of ["none", "minimal"]) {
    const bodies = [];
    await withMockUpstream(
      async (req, res) => {
        bodies.push(JSON.parse(await readBody(req)));
        return sendJson(res, 200, claudeOkBody);
      },
      async (baseUrl) => {
        const profile = await probeProfile(baseUrl, {
          protocol: "claude_messages",
          reasoningEffortOverride: level,
          defaultModel: `claude-effort-drop-${level}`,
        });
        const r = await executeTestRequest(profile, "hi", { writeLog: false });
        assert.equal(r.success, true, `${level} 应照常测出结果（跑在模型默认档上）`);
        assert.equal(bodies.length, 1, `${level} 不在取值域内，不该先发一趟注定 400 的请求`);
        assert.ok(!("output_config" in bodies[0]), `${level} 不该被发给 Claude`);
        assert.equal(r.reasoningEffortStripped, true, `${level} 被丢弃必须留痕，否则报告显示的档位与实际不符`);
      },
    );
  }
});

test("超时 → 止损不重试：重试会让一次卡死的探测拖成 N 倍超时", async () => {
  let hits = 0;
  await withMockUpstream(
    (req, res) => {
      hits += 1;
      // 永不响应：让客户端超时控制器开火。连接由 withMockUpstream 收尾销毁。
    },
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl, { timeoutMs: 300 }), "hi", { writeLog: false });
      assert.equal(r.success, false);
      assert.equal(r.normalizedError, "timeout");
      assert.equal(r.attempts, 1, "超时不得重试");
      assert.equal(hits, 1, "只应发出一次请求");
    },
  );
});

test("瞬时网络错误（连接被拒）→ 重试到上限：区别于超时的止损语义", async () => {
  // 先起再关，拿到一个确定无人监听的端口 → 连接必被拒（ECONNREFUSED），且不依赖外网。
  const probe = createServer(() => {});
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const deadPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const r = await executeTestRequest(await probeProfile(`http://127.0.0.1:${deadPort}`), "hi", { writeLog: false });
  assert.equal(r.success, false);
  assert.equal(r.normalizedError, "network_error", "连接被拒是瞬时网络错误，不该归成超时");
  assert.equal(r.attempts, RETRY_MAX_ATTEMPTS, "瞬时网络错误应重试到上限");
  assert.ok(/ECONNREFUSED/i.test(r.rawError), `rawError 应带上底层 errno 便于定位，实际：${r.rawError}`);
});

test("退避途中被用户取消 → 立即收手，不再发下一次请求（取消要立刻止血、不再计费）", async () => {
  let hits = 0;
  const controller = new AbortController();
  await withMockUpstream(
    (req, res) => {
      hits += 1;
      sendJson(res, 429, { error: { message: "too many requests" } });
      // 首次被拒后立刻取消：此时探测正处在 600ms 退避睡眠里。
      if (hits === 1) setTimeout(() => controller.abort(), 50).unref();
    },
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", {
        writeLog: false,
        abortSignal: controller.signal,
      });
      assert.equal(r.success, false);
      assert.equal(r.attempts, 1, "退避中被取消不得再发下一次");
      assert.equal(hits, 1, "上游只应收到一次请求");
    },
  );
});

test("noRetry（压测）：429 只发一次——重试会吞掉正要测的限流信号", async () => {
  let hits = 0;
  await withMockUpstream(
    (req, res) => {
      hits += 1;
      sendJson(res, 429, { error: { message: "too many requests" } });
    },
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { writeLog: false, noRetry: true });
      assert.equal(r.success, false);
      assert.equal(r.normalizedError, "rate_limited");
      assert.equal(r.attempts, 1, "压测每请求只测一次");
      assert.equal(hits, 1, "重试会把 429 吞掉、并把退避 sleep 混进延迟，污染 QPS 与尾延迟");
    },
  );
});

test("上游 302 → 不跟随重定向：Key 只能发往已过出站校验的地址", async () => {
  // 出站校验（assertPublicTarget）只看我方构造的 URL。若 fetch 跟随重定向，
  // 上游一句 302 就能把带 Key 的请求引到未经校验的地址（元数据服务/内网）。
  // redirect:"error" 是这条防线——这里锁定它：重定向目标一个请求都收不到。
  let redirectTargetHits = 0;
  await withMockUpstream(
    (req, res) => {
      redirectTargetHits += 1;
      sendJson(res, 200, okBody);
    },
    async (targetUrl) => {
      await withMockUpstream(
        (req, res) => {
          res.writeHead(302, { location: `${targetUrl}/v1/chat/completions` });
          res.end();
        },
        async (baseUrl) => {
          const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { writeLog: false });
          assert.equal(r.success, false, "跟随重定向就会把 Key 送到未校验的地址");
          assert.equal(redirectTargetHits, 0, "重定向目标不得收到任何请求");
        },
      );
    },
  );
});

// —— 摘参记忆的协议分区：同址同模型、两种协议互不污染 ——
//
// 曾有一版把记忆键写成 `baseUrl|model`，并在注释里断言「同一个 baseUrl+model 只会走一种协议」。
// 那条断言是错的，且错得可达：中转（new-api / one-api / sub2api）常同时暴露
// /v1/chat/completions 与 /v1/messages；渠道判重键是 `baseUrl|keyHash`（不含协议）；
// sub2api 导入又是「每个密钥建一个渠道、协议按分组 platform 各判」。于是「同址同模型、协议不同」
// 是常见形态。后果：一条协议被 400 后，另一条协议的渠道**首发就丢掉**用户填的值，
// 而那个端点本来是接受的——报告虽标注"未生效"，用户选的档位/温度却根本没跑，且归因指向错误方向。
//
// 两个用例的骨架都靠「步骤1 必须真的写入记忆」自证：断言 attempts=2 + stripped=true。
// 若步骤1 因文案不被探测器识别而没触发摘参（曾踩过这个坑），记忆压根没写，步骤2 的绿毫无意义。
// 变异验证：把 tempKey 还原成不含协议，两条都变红。
async function withDualProtocolUpstream(handlers, run) {
  return withMockUpstream(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const isClaude = req.url.includes("/messages");
    handlers.seen.push({ isClaude, body });
    return (isClaude ? handlers.claude : handlers.openai)(body, res);
  }, run);
}

test("思考强度摘参记忆按协议分区：Claude 侧被拒不该让同址同模型的 OpenAI 渠道丢档位", async () => {
  const h = {
    seen: [],
    // Claude 端点：老模型只到 high，不认 xhigh（复刻 Anthropic 的 pydantic 风格文案）
    claude: (body, res) =>
      body.output_config?.effort !== undefined
        ? sendJson(res, 400, { error: { message: "output_config.effort: Input should be 'low', 'medium' or 'high'" } })
        : sendJson(res, 200, claudeOkBody),
    // OpenAI 端点：完全接受 reasoning_effort——这是关键，它本来是好的
    openai: (_body, res) => sendJson(res, 200, okBody),
  };
  await withDualProtocolUpstream(h, async (baseUrl) => {
    const model = "shared-model-effort-partition";
    const mk = (protocol) => probeProfile(baseUrl, { protocol, defaultModel: model, reasoningEffortOverride: "xhigh" });

    const claudeRun = await executeTestRequest(await mk("claude_messages"), "hi", { writeLog: false });
    // 骨架自证：这两条保证记忆真的被写入了，否则下面那条断言的绿毫无意义。
    assert.equal(claudeRun.attempts, 2, "前提：Claude 侧必须真的经历「被拒→摘参重试」");
    assert.equal(claudeRun.reasoningEffortStripped, true, "前提：Claude 侧摘参必须留痕（记忆已写入）");

    h.seen.length = 0;
    const openaiRun = await executeTestRequest(await mk("openai_compatible"), "hi", { writeLog: false });
    const sent = h.seen.find((s) => !s.isClaude)?.body;
    assert.equal(sent?.reasoning_effort, "xhigh", "该端点本来接受该字段，不得因另一协议被拒而首发就丢掉");
    assert.equal(openaiRun.reasoningEffortStripped, false, "没摘就不该留痕，否则报告误标「未生效」");
  });
});

test("temperature 摘参记忆按协议分区：同址同模型的另一协议渠道不该丢掉手填温度", async () => {
  const h = {
    seen: [],
    // Claude 端点：拒收自定义 temperature（复刻 Opus 4.7+ 行为）。
    // 文案必须是 isTemperatureUnsupportedError 真认得的那几个词之一，否则摘参分支不触发、
    // 记忆不写入，整个用例会得到一个毫无意义的绿——这个坑本轮踩过一次。
    claude: (body, res) =>
      body.temperature !== undefined
        ? sendJson(res, 400, { error: { message: "'temperature' is not supported with this model" } })
        : sendJson(res, 200, claudeOkBody),
    openai: (_body, res) => sendJson(res, 200, okBody),
  };
  await withDualProtocolUpstream(h, async (baseUrl) => {
    const model = "shared-model-temp-partition";
    const mk = (protocol) => probeProfile(baseUrl, { protocol, defaultModel: model, temperatureOverride: 1 });

    const claudeRun = await executeTestRequest(await mk("claude_messages"), "hi", { writeLog: false });
    assert.equal(claudeRun.attempts, 2, "前提：Claude 侧必须真的经历「被拒→摘参重试」");
    assert.equal(claudeRun.temperatureStripped, true, "前提：Claude 侧摘参必须留痕（记忆已写入）");

    h.seen.length = 0;
    const openaiRun = await executeTestRequest(await mk("openai_compatible"), "hi", { writeLog: false });
    const sent = h.seen.find((s) => !s.isClaude)?.body;
    assert.equal(sent?.temperature, 1, "该端点本来接受 temperature=1，不得因另一协议被拒而首发就丢掉");
    assert.equal(openaiRun.temperatureStripped, false, "没摘就不该留痕");
  });
});
