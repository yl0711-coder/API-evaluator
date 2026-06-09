import { formatPercent, sumNullable } from "./utils.mjs";

export const FINGERPRINT_LIBRARY_VERSION = "2026.06.01";

const FAMILY_LABELS = {
  claude: "Claude",
  openai: "OpenAI / GPT",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  glm: "GLM",
  doubao: "豆包",
  kimi: "Kimi",
  grok: "Grok",
  unknown: "未知",
};

export function inferModelFamily(modelName) {
  const text = String(modelName || "").toLowerCase();
  if (/claude|anthropic/.test(text)) return "claude";
  if (/gemini|palm/.test(text)) return "gemini";
  if (/deepseek/.test(text)) return "deepseek";
  if (/(^|[-_])glm|chatglm|zhipu/.test(text)) return "glm";
  if (/doubao|ark|volc|豆包/.test(text)) return "doubao";
  if (/kimi|moonshot/.test(text)) return "kimi";
  if (/grok|xai/.test(text)) return "grok";
  if (/gpt|openai|codex|(^|[-_])o[134](?:[-_]|$)|o\d/.test(text)) return "openai";
  return "";
}

export function normalizeModelFamily(value) {
  const text = String(value || "").toLowerCase();
  if (!text) return "";
  if (/claude|anthropic/.test(text)) return "claude";
  if (/gemini|google/.test(text)) return "gemini";
  if (/deepseek/.test(text)) return "deepseek";
  if (/chatglm|glm|zhipu/.test(text)) return "glm";
  if (/doubao|豆包|volc|bytedance|ark/.test(text)) return "doubao";
  if (/kimi|moonshot/.test(text)) return "kimi";
  if (/grok|xai/.test(text)) return "grok";
  if (/openai|gpt|codex|(^|[^a-z])o[134]([^a-z]|$)/.test(text)) return "openai";
  if (/unknown|无法|不能确认|not sure|cannot|can't/.test(text)) return "unknown";
  return "";
}

export function familyLabel(family) {
  return FAMILY_LABELS[family] || family || "未知";
}

export function getFingerprintLibraryMetadata(modelName = "") {
  const expectedFamily = inferModelFamily(modelName);
  const familyProbeCount = expectedFamily ? FAMILY_FINGERPRINT_PROBES[expectedFamily]?.length || 0 : 0;
  return {
    version: FINGERPRINT_LIBRARY_VERSION,
    baseProbeCount: BASE_FINGERPRINT_PROBES.length,
    familyProbeCount,
    totalProbeCount: BASE_FINGERPRINT_PROBES.length + familyProbeCount,
    expectedFamily,
    expectedFamilyLabel: familyLabel(expectedFamily || "unknown"),
    supportedFamilies: Object.keys(FAMILY_FINGERPRINT_PROBES),
    notes: [
      "指纹题库用于黑盒初筛，不等同于官方模型身份认证。",
      "题库结论需要结合协议结构、稳定性、Token 审计和人工复核判断。",
    ],
  };
}

export function buildTokenAudit(records) {
  const requestCount = records.length;
  const recordsWithUsage = records.filter((record) => record.inputTokens !== null || record.outputTokens !== null);
  const successfulRecords = records.filter((record) => record.success);
  const zeroOutputSuccessCount = successfulRecords.filter((record) => Number(record.outputTokens) === 0).length;
  const inputTokens = sumNullable(records.map((record) => record.inputTokens));
  const outputTokens = sumNullable(records.map((record) => record.outputTokens));
  const usageCoverage = requestCount ? recordsWithUsage.length / requestCount : 0;
  const issues = [];

  if (usageCoverage < 0.8) {
    issues.push({
      code: "low_usage_coverage",
      title: "Token 用量覆盖不足",
      detail: `只有 ${recordsWithUsage.length}/${requestCount} 条请求返回 usage，成本审计可信度不足。`,
      severity: usageCoverage === 0 ? "high" : "medium",
    });
  }
  if (zeroOutputSuccessCount > 0) {
    issues.push({
      code: "zero_output_success",
      title: "成功请求输出 tokens 为 0",
      detail: `${zeroOutputSuccessCount} 条成功请求的输出 tokens 为 0，需要确认上游 usage 是否可信。`,
      severity: "medium",
    });
  }

  return {
    requestCount,
    recordsWithUsage: recordsWithUsage.length,
    usageCoverage,
    usageCoverageText: formatPercent(usageCoverage),
    inputTokens,
    outputTokens,
    avgInputTokens: recordsWithUsage.length ? Math.round((inputTokens || 0) / recordsWithUsage.length) : null,
    avgOutputTokens: recordsWithUsage.length ? Math.round((outputTokens || 0) / recordsWithUsage.length) : null,
    tokenReliability: usageCoverage >= 0.8 ? "high" : usageCoverage > 0 ? "medium" : "low",
    issues,
  };
}

const BASE_FINGERPRINT_PROBES = [
  {
    id: "fingerprint_instruction_lock",
    name: "指纹探针：固定 JSON 指令",
    prompt: [
      "这是模型指纹探针，请严格遵守。",
      "只输出一行 JSON，不要 Markdown，不要解释。",
      '必须精确输出：{"marker":"NXFP-7429","answer":"blue-17","count":3}',
    ].join("\n"),
  },
  {
    id: "fingerprint_logic_anchor",
    name: "指纹探针：基础逻辑锚点",
    prompt: "盒子里有 4 个红球、3 个蓝球。拿走 2 个红球，再放入 5 个蓝球。现在有几个蓝球？只回复数字。",
  },
  {
    id: "fingerprint_code_reasoning",
    name: "指纹探针：代码推理",
    prompt: [
      "下面代码为什么可能返回 undefined？请说明原因并给出修复后的最小代码。",
      "",
      "async function loadUser(id) {",
      "  const user = fetchUser(id)",
      "  if (!user) return",
      "  return user.name",
      "}",
      "",
      "要求：必须提到异步/await 或 Promise，并给出修复代码。",
    ].join("\n"),
  },
  {
    id: "fingerprint_context_recall",
    name: "指纹探针：上下文锚点召回",
    prompt: [
      "记住以下映射：",
      "Alpha = river",
      "Bravo = matrix",
      "Charlie = lantern",
      "Delta = copper",
      "",
      "请只返回 Bravo 和 Charlie 的值，中间用 / 分隔，不要解释。",
    ].join("\n"),
  },
];

const FAMILY_FINGERPRINT_PROBES = {
  claude: [
    {
      id: "fingerprint_family_claude_messages",
      name: "Claude 家族探针：Messages 事件结构",
      family: "claude",
      prompt: [
        "请只输出一行 JSON，不要 Markdown，不要解释。",
        "问题：Anthropic Claude Messages 流式响应中，内容块增量事件和消息结束事件通常叫什么？",
        '格式：{"family":"claude","events":["事件1","事件2"]}',
      ].join("\n"),
      expectedSignals: [
        { code: "claude_family", pattern: /claude|anthropic/i },
        { code: "content_block_delta", pattern: /content_block_delta/i },
        { code: "message_stop", pattern: /message_stop/i },
      ],
      minSignals: 2,
    },
  ],
  openai: [
    {
      id: "fingerprint_family_openai_chat",
      name: "OpenAI 家族探针：Chat Completions 结构",
      family: "openai",
      prompt: [
        "请只输出一行 JSON，不要 Markdown，不要解释。",
        "问题：OpenAI Chat Completions 普通响应中，最常见的候选数组字段和消息内容字段叫什么？",
        '格式：{"family":"openai","fields":["字段1","字段2","字段3"]}',
      ].join("\n"),
      expectedSignals: [
        { code: "openai_family", pattern: /openai|gpt|chat.?completions/i },
        { code: "choices", pattern: /choices/i },
        { code: "message", pattern: /message/i },
        { code: "content", pattern: /content/i },
      ],
      minSignals: 3,
    },
  ],
  gemini: [
    {
      id: "fingerprint_family_gemini_candidates",
      name: "Gemini 家族探针：Candidates 结构",
      family: "gemini",
      prompt: [
        "请只输出一行 JSON，不要 Markdown，不要解释。",
        "问题：Google Gemini 原生响应中，候选结果、内容片段和安全评级常见字段分别叫什么？",
        '格式：{"family":"gemini","fields":["字段1","字段2","字段3"]}',
      ].join("\n"),
      expectedSignals: [
        { code: "gemini_family", pattern: /gemini|google/i },
        { code: "candidates", pattern: /candidates/i },
        { code: "parts", pattern: /parts/i },
        { code: "safety", pattern: /safetyRatings|safety/i },
      ],
      minSignals: 3,
    },
  ],
  deepseek: [
    {
      id: "fingerprint_family_deepseek_reasoner",
      name: "DeepSeek 家族探针：推理模型认知",
      family: "deepseek",
      prompt: [
        "请只输出一行 JSON，不要 Markdown，不要解释。",
        "问题：DeepSeek 常见的通用聊天模型和推理模型命名有什么差异？",
        '格式：{"family":"deepseek","models":["模型1","模型2"],"difference":"一句话"}',
      ].join("\n"),
      expectedSignals: [
        { code: "deepseek_family", pattern: /deepseek/i },
        { code: "chat", pattern: /chat/i },
        { code: "reasoner", pattern: /reasoner|推理/i },
      ],
      minSignals: 2,
    },
  ],
  glm: [
    {
      id: "fingerprint_family_glm_zhipu",
      name: "GLM 家族探针：智谱模型认知",
      family: "glm",
      prompt: [
        "请只输出一行 JSON，不要 Markdown，不要解释。",
        "问题：GLM 系列模型通常由哪家国内厂商提供？请同时给出 GLM 和厂商名。",
        '格式：{"family":"glm","vendor":"厂商名","keyword":"glm"}',
      ].join("\n"),
      expectedSignals: [
        { code: "glm_family", pattern: /glm|chatglm/i },
        { code: "zhipu", pattern: /智谱|zhipu/i },
      ],
      minSignals: 2,
    },
  ],
  doubao: [
    {
      id: "fingerprint_family_doubao_volcengine",
      name: "豆包家族探针：火山方舟认知",
      family: "doubao",
      prompt: [
        "请只输出一行 JSON，不要 Markdown，不要解释。",
        "问题：豆包大模型通常与哪个云平台或模型服务品牌相关？",
        '格式：{"family":"doubao","platform":"平台名","vendor":"厂商名"}',
      ].join("\n"),
      expectedSignals: [
        { code: "doubao_family", pattern: /豆包|doubao/i },
        { code: "volcengine", pattern: /火山|方舟|volc|ark|字节|bytedance/i },
      ],
      minSignals: 2,
    },
  ],
  kimi: [
    {
      id: "fingerprint_family_kimi_moonshot",
      name: "Kimi 家族探针：Moonshot 认知",
      family: "kimi",
      prompt: [
        "请只输出一行 JSON，不要 Markdown，不要解释。",
        "问题：Kimi 模型通常与哪家公司或英文品牌名相关？",
        '格式：{"family":"kimi","vendor":"厂商名","brand":"英文品牌"}',
      ].join("\n"),
      expectedSignals: [
        { code: "kimi_family", pattern: /kimi/i },
        { code: "moonshot", pattern: /moonshot|月之暗面/i },
      ],
      minSignals: 2,
    },
  ],
  grok: [
    {
      id: "fingerprint_family_grok_xai",
      name: "Grok 家族探针：xAI 认知",
      family: "grok",
      prompt: [
        "请只输出一行 JSON，不要 Markdown，不要解释。",
        "问题：Grok 模型通常由哪家公司提供？请包含 Grok 和公司名。",
        '格式：{"family":"grok","vendor":"公司名","keyword":"grok"}',
      ].join("\n"),
      expectedSignals: [
        { code: "grok_family", pattern: /grok/i },
        { code: "xai", pattern: /xai|x\.ai|马斯克|musk/i },
      ],
      minSignals: 2,
    },
  ],
};

// 基础指纹探针的固定文本（id → prompt）。供绝对 token 审计取"已知固定文本"做精确分词对照。
export function getBaseFingerprintProbeTexts() {
  const out = {};
  for (const probe of BASE_FINGERPRINT_PROBES) out[probe.id] = probe.prompt;
  return out;
}

export function buildFingerprintProbeCases(options = {}) {
  const modelName = typeof options === "string" ? options : options.modelName;
  const includeFamilySpecific = typeof options === "object" ? options.includeFamilySpecific !== false : Boolean(modelName);
  const expectedFamily = inferModelFamily(modelName);
  const familyProbes = includeFamilySpecific && expectedFamily ? FAMILY_FINGERPRINT_PROBES[expectedFamily] || [] : [];
  return [...BASE_FINGERPRINT_PROBES, ...familyProbes].map((item) => ({
    ...item,
    libraryVersion: FINGERPRINT_LIBRARY_VERSION,
    expectedFamily: item.family || expectedFamily || "",
  }));
}

export function buildPurityAssessment({
  modelName,
  protocol,
  successRate,
  p95TotalMs,
  identityCheck,
  jsonPassed,
  toolCallPassed,
  streamPassed,
  errorCounts = {},
  tokenAudit,
  fingerprintSummary,
}) {
  const expectedFamily = inferModelFamily(modelName) || identityCheck?.expectedFamily || "unknown";
  const evidence = [];
  const riskFlags = [];
  let score = 100;

  addEvidence(evidence, "标称模型家族", `模型名推断为 ${familyLabel(expectedFamily)}。`, "info");

  if (identityCheck?.status === "aligned") {
    addEvidence(evidence, "标称一致性", `模型自述与标称家族一致：${familyLabel(identityCheck.reportedFamily)}。`, "pass");
  } else if (identityCheck?.status === "conflict") {
    score -= 35;
    addRisk(riskFlags, "identity_conflict", "模型标称冲突", `标称 ${familyLabel(identityCheck.expectedFamily)}，自述 ${familyLabel(identityCheck.reportedFamily)}。`, "high");
  } else if (identityCheck?.status === "unknown") {
    score -= 8;
    addRisk(riskFlags, "identity_unknown", "模型身份无法确认", "模型没有明确给出可验证家族信息，需要后续指纹题复测。", "medium");
  } else {
    score -= 5;
    addEvidence(evidence, "标称一致性", "未形成明确冲突，但证据不足。", "watch");
  }

  if (jsonPassed) {
    addEvidence(evidence, "结构化输出", "JSON 结构化输出通过。", "pass");
  } else {
    score -= 8;
    addRisk(riskFlags, "json_structure_failed", "结构化输出失败", "结构化输出不稳定，可能影响工具链和自动化任务。", "medium");
  }

  if (toolCallPassed) {
    addEvidence(evidence, "工具调用", "工具调用结构通过。", "pass");
  } else {
    score -= 12;
    addRisk(riskFlags, "tool_call_failed", "工具调用失败", "工具调用结构未通过，Claude Code、Codex 等工具场景存在风险。", "medium");
  }

  if (streamPassed) {
    addEvidence(evidence, "流式结构", "流式事件结构通过。", "pass");
  } else {
    score -= protocol === "claude_messages" ? 18 : 12;
    addRisk(riskFlags, "stream_structure_failed", "流式结构失败", "流式事件结构异常，可能导致客户端中断或 Content block not found。", "high");
  }

  const contentBlockErrors = Number(errorCounts.content_block_not_found || 0);
  const upstream5xx = Number(errorCounts.upstream_5xx || 0);
  const timeout = Number(errorCounts.timeout || 0);
  if (contentBlockErrors > 0) {
    score -= 25;
    addRisk(riskFlags, "content_block_not_found", "Claude 流式块异常", `出现 ${contentBlockErrors} 次 Content block not found 相关风险。`, "high");
  }
  if (upstream5xx > 0 || timeout > 0) {
    score -= Math.min(20, (upstream5xx + timeout) * 8);
    addRisk(riskFlags, "upstream_unstable", "上游稳定性风险", `出现 5xx ${upstream5xx} 次、超时 ${timeout} 次。`, "medium");
  }

  if (successRate < 0.8) {
    score -= 20;
    addRisk(riskFlags, "low_success_rate", "成功率不足", `准入成功率为 ${formatPercent(successRate)}。`, "high");
  } else {
    addEvidence(evidence, "基础可用性", `准入成功率为 ${formatPercent(successRate)}。`, "pass");
  }

  if (p95TotalMs && p95TotalMs > 45000) {
    score -= 10;
    addRisk(riskFlags, "high_tail_latency", "尾部延迟高", `P95 为 ${p95TotalMs} ms，复杂任务可能容易超时。`, "medium");
  }

  if (tokenAudit?.tokenReliability === "high") {
    addEvidence(evidence, "Token 审计", `usage 覆盖率 ${tokenAudit.usageCoverageText}，可作为成本参考。`, "pass");
  } else {
    score -= tokenAudit?.tokenReliability === "medium" ? 5 : 10;
    for (const issue of tokenAudit?.issues || []) {
      addRisk(riskFlags, issue.code, issue.title, issue.detail, issue.severity);
    }
  }

  if (fingerprintSummary?.totalCount > 0) {
    if (fingerprintSummary.passRate >= 0.8) {
      addEvidence(
        evidence,
        "模型指纹探针",
        `${fingerprintSummary.passedCount}/${fingerprintSummary.totalCount} 个指纹探针通过，行为一致性初筛正常。`,
        "pass",
      );
    } else {
      const penalty = fingerprintSummary.passRate < 0.5 ? 22 : 12;
      score -= penalty;
      addRisk(
        riskFlags,
        "fingerprint_probe_failed",
        "模型指纹探针通过率不足",
        `${fingerprintSummary.passedCount}/${fingerprintSummary.totalCount} 个指纹探针通过。失败项：${fingerprintSummary.failedNames.join("、") || "无明细"}。`,
        fingerprintSummary.passRate < 0.5 ? "high" : "medium",
      );
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const classification = classifyPurity(score, riskFlags);

  return {
    score,
    classification: classification.code,
    title: classification.title,
    confidence: classification.confidence,
    expectedFamily,
    expectedFamilyLabel: familyLabel(expectedFamily),
    evidence,
    riskFlags,
    nextAction: classification.nextAction,
  };
}

export function buildFingerprintProbeSummary(records) {
  const probeRecords = records.filter((record) => record.admission?.probe);
  const totalCount = probeRecords.length;
  const passedCount = probeRecords.filter((record) => record.admission?.passed).length;
  const failedNames = probeRecords
    .filter((record) => !record.admission?.passed)
    .map((record) => record.caseName || record.caseId || "未命名探针");

  return {
    libraryVersion: FINGERPRINT_LIBRARY_VERSION,
    totalCount,
    passedCount,
    failedCount: Math.max(0, totalCount - passedCount),
    passRate: totalCount ? passedCount / totalCount : 0,
    passRateText: formatPercent(totalCount ? passedCount / totalCount : 0),
    failedNames,
    probes: probeRecords.map((record) => ({
      id: record.caseId,
      name: record.caseName,
      passed: Boolean(record.admission?.passed),
      issue: record.admission?.issue || "",
      signals: record.admission?.signals || [],
    })),
  };
}

export function evaluateFingerprintProbe(testCase, text) {
  const raw = String(text || "");
  const normalized = raw.toLowerCase();
  if (Array.isArray(testCase.expectedSignals)) {
    const signals = testCase.expectedSignals
      .filter((signal) => signal.pattern.test(raw))
      .map((signal) => signal.code);
    const minSignals = Number.isFinite(Number(testCase.minSignals)) ? Number(testCase.minSignals) : testCase.expectedSignals.length;
    const passed = signals.length >= minSignals;
    return {
      passed,
      probe: true,
      family: testCase.family || "",
      signals,
      issue: passed
        ? `${familyLabel(testCase.family)} 家族探针通过。`
        : `${familyLabel(testCase.family)} 家族探针信号不足，命中 ${signals.length}/${testCase.expectedSignals.length}。`,
    };
  }
  if (testCase.id === "fingerprint_instruction_lock") {
    const compact = raw.replace(/\s+/g, "");
    const passed =
      compact.includes('"marker":"NXFP-7429"') &&
      compact.includes('"answer":"blue-17"') &&
      compact.includes('"count":3');
    return {
      passed,
      probe: true,
      signals: compact.match(/NXFP-7429|blue-17|"count":3/g) || [],
      issue: passed ? "固定 JSON 指令遵循通过。" : "没有严格返回要求的固定 JSON。",
    };
  }
  if (testCase.id === "fingerprint_logic_anchor") {
    const passed = /\b8\b|八/.test(raw);
    return {
      passed,
      probe: true,
      signals: passed ? ["answer_8"] : [],
      issue: passed ? "基础逻辑锚点通过。" : "基础逻辑题没有返回期望答案 8。",
    };
  }
  if (testCase.id === "fingerprint_code_reasoning") {
    const signals = [
      /await|异步|promise/i.test(raw) ? "async_await" : "",
      /return|返回/i.test(raw) ? "return_path" : "",
      /修复|fix|代码|function|async/i.test(raw) ? "fix_code" : "",
    ].filter(Boolean);
    const passed = signals.length >= 2 && raw.length >= 80;
    return {
      passed,
      probe: true,
      signals,
      issue: passed ? "代码推理探针通过。" : "代码推理回答缺少关键异步/返回路径分析。",
    };
  }
  if (testCase.id === "fingerprint_context_recall") {
    const compact = normalized.replace(/\s+/g, "");
    const passed = compact.includes("matrix/lantern") || compact.includes("matrix，lantern") || compact.includes("matrixlantern");
    return {
      passed,
      probe: true,
      signals: passed ? ["context_pair_recalled"] : [],
      issue: passed ? "上下文锚点召回通过。" : "没有正确召回上下文锚点 matrix/lantern。",
    };
  }
  return {
    passed: false,
    probe: true,
    signals: [],
    issue: "未知模型指纹探针。",
  };
}

function classifyPurity(score, riskFlags) {
  const highRisk = riskFlags.some((item) => item.severity === "high");
  const hasIdentityConflict = riskFlags.some((item) => item.code === "identity_conflict");
  if (hasIdentityConflict) {
    return {
      code: "suspected_model_mismatch",
      title: "疑似模型不匹配",
      confidence: score >= 60 ? "medium" : "high",
      nextAction: "暂停开放，要求上游解释模型来源，并用同模型其他渠道做横向复测。",
    };
  }
  if (score >= 85 && !highRisk) {
    return {
      code: "high_confidence_candidate",
      title: "高可信候选",
      confidence: "medium",
      nextAction: "进入稳定性、复杂编程场景和成本审计复测。",
    };
  }
  if (score >= 70) {
    return {
      code: "usable_but_unverified",
      title: "基本可用但未完全验证",
      confidence: "medium",
      nextAction: "继续做多轮稳定性和模型指纹复测，不要直接作为高质量渠道推荐。",
    };
  }
  if (score >= 50) {
    return {
      code: "needs_manual_review",
      title: "需要人工复核",
      confidence: "low",
      nextAction: "先查看失败项、原始 JSON 和上游日志，再决定是否继续消耗额度。",
    };
  }
  return {
    code: "not_admissible",
    title: "暂不具备准入条件",
    confidence: "medium",
    nextAction: "不要开放给用户，先修复协议、模型、Key、工具调用或上游稳定性问题。",
  };
}

function addEvidence(list, code, detail, severity) {
  list.push({ code, detail, severity });
}

function addRisk(list, code, title, detail, severity) {
  list.push({ code, title, detail, severity });
}
