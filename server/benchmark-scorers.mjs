// server/benchmark-scorers.mjs
//
// 能力深化 benchmark 判分器。纯判分逻辑，离线可测。
//
// 覆盖以下能力升级路径里的判分方法：
//   - BFCL AST：工具调用按结构（函数名 + 参数）判分，而非字符串匹配。
//   - NIAH / RULER：长上下文"针检索"——长文里埋事实，看模型能否取回。
//   - IFEval：可验证的指令遵循约束（字数/条数/关键词/格式…程序化判定）。
//   - HumanEval+：pass@k 无偏估计（Codex 论文）。
//   - LiveBench：客观 ground-truth 判分（精确答案 / 结构化深比对 / 无序集合）。
//
// 边界：数据集接入 + HumanEval 的**模型代码执行**需要隔离沙箱（运行不可信代码），
//   属 wiring，本模块不含执行，只提供 pass@k 估计与判分结构。

import { parseLooseJson } from "./utils.mjs";

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
  regex_match: (text, { pattern, flags }) => {
    try {
      return new RegExp(pattern, flags || "").test(text);
    } catch {
      return false;
    }
  },
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

// ---------------------------------------------------------------------------
// LiveBench：客观答案判分（精确匹配 / 结构化深比对 / 无序集合）
// 题目自带 ground-truth，程序化判分、不用 LLM 裁判。判分器为纯函数、离线可测。
// ---------------------------------------------------------------------------

// 全角 → 半角（数字/字母/标点），并把全角空格归一，统一比较口径。
function toHalfWidth(s) {
  return String(s || "")
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ");
}

