// 准入判定引擎（admission-policy-v1）。
//
// 【为什么单独成一个模块】v0.7.3 之前，"跑完没有" 和 "达没达标" 混在 test-runner.mjs 的
// buildAdmissionSummary 里同一段算分代码中，导致三类确定性假通过：
//   ① 未执行的用例被当成通过（空数组 .every() === true，白送 10 分）；
//   ② 综合分够 80 就给 B、B 又映射成 pass，工具调用完全不可用的渠道也判"可交付"；
//   ③ severeError 取 Object.keys().find()，选中哪个错误取决于用例执行顺序而非严重度。
// 判定一旦和"发请求 / 写报告"耦合，就没法在不联网的情况下证明它不会假通过。所以这里抽成
// 【纯函数】模块：无 fetch、无 fs、无 Date.now、不读全局状态，输入结果对象、输出结构化裁决。
// tests/admission-policy.test.mjs 因此可以对每条反例做确定性断言。
//
// 【与 grade 的关系】本模块新增 verdict，不改 grade 的含义。grade 有 8 处下游消费方
// （regression.mjs 的等级跌落告警、high-risk-store.mjs 的 BAD_GRADES、report-compare、
// reporting、ai-report-analysis + 3 处前端展示），改它的语义会连带影响告警口径和历史可比性。
// verdict 是纯增量字段：硬门槛失败 → not_passed，无论综合分多高。
//
// 【版本化】阈值或必选项目变化必须升版本，历史报告继续用原口径解释，禁止用新规则重写旧结论。

import { P95_LATENCY_OK_MS, P95_LATENCY_SLOW_MS } from "./constants.mjs";

export const ADMISSION_POLICY_VERSION = "admission-policy-v1";

// 标准评测稳定性冒烟的轮数：3 组预设文案（基础 / 结构化 / 编程）× 3 遍。
// 判定表按这个总数写，改轮数必须同时升 policy 版本，否则历史结论口径会漂。
export const STABILITY_SMOKE_TOTAL_ROUNDS = 9;

// 硬门槛用例：任一不通过即 not_passed，综合分再高也不能翻案。
// 注意 connectivity 不在此列——它由整体 successRate 与 severeError 覆盖，单独再判一次会重复扣分。
export const HARD_GATE_CASE_IDS = ["json_structure", "tool_call", "stream_structure"];

// 计分观察项：靠"命中关键词 + 长度阈值"判分，既会放过逻辑错误但凑够词的回答，也会误杀
// 正确但简洁的回答。在引入可执行测试或确定答案评分器之前，不足以支撑准入结论，因此既不进
// 硬门槛也不进综合分。
// 注意本数组【只列】这三道启发式能力题。指纹探针（fingerprint_*）与档位判别题（tier_*）
// 同样是观察证据，但它们在记录上带 admission.probe=true，由调用方按该标记排除；模型自述
// （model_identity）不是硬门槛，但保留 5 分权重——标称冲突是可核对的客观差异，不是启发式。
export const OBSERVATION_ONLY_CASE_IDS = ["coding_small", "behavior_reasoning", "long_context_light"];

// 严重错误优先级：显式数组，越靠前越严重。
// 修 ADM-018：原实现用 Object.keys(errorCounts).find(...)，而 countErrors 用 reduce 建对象，
// 键序 = 错误首次出现顺序。同时出现 auth_failed 和 upstream_5xx 时，选中哪个取决于用例执行
// 顺序——而这两者在 gradeAdmission 里的后果天差地别（F 级 vs 条件性 X 级）。同一组错误因为
// 用例顺序不同就得出不同等级，是不可接受的。
// 排序依据：能确定归因到配置/权限的排前（改配置即可解决），瞬时/上游波动排后（复测可能恢复）。
export const SEVERE_ERROR_PRIORITY = [
  "auth_failed",
  "forbidden",
  "model_not_found",
  "invalid_response",
  "protocol_error",
  "content_block_not_found",
  "empty_response",
  "timeout",
  "upstream_5xx",
  "rate_limited",
];

