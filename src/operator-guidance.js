export const PROFILE_TEMPLATES = {
  relay_openai_compatible: {
    label: "AI 中转站 / OpenAI 兼容",
    provider: "",
    protocol: "openai_compatible",
    baseUrlPlaceholder: "https://api.example.com",
    modelPlaceholder: "claude-sonnet-4-5 / gpt-4.1 / deepseek-chat",
    maxTokens: "512",
    timeoutMs: "60000",
    notes: "适合大多数中转站。Base URL 只填网关基础地址，不要填 /v1/chat/completions。",
  },
  claude_native: {
    label: "Claude 原生 Messages",
    provider: "Anthropic",
    protocol: "claude_messages",
    baseUrlPlaceholder: "https://api.anthropic.com",
    modelPlaceholder: "claude-sonnet-4-5",
    maxTokens: "512",
    timeoutMs: "120000",
    notes: "只有明确使用 Anthropic Claude Messages 原生接口时选择。中转站通常不要选这个。",
  },
  openai_official: {
    label: "OpenAI 官方 / Chat Completions",
    provider: "OpenAI",
    protocol: "openai_chat",
    baseUrlPlaceholder: "https://api.openai.com",
    modelPlaceholder: "gpt-4.1 / gpt-4.1-mini",
    maxTokens: "512",
    timeoutMs: "60000",
    notes: "适合 OpenAI Chat Completions 兼容路径。Base URL 不需要填写 /v1/chat/completions。",
  },
  deepseek_openai_compatible: {
    label: "DeepSeek / OpenAI 兼容",
    provider: "DeepSeek",
    protocol: "openai_compatible",
    baseUrlPlaceholder: "https://api.deepseek.com",
    modelPlaceholder: "deepseek-chat / deepseek-reasoner",
    maxTokens: "1024",
    timeoutMs: "120000",
    notes: "推理模型响应可能更慢，复杂测试建议把超时调到 120000ms。",
  },
};

export const SCENARIO_PACKS = {
  "scenario-small": {
    label: "低成本初筛包",
    categories: ["connectivity", "speed", "structured"],
    limit: 3,
    repeats: "1",
    maxParallelProfiles: "1",
    requestConcurrency: "1",
    note: "适合第一次验证，只确认连通、速度和结构化输出。",
  },
  "scenario-coding": {
    label: "编程能力包",
    categories: ["coding", "reasoning"],
    limit: 4,
    repeats: "1",
    maxParallelProfiles: "1",
    requestConcurrency: "1",
    note: "适合测试代码排错、工程分析和复杂决策。",
  },
  "scenario-long-context": {
    label: "长上下文包",
    categories: ["long_context", "reasoning", "writing"],
    limit: 4,
    repeats: "1",
    maxParallelProfiles: "1",
    requestConcurrency: "1",
    note: "适合验证大输入、资料归纳和业务说明能力，token 消耗较高。",
  },
  "scenario-safety": {
    label: "内容安全合规包",
    categories: ["safety"],
    limit: Infinity,
    repeats: "1",
    maxParallelProfiles: "1",
    requestConcurrency: "1",
    note: "用于低风险探测色情、暴力、血腥、政治谣言等内容是否被安全拒绝或改写。不会发送露骨细节。",
  },
  "scenario-basic": {
    label: "基础能力全量包",
    categories: ["connectivity", "speed", "structured", "coding", "long_context", "reasoning", "writing"],
    limit: Infinity,
    repeats: "1",
    maxParallelProfiles: "2",
    requestConcurrency: "1",
    note: "适合稳定性已通过后的基础能力评估。",
  },
  "scenario-deep": {
    label: "候选深度复测包",
    categories: ["connectivity", "speed", "structured", "coding", "long_context", "reasoning", "writing"],
    limit: Infinity,
    repeats: "2",
    maxParallelProfiles: "2",
    requestConcurrency: "1",
    note: "适合准备推荐某个候选渠道前复测，成本更高。",
  },
};

