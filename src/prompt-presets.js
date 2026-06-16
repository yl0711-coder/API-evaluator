import { escapeHtml } from "./client-utils.js";

export const QUICK_PROMPT_PRESETS = [
  {
    id: "connectivity",
    label: "基础连通：最省额度",
    hint: "适合新增或修改 API 后第一次测试，只确认 URL、Key、模型名和协议能不能跑通。",
    prompt: "你是被接入评测的 API 助手。请用一句中文回复：API 连通测试成功。",
  },
  {
    id: "format",
    label: "格式检查：短 JSON",
    hint: "适合确认接口不只会返回文本，也能按要求返回简单结构化内容。",
    prompt: [
      "你是被评测的 API 助手。请只输出 JSON，不要输出 Markdown。",
      "JSON 字段包含 status、message。",
      "status 固定为 ok，message 用中文说明 API 可以正常响应。",
    ].join("\n"),
  },
  {
    id: "chinese",
    label: "中文能力：一句话说明",
    hint: "适合确认模型中文回复是否自然，成本仍然很低。",
    prompt: "请用一句自然、通顺的中文说明：你已经准备好进入后续标准评测。",
  },
  {
    id: "custom",
    label: "自定义：我自己写测试文案",
    hint: "选择后不会覆盖当前文本。适合负责人提供了专门的连通性测试题。",
    prompt: "",
  },
];

export const STANDARD_PROMPT_PRESETS = [
  {
    id: "default",
    label: "标准初筛：低成本推荐",
    hint: "适合标准评测默认使用，先用短 Prompt 确认 API 能通，再进入稳定性和少量场景。",
    prompt: "请用一句中文说明你现在可以正常响应，并在最后单独返回固定句：标准评测开始。",
  },
  {
    id: "operator",
    label: "人工验收：人话回复",
    hint: "适合非技术测试人员验收，回复内容容易判断是否正常。",
    prompt: "你面向非技术验收人员。请用两句话说明你能正常工作，并提醒测试人员本次连通正常，可以继续后续评测流程。",
  },
  {
    id: "format",
    label: "格式验收：短 JSON",
    hint: "适合初步确认模型能按格式输出，后续报告更容易判断响应是否完整。",
    prompt: [
      "你是被评测的 API 助手。请只输出 JSON，不要输出 Markdown。",
      "字段包含 ready、summary。",
      "ready 为 true，summary 用中文说明当前 API 已可进入标准评测。",
    ].join("\n"),
  },
  {
    id: "custom",
    label: "自定义：我自己写测试文案",
    hint: "选择后不会覆盖当前文本。适合负责人要求标准评测先问指定问题。",
    prompt: "",
  },
];

export const STABILITY_PROMPT_PRESETS = [
  {
    id: "basic",
    label: "基础稳定性：短回答 + 指标理解",
    hint: "适合默认稳定性测试，成本低，能检查模型是否正常回答、是否容易空响应。",
    prompt: [
      "你是被接入评测的 AI 助手。请用中文完成一次稳定性测试回答：",
      "1. 用一句话说明你已正常响应。",
      "2. 用两条 bullet 说明评估 AI API 稳定性时应该关注哪些指标。",
      "3. 最后一行固定输出：测试完成。",
    ].join("\n"),
  },
  {
    id: "customer-support",
    label: "客服场景：解释问题并安抚用户",
    hint: "适合测试客服、售后、运营支持类业务，重点看表达是否清楚、语气是否稳定。",
    prompt: [
      "你是一名 AI 接口产品的在线客服。请回复用户反馈：“AI 接口偶尔很慢，有时还会失败”。",
      "要求：",
      "- 先安抚用户。",
      "- 用普通人能听懂的话解释可能原因。",
      "- 给出 3 个下一步处理建议。",
      "- 控制在 180 字以内。",
    ].join("\n"),
  },
  {
    id: "marketing",
    label: "运营文案：短文案生成",
    hint: "适合测试写作、运营和营销场景，重点看输出是否完整、自然、有结构。",
    prompt: [
      "你是一名负责产品营销的文案。请为一个“AI API 稳定性评测工具”写一段中文介绍。",
      "要求：",
      "- 语气自然，不要夸张。",
      "- 包含目标用户、核心价值和适合场景。",
      "- 输出标题 + 3 条要点。",
    ].join("\n"),
  },
  {
    id: "structured-json",
    label: "结构化输出：JSON 检查",
    hint: "适合测试结构化输出稳定性，重点看模型是否按格式返回，适合做自动化解析前的筛查。",
    prompt: [
      "你是一名 API 渠道评审员。请根据下面信息输出严格 JSON，不要输出 Markdown：",
      "场景：评估一个 AI API 渠道是否适合继续测试。",
      "数据：成功率 90%，P95 42000ms，主要错误 timeout。",
      "JSON 字段必须包含：summary、riskLevel、reasons、nextActions。",
      "reasons 和 nextActions 必须是字符串数组。",
    ].join("\n"),
  },
  {
    id: "coding",
    label: "编程场景：轻量排错",
    hint: "适合测试编程类模型渠道，成本比普通短文案高一点，但能观察代码分析能力。",
    prompt: [
      "你是一名资深后端工程师。请分析下面这段伪代码为什么可能导致请求一直等待，并给出修复建议：",
      "",
      "function request() {",
      "  const res = fetch(url);",
      "  return res.text();",
      "}",
      "",
      "要求：说明问题原因、给出修复思路、列出 2 条测试用例。",
    ].join("\n"),
  },
  {
    id: "long-summary",
    label: "长文本摘要：资料归纳",
    hint: "适合测试长文本处理，但会更耗 token。建议只在候选渠道上使用。",
    prompt: [
      "你是一名 API 渠道评测负责人。请阅读下面资料并输出摘要：",
      "我们要测试一个 AI API 中转服务。测试目标包括连通性、稳定性、响应速度、错误分布、复杂任务能力、内容安全表现和交付报告可读性。测试人员可能不是技术人员，所以工具需要给出清晰的人话结论，同时保留技术指标给负责人排查。测试时需要控制成本，先小轮数筛查，再对候选渠道做更完整复测。",
      "",
      "请输出：",
      "1. 100 字以内摘要。",
      "2. 5 个关键测试指标。",
      "3. 3 条给非技术测试人员的操作建议。",
    ].join("\n"),
  },
  {
    id: "custom",
    label: "自定义：我自己写测试文案",
    hint: "选择后不会覆盖当前文本。适合负责人提供了专门测试题，或你想测试特定业务场景。",
    prompt: "",
  },
];