// 项目三态。修 ADM-007：未执行的用例既不得分、也不算失败，必须与"跑了但没过"区分开。
export const ITEM_STATUS = {
  PASSED: "passed",
  FAILED: "failed",
  NOT_APPLICABLE: "not_applicable",
};

// 步骤/模型裁决。与 executionStatus（程序有没有跑完）正交：
// 一个 executionStatus=completed 的步骤，verdict 可能是 passed / warning / not_passed。
export const VERDICT = {
  PASSED: "passed",
  WARNING: "warning",
  NOT_PASSED: "not_passed",
  NOT_APPLICABLE: "not_applicable",
  INDETERMINATE: "indeterminate",
};

// 整体接入结论（PRD 8.1）。
export const CONCLUSION = {
  ACCEPTED: "accepted",
  ACCEPTED_WITH_CONDITIONS: "accepted_with_conditions",
  REJECTED: "rejected",
  INDETERMINATE: "indeterminate",
};

/**
 * 从错误计数里选出最严重的错误码，与对象键序无关（修 ADM-018）。
 * 不在优先级表里的错误码一律忽略——unknown_error 之类不足以单独定级。
 */
export function pickSevereError(errorCounts) {
  if (!errorCounts || typeof errorCounts !== "object") return null;
  const present = Object.keys(errorCounts).filter((code) => Number(errorCounts[code]) > 0);
  for (const code of SEVERE_ERROR_PRIORITY) {
    if (present.includes(code)) return code;
  }
  return null;
}

/**
 * 判定一组用例记录里某个用例的三态状态。
 * 用例不存在（如 quick 包不含编程题）→ not_applicable，绝不按通过处理。
 */
export function resolveItemStatus(cases, caseId) {
  const found = (cases || []).find((item) => item?.id === caseId);
  if (!found) return ITEM_STATUS.NOT_APPLICABLE;
  return found.passed ? ITEM_STATUS.PASSED : ITEM_STATUS.FAILED;
}

/**
 * 多个用例的合并三态：全不存在 → not_applicable；存在任一失败 → failed；否则 passed。
 * 这是 ADM-007 的正解：空集合返回 not_applicable，而不是 JS 里 [].every() 的 true。
 */
export function resolveGroupStatus(cases, caseIds) {
  const statuses = caseIds.map((id) => resolveItemStatus(cases, id));
  const applicable = statuses.filter((s) => s !== ITEM_STATUS.NOT_APPLICABLE);
  if (!applicable.length) return ITEM_STATUS.NOT_APPLICABLE;
  return applicable.every((s) => s === ITEM_STATUS.PASSED) ? ITEM_STATUS.PASSED : ITEM_STATUS.FAILED;
}

/**
 * 综合分：只对【适用】的项目计分，并按实际适用权重归一化到 100。
 *
 * 修 ADM-007 的关键——原实现把 coding 10 分写死在分母里，quick 包没有这些用例却照加，
 * 系统性虚高 10 分。现在不适用的维度直接退出权重池，quick 与 standard 的分数因此各自
 * 在自己的满分基准上计算。
 *
 * 注意：本函数【不】决定能否准入，只用于排序、观察和历史对比（PRD 7.6.1）。
 */