const ERROR_ADVICES = {
  auth_failed: {
    title: "认证失败",
    cause: "Key 错误、Key 没权限、余额不足，或鉴权头和协议不匹配。",
    actions: ["在 API 配置里点击“更新 Key”重新录入。", "确认账号余额、模型权限和渠道权限。", "重新跑 1 次快速测试，不要直接跑稳定性测试。"],
  },
  model_not_found: {
    title: "模型不可用",
    cause: "模型名写错，或当前渠道没有开通这个模型。",
    actions: ["复制平台后台展示的模型名，不要凭记忆填写。", "如果是中转站，确认该渠道是否支持这个模型。", "用默认短 Prompt 重新跑快速测试。"],
  },
  rate_limited: {
    title: "触发限流",
    cause: "请求太频繁、并发太高、套餐额度不够，或渠道本身有限流。",
    actions: ["把并发调成 1，轮数先用 3 轮。", "等待 1-5 分钟后复测。", "如果多次出现，记录给负责人，不建议直接推荐。"],
  },
  timeout: {
    title: "请求超时",
    cause: "模型响应慢、排队严重、长上下文耗时长，或本地网络链路不稳定。",
    actions: ["把超时时间调到 120000 后复测。", "先用短 Prompt 快速测试，确认不是配置问题。", "如果慢请求长期偏高，不适合低延迟业务。"],
  },
  network_error: {
    title: "本地网络错误",
    cause: "本机网络、VPN、DNS、代理或 Base URL 有问题。",
    actions: ["先确认浏览器和代理能正常访问网页。", "检查 Base URL 是否填成基础地址。", "如果只有本工具失败，把错误截图和配置名称发给负责人。"],
  },
  upstream_5xx: {
    title: "上游服务错误",
    cause: "上游模型、中转网关或协议转换链路异常。",
    actions: ["记录平台 Request ID。", "稍后复测 3 轮。", "如果集中出现 5xx，暂时不要作为稳定候选。"],
  },
  content_block_not_found: {
    title: "内容块缺失",
    cause: "常见于 Claude/OpenAI 协议转换不完整，平台显示 done 但客户端无法解析内容。",
    actions: ["优先检查协议：中转站多数选 OpenAI Compatible，Claude 原生才选 Claude Messages。", "查看平台日志里的请求转换方式。", "换一个同模型渠道快速测试，判断是不是单渠道转换问题。"],
  },
  empty_response: {
    title: "空响应",
    cause: "HTTP 成功但没有提取到文本，常见于协议选错或响应结构不兼容。",
    actions: ["检查协议和 Base URL。", "把 Prompt 改成最短问题复测。", "如果平台有原始响应，交给负责人排查响应格式。"],
  },
  invalid_response: {
    title: "响应格式异常",
    cause: "接口返回了非预期 JSON、HTML 错误页、代理报错文本或协议不匹配结果。",
    actions: ["确认 Base URL 不包含完整业务路径。", "确认协议与平台接口类型一致。", "复制错误摘要给负责人排查。"],
  },
  unknown_error: {
    title: "未知错误",
    cause: "当前工具无法明确归类。",
    actions: ["保留错误摘要。", "去报告中心查看最近请求。", "结合平台后台 Request ID 排查。"],
  },
};

export function applyProfileTemplateToForm(form, templateKey) {
  const template = PROFILE_TEMPLATES[templateKey];
  if (!template) return null;

  form.elements.provider.value = template.provider;
  form.elements.protocol.value = template.protocol;
  form.elements.maxTokens.value = template.maxTokens;
  form.elements.timeoutMs.value = template.timeoutMs;
  form.elements.baseUrl.placeholder = template.baseUrlPlaceholder;
  form.elements.defaultModel.placeholder = template.modelPlaceholder;
  if (!form.elements.notes.value.trim()) {
    form.elements.notes.value = template.notes;
  }
  return template;
}

