// 模型官方价目表（USD / 百万 token）。来源：各厂商定价页，2026-06 录入（见“几个模型的价格.docx”）。
// 用途：官方价【参考】表，供建渠道时按模型名预填价格起点等场景用——
//       注意中转/relay 渠道实际价常与官方标价不同，渠道真实成本仍以渠道自填单价为准，
//       本表不参与成本估算的静默兜底（避免给出误导成本）。
// 说明：本系统每渠道只有单一 input/output 单价，OpenAI 这里取“短上下文”标准价；
//       cachedInput / cacheRead 仅作记录。匹配对 . - _ 分隔与大小写都兼容。

const MODEL_PRICE_CATALOG = [
  // —— OpenAI GPT-5.x（短上下文标准价）——
  { id: "gpt-5.5-pro", match: /gpt[-_ ]?5[.\-_]5[-_ ]?pro/, input: 30, output: 180 },
  { id: "gpt-5.5", match: /gpt[-_ ]?5[.\-_]5/, input: 5, cachedInput: 0.5, output: 30 },
  { id: "gpt-5.4-pro", match: /gpt[-_ ]?5[.\-_]4[-_ ]?pro/, input: 30, output: 180 },
  { id: "gpt-5.4-mini", match: /gpt[-_ ]?5[.\-_]4[-_ ]?mini/, input: 0.75, cachedInput: 0.075, output: 4.5 },
  { id: "gpt-5.4-nano", match: /gpt[-_ ]?5[.\-_]4[-_ ]?nano/, input: 0.2, cachedInput: 0.02, output: 1.25 },
  { id: "gpt-5.4", match: /gpt[-_ ]?5[.\-_]4/, input: 2.5, cachedInput: 0.25, output: 15 },

  // —— Anthropic Claude ——
  { id: "claude-fable-5", match: /fable[-_ ]?5/, input: 10, output: 50, cacheRead: 1 },
  { id: "claude-mythos-5", match: /mythos[-_ ]?5/, input: 10, output: 50, cacheRead: 1 },
  { id: "claude-opus-4-8", match: /opus[-_ ]?4[.\-_]8/, input: 5, output: 25, cacheRead: 0.5 },
  { id: "claude-opus-4-7", match: /opus[-_ ]?4[.\-_]7/, input: 5, output: 25, cacheRead: 0.5 },
  { id: "claude-opus-4-6", match: /opus[-_ ]?4[.\-_]6/, input: 5, output: 25, cacheRead: 0.5 },
  { id: "claude-opus-4-5", match: /opus[-_ ]?4[.\-_]5/, input: 5, output: 25, cacheRead: 0.5 },
  { id: "claude-opus-4-1", match: /opus[-_ ]?4[.\-_]1/, input: 15, output: 75, cacheRead: 1.5 },
  { id: "claude-opus-4", match: /opus[-_ ]?4(?![.\-_]?\d)/, input: 15, output: 75, cacheRead: 1.5 },
  { id: "claude-sonnet-4-6", match: /sonnet[-_ ]?4[.\-_]6/, input: 3, output: 15, cacheRead: 0.3 },
  { id: "claude-sonnet-4-5", match: /sonnet[-_ ]?4[.\-_]5/, input: 3, output: 15, cacheRead: 0.3 },
  { id: "claude-sonnet-4", match: /sonnet[-_ ]?4(?![.\-_]?\d)/, input: 3, output: 15, cacheRead: 0.3 },
  { id: "claude-haiku-4-5", match: /haiku[-_ ]?4[.\-_]5/, input: 1, output: 5, cacheRead: 0.1 },
  { id: "claude-haiku-3-5", match: /haiku[-_ ]?3[.\-_]5/, input: 0.8, output: 4, cacheRead: 0.08 },
];

// 按模型名查官方价。命中返回单价对象，未命中返回 null。
export function lookupModelPrice(modelName) {
  const text = String(modelName || "").toLowerCase().trim();
  if (!text) return null;
  for (const entry of MODEL_PRICE_CATALOG) {
    if (entry.match.test(text)) {
      return {
        id: entry.id,
        inputPricePerMTokens: entry.input,
        outputPricePerMTokens: entry.output,
        cachedInputPricePerMTokens: entry.cachedInput ?? null,
        cacheReadPricePerMTokens: entry.cacheRead ?? null,
        currency: "USD",
      };
    }
  }
  return null;
}

// 供 UI / 调试列出全部已录入价目。
export function listModelPrices() {
  return MODEL_PRICE_CATALOG.map((entry) => ({
    id: entry.id,
    inputPricePerMTokens: entry.input,
    outputPricePerMTokens: entry.output,
  }));
}
