export const BASIC_SCENARIOS = [
  {
    "id": "connectivity-basic",
    "name": "连通性：基础响应",
    "category": "connectivity",
    "difficulty": "small",
    "prompt": "这是一次连通性自检。请只回复一句话，明确确认本渠道服务正常、已成功接通，必须在句中包含「服务正常」四个字，不要附加自我介绍或其他内容。",
    "minChars": 5,
    "requiredAny": [
      "服务正常",
      "正常",
      "服务",
      "可以",
      "ready",
      "working"
    ],
    "tag": "响应速度"
  },
  {
    "id": "speed-short",
    "name": "速度：短问题",
    "category": "speed",
    "difficulty": "small",
    "prompt": "你是一名 API 网关运维工程师。请用 3 条要点，向准备接入新渠道的同事说明：\n评测一个 API 中转渠道时最该盯紧哪些指标。\n每条先点出指标名（如延迟、成功率、稳定性、错误率），再用一句话说明它为什么重要。",
    "minChars": 60,
    "requiredAny": [
      "延迟",
      "稳定",
      "成功率",
      "错误",
      "速度"
    ]
  },
  {
    "id": "structured-json",
    "name": "结构化输出：JSON",
    "category": "structured",
    "difficulty": "normal",
    "prompt": "你是一名 API 渠道评审员。请评估一个 AI API 渠道是否适合上线，只输出 JSON，不要输出 Markdown。\nJSON 字段必须包含 latencyRisk、stabilityRisk、recommendation、checklist。\nchecklist 是字符串数组，至少 3 项，每项是一条上线前要确认的检查项。",
    "minChars": 100,
    "expectsJson": true,
    "requiredAny": [
      "latencyRisk",
      "stabilityRisk",
      "recommendation",
      "checklist"
    ]
  },
  {
    "id": "business-writing",
    "name": "写作：运营说明",
    "category": "writing",
    "difficulty": "normal",
    "prompt": "你是一名面向客户的运营专员。请给非技术客户写一段说明，解释为什么同一个 AI 模型在不同渠道下速度和稳定性会不一样。\n要求：口语化、清楚、不夸张，结合渠道、网络、服务等因素，不超过 250 字。",
    "minChars": 50,
    "requiredAny": [
      "渠道",
      "速度",
      "稳定",
      "网络",
      "服务"
    ]
  }
];