export function computeAdmissionScore({
  successRate = 0,
  passRate = 0,
  jsonStatus = ITEM_STATUS.NOT_APPLICABLE,
  toolCallStatus = ITEM_STATUS.NOT_APPLICABLE,
  streamStatus = ITEM_STATUS.NOT_APPLICABLE,
  identityStatus = ITEM_STATUS.NOT_APPLICABLE,
  tokenCoverage = 0,
  p95TotalMs = null,
  identityConflict = false,
} = {}) {
  // [维度, 权重, 得分比例]。权重只在维度适用时进入分母。
  const dimensions = [
    ["successRate", 35, clamp01(successRate), true],
    ["passRate", 25, clamp01(passRate), true],
    ["json", 10, jsonStatus === ITEM_STATUS.PASSED ? 1 : 0, jsonStatus !== ITEM_STATUS.NOT_APPLICABLE],
    ["toolCall", 10, toolCallStatus === ITEM_STATUS.PASSED ? 1 : 0, toolCallStatus !== ITEM_STATUS.NOT_APPLICABLE],
    ["stream", 10, streamStatus === ITEM_STATUS.PASSED ? 1 : 0, streamStatus !== ITEM_STATUS.NOT_APPLICABLE],
    ["identity", 5, identityStatus === ITEM_STATUS.PASSED ? 1 : 0, identityStatus !== ITEM_STATUS.NOT_APPLICABLE],
    ["tokenCoverage", 5, clamp01(tokenCoverage), true],
  ];

  const applicable = dimensions.filter(([, , , isApplicable]) => isApplicable);
  const totalWeight = applicable.reduce((sum, [, weight]) => sum + weight, 0);
  if (!totalWeight) return 0;

  const earned = applicable.reduce((sum, [, weight, ratio]) => sum + weight * ratio, 0);
  const normalized = (earned / totalWeight) * 100;

  // 延迟与标称冲突作为扣分项，在归一化之后施加——它们描述的是"同样的能力表现得更差"，
  // 不是一个可以缺席的能力维度，所以不进权重池。
  const latencyPenalty = p95TotalMs && p95TotalMs > P95_LATENCY_SLOW_MS ? 10 : p95TotalMs && p95TotalMs > P95_LATENCY_OK_MS ? 5 : 0;
  const identityPenalty = identityConflict ? 15 : 0;

  return Math.max(0, Math.min(100, Math.round(normalized - latencyPenalty - identityPenalty)));
}

/**
 * 准入步骤裁决：硬门槛优先，综合分不得覆盖（修 ADM-008）。
 *
 * 原实现里 B 级只要求 score >= 80，而 buildAdmissionRecommendation 把 A/B 一起映射成 pass，
 * 于是"工具调用失败 + 其余全过"的 quick 包能拿约 87 分 → B → pass。这是最危险的假通过：
 * 平台会把工具调用实际不可用的渠道判断为可以接入。
 *
 * 硬门槛只看 HARD_GATE_CASE_IDS 中【适用且失败】的项。不适用的项（如某测试包不含该用例）
 * 不构成失败，但会记进 notApplicable，让报告能说清"这次没测"而不是"这次通过了"。
 */
export function evaluateAdmission(summary) {
  if (!summary) {
    return decision(VERDICT.INDETERMINATE, "没有准入结果可判定。", { reasonCodes: ["missing_result"] });
  }

  const cases = summary.cases || [];
  const severeError = pickSevereError(summary.errorCounts);

  const gateStatuses = HARD_GATE_CASE_IDS.map((id) => ({ id, status: resolveItemStatus(cases, id) }));
  const failedGates = gateStatuses.filter((g) => g.status === ITEM_STATUS.FAILED);
  const notApplicableGates = gateStatuses.filter((g) => g.status === ITEM_STATUS.NOT_APPLICABLE);

  const observed = {
    score: summary.score ?? null,
    grade: summary.grade ?? null,
    successRate: summary.successRate ?? null,
    p95TotalMs: summary.p95TotalMs ?? null,
    severeError,
    hardGates: gateStatuses,
  };
  const criteria = {
    hardGates: HARD_GATE_CASE_IDS,
    note: "硬门槛全部通过才可交付；综合分只用于排序与观察。",
  };

  // 确定性错误优先于用例分项——认证失败时，工具调用"没通过"只是它的后果而非独立问题。
  if (severeError === "auth_failed" || severeError === "forbidden" || severeError === "model_not_found") {
    return decision(VERDICT.NOT_PASSED, `存在确定性错误 ${severeError}，无法判断模型能力。`, {
      observed,
      criteria,
      reasonCodes: [severeError],
    });
  }

  if (failedGates.length) {
    const names = failedGates.map((g) => g.id).join("、");
    return decision(VERDICT.NOT_PASSED, `硬门槛未通过：${names}。综合分 ${summary.score ?? "-"} 不能覆盖硬门槛失败。`, {
      observed,
      criteria,
      reasonCodes: failedGates.map((g) => `hard_gate_failed:${g.id}`),
    });
  }

  const warnings = [];
  if (notApplicableGates.length) {
    warnings.push(`本次测试包未覆盖：${notApplicableGates.map((g) => g.id).join("、")}。`);
  }
  if (severeError) {
    warnings.push(`出现 ${severeError}，建议复测确认是否为偶发。`);
  }
  if (summary.p95TotalMs && summary.p95TotalMs > P95_LATENCY_OK_MS) {
    warnings.push(`P95 ${summary.p95TotalMs} ms 超过 ${P95_LATENCY_OK_MS} ms 标准。`);
  }
  if (summary.identityCheck?.status === "conflict") {
    warnings.push("模型标称与预期不一致（观察项，不单独阻断）。");
  }

  const verdict = warnings.length ? VERDICT.WARNING : VERDICT.PASSED;
  const summaryText = warnings.length
    ? `硬门槛全部通过，但有需要关注的项：${warnings.join(" ")}`
    : `硬门槛全部通过，综合分 ${summary.score ?? "-"}。`;

  return decision(verdict, summaryText, { observed, criteria, warnings });
}

