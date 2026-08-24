import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProtocolRequest,
  buildProtocolStreamRequest,
  buildProtocolToolRequest,
  buildProtocolUrl,
  CLAUDE_EFFORT_LEVELS,
  extractOutputText,
  extractToolCall,
  extractUsage,
  isClaudeEffortUnsupportedError,
  isMaxTokensRenameRequiredError,
  isReasoningEffortUnsupportedError,
  normalizeEmptyResponse,
  normalizeHttpError,
  REASONING_EFFORT_LEVELS,
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

// openai_path_prefix：baseUrl 已含厂商自己的版本前缀，只补最后一段 /chat/completions。
// 回归的是「直连智谱必然 404」——此前固定拼 /v1，https://open.bigmodel.cn/api/paas/v4
// 会变成 .../api/paas/v4/v1/chat/completions。
test("buildProtocolUrl：自定义路径前缀协议不再补 /v1", () => {
  assert.equal(
    buildProtocolUrl("openai_path_prefix", "https://open.bigmodel.cn/api/paas/v4"),
    "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  );
  // 尾随斜杠归一，不产生 //chat/completions
  assert.equal(
    buildProtocolUrl("openai_path_prefix", "https://open.bigmodel.cn/api/paas/v4/"),
    "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  );
  // 其余厂商同一条协议即可覆盖，代码里不硬编码任何前缀
  assert.equal(
    buildProtocolUrl("openai_path_prefix", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  );
  // 既有三协议的 URL 一字不变（本次改动是纯新增，不得动老行为）
  assert.equal(buildProtocolUrl("openai_compatible", "https://api.example.com"), "https://api.example.com/v1/chat/completions");
  assert.equal(buildProtocolUrl("openai_chat", "https://api.example.com"), "https://api.example.com/v1/chat/completions");
  assert.equal(buildProtocolUrl("claude_messages", "https://api.example.com"), "https://api.example.com/v1/messages");
  // 未知协议按 OpenAI 兼容兜底，与 normalizeProtocol 的兜底方向一致
  assert.equal(buildProtocolUrl("something_else", "https://api.example.com"), "https://api.example.com/v1/chat/completions");
});

test("openai_path_prefix：四种请求构造都走自定义前缀，请求体与 openai_compatible 一致", () => {
  const profile = {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKey: "sk-glm",
    protocol: "openai_path_prefix",
    defaultModel: "glm-4.6",
    maxTokens: 1024,
  };
  const expected = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

  const plain = buildProtocolRequest(profile, "你好");
  assert.equal(plain.url, expected);
  assert.equal(plain.headers.authorization, "Bearer sk-glm");
  assert.equal(plain.body.model, "glm-4.6");
  assert.equal(plain.body.stream, false);
  assert.equal(plain.body.temperature, 0.2, "沿用 OpenAI 系默认温度");

  const streamed = buildProtocolStreamRequest(profile, "你好", { includeUsage: true });
  assert.equal(streamed.url, expected);
  assert.equal(streamed.body.stream, true);
  assert.deepEqual(streamed.body.stream_options, { include_usage: true });

  const tool = buildProtocolToolRequest(profile);
  assert.equal(tool.url, expected);
  assert.equal(tool.body.tools[0].type, "function", "工具形状必须是 OpenAI 的 function，不是 Claude 的 input_schema");
  assert.equal(tool.body.temperature, 0);

  // 不得误用 Claude 的鉴权头
  for (const request of [plain, streamed, tool]) {
    assert.equal("x-api-key" in request.headers, false);
    assert.equal("anthropic-version" in request.headers, false);
  }
});

// 思考强度（reasoning_effort）。最关键的一条是「留空绝不发」：官方口径默认档是 per-model 的
// （如 gpt-5.5 默认 medium），凭空发一个工具级默认会悄悄改掉厂商调好的基线，
// 报告里的质量/耗时/成本就不再代表用户直连时的表现。
test("reasoningEffortOverride：留空绝不发该字段，填了才发", () => {
  const base = {
    baseUrl: "https://api.example.com",
    apiKey: "sk-test",
    protocol: "openai_compatible",
    defaultModel: "gpt-5.6",
    maxTokens: 256,
  };

  // 留空/未传 → 字段整个不存在（不是 null、不是空串，那些会被上游当成非法值）
  for (const profile of [base, { ...base, reasoningEffortOverride: null }]) {
    assert.equal("reasoning_effort" in buildProtocolRequest(profile, "hi").body, false);
    assert.equal("reasoning_effort" in buildProtocolStreamRequest(profile, "hi").body, false);
    assert.equal("reasoning_effort" in buildProtocolToolRequest(profile).body, false);
  }

  // 填了 → 三种请求都带上
  const withEffort = { ...base, reasoningEffortOverride: "xhigh" };
  assert.equal(buildProtocolRequest(withEffort, "hi").body.reasoning_effort, "xhigh");
  assert.equal(buildProtocolStreamRequest(withEffort, "hi").body.reasoning_effort, "xhigh");
  assert.equal(buildProtocolToolRequest(withEffort).body.reasoning_effort, "xhigh");

  // "none" 是合法档位（不思考），不能被 falsy 判断吞掉——同 temperature 填 0 的那个坑
  assert.equal(buildProtocolRequest({ ...base, reasoningEffortOverride: "none" }, "hi").body.reasoning_effort, "none");

  // 自定义路径前缀协议（GLM 等）同样带上：它与 openai_compatible 共用同一套 body 构造
  assert.equal(
    buildProtocolRequest({ ...withEffort, protocol: "openai_path_prefix", baseUrl: "https://open.bigmodel.cn/api/paas/v4" }, "hi").body
      .reasoning_effort,
    "xhigh",
  );

  // Claude 分支走 output_config.effort（见下方专门的用例），此处只锁「不得因为共用同一个
  // profile 字段就误发 OpenAI 的扁平字段」。两边字段名互不通用：发错一边会被当未知参数 400。
  const claude = { ...withEffort, protocol: "claude_messages", defaultModel: "claude-opus-4-7" };
  assert.equal("reasoning_effort" in buildProtocolRequest(claude, "hi").body, false);
  assert.equal("reasoning_effort" in buildProtocolStreamRequest(claude, "hi").body, false);
  assert.equal("reasoning_effort" in buildProtocolToolRequest(claude).body, false);
});

// —— max_tokens → max_completion_tokens 改名判定 ——
// OpenAI 从 o1 起把 max_tokens 标为 deprecated，GPT-5 系（已确认到 5.4）直接 400。
// 不处理的后果是整轮全灭：四个 builder 全都发 max_tokens，直连这类模型每道用例都 400 →
// successRate 0 → grade F → 报告写「暂不建议接入」。健康渠道被报成不可用。
test("isMaxTokensRenameRequiredError：认改名要求，且不被请求体回显误导", () => {
  // OpenAI 官方原文
  assert.equal(
    isMaxTokensRenameRequiredError(
      "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
    ),
    true,
  );
  // 措辞变体（不同中转会重写文案）
  assert.equal(isMaxTokensRenameRequiredError("max_tokens is deprecated, use max_completion_tokens"), true);

  // 【必须同时点名替代名】——只说「max_tokens 不支持」而不给替代名时不认：
  // 改成什么就是猜，猜错照旧 400 还多烧一次往返，宁可让用户看见真实报错。
  assert.equal(isMaxTokensRenameRequiredError("Unsupported parameter: 'max_tokens' is not supported with this model."), false);

  // 请求体回显：我方发的就是 max_tokens，400 的回显里必然带着它。只凭 includes 会把
  // 无关错误误判成"要改名" → 模型被永久加进改名名单 → 此后对只认老字段的中转全灭。
  //
  // 【这一条是真正压住回显防护的用例】：拒收词（unsupported）与回显同时出现，
  // 但上游点名的是 temperature，不是 max_tokens。少了这条，把 errorNamesParam 换成裸 includes
  // 测试也照样全绿——下面两条只是没有拒收词，挡住它们的是拒收词门禁而非回显防护（已实测）。
  assert.equal(
    isMaxTokensRenameRequiredError(
      '{"error":{"message":"Unsupported value: \'temperature\' does not support 0.2","param":"temperature"},' +
        '"request":{"max_tokens":512,"max_completion_tokens":null,"temperature":0.2}}',
    ),
    false,
    "上游点名的是 temperature；max_tokens 只是请求体回显，不该据此改名",
  );
  // LiteLLM 风格的 kwargs dump，同样带拒收词但点名的是别的参数
  assert.equal(
    isMaxTokensRenameRequiredError(
      "litellm.BadRequestError: Unsupported parameter: 'stream_options' is not supported. " +
        "kwargs: max_tokens=512, max_completion_tokens=None, stream_options={'include_usage': True}",
    ),
    false,
  );
  // 无拒收词的回显（这两条挡在拒收词门禁上，保留作纵深防御）
  assert.equal(
    isMaxTokensRenameRequiredError('{"error":"rate limit exceeded","request":{"max_tokens":512,"max_completion_tokens":null}}'),
    false,
  );
  assert.equal(isMaxTokensRenameRequiredError("kwargs: max_tokens=512 -> upstream timeout (max_completion_tokens unused)"), false);

  // 反向错误（中转只认老字段、拒收新字段）绝不能触发改名——那会把方向搞反、彻底卡死
  assert.equal(isMaxTokensRenameRequiredError("Unrecognized request argument supplied: max_completion_tokens"), false);
  assert.equal(isMaxTokensRenameRequiredError(""), false);
  // 不点名任何一方的错误一律不认
  assert.equal(isMaxTokensRenameRequiredError("Unsupported parameter: 'temperature'"), false);
});

// —— Claude 侧思考强度：output_config.effort ——
// 与 OpenAI 侧共用同一个 profile 字段（reasoningEffortOverride），但落点是嵌套的
// output_config.effort，且合法档位少两档（没有 none / minimal）。
test("Claude effort：留空绝不发 output_config，填了才发（三种请求都带）", () => {
  const claude = {
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-test",
    protocol: "claude_messages",
    defaultModel: "claude-opus-5",
    maxTokens: 256,
  };

  // 留空 → 连 output_config 这个壳都不该出现。发一个空壳给老版本 API / 不认该字段的中转
  // 会白吃一个 400，而用户什么都没选、本不该有任何额外风险。
  for (const profile of [claude, { ...claude, reasoningEffortOverride: null }]) {
    for (const req of [buildProtocolRequest(profile, "hi"), buildProtocolStreamRequest(profile, "hi"), buildProtocolToolRequest(profile)]) {
      assert.equal("output_config" in req.body, false);
      assert.equal(req.effortDropped, undefined, "什么都没选就不该报「被丢弃」，否则提示卡变噪音");
    }
  }

  // 填了合法档 → 三种请求都带上。工具题也要带：官方口径 effort 约束的是全部 token（含工具调用），
  // 低档会让模型少调工具，那正是工具题要观察的行为，不该替用户抹掉。
  const withEffort = { ...claude, reasoningEffortOverride: "xhigh" };
  assert.equal(buildProtocolRequest(withEffort, "hi").body.output_config.effort, "xhigh");
  assert.equal(buildProtocolStreamRequest(withEffort, "hi").body.output_config.effort, "xhigh");
  assert.equal(buildProtocolToolRequest(withEffort).body.output_config.effort, "xhigh");

  // 绝不能顺手也发 OpenAI 的扁平字段（会被 Anthropic 当未知参数 400）。
  assert.equal("reasoning_effort" in buildProtocolRequest(withEffort, "hi").body, false);

  // high 与留空行为等价（high 即 Claude 默认档），但仍照发：用户显式选了就该在请求里看得到，
  // 省掉它会让抓包对不上，也让日后厂商改默认档时行为静默漂移。
  assert.equal(buildProtocolRequest({ ...claude, reasoningEffortOverride: "high" }, "hi").body.output_config.effort, "high");
});

test("Claude effort：不在取值域的档位（none / minimal）就地丢弃，且必须留痕", () => {
  const claude = {
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-test",
    protocol: "claude_messages",
    defaultModel: "claude-opus-5",
    maxTokens: 256,
  };

  // none / minimal 是 OpenAI 系独有的两档，不在 Claude 的取值范围内。这属于编译期已知的事实，
  // 不该发一趟注定 400 的请求去发现它——但也绝不能静默丢弃：置 effortDropped，
  // 由传输层转成 reasoningEffortStripped，报告与提示卡照常写明「未生效」。
  // 静默丢的后果特别严重：用户选 none 想看「不思考时的表现」，实拿到的是默认 high 档的数字。
  for (const level of ["none", "minimal"]) {
    for (const req of [
      buildProtocolRequest({ ...claude, reasoningEffortOverride: level }, "hi"),
      buildProtocolStreamRequest({ ...claude, reasoningEffortOverride: level }, "hi"),
      buildProtocolToolRequest({ ...claude, reasoningEffortOverride: level }),
    ]) {
      assert.equal("output_config" in req.body, false, `${level} 不在 Claude 取值域，不该发出去`);
      assert.equal(req.effortDropped, true, `${level} 被丢弃必须留痕，否则报告显示的档位与实际不符`);
    }
  }

  // 反过来：OpenAI 系照发 none / minimal，不受 Claude 那份收窄名单影响。
  const openai = { ...claude, protocol: "openai_compatible", defaultModel: "gpt-5.6" };
  assert.equal(buildProtocolRequest({ ...openai, reasoningEffortOverride: "none" }, "hi").body.reasoning_effort, "none");
  assert.equal(buildProtocolRequest({ ...openai, reasoningEffortOverride: "minimal" }, "hi").effortDropped, undefined);
});

test("CLAUDE_EFFORT_LEVELS：五档，是 OpenAI 全集去掉 none / minimal 后的子集", () => {
  assert.deepEqual(CLAUDE_EFFORT_LEVELS, ["low", "medium", "high", "xhigh", "max"]);
  // 子集关系不是巧合：UI 是一份下拉共用两种协议，若 Claude 冒出一个全集里没有的档位，
  // 那个档位在界面上根本选不到，等于死代码。
  for (const level of CLAUDE_EFFORT_LEVELS) {
    assert.ok(REASONING_EFFORT_LEVELS.includes(level), `${level} 不在七档全集里，UI 选不到`);
  }
});

test("isClaudeEffortUnsupportedError：认全两类拒收，且不被请求体回显误导", () => {
  // ① 老版本 API / 中转不认 output_config 这个顶层字段（Anthropic 的 pydantic 风格文案）
  assert.equal(isClaudeEffortUnsupportedError("output_config: Extra inputs are not permitted"), true);
  assert.equal(isClaudeEffortUnsupportedError("Unrecognized request argument supplied: output_config"), true);
  // ② 该模型不支持所选档位（xhigh / max 是后加的，老模型只到 high）
  assert.equal(isClaudeEffortUnsupportedError("output_config.effort: Input should be 'low', 'medium' or 'high'"), true);
  assert.equal(isClaudeEffortUnsupportedError("Unsupported value for 'effort': xhigh is not supported by this model"), true);

  // 关键：400 常把我方请求体原样回显，只凭「文本里出现 effort」会把无关错误误判成"该参数被拒"
  // → 模型被永久加进摘参名单 → 此后静默按默认档跑却仍显示用户选的档位。
  assert.equal(isClaudeEffortUnsupportedError('{"error":"rate limit exceeded","request":{"output_config":{"effort":"max"}}}'), false);
  assert.equal(isClaudeEffortUnsupportedError("kwargs: effort='max', temperature=1 -> upstream timeout"), false);
  // 不点名该参数的错误一律不认（哪怕含 unsupported 字样）
  assert.equal(isClaudeEffortUnsupportedError("Unsupported parameter: 'stream_options'"), false);
  assert.equal(isClaudeEffortUnsupportedError(""), false);

  // 真实误判（本条曾复现）：裸英文里的 "best-effort" 不是字段名。
  // errorNamesParam 最后一步是纯子串 includes，若直接拿 "effort" 去问它，这句会被判成"该参数被拒"
  // → 模型被永久加进进程级摘参名单 → 此后静默按默认档跑却仍显示用户选的档位。
  assert.equal(isClaudeEffortUnsupportedError("Best-effort routing is not supported for this endpoint"), false);
  assert.equal(isClaudeEffortUnsupportedError("This model does not support effortless mode"), false);
  // 上面那条只覆盖了【不带冒号】的形态。带冒号的变体曾漏网：判定用的 lookbehind (?<![\w.])
  // 不排除连字符，于是这四条与思考强度**毫无关系**的网关报错全被判成"该参数被拒"
  // → 模型永久进摘参名单 → 此后静默按默认档跑，报告却写「思考强度未生效」，
  // 把排查引向"模型支持哪些档位"，而真实原因在网关容量配置。
  // 变异验证：把裸 effort 分支还原成 /(?<![\w.])effort\s*:/ 即四条全变红。
  assert.equal(isClaudeEffortUnsupportedError("Best-effort: not supported for this endpoint"), false);
  assert.equal(isClaudeEffortUnsupportedError("best-effort: unsupported delivery mode"), false);
  assert.equal(isClaudeEffortUnsupportedError("Low-effort: requests are not allowed on this tier"), false);
  assert.equal(isClaudeEffortUnsupportedError("Zero-effort: invalid configuration"), false);
  // 正面：裸 effort 出现在【键该出现的位置】（行首 / 紧跟 { , ; 或引号）仍要认，
  // 否则上面的收紧就成了把真投诉一起挡掉。
  assert.equal(isClaudeEffortUnsupportedError("effort: Input should be 'low', 'medium' or 'high'"), true);
  assert.equal(isClaudeEffortUnsupportedError("model: gpt-5, effort: input should be one of low, medium, high"), true);
  assert.equal(isClaudeEffortUnsupportedError("invalid request:\neffort: unsupported value xhigh"), true);
  // 边界（刻意如此，非缺陷）：`{"effort": "<一句话>"}` 判 false——「引号键 + 引号值」与请求体回显
  // 在形态上无法区分，抹除规则按设计把它当回显抹掉。真实的 pydantic / OpenAI 报错不是这个形状
  // （它们写成 output_config.effort: … 或 'effort' …，由前三支覆盖），故按"宁可漏判不可误判"接受。
  assert.equal(isClaudeEffortUnsupportedError('{"effort": "input should be one of low, medium, high"}'), false);

  // 中转把 Claude 形状翻成 OpenAI 后端时会回 OpenAI 措辞的报错。我方发的确实是思考强度，
  // 摘参重试正是对的处置，故这里刻意【认】——不是漏了收窄。
  assert.equal(isClaudeEffortUnsupportedError("Invalid 'reasoning_effort' for non-reasoning model: gpt-5-chat-latest"), true);

  // 反向不对称是有意的：非 Claude 渠道本就不该出现 output_config，认它只会扩大误判面，
  // 而漏判的代价仅是用户看见真实 400（本仓库一贯的取向：宁可漏判不可误判）。
  assert.equal(isReasoningEffortUnsupportedError("output_config.effort: Input should be 'low', 'medium' or 'high'"), false);
});

test("REASONING_EFFORT_LEVELS：七档全集，覆盖官方 per-model 取值的并集", () => {
  assert.deepEqual(REASONING_EFFORT_LEVELS, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("isReasoningEffortUnsupportedError：认全四类拒收，且不被请求体回显误导", () => {
  // ① 非推理模型
  assert.equal(isReasoningEffortUnsupportedError("Invalid 'reasoning_effort' for non-reasoning model: gpt-5-chat-latest"), true);
  // ② 不认这一档（取值 per-model，如 GPT-5.6 系无 minimal）
  assert.equal(isReasoningEffortUnsupportedError("Unsupported value: 'reasoning_effort' does not support 'minimal'"), true);
  // ③ 与 function tools 冲突（GPT-5.6 系在 chat/completions 上）
  assert.equal(
    isReasoningEffortUnsupportedError(
      "Function tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
    ),
    true,
  );
  // ④ 中转/非官方实现根本不认这个字段
  assert.equal(isReasoningEffortUnsupportedError("Unrecognized request argument supplied: reasoning_effort"), true);

  // 关键：400 常把我方请求体原样回显，只凭「文本里出现 reasoning_effort」会把无关错误
  // 误判成"该参数被拒" → 模型被永久加进摘参名单 → 此后静默按默认档跑却仍显示用户选的档位。
  assert.equal(isReasoningEffortUnsupportedError('{"error":"rate limit exceeded","request":{"reasoning_effort":"high"}}'), false);
  assert.equal(isReasoningEffortUnsupportedError("kwargs: reasoning_effort='high', temperature=0.2 -> upstream timeout"), false);
  // 不点名该参数的错误一律不认（哪怕含 unsupported 字样）
  assert.equal(isReasoningEffortUnsupportedError("Unsupported parameter: 'stream_options'"), false);
  assert.equal(isReasoningEffortUnsupportedError(""), false);
});

test("temperatureOverride：填写时覆盖协议默认温度，0 不被当作留空", () => {
  const openaiBase = {
    baseUrl: "https://api.example.com",
    apiKey: "sk-test",
    protocol: "openai_compatible",
    defaultModel: "gpt-test",
    maxTokens: 256,
  };

  // 留空 → OpenAI 协议保持既有默认 0.2
  assert.equal(buildProtocolRequest(openaiBase, "hi").body.temperature, 0.2);
  // 填 1（月之暗面这类只接受 temperature=1 的模型）
  assert.equal(buildProtocolRequest({ ...openaiBase, temperatureOverride: 1 }, "hi").body.temperature, 1);
  // 填 0 是合法值，不能被 falsy 判断吞掉回落成 0.2
  assert.equal(buildProtocolRequest({ ...openaiBase, temperatureOverride: 0 }, "hi").body.temperature, 0);
  // 流式分支同样生效
  assert.equal(buildProtocolStreamRequest({ ...openaiBase, temperatureOverride: 1 }, "hi").body.temperature, 1);

  const claudeBase = { ...openaiBase, protocol: "claude_messages", defaultModel: "claude-test" };
  // Claude 留空时不带该字段（保持模型自决策，Opus 4.7+ 会拒绝部分采样参数）
  assert.equal("temperature" in buildProtocolRequest(claudeBase, "hi").body, false);
  assert.equal("temperature" in buildProtocolStreamRequest(claudeBase, "hi").body, false);
  // 明确填写时才带上
  assert.equal(buildProtocolRequest({ ...claudeBase, temperatureOverride: 1 }, "hi").body.temperature, 1);
  assert.equal(buildProtocolStreamRequest({ ...claudeBase, temperatureOverride: 0 }, "hi").body.temperature, 0);
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
  const raw = ['data: {"choices":[{"delta":{"content":"hello"}}]}', "", "data: [DONE]", ""].join("\n");
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

// 把 Claude 包成 OpenAI 形状的中转会回「内容分片数组」而非字符串。此前 String(数组) 得到
// "[object Object]"——非空，于是空回复归一不会触发，这串垃圾会被当成模型答案存进报告并拿去打分。
test("extractOutputText：OpenAI 形状的数组 content → 拼出真文本，绝不能是 [object Object]", () => {
  assert.equal(
    extractOutputText("openai_compatible", {
      choices: [
        {
          message: {
            content: [
              { type: "text", text: "第一段" },
              { type: "text", text: "第二段" },
            ],
          },
        },
      ],
    }),
    "第一段\n第二段",
  );
});

test("extractOutputText：数组 content 里的思考块不计入可见输出（与 Claude 口径一致）", () => {
  assert.equal(
    extractOutputText("openai_compatible", {
      choices: [
        {
          message: {
            content: [
              { type: "thinking", text: "我先想想" },
              { type: "text", text: "答案" },
            ],
          },
        },
      ],
    }),
    "答案",
  );
});

test("extractOutputText：字符串 content 与空值行为不变（防回归）", () => {
  assert.equal(extractOutputText("openai_compatible", { choices: [{ message: { content: "  文本  " } }] }), "文本");
  assert.equal(extractOutputText("openai_compatible", { choices: [{ message: { content: null } }] }), "");
  assert.equal(extractOutputText("openai_compatible", { choices: [{ message: { content: [] } }] }), "");
  // 数组里没有任何可见文本 → 空串，交由上层判 empty_response（而非留下垃圾串）
  assert.equal(extractOutputText("openai_compatible", { choices: [{ message: { content: [{ type: "image_url" }] } }] }), "");
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
                  arguments: '{"city":"北京"}',
                },
              },
            ],
          },
        },
      ],
    }),
    {
      name: "get_weather",
      arguments: '{"city":"北京"}',
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