export const BATCH_PROMPT_PRESETS = [
  {
    id: "fair-basic",
    label: "公平对比：统一短任务",
    hint: "推荐默认使用。所有 API 使用同一份短任务，方便横向比较成功率和速度。",
    prompt: [
      "你是参与统一对比测试的 AI 助手。请完成一次统一批量对比测试：",
      "1. 用一句话说明你已正常响应。",
      "2. 用三条要点说明判断一个 AI API 渠道是否稳定应该看什么。",
      "3. 最后一行输出：批量对比完成。",
    ].join("\n"),
  },
  {
    id: "fair-json",
    label: "公平对比：统一 JSON",
    hint: "适合比较多个 API 的结构化输出稳定性，方便技术人员看是否容易解析。",
    prompt: [
      "你是被评测的 API 助手。请只输出 JSON，不要输出 Markdown。",
      "字段包含 channelReady、latencyRisk、stabilityAdvice。",
      "channelReady 为 true，latencyRisk 从 low、medium、high 中选择一个，stabilityAdvice 用中文写一句建议。",
    ].join("\n"),
  },
  {
    id: "fair-business",
    label: "公平对比：业务短答",
    hint: "适合运营、客服、销售场景的渠道横向比较，重点看表达质量和响应完整度。",
    prompt: [
      "你是一名面向业务负责人的运营专员。请写一段简短说明：为什么同一个模型在不同 API 渠道下，速度和稳定性可能不同？",
      "要求：控制在 160 字以内，表达清楚，不要使用太多技术术语。",
    ].join("\n"),
  },
  {
    id: "custom",
    label: "自定义：我自己写测试文案",
    hint: "选择后不会覆盖当前文本。适合所有 API 都要用同一份指定测试题做横向比较。",
    prompt: "",
  },
];

const PRESETS_BY_KIND = {
  quick: QUICK_PROMPT_PRESETS,
  standard: STANDARD_PROMPT_PRESETS,
  stability: STABILITY_PROMPT_PRESETS,
  batch: BATCH_PROMPT_PRESETS,
};

export function renderPromptPresetOptions(kindOrSelectedId = "stability", maybeSelectedId = "basic") {
  const { presets, selectedId } = resolvePresetArgs(kindOrSelectedId, maybeSelectedId);
  return presets
    .map((preset) => `<option value="${escapeHtml(preset.id)}"${preset.id === selectedId ? " selected" : ""}>${escapeHtml(preset.label)}</option>`)
    .join("");
}

export function getPromptPreset(kindOrId, maybeId) {
  const kind = maybeId === undefined ? "stability" : kindOrId;
  const id = maybeId === undefined ? kindOrId : maybeId;
  const presets = PRESETS_BY_KIND[kind] || STABILITY_PROMPT_PRESETS;
  return presets.find((preset) => preset.id === id) || presets[0];
}

export function applyPromptPresetToForm({ kind = "stability", form, select, hint, updateEstimates }) {
  const preset = getPromptPreset(kind, select.value);
  const promptInput = form.elements.prompt;
  if (hint) {
    hint.textContent = preset.id === "custom" ? `${preset.hint} 下方文本框现在可以编辑。` : `${preset.hint} 下方文本框已自动填入，可直接开始测试。`;
  }
  if (promptInput) {
    promptInput.readOnly = preset.id !== "custom";
    promptInput.classList.toggle("readonly-prompt", preset.id !== "custom");
    if (preset.id !== "custom") {
      promptInput.value = preset.prompt;
    } else {
      promptInput.focus();
    }
  }
  updateEstimates?.();
  return preset;
}

function resolvePresetArgs(kindOrSelectedId, maybeSelectedId) {
  if (PRESETS_BY_KIND[kindOrSelectedId]) {
    return {
      presets: PRESETS_BY_KIND[kindOrSelectedId],
      selectedId: maybeSelectedId,
    };
  }
  return {
    presets: STABILITY_PROMPT_PRESETS,
    selectedId: kindOrSelectedId,
  };
}