/**
 * 稳定性冒烟裁决（PRD 7.5.2，按 9 轮口径）。
 *
 * 双口径：finalSuccessRate（重试后最终成功）与 firstAttemptSuccessRate（首次即成功）。
 * 后者由 buildStabilitySummary 从 record.attempts 派生；那批记录若缺 attempts 会传 null，
 * 此时【不】假装首次全成功，而是照最终口径判定并在 warnings 里如实说明"首次成功率未能统计"。
 * 延迟目前仍只有最后一次尝试的耗时，端到端（含失败尝试与退避）待 ADM-010 改造，
 * 所以这里不声称 P95 覆盖了重试等待。
 */
export function evaluateStability(summary, { expectedRounds = STABILITY_SMOKE_TOTAL_ROUNDS } = {}) {
  if (!summary) {
    return decision(VERDICT.INDETERMINATE, "没有稳定性结果可判定。", { reasonCodes: ["missing_result"] });
  }

  const requestCount = Number(summary.requestCount ?? 0);
  const successRate = Number(summary.successRate ?? 0);
  const p95TotalMs = summary.p95TotalMs ?? null;
  const severeError = pickSevereError(summary.errorCounts);
  const firstAttemptSuccessRate = summary.firstAttemptSuccessRate ?? null;

  const observed = { requestCount, successRate, p95TotalMs, severeError, firstAttemptSuccessRate };
  const criteria = {
    expectedRounds,
    finalSuccessRate: 1,
    p95OkMs: P95_LATENCY_OK_MS,
    p95SlowMs: P95_LATENCY_SLOW_MS,
  };

  // 样本不完整不等于渠道不行——是我们没拿到足够证据，应判 indeterminate 而非 not_passed。
  if (requestCount < expectedRounds) {
    return decision(VERDICT.INDETERMINATE, `只取得 ${requestCount}/${expectedRounds} 轮有效结果，样本不完整，无法判定。`, {
      observed,
      criteria,
      reasonCodes: ["incomplete_sample"],
    });
  }

  if (severeError === "auth_failed" || severeError === "forbidden" || severeError === "model_not_found") {
    return decision(VERDICT.NOT_PASSED, `稳定性测试出现确定性错误 ${severeError}。`, {
      observed,
      criteria,
      reasonCodes: [severeError],
    });
  }

  if (successRate < 1) {
    const failed = Math.round((1 - successRate) * requestCount);
    return decision(
      VERDICT.NOT_PASSED,
      `${requestCount - failed}/${requestCount} 最终成功，未达到 ${expectedRounds}/${expectedRounds} 标准。`,
      {
        observed,
        criteria,
        reasonCodes: ["success_rate_below_threshold"],
      },
    );
  }

  if (p95TotalMs && p95TotalMs > P95_LATENCY_SLOW_MS) {
    return decision(VERDICT.NOT_PASSED, `P95 ${p95TotalMs} ms 超过 ${P95_LATENCY_SLOW_MS} ms 上限。`, {
      observed,
      criteria,
      reasonCodes: ["p95_too_slow"],
    });
  }

  const warnings = [];
  if (p95TotalMs && p95TotalMs > P95_LATENCY_OK_MS) {
    warnings.push(`P95 ${p95TotalMs} ms 介于 ${P95_LATENCY_OK_MS}~${P95_LATENCY_SLOW_MS} ms，属有条件通过。`);
  }
  if (firstAttemptSuccessRate !== null && firstAttemptSuccessRate < 1) {
    warnings.push("存在重试后才成功的请求，首次请求体验不如最终成功率乐观。");
  } else if (firstAttemptSuccessRate === null) {
    warnings.push("当前口径为重试后最终成功率；首次成功率尚未单独统计。");
  }
  if (severeError) {
    warnings.push(`出现 ${severeError}，建议复测。`);
  }

  const verdict = warnings.length ? VERDICT.WARNING : VERDICT.PASSED;
  const text = `${requestCount}/${requestCount} 最终成功，P95 ${p95TotalMs ?? "-"} ms；标准为 ${expectedRounds}/${expectedRounds} 且 P95 ≤ ${P95_LATENCY_OK_MS} ms。`;
  return decision(verdict, warnings.length ? `${text} ${warnings.join(" ")}` : text, { observed, criteria, warnings });
}

