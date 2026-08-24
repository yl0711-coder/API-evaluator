// server/protocols.mjs
// 协议适配层：按渠道协议（OpenAI Chat / OpenAI 兼容 / OpenAI 自定义前缀 / Claude Messages）构造请求，
// 解析响应与 SSE 流、抽取输出文本 / 工具调用 / usage，并把上游错误归一化为统一错误码。

// 「OpenAI 兼容但路径前缀不是 /v1」的协议：baseUrl 原样 + /chat/completions。
// 请求体与响应解析与 openai_compatible 完全一致——差别只在 URL 怎么拼，故所有
// isClaude 之外的分支都共用同一套 body 构造，只有这里分流。
//
// 存在的原因：不少厂商的 OpenAI 兼容端点前缀并非 /v1，直连时无法用固定 `${baseUrl}/v1/...` 拼出来：
//   · 智谱 GLM        https://open.bigmodel.cn/api/paas/v4  → /api/paas/v4/chat/completions
//   · 阿里 DashScope  https://dashscope.aliyuncs.com/compatible-mode/v1
//   · Google Gemini   https://generativelanguage.googleapis.com/v1beta/openai
//   · 火山方舟        https://ark.cn-beijing.volces.com/api/v3
// 此前这些只能「经中转站测」（中转会把前缀统一包成 /v1）；直连必然 404 → 报告上是一条
// 并不存在的「渠道不可用」。刻意不在代码里硬编码任何厂商的前缀：用户填平台后台给的完整
// 兼容端点地址，工具只补最后一段 /chat/completions——多一个厂商不需要改代码。
export const OPENAI_PATH_PREFIX_PROTOCOL = "openai_path_prefix";

// 推理强度（思考强度）的合法档位。官方口径：取值与默认值都是 **per-model** 的，
// 这个全集只是「可能出现的档位」，不代表任一模型都收全部七档
// （如 GPT-5.6 sol/terra/luna 支持 none/low/medium/high/xhigh/max，独缺 minimal）。
// 因此本工具只做「白名单挡掉手滑」，不做「保证上游一定接受」——发出去被 400 由传输层摘参重试兜底。
export const REASONING_EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

// Claude（Messages API）侧的合法档位：官方只定义 low / medium / high / xhigh / max，
// **没有 none 和 minimal**——这是与 OpenAI 系档位集合的实质差异，不是文档写漏。
// 另两条官方口径影响本文件的实现：
//   · effort 不需要开启 thinking，它约束**整个响应**的 token 花费（正文 + 工具调用 + 思考）；
//     故按 output_config 顶层字段发，与 thinking 无关。
//   · effort="high" 与「完全不发该字段」行为**完全等价**（high 即默认）。仍照发不做优化：
//     用户显式选了 high 就该在请求里看到，省掉它会让抓包对不上，也让日后默认档变更时行为静默漂移。
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

// 刻意【没有】工具级默认值：默认档位由厂商按模型各自调好（如 gpt-5.5 默认 medium），
// 我们凭空发一个"默认"等于悄悄改掉那个基线，报告里的质量/延迟/成本就不再代表用户直连时的表现。
// 留空 = 整个字段不出现在请求体里 = 用模型自己的默认档。
//
// 字段名用扁平 `reasoning_effort`：官方文档里写作 `reasoning.effort` 的是 Responses API 的嵌套形状，
// 而本工具打的是 /v1/chat/completions，那里的拼写是扁平的 reasoning_effort。
// 万一拼错或上游不认，传输层的 isReasoningEffortUnsupportedError 会摘参重试，不会让整轮判失败。
function applyReasoningEffort(body, profile) {
  if (profile.reasoningEffortOverride != null) {
    body.reasoning_effort = profile.reasoningEffortOverride;
  }
  return body;
}

// Claude 侧的思考强度。与 OpenAI 分支同一个 profile 字段（reasoningEffortOverride），
// 但落到请求里是 output_config.effort（嵌套），不是扁平的 reasoning_effort——两者不可混用：
// 把 OpenAI 的字段名发给 Claude 会被当未知参数 400，反之亦然。
//
// 【用户选了 Claude 不支持的档位（none / minimal）时就地丢弃，不发出去】
// 这与「发出去被 400 再摘参重试」的既有套路刻意不同：那套路用于**运行时才知道**的约束
// （某模型收不收某档、与工具调用冲不冲突）；而 none/minimal 不在 Claude 协议的取值域里，
// 是**编译期就已知**的事实，发一趟注定失败的请求只是白烧一次往返和额度。
// 丢弃必须留痕：置 effortDropped，由传输层转成 reasoningEffortStripped，
// 报告与提示卡照常写明「所选思考强度未生效」。静默丢弃才是本仓库最忌讳的失真。
function applyClaudeEffort(request, profile) {
  const effort = profile.reasoningEffortOverride;
  if (effort == null) return request;
  if (!CLAUDE_EFFORT_LEVELS.includes(effort)) {
    request.effortDropped = true;
    return request;
  }
  // 与已有字段合并而非整体赋值：output_config 日后可能承载别的子字段，直接盖会把它们冲掉。
  request.body.output_config = { ...(request.body.output_config || {}), effort };
  return request;
}

