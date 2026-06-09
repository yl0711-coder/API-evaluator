// server/tokenizer-official.mjs
//
// 官方 tokenizer 精确分词（OpenAI 系）。基于成熟开源库 gpt-tokenizer（MIT，纯 JS，
// 内置 cl100k_base / o200k_base 词表，零自身运行时依赖）。
//
// 作用：对 OpenAI 系模型，可在本地精确算出任意文本的真实 token 数 → 把 token 审计
//   从"对照本地粗估/同模型横向"升级为**单渠道绝对 ground-truth**（精确虚报率 / tokenizer
//   家族一致性）。Claude/Gemini 官方未放出离线分词器，无法覆盖，调用方回退横向对照法。
//
// 懒加载：按需 import 对应编码子模块，未用到的编码不进内存；导入失败一律降级返回 null。

const encoderCache = new Map(); // encoding -> encode fn | null

// 模型名 → OpenAI 官方编码。无法确信映射时返回 null（宁可回退，也不用错编码算出假数据）。
// 内存保险：每个编码的 BPE 词表常驻约 70–90MB。在 2C/2G/无 swap 等极紧张部署上，可设
// EVALUATOR_OFFLINE_TOKENIZER=off 一键关闭官方分词器，全部回退到零额外内存的横向对照法。
export function resolveOpenAiEncoding(model) {
  if (String(process.env.EVALUATOR_OFFLINE_TOKENIZER || "").toLowerCase() === "off") return null;
  const m = String(model || "").toLowerCase().trim();
  if (!m) return null;
  if (/gpt-4o|chatgpt-4o|gpt-4\.1|gpt-5|o200k/.test(m)) return "o200k_base";
  if (/(^|[^a-z0-9])o[1345]([^a-z0-9]|$)/.test(m)) return "o200k_base"; // o1/o3/o4 推理系
  if (/gpt-4|gpt-3\.5|gpt-35|turbo|cl100k|text-embedding-3|davinci-002|babbage-002/.test(m)) return "cl100k_base";
  return null;
}

async function loadEncoder(encoding) {
  if (encoderCache.has(encoding)) return encoderCache.get(encoding);
  let fn = null;
  try {
    const mod = await import(`gpt-tokenizer/encoding/${encoding}`);
    const encode = mod.encode || mod.default?.encode;
    if (typeof encode === "function") fn = encode;
  } catch {
    fn = null;
  }
  encoderCache.set(encoding, fn);
  return fn;
}

// 精确 token 数；模型非 OpenAI 系或库不可用 → 返回 null（调用方回退）。
export async function countExactTokens(text, model) {
  const encoding = resolveOpenAiEncoding(model);
  if (!encoding) return null;
  const encode = await loadEncoder(encoding);
  if (!encode) return null;
  try {
    return encode(String(text || "")).length;
  } catch {
    return null;
  }
}

export function getModelEncodingInfo(model) {
  const encoding = resolveOpenAiEncoding(model);
  return { encoding, supported: Boolean(encoding) };
}