export function validateProfileConfig(payload) {
  const issues = [];
  const baseUrl = String(payload.baseUrl || "").trim();
  const isEdit = Boolean(String(payload.id || "").trim());
  const apiKey = String(payload.apiKey || "").trim();
  // 新建渠道必须填 Key；编辑已有渠道时留空表示保留原 Key（后端按 id 保留）。
  if (!isEdit && !apiKey) {
    issues.push({
      level: "blocker",
      title: "新建渠道必须填 API Key",
      detail: "粘贴平台提供的 API Key。（编辑已有渠道时才可以留空表示不修改。）",
    });
  }
  const protocol = String(payload.protocol || "");
  const model = String(payload.defaultModel || "").trim();
  const timeoutMs = Number(payload.timeoutMs || 0);
  const maxTokens = Number(payload.maxTokens || 0);

  let parsedUrl = null;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    issues.push({
      level: "blocker",
      title: "Base URL 不是有效网址",
      detail: "请填写类似 https://api.example.com 的基础地址。",
    });
  }

  if (parsedUrl) {
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      issues.push({
        level: "blocker",
        title: "Base URL 协议不正确",
        detail: "请使用 http:// 或 https:// 开头的地址。",
      });
    }

    if (/\/v1\/(messages|chat\/completions)\/?$/i.test(parsedUrl.pathname)) {
      issues.push({
        level: "blocker",
        title: "Base URL 填得太完整了",
        detail: "这里只填基础地址。不要带 /v1/messages 或 /v1/chat/completions，工具会按协议自动拼接。",
      });
    } else if (parsedUrl.pathname && parsedUrl.pathname !== "/") {
      issues.push({
        level: "warning",
        title: "Base URL 带了额外路径",
        detail: "如果这是平台要求的网关前缀，可以保留；如果不确定，建议只填域名或网关根地址。",
      });
    }
  }

  if (protocol === "claude_messages" && /openai|deepseek|chat\/completions/i.test(baseUrl)) {
    issues.push({
      level: "warning",
      title: "协议可能选错",
      detail: "当前选择 Claude Messages，但地址看起来像 OpenAI 兼容接口。中转站通常应选 OpenAI Compatible。",
    });
  }

  if (protocol !== "claude_messages" && /anthropic\.com/i.test(baseUrl)) {
    issues.push({
      level: "warning",
      title: "协议可能选错",
      detail: "地址看起来像 Anthropic 原生接口。如果你直连 Claude 官方接口，通常应选择 Claude Messages。",
    });
  }

  if (!model) {
    issues.push({
      level: "blocker",
      title: "模型名不能为空",
      detail: "请填写平台后台展示的模型名，不要凭记忆猜测。",
    });
  } else if (/\s/.test(model)) {
    issues.push({
      level: "warning",
      title: "模型名里有空格",
      detail: "大多数模型名不包含空格。请确认是否从平台后台完整复制。",
    });
  }

  if (timeoutMs > 0 && timeoutMs < 30000) {
    issues.push({
      level: "warning",
      title: "超时时间偏短",
      detail: "低于 30000ms 容易把慢响应误判成失败。复杂任务建议 60000-120000ms。",
    });
  }

  if (maxTokens > 0 && maxTokens < 128) {
    issues.push({
      level: "warning",
      title: "最大输出偏小",
      detail: "低于 128 可能导致复杂测试输出不完整。普通测试建议至少 512。",
    });
  }

  return {
    issues,
    hasBlockers: issues.some((issue) => issue.level === "blocker"),
    hasWarnings: issues.some((issue) => issue.level === "warning"),
  };
}

export function getScenarioPack(templateKey) {
  return SCENARIO_PACKS[templateKey] || SCENARIO_PACKS["scenario-basic"];
}

export function pickScenarioIdsForPack(scenarios, templateKey) {
  const pack = getScenarioPack(templateKey);
  const source = pack.categories.length
    ? scenarios.filter((scenario) => pack.categories.includes(scenario.category))
    : scenarios;
  return source.slice(0, pack.limit).map((scenario) => scenario.id);
}

export function normalizeErrorKey(errorLike) {
  const raw = typeof errorLike === "string" ? errorLike : errorLike?.normalizedError || errorLike?.error || errorLike?.message || "";
  const text = String(raw).toLowerCase();
  if (ERROR_ADVICES[text]) return text;
  if (text.includes("content block not found")) return "content_block_not_found";
  if (text.includes("auth") || text.includes("401") || text.includes("403") || text.includes("unauthorized")) return "auth_failed";
  if (text.includes("model") && (text.includes("not found") || text.includes("invalid") || text.includes("unknown"))) return "model_not_found";
  if (text.includes("rate") || text.includes("429") || text.includes("quota")) return "rate_limited";
  if (text.includes("timeout") || text.includes("aborted")) return "timeout";
  if (text.includes("network") || text.includes("fetch failed") || text.includes("dns") || text.includes("tls")) return "network_error";
  if (text.includes("5xx") || text.includes("500") || text.includes("502") || text.includes("503") || text.includes("504")) return "upstream_5xx";
  if (text.includes("empty")) return "empty_response";
  if (text.includes("invalid") || text.includes("json")) return "invalid_response";
  return "unknown_error";
}

export function buildErrorAdviceText(errorLike) {
  const key = normalizeErrorKey(errorLike);
  const advice = ERROR_ADVICES[key] || ERROR_ADVICES.unknown_error;
  return [
    "## 错误处理建议",
    "",
    `- 错误类型：${advice.title}（${key}）`,
    `- 可能原因：${advice.cause}`,
    "- 建议操作：",
    ...advice.actions.map((action, index) => `  ${index + 1}. ${action}`),
  ].join("\n");
}