// 各协议的目标 URL。集中一处，四个 builder（普通/流式/工具/token 探针）都走它，
// 避免此前那样在 6 处各自硬编码字面量、加协议要逐个补。
export function buildProtocolUrl(protocol, baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (protocol === "claude_messages") return `${base}/v1/messages`;
  // baseUrl 已含厂商自己的版本前缀，不再补 /v1。
  if (protocol === OPENAI_PATH_PREFIX_PROTOCOL) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

export function buildProtocolRequest(profile, prompt) {
  const model = profile.defaultModel;
  const text = prompt.trim() || "请用一句话说明你现在可以正常工作。";
  const baseUrl = profile.baseUrl.replace(/\/+$/, "");

  if (profile.protocol === "claude_messages") {
    const body = {
      model,
      max_tokens: Number(profile.maxTokens || 512),
      // 显式非流式：规范里 stream 默认 false，但部分中转（尤其把 OpenAI 后端包成 Claude 格式的）
      // 不带该字段时会默认回 SSE，导致按 JSON 解析读不出文本、被误判成 empty_response。
      stream: false,
      messages: [{ role: "user", content: text }],
    };
    // Claude Messages API 一般不带 temperature（模型自决策），除非用户明确覆盖
    if (profile.temperatureOverride != null) {
      body.temperature = profile.temperatureOverride;
    }
    return applyClaudeEffort(
      {
        url: buildProtocolUrl(profile.protocol, baseUrl),
        headers: {
          "content-type": "application/json",
          "x-api-key": profile.apiKey,
          "anthropic-version": profile.anthropicVersion || "2023-06-01",
        },
        body,
      },
      profile,
    );
  }

  const body = applyReasoningEffort(
    {
      model,
      messages: [{ role: "user", content: text }],
      temperature: profile.temperatureOverride != null ? profile.temperatureOverride : 0.2,
      max_tokens: Number(profile.maxTokens || 512),
      stream: false,
    },
    profile,
  );
  return {
    url: buildProtocolUrl(profile.protocol, baseUrl),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${profile.apiKey}`,
    },
    body,
  };
}

export function buildProtocolToolRequest(profile) {
  const model = profile.defaultModel;
  const baseUrl = profile.baseUrl.replace(/\/+$/, "");
  const toolName = "get_weather";
  const prompt = "请调用 get_weather 查询北京天气，只返回工具调用，不要输出自然语言解释。";

  if (profile.protocol === "claude_messages") {
    const body = {
      model,
      max_tokens: Number(profile.maxTokens || 512),
      stream: false, // 同 buildProtocolRequest：不带该字段时部分中转会默认回 SSE。
      tools: [
        {
          name: toolName,
          description: "Get weather for a city",
          input_schema: {
            type: "object",
            properties: {
              city: {
                type: "string",
                description: "City name",
              },
            },
            required: ["city"],
          },
        },
      ],
      tool_choice: {
        type: "tool",
        name: toolName,
      },
      messages: [{ role: "user", content: prompt }],
    };
    // 同 buildProtocolRequest：Claude 侧默认不带 temperature（Opus 4.7+ 拒收采样参数），
    // 只在用户手填时才发。
    if (profile.temperatureOverride != null) {
      body.temperature = profile.temperatureOverride;
    }
    // 工具题同样带 effort。官方明说 effort 约束的是「全部 token，含工具调用参数」，
    // 低档会让模型少调工具——正是本题要观察的行为，不该在这里替用户抹掉。
    return applyClaudeEffort(
      {
        url: buildProtocolUrl(profile.protocol, baseUrl),
        headers: {
          "content-type": "application/json",
          "x-api-key": profile.apiKey,
          "anthropic-version": profile.anthropicVersion || "2023-06-01",
        },
        body,
      },
      profile,
    );
  }

  return {
    url: buildProtocolUrl(profile.protocol, baseUrl),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${profile.apiKey}`,
    },
    // 工具题也带 reasoning_effort（用户填了才带）。已知边界：GPT-5.6 系在
    // /v1/chat/completions 上「function tools + reasoning_effort≠none」直接不支持，报错原文
    // 「To use function tools, use /v1/responses or set reasoning_effort to 'none'」。
    // 刻意仍然发：被 400 后由传输层摘参重试，工具题照样能过，并在报告里标注「档位被摘」——
    // 比这里静默不发好，后者会让用户以为工具题是在他选的档位下通过的。
    body: applyReasoningEffort(
      {
        model,
        messages: [{ role: "user", content: prompt }],
        // 工具调用题默认用 0 求确定性（结构对不对不该受采样影响）。用户手填温度时以手填为准——
        // 有些模型只接受特定温度（如月之暗面只认 1），硬发 0 会让这一题必然 400，
        // 报告上就成了一条并不存在的「工具调用不可用」。
        temperature: profile.temperatureOverride != null ? profile.temperatureOverride : 0,
        max_tokens: Number(profile.maxTokens || 512),
        stream: false,
        tools: [
          {
            type: "function",
            function: {
              name: toolName,
              description: "Get weather for a city",
              parameters: {
                type: "object",
                properties: {
                  city: {
                    type: "string",
                    description: "City name",
                  },
                },
                required: ["city"],
              },
            },
          },
        ],
        tool_choice: {
          type: "function",
          function: {
            name: toolName,
          },
        },
      },
      profile,
    ),
  };
}