/**
 * 快速测试裁决：只有"连通"是硬门槛。
 * 模型自述、指纹探针、token 审计一律为观察项——它们不能证明底层模型身份（PRD 非目标 3）。
 */
export function evaluateQuick(result) {
  if (!result) {
    return decision(VERDICT.INDETERMINATE, "没有快速测试结果可判定。", { reasonCodes: ["missing_result"] });
  }

  const cases = result.cases || [];
  const connectivity = cases.find((item) => item?.id === "connectivity");
  const observed = {
    connectivityPassed: connectivity ? Boolean(connectivity.passed) : null,
    statusCode: connectivity?.statusCode ?? null,
    successRate: result.successRate ?? null,
  };
  const criteria = { hardGates: ["connectivity"], note: "身份自述与指纹仅作观察证据。" };

  const connected = connectivity ? Boolean(connectivity.passed) : Number(result.successRate ?? 0) > 0;
  if (!connected) {
    return decision(VERDICT.NOT_PASSED, connectivity?.issue || result.verdict?.reasons?.[0] || "连通未通过。", {
      observed,
      criteria,
      reasonCodes: ["connectivity_failed"],
    });
  }

  const warnings = [];
  const secondaryFailures = cases.filter((item) => item?.id !== "connectivity" && item?.passed === false);
  if (secondaryFailures.length) {
    warnings.push(`观察项有 ${secondaryFailures.length} 项未通过（不阻断，继续后续测试）。`);
  }

  return decision(warnings.length ? VERDICT.WARNING : VERDICT.PASSED, warnings.length ? warnings.join(" ") : "连通正常。", {
    observed,
    criteria,
    warnings,
  });
}

/**
 * 单模型聚合：把该模型下各步骤裁决合成一个接入结论。
 * indeterminate（平台自身异常/证据不足）优先于 not_passed——我们不能因为自己没测成
 * 就说渠道不行。
 */
