// server/judge-orchestration.mjs
//
// LLM-as-Judge 编排层。
//
// 把裁判原语（同家族规避 / 聚合 / Krippendorff α 一致性）组装成可运行流程。
// **裁判调用用依赖注入的 callJudge 函数**：测试用 mock，零真实请求、零额度消耗。
// 等用户授权裁判渠道 + 额度后，把真实 callJudge（接 test-runner 请求机）传进来即可激活。
//
// 红线：裁判主 API 不评同家族被测模型；裁判数 <2 或一致性不足 → 标"需人工复核"，
// 不当可信结论；盲测（不告诉裁判回答来自哪个模型/厂商）。

import { aggregateJudgeScores, judgeConsistency, selectEligibleJudges } from "./llm-judge.mjs";

export const DEFAULT_JUDGE_SCALE = 100;

// 盲测评分 prompt：只给问题 + 回答，不透露来源模型，要求结尾"评分：<数字>"。
export function buildJudgePrompt({ question = "", answer = "", rubric = "", scale = DEFAULT_JUDGE_SCALE } = {}) {
  return [
    "你是一名严格、中立的资深评测专家，负责为模型回答的质量打分。",
    "请只依据下面的【问题】和【回答】评分，不要猜测回答出自哪个模型或厂商，",
    "也不要因回答长度或措辞华丽与否而抬高或压低分数。",
    rubric ? `评分标准：\n${rubric}` : "评分标准：依次衡量准确性、完整性、相关性、表达清晰度四个维度，综合给分。",
    `请按步骤输出：先用不超过 100 字点出扣分点与亮点，再在最后单独一行用“评分：<数字>”给出一个 0 到 ${scale} 的整数。`,
    "",
    `【问题】\n${question}`,
    "",
    `【回答】\n${answer}`,
  ].join("\n");
}

// 从裁判文本里抽取分数。多级回退，但每级都收紧到"可信"才采用，否则返回 null
// （null = 无法解析，上游会跳过该裁判）。绝不把"猜出来的数字"伪装成有效评分——
// 旧实现的裸数字/分数回退会把 "3/2024" 解析成 0.148、把 "…2024…85分" 截成 202→100。
export function parseJudgeScore(text, { scale = DEFAULT_JUDGE_SCALE } = {}) {
  const t = String(text || "");
  const clamp = (v) => Math.max(0, Math.min(scale, v));

  // 1) 显式 "评分：NN"（prompt 要求的格式，最高优先级，越界裁剪）
  const labeled = t.match(/评分[:：]\s*(\d+(?:\.\d+)?)/);
  if (labeled) return clamp(Number(labeled[1]));

  // 2) 带计分上下文的数字："给 NN"/"得分 NN"/"score NN"/"NN 分"（排除 分类/分钟）
  const ctx = t.match(/(?:给(?:出)?\s*|得分[:：]?\s*|score[:：]?\s*)(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*分(?![类钟])/i);
  if (ctx) {
    const v = Number(ctx[1] ?? ctx[2]);
    if (Number.isFinite(v) && v >= 0 && v <= scale) return v;
  }

  // 3) "NN/MM" 分数式：分母必须是合理满分、分子不超分母（排除 "3/2024" 这类日期）
  const frac = t.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+)/);
  if (frac) {
    const num = Number(frac[1]);
    const den = Number(frac[2]);
    const plausibleDen = den === scale || [5, 10, 20, 50, 100, 1000].includes(den);
    if (den > 0 && plausibleDen && num <= den) return clamp((num / den) * scale);
  }

  // 4) 兜底：全文"恰好只有一个"数字 token 且落在 [0, scale] 时才采用
  //    （有第二个数字 token——日期/年份/小数项——就放弃，宁可记 null）
  const tokens = t.match(/\d+(?:\.\d+)?/g) || [];
  if (tokens.length === 1) {
    const v = Number(tokens[0]);
    if (v >= 0 && v <= scale) return v;
  }

  return null;
}

// 单答案多裁判评分。callJudge(judge, prompt) => Promise<string>（裁判原始文本）。
export async function runMultiJudge({
  judges = [],
  targetModel = "",
  question = "",
  answer = "",
  rubric = "",
  scale = DEFAULT_JUDGE_SCALE,
  callJudge,
} = {}) {
  if (typeof callJudge !== "function") throw new Error("runMultiJudge 需要 callJudge 函数");
  const { eligible, excluded } = selectEligibleJudges(judges, targetModel);
  if (eligible.length === 0) {
    return {
      ok: false,
      reason: "no_eligible_judge",
      excluded,
      needsHumanReview: true,
      note: "无可用裁判（全部与被测同家族），结果不可信，需人工复核。",
    };
  }
  const perJudge = [];
  for (const judge of eligible) {
    const prompt = buildJudgePrompt({ question, answer, rubric, scale });
    let raw = "";
    try {
      raw = await callJudge(judge, prompt);
    } catch {
      raw = "";
    }
    const score = parseJudgeScore(raw, { scale });
    if (score !== null) perJudge.push({ judge, score });
  }
  const aggregate = aggregateJudgeScores(perJudge);
  return {
    ok: perJudge.length > 0,
    scale,
    excluded,
    perJudge,
    ...aggregate,
    needsHumanReview: perJudge.length < 2, // 单裁判不算可信，一致性也无从谈起
  };
}

// 多答案 + 同一裁判组 → panel 级一致性（Krippendorff α 才有意义）。
// items：[{ question, answer, rubric }]
export async function assessJudgePanel({
  items = [],
  judges = [],
  targetModel = "",
  scale = DEFAULT_JUDGE_SCALE,
  callJudge,
  level = "interval",
} = {}) {
  const perItem = [];
  const units = [];
  for (const item of items) {
    // eslint-disable-next-line no-await-in-loop
    const r = await runMultiJudge({ judges, targetModel, scale, callJudge, ...item });
    perItem.push(r);
    units.push((r.perJudge || []).map((p) => p.score));
  }
  const consistency = judgeConsistency(units, { level });
  return {
    items: perItem,
    consistency,
    needsHumanReview: consistency.needsHumanReview || perItem.some((p) => !p.ok),
    method: "multi-judge + Krippendorff α 一致性",
  };
}