// includeUsage：OpenAI 流式默认不返回 usage，必须显式 stream_options 才有 token 数。
// 做成可选参数而非写死：只有「生成类」流式探测需要 token 数才传 true；
// 准入的 stream_structure 用例（只校验 SSE 结构）不传，行为保持原样，
// 免得个别中转不认 stream_options 直接 400、把原本能过的用例弄挂。
export function buildProtocolStreamRequest(profile, prompt, { includeUsage = false } = {}) {
  const model = profile.defaultModel;
  const text = prompt.trim() || "请用一句话说明你现在可以正常工作。";
  const baseUrl = profile.baseUrl.replace(/\/+$/, "");

  if (profile.protocol === "claude_messages") {
    const body = {
      model,
      max_tokens: Number(profile.maxTokens || 512),
      stream: true,
      messages: [{ role: "user", content: text }],
    };
    // Claude Messages API 一般不带 temperature（模型自决策），除非用户明确覆盖
    if (profile.temperatureOverride != null) {
      body.temperature = profile.temperatureOverride;
    }
    return applyClaudeEffort(
      {
        url: buildProtocolUrl(profile.protocol, baseUrl),
        headers: {
          "content-type": "application/json",
          "x-api-key": profile.apiKey,
          "anthropic-version": profile.anthropicVersion || "2023-06-01",
        },
        body,
      },
      profile,
    );
  }

  const body = applyReasoningEffort(
    {
      model,
      messages: [{ role: "user", content: text }],
      temperature: profile.temperatureOverride != null ? profile.temperatureOverride : 0.2,
      max_tokens: Number(profile.maxTokens || 512),
      stream: true,
      // Claude 分支无需对应字段：其流式原生带 usage（message_start + message_delta），
      // coalesceClaudeSse 已做合并。
      ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
    },
    profile,
  );
  return {
    url: buildProtocolUrl(profile.protocol, baseUrl),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${profile.apiKey}`,
    },
    body,
  };
}

export function parseSseEvents(raw) {
  const events = [];
  let eventName = "";
  const dataLines = [];

  const flush = () => {
    if (!eventName && dataLines.length === 0) return;
    const data = dataLines.join("\n");
    events.push({
      event: eventName,
      data,
      parsed: data && data !== "[DONE]" ? safeJsonForProtocol(data) : null,
    });
    eventName = "";
    dataLines.length = 0;
  };

  for (const line of String(raw || "").split(/\r?\n/)) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  flush();
  return events;
}

export function summarizeStreamStructure(protocol, raw) {
  const events = parseSseEvents(raw);
  if (protocol === "claude_messages") {
    return summarizeClaudeStream(events, raw);
  }
  return summarizeOpenAiStream(events, raw);
}

// 兜底：上游无视 stream:false、直接回 SSE 时，把流式事件重新拼回「非流式响应」的形状，
// 于是 extractOutputText / extractUsage / extractFinishReason / extractToolCall 无需改动即可复用。
// 非 SSE（或空流）返回 null，交由调用方按原逻辑判错。
export function coalesceSseResponse(protocol, raw) {
  const events = parseSseEvents(raw);
  if (!events.length) return null;
  return protocol === "claude_messages" ? coalesceClaudeSse(events) : coalesceOpenAiSse(events);
}

function coalesceClaudeSse(events) {
  const blocks = new Map(); // index -> { type, text, name, id, jsonParts }
  let usage = null;
  let stopReason = null;
  let sawAny = false;

  const blockAt = (index) => {
    const idx = Number.isInteger(index) ? index : 0;
    let block = blocks.get(idx);
    if (!block) {
      block = { type: "text", text: "", name: "", id: "", jsonParts: [] };
      blocks.set(idx, block);
    }
    return block;
  };

  for (const item of events) {
    const type = item.event || item.parsed?.type || "";
    const data = item.parsed || {};
    if (!type) continue;
    sawAny = true;

    if (type === "message_start") {
      if (data.message?.usage) usage = { ...data.message.usage };
    } else if (type === "content_block_start") {
      const cb = data.content_block || {};
      const idx = Number.isInteger(data.index) ? data.index : blocks.size;
      blocks.set(idx, { type: cb.type || "text", text: cb.text || "", name: cb.name || "", id: cb.id || "", jsonParts: [] });
    } else if (type === "content_block_delta") {
      const block = blockAt(data.index);
      const delta = data.delta || {};
      if (delta.type === "text_delta") block.text += delta.text || "";
      else if (delta.type === "input_json_delta") block.jsonParts.push(delta.partial_json || "");
      // thinking_delta 等其它增量不计入可见文本（与非流式响应里 thinking 不进 content 一致）。
    } else if (type === "message_delta") {
      if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
      if (data.usage) usage = { ...(usage || {}), ...data.usage };
    }
  }
  if (!sawAny) return null;

  const content = [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, block]) => {
      if (block.type !== "tool_use") return { type: block.type || "text", text: block.text };
      const joined = block.jsonParts.join("");
      let input = {};
      if (joined) {
        try {
          input = JSON.parse(joined);
        } catch {
          // 参数被截断 → 保留空对象，交由上层按 tool_call 参数缺失处理。
        }
      }
      return { type: "tool_use", name: block.name, id: block.id, input };
    });

  return { content, stop_reason: stopReason, ...(usage ? { usage } : {}) };
}

function coalesceOpenAiSse(events) {
  const toolCalls = new Map(); // index -> { id, name, argParts }
  let content = "";
  let finishReason = null;
  let usage = null;
  let sawAny = false;

  for (const item of events) {
    if (item.data === "[DONE]") {
      sawAny = true;
      continue;
    }
    const data = item.parsed;
    if (!data || typeof data !== "object") continue;
    sawAny = true;
    if (data.usage) usage = data.usage;

    const choice = data.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === "string") content += delta.content;

    for (const call of delta.tool_calls || []) {
      const idx = Number.isInteger(call.index) ? call.index : 0;
      let entry = toolCalls.get(idx);
      if (!entry) {
        entry = { id: "", name: "", argParts: [] };
        toolCalls.set(idx, entry);
      }
      if (call.id) entry.id = call.id;
      if (call.function?.name) entry.name = call.function.name;
      if (call.function?.arguments) entry.argParts.push(call.function.arguments);
    }
  }
  if (!sawAny) return null;

  const message = { role: "assistant", content };
  if (toolCalls.size) {
    message.tool_calls = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, entry]) => ({
        id: entry.id,
        type: "function",
        // 非流式响应里 arguments 也是 JSON 字符串，拼接后形状一致。
        function: { name: entry.name, arguments: entry.argParts.join("") },
      }));
  }
  return { choices: [{ message, finish_reason: finishReason }], ...(usage ? { usage } : {}) };
}

export function extractOutputText(protocol, parsed) {
  if (!parsed || typeof parsed !== "object") {
    return "";
  }

  if (protocol === "claude_messages") {
    const content = Array.isArray(parsed.content) ? parsed.content : [];
    return content
      .map((item) => (item && item.type === "text" ? item.text || "" : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  const content = parsed.choices?.[0]?.message?.content;
  // 把 Claude 包成 OpenAI 形状的中转会回「内容分片数组」而非字符串。String(数组) 得到
  // "[object Object]"——非空，于是 normalizeEmptyResponse 不会触发，这串垃圾会被当成模型答案
  // 存进报告并拿去打分。按分片取 text，与上面 Claude 分支同口径（thinking/reasoning 不算可见输出）。
  if (Array.isArray(content)) {
    return content
      .map((item) => (item && typeof item.text === "string" && item.type !== "thinking" && item.type !== "reasoning" ? item.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return String(content || "").trim();
}

// 截断信号：OpenAI choices[0].finish_reason==="length" / Claude stop_reason==="max_tokens"，
// 表示输出被 max_tokens 截断（含推理模型把预算花在思考、最终答案没输出完）。返回原始 reason 或 null。
export function extractFinishReason(protocol, parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (protocol === "claude_messages") return parsed.stop_reason ?? null;
  return parsed.choices?.[0]?.finish_reason ?? null;
}

export function isTruncatedFinish(reason) {
  return reason === "length" || reason === "max_tokens";
}

export function extractToolCall(protocol, parsed) {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  if (protocol === "claude_messages") {
    const content = Array.isArray(parsed.content) ? parsed.content : [];
    const toolUse = content.find((item) => item && item.type === "tool_use");
    return toolUse
      ? {
          name: toolUse.name || "",
          arguments: toolUse.input || {},
        }
      : null;
  }

  const toolCall = parsed.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) {
    return null;
  }
  return {
    name: toolCall.function?.name || toolCall.name || "",
    arguments: toolCall.function?.arguments || toolCall.arguments || {},
  };
}

export function extractUsage(parsed) {
  if (!parsed || typeof parsed !== "object" || !parsed.usage) {
    return null;
  }

  const usage = parsed.usage;
  // 2026 年成本大头：缓存读写 + 推理 token。各家字段名不同，统一归一。
  // OpenAI：prompt_tokens_details.cached_tokens / completion_tokens_details.reasoning_tokens
  // Anthropic：cache_creation_input_tokens / cache_read_input_tokens（thinking 已计入 output_tokens）
  const promptDetails = usage.prompt_tokens_details || usage.input_tokens_details || {};
  const completionDetails = usage.completion_tokens_details || usage.output_tokens_details || {};

  return {
    inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
    outputTokens: usage.completion_tokens ?? usage.output_tokens ?? null,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? usage.cache_creation_tokens ?? null,
    cacheReadTokens: usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? promptDetails.cached_tokens ?? null,
    reasoningTokens: usage.reasoning_tokens ?? completionDetails.reasoning_tokens ?? null,
  };
}

export function normalizeHttpError(status, raw) {
  const text = String(raw || "").toLowerCase();
  if (status === 401 || status === 403) return "auth_failed";
  if (text.includes("content block not found")) return "content_block_not_found";
  if (status === 404 || /model.*not.*found|unknown model|invalid model/.test(text)) return "model_not_found";
  if (status === 429) return "rate_limited";
  if (/rate limit|too many requests|quota exceeded|insufficient quota/.test(text)) return "rate_limited";
  if (status >= 500) return "upstream_5xx";
  return "invalid_response";
}

// 上游报 400 时经常把我方请求体原样回显（不少中转带 request 字段，LiteLLM 直接 dump kwargs）。
// 于是「错误文本里出现 temperature / stream_options」根本不能证明它就是被拒的那个参数——
// 只要我们发了它，回显里就必然有。这里先抹掉「作为字典键/kwarg 出现」的那些
// （`"x": <值>` / `'x': <值>` / `x=<值>`，靠值的起始形状识别），剩下还提到，才算上游确实点名了它。
// 刻意不抹 `x: Extra inputs are not permitted` 这种——冒号后跟的是抱怨而非值，那是真投诉（pydantic 风格）。
// 取向：宁可漏判也不能误判。漏判只是这次请求照旧 400（用户看得见真实报错）；
// 误判会把模型永久加进进程级摘参名单（见 test-runner 的 *_UNSUPPORTED_MODELS），
// 此后静默丢 usage / 丢 temperature，报告数字变错却毫无提示。
function errorNamesParam(text, param) {
  const echoedKey = new RegExp(`["']?\\b${param}\\b["']?\\s*[:=]\\s*(?=[{\\[]|["']|-?\\d|true\\b|false\\b|null\\b)`, "g");
  return text.replace(echoedKey, " ").includes(param);
}

// 部分 OpenAI 系模型（推理模型 o 系、GPT-5 系）不再接受自定义 temperature，只允许默认值，
// 收到 temperature≠默认会返回 400（如 "Unsupported value: 'temperature' does not support 0.2 ...
// Only the default (1) value is supported."）。识别这类错误，以便去掉 temperature 后重试。
export function isTemperatureUnsupportedError(raw) {
  const text = String(raw || "").toLowerCase();
  if (!errorNamesParam(text, "temperature")) return false;
  return (
    text.includes("unsupported") || // Unsupported value/parameter: 'temperature'
    text.includes("does not support") || // does not support 0.2 with this model
    text.includes("only the default") || // Only the default (1) value is supported
    text.includes("not supported") // 'temperature' is not supported with this model
  );
}

// 首个「可见输出 token」的到达标记（供流式 TTFT 打点）。
// 不能用「首个 SSE 分片到达」近似：Claude 首帧是 message_start（不含任何文本）、部分中转还会先发
// 保活注释（`: ping`）或换行开流——都会让 TTFT 系统性偏快，且 Claude 与 OpenAI 口径不对等、无法横评。
// 返回不带 /g 的正则（.test 无状态），交给流式读取器逐分片对累积缓冲匹配。
export function firstTokenPatternFor(protocol) {
  if (protocol === "claude_messages") {
    // text_delta=可见文本；input_json_delta=工具参数（工具流的首个真实产出）。
    // thinking_delta 不算：它不进可见输出（见 extractOutputText），计入会让推理模型显得反应更快。
    return /"type"\s*:\s*"(?:text_delta|input_json_delta)"/;
  }
  // OpenAI：delta.content 的首个非空字符串；工具流以 tool_calls 出现为准。
  // 要求引号后至少一个字符，从而排除角色帧 "content":"" 与 "content":null；
  // "reasoning_content" 不会误命中（其 content 前是下划线而非引号）。
  return /"content"\s*:\s*"[^"]|"tool_calls"\s*:\s*\[/;
}

// 部分中转 / 非 OpenAI 官方实现不认 stream_options（流式取 usage 的必需参数），收到会直接 400
// （如 "Unrecognized request argument supplied: stream_options"、"Extra inputs are not permitted"）。
// 识别这类错误，以便去掉 stream_options 后重试——代价仅是拿不到上游 usage，
// 调用方（load-test 的 deriveOutputTokens）本就会回退按字符估算，不影响成败判定。
// 与 isTemperatureUnsupportedError 同款保守口径：必须点名 stream_options 才认（见 errorNamesParam——
// 单纯 includes 挡不住回显：正因为我们发了 stream_options，回显里才必然带着它）。
export function isStreamOptionsUnsupportedError(raw) {
  const text = String(raw || "").toLowerCase();
  if (!errorNamesParam(text, "stream_options")) return false;
  return (
    text.includes("unsupported") || // Unsupported parameter: 'stream_options'
    text.includes("not supported") || // stream_options is not supported
    text.includes("does not support") ||
    text.includes("unrecognized") || // Unrecognized request argument supplied: stream_options
    text.includes("unknown") || // Unknown parameter: 'stream_options'
    text.includes("unexpected") || // unexpected keyword argument
    text.includes("not permitted") || // Extra inputs are not permitted（pydantic 系）
    text.includes("not allowed") ||
    text.includes("invalid")
  );
}

// 上游拒收 reasoning_effort（思考强度）的几种情形，识别后由传输层删参重试：
//   ① 该模型不是推理模型 —— "Invalid 'reasoning_effort' for non-reasoning model"
//   ② 该模型不认这一档 —— 取值是 per-model 的，如 GPT-5.6 系不支持 minimal
//   ③ 与 function tools 冲突 —— GPT-5.6 系在 chat/completions 上要求
//      "use /v1/responses or set reasoning_effort to 'none'"
//   ④ 中转 / 非官方实现根本不认这个字段
// 同 isTemperatureUnsupportedError / isStreamOptionsUnsupportedError 的保守口径：必须点名
// reasoning_effort 才认（见 errorNamesParam——我们发了它，400 的请求体回显里就必然带着它）。
// 宁可漏判也不误判：漏判只是这次照旧 400（用户看得见真实报错）；误判会把模型加进进程级摘参名单，
// 此后静默按模型默认档跑，报告却显示用户选的档位——那是最坏的失真。
export function isReasoningEffortUnsupportedError(raw) {
  const text = String(raw || "").toLowerCase();
  if (!errorNamesParam(text, "reasoning_effort")) return false;
  return (
    text.includes("unsupported") ||
    text.includes("not supported") ||
    text.includes("does not support") ||
    text.includes("unrecognized") ||
    text.includes("unknown") ||
    text.includes("unexpected") ||
    text.includes("not permitted") ||
    text.includes("not allowed") ||
    text.includes("invalid") || // Invalid 'reasoning_effort' for non-reasoning model
    text.includes("only the default") ||
    text.includes("/v1/responses") || // 「改用 Responses API 或设成 none」这类改道建议
    text.includes("responses api")
  );
}

// 上游要求把 max_tokens 改名成 max_completion_tokens。OpenAI 从 o1 起把 max_tokens 标为
// deprecated，GPT-5 系（已确认到 5.4）直接 400：
//   "Unsupported parameter: 'max_tokens' is not supported with this model.
//    Use 'max_completion_tokens' instead."
// 不处理的后果不是少一项指标，而是**整轮全灭**：四个 builder 全都发 max_tokens，直连这类模型
// 每一道用例都 400 → successRate 0 → grade F → 报告写「暂不建议接入」。一条健康渠道被报成不可用，
// 与此前直连智谱必然 404 是同一类假失败。
//
// 【这一类必须改名，不能像 temperature / stream_options / reasoning_effort 那样摘掉】
// 那三个都是可选参数，摘了只是少个约束；max_tokens 是输出上限，摘掉等于放开到模型自己的上限
// （GPT-5.6 是 128K）。代价不只是钱：场景题刻意设 8192/4096、压测按 4096 收口，且传输层还有
// MAX_UPSTREAM_RESPONSE_BYTES 字节上限——放开 token 上限会把响应顶到那个截断分支，
// 变成 response_too_large 判 F，又是一条假失败。
//
// 【判定要求同时点名两个字段】——这是刻意的严格：
// 只说「max_tokens 不支持」而不给替代名，改成什么就是猜；猜错照旧 400，还多烧一次往返。
// 那种情况宁可让用户看见真实报错（本仓库一贯取向：宁可漏判不可误判）。
// 必须有「拒收词」才认，且先抹掉请求体回显（见 errorNamesParam）：我方发的就是 max_tokens，
// 400 的回显里必然带着它，单纯 includes 挡不住。
export function isMaxTokensRenameRequiredError(raw) {
  const text = String(raw || "").toLowerCase();
  // 替代名只作为「上游给出了改名建议」的证据，不参与回显判定：它不可能出现在我方请求体里。
  if (!text.includes("max_completion_tokens")) return false;
  if (!errorNamesParam(text, "max_tokens")) return false;
  return (
    text.includes("unsupported") || // Unsupported parameter: 'max_tokens'
    text.includes("not supported") || // is not supported with this model
    text.includes("does not support") ||
    text.includes("instead") || // Use 'max_completion_tokens' instead
    text.includes("deprecated") ||
    text.includes("invalid") ||
    text.includes("unrecognized")
  );
}

// 上游拒收 Claude 侧思考强度（output_config.effort）的情形。刻意与
// isReasoningEffortUnsupportedError 分开：两边的字段名不同（嵌套 output_config.effort vs 扁平
// reasoning_effort），共用一个探测器会互相漏判——按 "reasoning_effort" 点名去查 Claude 的报错，
// 永远查不到，摘参重试就永不触发。
// 拒收来源有二：
//   ① 老版本 API / 中转不认 output_config 这个顶层字段
//      —— Anthropic 是 pydantic 风格，原文形如 "output_config: Extra inputs are not permitted"
//   ② 该模型不支持所选档位（xhigh / max 是后加的，老模型只到 high）
//      —— 原文形如 "output_config.effort: Input should be 'low', 'medium' or 'high'"
// 同款保守口径：必须点名 effort 或 output_config 才认（见 errorNamesParam，挡请求体回显）。
// 「上游点名了 Claude 侧的思考强度字段」的判定。刻意不直接用 errorNamesParam(text, "effort")：
// 那个函数最后一步是纯子串 includes，裸 "effort" 会命中任何含该英文词的句子——实测
// "Best-effort routing is not supported for this endpoint" 会被判成 true，于是模型被永久加进
// 进程级摘参名单，此后静默按默认档跑却仍显示用户选的档位。那是本仓库最忌讳的失真。
// 故只认三种「确实在指字段」的形态：
//   ① 嵌套路径 output_config.effort
//   ② 带引号的字段形态（'effort' / "effort"——pydantic 与 OpenAI 系报错都是这个样子）
//   ③ 容器被整体拒收（output_config 这个名字不与任何英文词碰撞，交给 errorNamesParam 即可）
//   ④ 裸 effort 作为键，且**位于键该出现的位置**（行首，或紧跟 { , ; 或引号）
// 另外刻意【认】扁平的 reasoning_effort：中转把 Claude 形状翻成 OpenAI 后端时，回的是 OpenAI
// 措辞的报错，而我方发的确实是思考强度——摘参重试正是对的处置。
// 反向不对称（isReasoningEffortUnsupportedError 不认 output_config）是有意的：非 Claude 渠道
// 本就不该出现这个字段，认它只会扩大误判面，而漏判的代价仅是用户看见真实 400。
function errorNamesClaudeEffort(text) {
  if (text.includes("reasoning_effort")) return true;
  if (text.includes("output_config.effort")) return true;
  if (errorNamesParam(text, "output_config")) return true;
  // 带引号的字段形态（'effort' / "effort"），或裸 effort 作为键出现。
  // 先抹掉「键: 值」的请求体回显，剩下还提到才算真投诉。
  const stripped = text.replace(/["']effort["']\s*[:=]\s*(?=[{[]|["']|-?\d|true\b|false\b|null\b)/g, " ");
  if (/["']effort["']/.test(stripped)) return true;
  // 裸 effort + 冒号：必须出现在【键该出现的位置】——行首，或紧跟 { , ; 或引号。
  // 【为什么不能只用 (?<![\w.]) 排除前缀】那个 lookbehind 不排除连字符，于是
  // "Best-effort: not supported" / "Low-effort: not allowed" 这类**与思考强度无关**的网关报错
  // 全被判成"该参数被拒"（四个变体实测复现）→ 模型被永久加进进程级摘参名单 →
  // 此后静默按默认档跑，报告却写「思考强度未生效」，把排查引向"模型支持哪些档位"，
  // 而真实原因在网关容量配置。这是本仓库最忌讳的那类归因失真。
  // 【刻意接受的漏判】句中散文式的 "Invalid value for effort: xhigh"（effort 前是空格）不再认。
  // 实证依据：Anthropic / pydantic 与 OpenAI 系的真实报错都写成字段路径或带引号形态
  // （output_config.effort: … / 'effort' …），已由上面三支覆盖；而"best effort"作为英文习语
  // 在基础设施报错里是真实存在的。两害相权取漏判：漏判的代价仅是用户看见真实 400（自己能看懂），
  // 误判的代价是静默丢掉用户选的档位 + 误导排查方向。
  return /(?:^|[\n\r{,;"'])\s*effort\s*:/.test(stripped);
}

export function isClaudeEffortUnsupportedError(raw) {
  const text = String(raw || "").toLowerCase();
  if (!errorNamesClaudeEffort(text)) return false;
  return (
    text.includes("unsupported") ||
    text.includes("not supported") ||
    text.includes("does not support") ||
    text.includes("unrecognized") || // Unrecognized request argument supplied: output_config
    text.includes("unknown") ||
    text.includes("unexpected") ||
    text.includes("not permitted") || // Extra inputs are not permitted（Anthropic 的 pydantic 风格）
    text.includes("not allowed") ||
    text.includes("invalid") ||
    text.includes("input should be") || // Input should be 'low', 'medium' or 'high'
    text.includes("should be one of")
  );
}

export function normalizeEmptyResponse(raw) {
  const text = String(raw || "").toLowerCase();
  if (text.includes("content block not found")) return "content_block_not_found";
  if (/model.*not.*found|unknown model|invalid model/.test(text)) return "model_not_found";
  if (/rate limit|too many requests|quota exceeded|insufficient quota/.test(text)) return "rate_limited";
  return "empty_response";
}

function summarizeClaudeStream(events, raw) {
  const issues = [];
  let sawMessageStart = false;
  let sawContentStart = false;
  let sawDelta = false;
  let sawContentStop = false;
  let sawMessageStop = false;
  let invalidOrder = false;

  // per-index block 跟踪，覆盖 `Content block not found` 的四根因里的三条：
  //   根因1 content_block_dropped：delta 落在从未 start 的 index（大输出常触发）。
  //   根因2 delta_block_mismatch：delta 类型与 block 类型不符（text_delta 打到 tool_use 等）。
  //   根因3 tool_args_lost：tool_use 的 input_json_delta 拼接后不是合法 JSON（参数丢失/截断）。
  const blocks = new Map(); // index -> { type, jsonParts, sawDelta }
  let contentBlockDropped = false;
  let deltaBlockMismatch = false;
  let toolArgsLost = false;

  for (const item of events) {
    const type = item.event || item.parsed?.type || "";
    const data = item.parsed || {};
    const index = Number.isInteger(data.index) ? data.index : null;

    if (type === "message_start") {
      sawMessageStart = true;
    } else if (type === "content_block_start") {
      if (!sawMessageStart) invalidOrder = true;
      sawContentStart = true;
      if (index !== null) {
        blocks.set(index, { type: data.content_block?.type || "", jsonParts: [], sawDelta: false });
      }
    } else if (type === "content_block_delta") {
      if (!sawContentStart) invalidOrder = true;
      sawDelta = true;
      const block = index !== null ? blocks.get(index) : null;
      if (index !== null && !block) {
        contentBlockDropped = true; // 根因1：start 丢失
      }
      const deltaType = data.delta?.type || "";
      if (block) {
        block.sawDelta = true;
        if (deltaType === "text_delta" && block.type && block.type !== "text") {
          deltaBlockMismatch = true; // 根因2
        }
        if (deltaType === "input_json_delta") {
          if (block.type && block.type !== "tool_use") deltaBlockMismatch = true; // 根因2
          block.jsonParts.push(String(data.delta?.partial_json ?? ""));
        }
      }
    } else if (type === "content_block_stop") {
      if (!sawContentStart) invalidOrder = true;
      sawContentStop = true;
    } else if (type === "message_stop") {
      sawMessageStop = true;
    } else if (type === "error") {
      issues.push("stream_error_event");
    }
  }

  // 根因3：tool_use 参数完整性——有 input_json_delta 但拼起来非空且不可解析 → 参数丢失/截断。
  // 空串不判（无法区分"无参工具"与"全丢"），避免误报。
  for (const block of blocks.values()) {
    if (block.type === "tool_use" && block.jsonParts.length > 0) {
      const joined = block.jsonParts.join("").trim();
      if (joined !== "" && safeJsonForProtocol(joined) === null) {
        toolArgsLost = true;
      }
    }
  }

  if (!events.length) issues.push("empty_stream");
  if (!sawMessageStart) issues.push("missing_message_start");
  if (!sawContentStart) issues.push("missing_content_block_start");
  if (!sawDelta) issues.push("missing_content_block_delta");
  if (!sawContentStop) issues.push("missing_content_block_stop");
  if (!sawMessageStop) issues.push("missing_message_stop");
  if (invalidOrder) issues.push("event_order_invalid");
  if (contentBlockDropped) issues.push("content_block_dropped");
  if (deltaBlockMismatch) issues.push("delta_block_mismatch");
  if (toolArgsLost) issues.push("tool_args_lost");
  if (/content block not found/i.test(String(raw || ""))) issues.push("content_block_not_found");

  return {
    protocol: "claude_messages",
    passed: issues.length === 0,
    eventCount: events.length,
    issues,
    flags: {
      messageStart: sawMessageStart,
      contentBlockStart: sawContentStart,
      contentBlockDelta: sawDelta,
      contentBlockStop: sawContentStop,
      messageStop: sawMessageStop,
      blockCount: blocks.size,
      contentBlockDropped,
      deltaBlockMismatch,
      toolArgsLost,
    },
  };
}

function summarizeOpenAiStream(events, raw) {
  const issues = [];
  let sawDelta = false;
  let sawDone = false;
  let sawErrorEvent = false;
  let invalidJsonChunks = 0;

  for (const item of events) {
    // 保活/空帧：`event: ping` 这种只有 event 行的、以及空 `data:` 的心跳帧，都不是 JSON 分片。
    // 计入 invalidJsonChunks 会把健康中转误判成「SSE 结构坏了」——评测工具最不该犯的错。
    // （`: ping` 注释帧在 parseSseEvents 就被跳过了，这里兜住另外两种形态。）
    // 顺带容忍 `data: [DONE] ` 这类带尾随空白的收尾帧，同属「良性空白被当成坏数据」。
    const data = String(item.data || "").trim();
    if (!data) continue;
    if (data === "[DONE]") {
      sawDone = true;
      continue;
    }
    if (!item.parsed) {
      invalidJsonChunks += 1;
      continue;
    }
    // 错误帧：上游吐到一半改口报错（输出被截断）。只看结构完整性会误判「通过」——
    // delta 有、[DONE] 也有。Claude 路径一直有这道检查（stream_error_event），此处对齐。
    // 只认真值 error：部分中转每帧都带 "error":null，当错误帧会把健康流全判失败。
    if (item.event === "error" || item.parsed.error) {
      sawErrorEvent = true;
      continue;
    }
    const choices = Array.isArray(item.parsed.choices) ? item.parsed.choices : [];
    const delta = choices[0]?.delta;
    if (delta && typeof delta === "object" && Object.keys(delta).length > 0) {
      sawDelta = true;
    }
  }

  if (!events.length) issues.push("empty_stream");
  if (!sawDelta) issues.push("missing_delta");
  if (!sawDone) issues.push("missing_done");
  if (invalidJsonChunks > 0) issues.push("invalid_json_chunk");
  if (sawErrorEvent) issues.push("stream_error_event");
  if (/content block not found/i.test(String(raw || ""))) issues.push("content_block_not_found");

  return {
    protocol: "openai_compatible",
    passed: issues.length === 0,
    eventCount: events.length,
    issues,
    flags: {
      delta: sawDelta,
      done: sawDone,
      errorEvent: sawErrorEvent,
      invalidJsonChunks,
    },
  };
}

function safeJsonForProtocol(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