export function aggregateModel(stepDecisions) {
  const decisions = (stepDecisions || []).filter(Boolean);
  if (!decisions.length) {
    return { conclusion: CONCLUSION.INDETERMINATE, reasons: ["没有任何步骤结果。"] };
  }

  const blocking = decisions.filter((d) => d.blocking !== false);
  if (blocking.some((d) => d.verdict === VERDICT.INDETERMINATE)) {
    return {
      conclusion: CONCLUSION.INDETERMINATE,
      reasons: blocking.filter((d) => d.verdict === VERDICT.INDETERMINATE).map((d) => d.summary),
    };
  }
  if (blocking.some((d) => d.verdict === VERDICT.NOT_PASSED)) {
    return {
      conclusion: CONCLUSION.REJECTED,
      reasons: blocking.filter((d) => d.verdict === VERDICT.NOT_PASSED).map((d) => d.summary),
    };
  }
  if (decisions.some((d) => d.verdict === VERDICT.WARNING)) {
    return {
      conclusion: CONCLUSION.ACCEPTED_WITH_CONDITIONS,
      reasons: decisions.filter((d) => d.verdict === VERDICT.WARNING).map((d) => d.summary),
    };
  }
  return { conclusion: CONCLUSION.ACCEPTED, reasons: [] };
}

/**
 * 多模型聚合（PRD 8.2）：结论必须覆盖全部必选模型，不能只取第一个。
 *
 * 修 ADM-006：前端现在用 perModelResults.find(...) 取首个模型的结论当整体结论，
 * 于是"模型 A 通过、模型 B 失败"会在顶部显示初筛通过。
 *
 * 优先级：rejected > indeterminate > accepted_with_conditions > accepted。
 * 注意 rejected 压过 indeterminate——已经确证某个模型不达标时，另一个模型没测完
 * 并不能让整体结论回到"待定"。
 */
export function aggregateSuite(modelResults) {
  const results = (modelResults || []).filter(Boolean);
  const required = results.filter((item) => item.optional !== true);
  if (!required.length) {
    return { conclusion: CONCLUSION.INDETERMINATE, reasons: ["没有必选模型结果。"], models: results };
  }

  const conclusionOf = (item) => item.conclusion || CONCLUSION.INDETERMINATE;
  const pick = (target) => required.filter((item) => conclusionOf(item) === target);

  const rejected = pick(CONCLUSION.REJECTED);
  if (rejected.length) {
    return {
      conclusion: CONCLUSION.REJECTED,
      reasons: rejected.map((item) => `${item.model || item.profileId || "模型"}：不可接入。`),
      models: results,
    };
  }

  const indeterminate = pick(CONCLUSION.INDETERMINATE);
  if (indeterminate.length) {
    return {
      conclusion: CONCLUSION.INDETERMINATE,
      reasons: indeterminate.map((item) => `${item.model || item.profileId || "模型"}：无法判定。`),
      models: results,
    };
  }

  const conditional = pick(CONCLUSION.ACCEPTED_WITH_CONDITIONS);
  if (conditional.length) {
    return {
      conclusion: CONCLUSION.ACCEPTED_WITH_CONDITIONS,
      reasons: conditional.map((item) => `${item.model || item.profileId || "模型"}：有条件接入。`),
      models: results,
    };
  }

  return { conclusion: CONCLUSION.ACCEPTED, reasons: [], models: results };
}

/** 结论 → 面向操作人员的"是否可以接入"。禁止把推测写成事实，这里只做枚举映射。 */
export function describeConclusion(conclusion) {
  if (conclusion === CONCLUSION.ACCEPTED) return { title: "可接入", canOnboard: "是" };
  if (conclusion === CONCLUSION.ACCEPTED_WITH_CONDITIONS) return { title: "有条件接入", canOnboard: "是（有条件）" };
  if (conclusion === CONCLUSION.REJECTED) return { title: "不可接入", canOnboard: "否" };
  return { title: "无法判定", canOnboard: "待定" };
}

/**
 * 结构化输出硬门槛验证器（修 ADM-012）。
 *
 * 原实现是 `parsed && Object.hasOwn(parsed,"channelReady") && parsed.modelType && parsed.risk`，
 * 只检查字段【存在且真值】。反例 {"channelReady":"false","modelType":123,"risk":"critical"}
 * 会通过：字符串 "false" 真值、数字 123 真值、"critical" 真值。提示词明确要求
 * channelReady 为 true、risk 填 low，所以这里按题面校验类型与取值。
 *
 * 同时拒绝 Markdown 包裹：提示词写了"不要使用 Markdown"，而 parseLooseJson 会从任意文本里
 * 正则抠出 {...}，````json {...}``` 这类回答本来能蒙混过关。能否返回纯 JSON 是接入方要
 * 直接消费的协议能力，不是排版偏好。
 */
