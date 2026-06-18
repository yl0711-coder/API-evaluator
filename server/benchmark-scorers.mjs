// server/benchmark-scorers.mjs
//
// 能力深化 benchmark 判分器。纯判分逻辑，离线可测。
//
// 覆盖以下能力升级路径里的判分方法：
//   - BFCL AST：工具调用按结构（函数名 + 参数）判分，而非字符串匹配。
//   - NIAH / RULER：长上下文"针检索"——长文里埋事实，看模型能否取回。
//   - IFEval：可验证的指令遵循约束（字数/条数/关键词/格式…程序化判定）。
//   - HumanEval+：pass@k 无偏估计（Codex 论文）。
//
// 边界：数据集接入 + HumanEval 的**模型代码执行**需要隔离沙箱（运行不可信代码），
//   属 wiring，本模块不含执行，只提供 pass@k 估计与判分结构。

const isNum = (v) => Number.isFinite(Number(v));

// ---------------------------------------------------------------------------
// BFCL：AST 风格工具调用判分
// ---------------------------------------------------------------------------

function valuesEqual(a, b) {
  if (a === b) return true;
  if (isNum(a) && isNum(b)) return Number(a) === Number(b);
  if (typeof a === "string" && typeof b === "string") return a.trim() === b.trim();
  // 结构化值按 JSON 比较
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
} // 这个函数用来比较a和b是不是相等

// expected/actual：{ name, arguments: {k:v} }。结构化比对，非字符串匹配。
export function scoreBfclToolCall(expected, actual) {
  const issues = [];
  if (!expected || !expected.name) {
    return { match: false, score: 0, nameMatch: false, issues: ["缺少期望工具定义"] };
  }
  if (!actual || !actual.name) {
    return { match: false, score: 0, nameMatch: false, issues: ["未产生工具调用"] };
  }
  const nameMatch = expected.name === actual.name;
  if (!nameMatch) {
    return { match: false, score: 0, nameMatch: false, issues: [`函数名不符：期望 ${expected.name}，实际 ${actual.name}`] };
  }

  const expArgs = expected.arguments || {};
  const actArgs = actual.arguments || {};
  const expKeys = Object.keys(expArgs);
  const missingArgs = [];
  const wrongArgs = [];
  let correct = 0;
  for (const k of expKeys) {
    if (!(k in actArgs)) {
      missingArgs.push(k);
    } else if (valuesEqual(expArgs[k], actArgs[k])) {
      correct += 1;
    } else {
      wrongArgs.push(k);
    }
  }
  const extraArgs = Object.keys(actArgs).filter((k) => !(k in expArgs));

  if (missingArgs.length) issues.push(`缺少参数：${missingArgs.join(", ")}`);
  if (wrongArgs.length) issues.push(`参数值不符：${wrongArgs.join(", ")}`);
  if (extraArgs.length) issues.push(`多余参数（疑似幻觉）：${extraArgs.join(", ")}`);

  const argCorrectness = expKeys.length === 0 ? 1 : correct / expKeys.length;
  // 名对得 0.5，参数正确性占 0.5；多余参数扣分
  let score = 0.5 + 0.5 * argCorrectness;
  if (extraArgs.length) score -= Math.min(0.5, 0.1 * extraArgs.length);
  score = Math.max(0, Math.min(1, score));

  const match = missingArgs.length === 0 && wrongArgs.length === 0 && extraArgs.length === 0;
  return { match, score: Math.round(score * 1000) / 1000, nameMatch, missingArgs, wrongArgs, extraArgs, issues };
}

// ---------------------------------------------------------------------------
// NIAH / RULER：长上下文针检索
// ---------------------------------------------------------------------------

// 在 filler 文本里按深度比例插入 needle，构造长上下文 haystack。
export function buildHaystack({ filler, needle, depthRatio = 0.5, repeats = 50 } = {}) {
  const base = String(filler || "这是一段无关的填充文本，用于撑长上下文。").trim();
  const blocks = Array.from({ length: Math.max(1, repeats) }, () => base);
  const at = Math.max(0, Math.min(blocks.length, Math.round(blocks.length * depthRatio)));
  blocks.splice(at, 0, String(needle || ""));
  return blocks.join("\n");
}

// 判分：模型回答里是否取回了 needle 的答案（归一化子串匹配）。
export function scoreNeedleRetrieval(response, needleAnswer) {
  const text = String(response || "").toLowerCase().replace(/\s+/g, "");
  const target = String(needleAnswer || "").toLowerCase().replace(/\s+/g, "");
  if (!target) return { retrieved: false, score: 0, note: "未指定 needle 答案" };
  const retrieved = text.includes(target);
  return { retrieved, score: retrieved ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// IFEval：可验证指令遵循
// ---------------------------------------------------------------------------

const IFEVAL_CHECKERS = {
  min_words: (text, { count }) => wordCount(text) >= count,
  max_words: (text, { count }) => wordCount(text) <= count,
  exact_bullets: (text, { count }) => bulletLines(text).length === count,
  include_keyword: (text, { keyword }) => text.includes(String(keyword)),
  forbidden_keyword: (text, { keyword }) => !text.includes(String(keyword)),
  no_commas: (text) => !/[,，]/.test(text),
  json_only: (text) => isJsonOnly(text),
  ends_with: (text, { phrase }) => text.trim().endsWith(String(phrase)),
  starts_with: (text, { phrase }) => text.trim().startsWith(String(phrase)),
  min_chars: (text, { count }) => [...text].length >= count,
  max_chars: (text, { count }) => [...text].length <= count,
};

function wordCount(text) {
  const t = String(text || "").trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}
function bulletLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^([-*•]|\d+[.、)])\s+/.test(l));
}
function isJsonOnly(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

// instructions：[{ type, ...params }]。返回每条是否通过 + 总通过率（全过才 passed）。
export function ifevalCheck(response, instructions) {
  const text = String(response || "");
  const results = (instructions || []).map((ins) => {
    const checker = IFEVAL_CHECKERS[ins.type];
    if (!checker) return { type: ins.type, passed: false, note: "未知指令类型" };
    let passed = false;
    try {
      passed = Boolean(checker(text, ins));
    } catch {
      passed = false;
    }
    return { type: ins.type, passed };
  });
  const total = results.length;
  const passedCount = results.filter((r) => r.passed).length;
  return {
    passed: total > 0 && passedCount === total,
    passRate: total ? Math.round((passedCount / total) * 1000) / 1000 : null,
    passedCount,
    total,
    results,
  };
}

// ---------------------------------------------------------------------------
// HumanEval+：pass@k 无偏估计（Codex 论文）
// ---------------------------------------------------------------------------

// n 个采样里 c 个通过，估计 pass@k。数值稳定形式：n-c<k → 1，否则 1-∏(1-k/i)。
export function passAtK(n, c, k) {
  const N = Math.floor(n);
  const C = Math.floor(c);
  const K = Math.floor(k);
  if (N <= 0 || K <= 0 || C < 0 || C > N) return null;
  if (N - C < K) return 1;
  let prod = 1;
  for (let i = N - C + 1; i <= N; i++) {
    prod *= 1 - K / i;
  }
  return Math.round((1 - prod) * 1e6) / 1e6;
}