// 归一化：半角化、折叠空白、去首尾、小写、剥成对引号/括号与尾随标点。
function normalizeAnswer(s) {
  let t = toHalfWidth(s).replace(/\s+/g, " ").trim().toLowerCase();
  t = t.replace(/^["'`“”‘’（(\[【]+/, "").replace(/["'`“”‘’）)\]】。.!！?？，,;；:：]+$/, "");
  return t.trim();
}

// 剥掉「答案标签」(最终答案/答案/the answer is/answer)：取最后一个标签后的内容，无标签则原样返回。
// 场景：题面常要求 "Answer: <...>"，模型会把整行（含标签）塞进 <solution>，导致抽取出 "Answer: 4, 1, 2, 3"
// 与期望 "4,1,2,3" 比不上。英文词加 \b 词界，避免误伤 "answered" 等。
function afterAnswerLabel(s) {
  const t = String(s || "").trim();
  const matches = [...t.matchAll(/(?:最终答案|答案(?:是|为)?|\bthe\s+answer\s+is\b|\banswer\b)(?:\s+is)?\s*[:：=]?\s*(.+)/gi)];
  const last = matches.length ? matches[matches.length - 1][1].trim() : "";
  return last || t;
}

// 从模型回答里抽取候选答案：<solution></solution> → 剥代码围栏 → \boxed{} → "答案/answer" 标记 → 末行。
function extractAnswer(response) {
  let text = String(response || "").trim();
  // LiveBench 多任务（zebra/web_of_lies 等）要求把最终答案放进 <solution></solution>，优先取其中内容；
  // 取最后一处，避免命中题面里的示例标签。再剥一层答案标签（奥赛填空等会把 "Answer: ..." 整行放进来）。
  const sols = [...text.matchAll(/<solution>\s*([\s\S]*?)\s*<\/solution>/gi)];
  if (sols.length) return afterAnswerLabel(sols[sols.length - 1][1].trim());
  text = text.replace(/```[a-zA-Z0-9_-]*\n?/g, "").replace(/```/g, "").trim();
  const boxed = text.match(/\\boxed\{([^}]*)\}/);
  if (boxed) return boxed[1].trim();
  const labeled = afterAnswerLabel(text);
  if (labeled !== text) return labeled; // 命中答案标签
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : text;
}

// 去千分位/空格后解析数值，失败返回 null。
function toNumber(v) {
  const n = Number(String(v == null ? "" : v).replace(/[,\s ]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// 精确答案判分：抽取 + 归一化匹配。expected 可为字符串或「可接受答案」数组。
// opts: { numeric:bool 强制数值比较, tolerance:number 数值容差(默认0), extract:bool 是否抽取(默认true) }
export function scoreExactAnswer(response, expected, opts = {}) {
  const { numeric = false, tolerance = 0, extract = true } = opts;
  const accepted = (Array.isArray(expected) ? expected : [expected]).filter((x) => x != null && String(x).length);
  if (!accepted.length) return { passed: false, score: 0, extracted: "", issues: ["未指定期望答案"] };
  const candidate = extract ? extractAnswer(response) : String(response || "");
  const candNorm = normalizeAnswer(candidate);
  const candCompact = candNorm.replace(/\s+/g, ""); // 去全部空白，吸收 "1, 6" vs "1,6" 这类序列格式差
  const candNum = toNumber(candidate);
  for (const exp of accepted) {
    const expNum = toNumber(exp);
    const numericPair = candNum != null && expNum != null && (numeric || /^[\s\d.,+\-/*^()]+$/.test(String(exp)));
    if (numericPair && Math.abs(candNum - expNum) <= tolerance) {
      return { passed: true, score: 1, extracted: candidate, issues: [] };
    }
    const expNorm = normalizeAnswer(exp);
    if (expNorm === candNorm || expNorm.replace(/\s+/g, "") === candCompact) {
      return { passed: true, score: 1, extracted: candidate, issues: [] };
    }
  }
  // 失败信息同时给出「期望」与「抽取」，避免误以为抽取值==模型回答就该判对（真正比对的是期望答案）。
  const expectedText = accepted.map((x) => String(x)).join(" / ").slice(0, 80);
  return { passed: false, score: 0, extracted: candidate, issues: [`答案不符（期望：${expectedText}；抽取：${candidate.slice(0, 60)}）`] };
}

// 把任意 JSON 值拍平成「路径 → 标量」映射，用于逐叶比对（对象键排序，保证稳定）。
function flattenLeaves(val, prefix = "", out = new Map()) {
  if (val === null || typeof val !== "object") {
    out.set(prefix, val);
    return out;
  }
  if (Array.isArray(val)) {
    val.forEach((v, i) => flattenLeaves(v, `${prefix}[${i}]`, out));
    return out;
  }
  for (const k of Object.keys(val).sort()) {
    flattenLeaves(val[k], prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

// 叶子相等：先严格相等，再数值容差，最后归一化字符串比较。
function leafEqual(a, b) {
  if (a === b) return true;
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na != null && nb != null) return na === nb;
  return normalizeAnswer(a) === normalizeAnswer(b);
}

// 鲁棒结构化解析：严格 JSON → 宽松 JSON → JSONL（逐行一个对象，table 重排常见）。
function parseStructured(text) {
  const t = String(text == null ? "" : text).trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    // 继续兜底
  }
  const loose = parseLooseJson(t);
  if (loose != null) return loose;
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    const arr = [];
    for (const ln of lines) {
      try {
        arr.push(JSON.parse(ln));
      } catch {
        return null;
      }
    }
    return arr;
  }
  return null;
}

// 结构化深比对（data-analysis：表格重排/连接/列类型）。解析模型 JSON 输出与 expected
// 逐叶比较，给部分得分；全叶命中且无多余字段才 passed。expected 可为 JS 值或 JSON/JSONL 字符串。
export function scoreStructuredMatch(response, expected) {
  let exp = expected;
  if (typeof expected === "string") {
    exp = parseStructured(expected);
    if (exp == null) return { passed: false, score: 0, matched: 0, total: 0, issues: ["expected 不是合法 JSON"] };
  }
  const got = parseStructured(String(response || ""));
  if (got == null) return { passed: false, score: 0, matched: 0, total: 0, issues: ["模型输出不是可解析 JSON"] };
  const expLeaves = flattenLeaves(exp);
  const gotLeaves = flattenLeaves(got);
  let matched = 0;
  const wrong = [];
  for (const [key, ev] of expLeaves) {
    if (gotLeaves.has(key) && leafEqual(ev, gotLeaves.get(key))) matched += 1;
    else wrong.push(key);
  }
  const extra = [...gotLeaves.keys()].filter((k) => !expLeaves.has(k));
  const total = expLeaves.size || 1;
  const score = Math.round((matched / total) * 1000) / 1000;
  const passed = matched === expLeaves.size && extra.length === 0;
  const issues = [];
  if (wrong.length) issues.push(`字段不符：${wrong.slice(0, 5).join(", ")}${wrong.length > 5 ? "…" : ""}`);
  if (extra.length) issues.push(`多余字段：${extra.length}`);
  return { passed, score, matched, total: expLeaves.size, issues };
}

// 把「表格的 JSON 表示」归一成「行对象数组」，吸收三种合法编排：
//   - 行对象数组 / JSONL（orient=records）→ 原样；
//   - 以行号为键的对象（orient=index，值都是对象）→ 取 values（丢掉行号，因为行号不可由模型复现）；
//   - 单个行对象 → 包一层。
// 其它（标量、列向 orient=columns 等）无法可靠判定行集，返回 null 让上层判失败。
function toRowList(parsed) {
  if (parsed == null) return null;
  if (Array.isArray(parsed)) return parsed.every((r) => r && typeof r === "object" && !Array.isArray(r)) ? parsed : null;
  if (typeof parsed === "object") {
    const vals = Object.values(parsed);
    if (vals.length && vals.every((v) => v && typeof v === "object" && !Array.isArray(v))) return vals;
    return [parsed]; // 扁平的单行对象
  }
  return null;
}
// 行内键去首尾空白（吸收 TSV 表头 "Accident " 这类尾空格），值原样保留。
function normalizeRow(row) {
  const out = {};
  for (const k of Object.keys(row)) out[String(k).trim()] = row[k];
  return out;
}
// 两行相等：同列集合 + 每列叶子相等（数值容差/归一化，复用 leafEqual）。
function rowsEqual(a, b) {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (!(k in b) || !leafEqual(a[k], b[k])) return false;
  }
  return true;
}

// 表格重排/连接专用判分（data-analysis tablereformat/tablejoin）。LiveBench 的 ground truth 把原始
// dataframe 的「行号」当顶层键（如 "69"/"2266"），而题面并不展示这些行号 —— 模型无从复现。故这里按
// **行对象的多重集合**比对：忽略顶层行号键、去列名首尾空白、数值容差、行序无关。全部行命中且无多余行才 passed。
export function scoreTableReformat(response, expected) {
  const exp = typeof expected === "string" ? parseStructured(expected) : expected;
  const expRows = toRowList(exp);
  if (!expRows) return { passed: false, score: 0, matched: 0, total: 0, issues: ["expected 不是可解析的表格"] };
  const got = parseStructured(String(response || ""));
  const gotRows = toRowList(got);
  if (!gotRows) return { passed: false, score: 0, matched: 0, total: expRows.length, issues: ["模型输出不是可解析的表格（应为行对象数组/JSON/JSONL）"] };
  const expN = expRows.map(normalizeRow);
  const gotN = gotRows.map(normalizeRow);
  const used = new Array(gotN.length).fill(false);
  let matched = 0;
  for (const er of expN) {
    const idx = gotN.findIndex((gr, i) => !used[i] && rowsEqual(er, gr));
    if (idx >= 0) {
      used[idx] = true;
      matched += 1;
    }
  }
  const extra = gotN.length - matched;
  const total = expN.length || 1;
  const score = Math.round((matched / total) * 1000) / 1000;
  const passed = matched === expN.length && extra === 0;
  const issues = [];
  if (matched < expN.length) issues.push(`行不符：命中 ${matched}/${expN.length}`);
  if (extra > 0) issues.push(`多余行：${extra}`);
  return { passed, score, matched, total: expN.length, issues };
}

// 把文本拆成成员集合：按换行/逗号/顿号/分号/竖线分隔，归一化去空。
function tokenizeSet(text) {
  return String(text || "")
    .split(/[\n,，、;；|]+/)
    .map((x) => normalizeAnswer(x))
    .filter(Boolean);
}

// 无序集合匹配（如 Connections 分组）：期望成员是否都出现在模型输出里。
// score=命中/期望，全中才 passed。expectedSet: 字符串数组（期望成员）。
export function scoreSetMatch(response, expectedSet) {
  const expected = (expectedSet || []).map((x) => normalizeAnswer(x)).filter(Boolean);
  if (!expected.length) return { passed: false, score: 0, matched: 0, total: 0, issues: ["未指定期望集合"] };
  const got = new Set(tokenizeSet(response));
  const norm = normalizeAnswer(response);
  let matched = 0;
  const missing = [];
  for (const m of expected) {
    if (got.has(m) || norm.includes(m)) matched += 1;
    else missing.push(m);
  }
  const total = expected.length;
  const score = Math.round((matched / total) * 1000) / 1000;
  return {
    passed: matched === total,
    score,
    matched,
    total,
    issues: missing.length ? [`缺成员：${missing.slice(0, 5).join(", ")}`] : [],
  };
}
