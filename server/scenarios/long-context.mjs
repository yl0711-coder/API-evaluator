import { buildHaystack } from "../benchmark-scorers.mjs";

export const LONG_CONTEXT_SCENARIOS = [
  {
    id: "long-context-needle",
    name: "长上下文：关键事实检索 (NIAH)",
    category: "long_context",
    difficulty: "complex",
    prompt: [
      "下面是一份很长的资料，其中藏着一条关键信息。请只回答：资料里提到的项目代号是什么？",
      "",
      buildHaystack({
        filler: "这是一段无关的渠道测试流水记录，用于撑长上下文，不包含要找的信息。",
        needle: "【重要】本次评测的项目代号是 ORION-7，请记住这个代号。",
        depthRatio: 0.6,
        repeats: 60,
      }),
    ].join("\n"),
    minChars: 1,
    scorer: "needle",
    needle: "ORION-7",
  },
  {
    id: "long-context-summary",
    name: "长上下文：资料归纳",
    category: "long_context",
    difficulty: "complex",
    prompt: [
      "请阅读下面这份渠道测试记录，输出：1. 结论；2. 主要风险；3. 建议复测方案；4. 给非技术人员看的说明。",
      "",
      buildSyntheticLongContext(),
    ].join("\n"),
    minChars: 700,
    requiredAny: ["结论", "风险", "复测", "非技术", "建议"],
  },
  {
    id: "reasoning-decision",
    name: "复杂问题：决策推理",
    category: "reasoning",
    difficulty: "complex",
    prompt: [
      "现在有三个模型渠道：",
      "A：成功率 99%，平均延迟 18 秒，价格高。",
      "B：成功率 94%，平均延迟 7 秒，价格中等。",
      "C：成功率 88%，平均延迟 3 秒，价格低。",
      "业务场景是给企业客户做代码生成，要求结果稳定、等待时间可接受、不能频繁失败。",
      "请给出选择建议、淘汰理由、灰度策略和监控指标。",
    ].join("\n"),
    minChars: 400,
    requiredAny: ["建议", "灰度", "监控", "成功率", "延迟", "代码生成"],
  },
];

function buildSyntheticLongContext() {
  const blocks = [];
  for (let i = 1; i <= 40; i += 1) {
    blocks.push(
      `第 ${i} 批测试：渠道 A 成功率 ${95 + (i % 5)}%，平均延迟 ${8 + (i % 7)} 秒，` +
        `渠道 B 成功率 ${88 + (i % 9)}%，平均延迟 ${4 + (i % 6)} 秒。` +
        `异常包括偶发 timeout、rate limit、empty response。业务方更关注稳定性，其次才是价格。`,
    );
  }
  return blocks.join("\n");
}