export function buildStandardNextStepAdvice({ quick, stability, scenario }) {
  if (!quick?.success) {
    return [
      "快速测试没有通过，先不要继续消耗 token。",
      "下一步：回到 API 配置，检查 Base URL、协议、模型名和 Key，然后重新跑快速测试。",
    ];
  }

  const successRate = Number(stability?.successRate ?? 0);
  const p95 = Number(stability?.p95TotalMs ?? 0);
  const scenarioScores = scenario?.results?.map((item) => Number(item.avgQualityScore)).filter(Number.isFinite) || [];
  const avgScore = scenarioScores.length ? scenarioScores.reduce((sum, value) => sum + value, 0) / scenarioScores.length : null;

  if (successRate >= 0.95 && (!p95 || p95 <= 30000) && (avgScore === null || avgScore >= 70)) {
    return [
      "初筛结果可用，可以进入更正式的复测。",
      "下一步：先复制交付模板给负责人；如果负责人要求更稳妥，再跑 10 轮稳定性或基础全量场景包。",
    ];
  }

  if (successRate < 0.9) {
    return [
      "稳定性不足，暂时不建议作为候选渠道。",
      "下一步：去报告中心查看失败类型；如果是限流或上游 5xx，间隔一段时间后用 3 轮复测。",
    ];
  }

  if (p95 > 30000) {
    return [
      "能跑通，但响应偏慢。",
      "下一步：确认业务是否能接受等待时间；如不能接受，换低延迟渠道或降低复杂任务输入长度。",
    ];
  }

  return [
    "结果需要人工复核。",
    "下一步：查看报告中心的错误诊断和输出摘要，再决定是否扩大轮数。",
  ];
}

export function buildStandardOperatorSummary({ quick, stability, scenario }) {
  if (!quick?.success) {
    return {
      level: "fail",
      title: "这条 API 现在还不能进入正式测试",
      detail: "快速测试已经失败，继续跑稳定性或场景测试只会浪费额度。先修配置，再复测。",
    };
  }

  const successRate = Number(stability?.successRate ?? 0);
  const p95 = Number(stability?.p95TotalMs ?? 0);
  const scenarioScores = scenario?.results?.map((item) => Number(item.avgQualityScore)).filter(Number.isFinite) || [];
  const avgScore = scenarioScores.length ? scenarioScores.reduce((sum, value) => sum + value, 0) / scenarioScores.length : null;

  if (successRate >= 0.95 && (!p95 || p95 <= 30000) && (avgScore === null || avgScore >= 70)) {
    return {
      level: "pass",
      title: "初筛通过，值得进入下一轮复测",
      detail: "这条 API 基本可用。可以先复制交付模板给负责人；如果要更稳妥，再跑 10 轮稳定性或完整场景包。",
    };
  }

  if (successRate < 0.9) {
    return {
      level: "fail",
      title: "稳定性不够，暂时不建议推荐",
      detail: "失败比例偏高。先看报告中心里的错误类型，再决定是修配置、降低并发，还是换渠道。",
    };
  }

  if (p95 > 30000) {
    return {
      level: "watch",
      title: "能用，但速度偏慢",
      detail: "如果业务能接受等待，可以继续观察；如果需要低延迟，不建议优先推荐这条渠道。",
    };
  }

  return {
    level: "watch",
    title: "结果需要人工复核",
    detail: "基础测试没有明显阻断，但结论还不够强。建议查看报告明细后再扩大测试。",
  };
}

export function buildStandardActionPlan({ quick, stability, scenario }) {
  if (!quick?.success) {
    return [
      { label: "回 API 配置检查", action: "profile-config", kind: "primary" },
      { label: "去快速测试复测", action: "quick-retry", kind: "secondary" },
    ];
  }

  const summary = buildStandardOperatorSummary({ quick, stability, scenario });
  if (summary.level === "pass") {
    return [
      { label: "复制交付模板", action: "handoff", kind: "primary" },
      { label: "跑 10 轮稳定性", action: "stability-basic", kind: "secondary" },
      { label: "跑基础全量场景", action: "scenario-basic", kind: "secondary" },
    ];
  }

  return [
    { label: "去报告中心看错误", action: "reports", kind: "primary" },
    { label: "3 轮复测", action: "stability-smoke", kind: "secondary" },
    { label: "复制交付模板", action: "handoff", kind: "secondary" },
  ];
}