export function validateStructuredJsonCase(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw) return { passed: false, issue: "没有返回任何内容。" };

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { passed: false, issue: "响应不是纯 JSON（可能带 Markdown 代码块或额外说明文字）。" };
  }

  if (!isPlainObject(parsed)) {
    return { passed: false, issue: "响应 JSON 顶层不是对象。" };
  }
  if (parsed.channelReady !== true) {
    return { passed: false, issue: `channelReady 必须是布尔 true，实际为 ${describeValue(parsed.channelReady)}。` };
  }
  if (typeof parsed.modelType !== "string" || !parsed.modelType.trim()) {
    return { passed: false, issue: `modelType 必须是非空字符串，实际为 ${describeValue(parsed.modelType)}。` };
  }
  if (parsed.risk !== "low") {
    return { passed: false, issue: `risk 必须是 "low"，实际为 ${describeValue(parsed.risk)}。` };
  }
  return { passed: true, issue: "结构化 JSON 字段、类型和取值均符合要求。" };
}

// 工具调用提示词是"查询北京天气"。模型返回 Beijing 是同样正确的作答——硬门槛上的
// 假失败和假通过一样有害，所以中英文都接受。方案文档写的是严格等于"北京"，这里
// 有意偏离并记录原因。
const ACCEPTED_WEATHER_CITIES = ["北京", "beijing", "bei jing", "peking"];

/**
 * 工具调用硬门槛验证器（修 ADM-013）。
 *
 * arguments 在两种协议下形状不同：claude_messages 的 tool_use.input 已是对象，
 * OpenAI 的 function.arguments 是 JSON 字符串。两者都要能校验。
 */
export function validateWeatherToolCall(toolCall) {
  if (!toolCall) return { passed: false, issue: "没有返回工具调用。" };
  if (toolCall.name !== "get_weather") {
    return { passed: false, issue: `工具名应为 get_weather，实际为 ${describeValue(toolCall.name)}。` };
  }

  let args = toolCall.arguments;
  if (typeof args === "string") {
    const text = args.trim();
    if (!text) return { passed: false, issue: "工具调用参数为空字符串。" };
    try {
      args = JSON.parse(text);
    } catch {
      return { passed: false, issue: "工具调用参数不是合法 JSON。" };
    }
  }
  if (!isPlainObject(args)) {
    return { passed: false, issue: `工具调用参数应为 JSON 对象，实际为 ${describeValue(args)}。` };
  }
  if (!Object.keys(args).length) {
    return { passed: false, issue: "工具调用参数为空对象，未按 schema 传入 city。" };
  }
  if (typeof args.city !== "string" || !args.city.trim()) {
    return { passed: false, issue: `工具调用缺少 city 参数或类型不对（实际 ${describeValue(args.city)}）。` };
  }

  const city = args.city.trim().toLowerCase();
  if (!ACCEPTED_WEATHER_CITIES.includes(city)) {
    return { passed: false, issue: `city 应为提示词指定的"北京"，实际为 ${describeValue(args.city)}。` };
  }
  return { passed: true, issue: "工具调用结构与参数均正确。" };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function describeValue(value) {
  if (value === undefined) return "缺失";
  if (value === null) return "null";
  if (typeof value === "string") return `"${value.slice(0, 40)}"`;
  if (typeof value === "object") return Array.isArray(value) ? "数组" : "对象";
  return String(value);
}

function decision(verdict, summary, { observed = {}, criteria = {}, reasonCodes = [], warnings = [], blocking = true } = {}) {
  return { policyVersion: ADMISSION_POLICY_VERSION, verdict, blocking, summary, observed, criteria, reasonCodes, warnings };
}

function clamp01(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(1, num));
}
