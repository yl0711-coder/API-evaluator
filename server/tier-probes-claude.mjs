// server/tier-probes-claude.mjs
//
// Claude 档位判别题（capability-cliff）。用于「声称 Sonnet，行为像 Haiku」这类
// 同家族同代际内的**档位降级**判别——tokenizer / 自述 / 家族知识探针在此全部失效，
// 唯一稳定维度是「能力」：旗舰稳过、廉价兄弟稳挂的题才有判别力。
//
// 设计三原则：
//   ① 机器可判：每题有唯一可程序化校验的答案（严格判分，多字段全中 / 末位整数精确 / 规则全满足）。
//   ② 题=生成器：每题参数化随机，答案当场算出 → 抗记忆、抗探针规避、难度可调（level 是旋钮）。
//   ③ 答案不可猜：数值 / 严格 JSON / 多约束全满足，杜绝二选一蒙对。
//
// 诚实红线（沿用项目口径）：能力测不出"量化/蒸馏后仍能过电池的高仿旗舰"，
//   且成熟中转可识别并只把探针路由到真模型（probe evasion）。结论永远"疑似降级 / 需上游解释"，
//   不写"确定"。单次噪声大——必须多次采样（samples）+ 与黄金参考分布做似然比，聚合才是真信号。

export const TIER_PROBE_VERSION = "2026.06.17";

// —— 可复现伪随机（mulberry32）：同 seed 同实例，便于离线校准复跑 ——
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (rng, arr) => arr[randInt(rng, 0, arr.length - 1)];
function shuffle(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(rng, 0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}
// 严格 JSON 抽取：容忍 ```json 围栏与前后空白，但取出的对象必须值正确、键集精确。
function parseJsonStrict(text) {
  let s = String(text || "").trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}
// 末位整数（含负数）。链式算术 / 代码预测都只取模型输出里的最后一个整数。
function lastInt(text) {
  const m = String(text || "").match(/-?\d+/g);
  return m ? Number(m[m.length - 1]) : null;
}

// ============================================================================
// 类目 1 · 约束叠加 JSON —— 考"同时握住多个并发约束"，mini 会丢其中一条。
// ============================================================================
const WORDS = [
  "garden", "planet", "silver", "copper", "matrix", "lantern", "window",
  "castle", "dragon", "forest", "bridge", "candle", "pepper", "velvet",
  "saddle", "mirror", "harbor", "ginger", "marble", "cactus",
];

export function genConstraintJson(rng, level = 1) {
  const W = pick(rng, WORDS);
  const L = W[randInt(rng, 0, W.length - 1)]; // 保证 L 在 W 中（count ≥ 1）
  const a = randInt(rng, 6, 40);
  const b = randInt(rng, 6, 40);
  const g = gcd(a, b);
  const expected = {
    r: [...W].reverse().join(""),
    g,
    c: [...W].filter((ch) => ch === L).length,
    p: W.length * g,
  };
  const extraLines = [];
  if (level >= 2) {
    expected.q = g % 2 === 0 ? expected.c + expected.p : expected.c - expected.p;
    extraLines.push(`  "q"：若 g 为偶数则 c+p，否则 c−p；`);
  }
  if (level >= 3) {
    expected.d = new Set([...W]).size;
    expected.n = Math.min(a, b) % (expected.c + 1);
    extraLines.push(`  "d"："${W}" 中不同字母的种类数；`);
    extraLines.push(`  "n"：${a} 与 ${b} 中较小者对 (c+1) 取模的余数。`);
  }
  const keyList =
    level >= 3 ? `"r","g","c","p","q","d","n"` : level >= 2 ? `"r","g","c","p","q"` : `"r","g","c","p"`;
  const prompt = [
    "只输出一行 JSON，不要 Markdown、不要解释、不要任何多余字段。字段定义：",
    `  "r"：单词 "${W}" 反转后的字符串；`,
    `  "g"：${a} 和 ${b} 的最大公约数；`,
    `  "c"：单词 "${W}" 中字母 "${L}" 出现的次数；`,
    `  "p"："${W}" 的长度乘以 g。`,
    ...extraLines,
    `请输出且仅输出恰好包含 ${keyList} 这些键的 JSON。`,
  ].join("\n");
  return { prompt, expected, meta: { W, L, a, b } };
}

export function gradeConstraintJson(text, expected) {
  const obj = parseJsonStrict(text);
  if (!obj || typeof obj !== "object") return false;
  const keys = Object.keys(expected);
  if (Object.keys(obj).length !== keys.length) return false; // 严格：不许缺键/多键
  return keys.every((k) => obj[k] === expected[k]);
}

// ============================================================================
// 类目 2 · 链式算术带干扰句 —— 考"无关信息干扰下的多跳追踪"，mini 被带偏/丢中间值。
// ============================================================================
const DISTRACTORS = [
  "（仓库还剩 37 箱矿泉水，与本题无关。）",
  "（昨天最高气温是 19 摄氏度。）",
  "（这组记录的编号是 88 号，请忽略。）",
  "（隔壁房间有 6 把椅子。）",
  "（备注：本句与计算无关。）",
  "（顺便一提，今年是第 12 届。）",
  "（参考资料共 45 页。）",
];

export function genChainArith(rng, level = 1) {
  const depth = 2 + level; // 派生变量个数：level1→3，level2→4
  const distractorCount = 1 + level;
  const names = ["A", "B", "C", "D", "E", "F", "G"];
  const vals = {};
  const recordLines = [];
  vals.A = randInt(rng, 2, 9);
  vals.B = randInt(rng, 2, 9);
  recordLines.push(`${names[0]}=${vals.A}`);
  recordLines.push(`${names[1]}=${vals.B}`);
  const ops = ["+", "-", "*"];
  for (let i = 2; i < 2 + depth; i++) {
    const op = pick(rng, ops);
    const x = names[randInt(rng, 0, i - 1)];
    const y = names[randInt(rng, 0, i - 1)];
    const v = op === "+" ? vals[x] + vals[y] : op === "-" ? vals[x] - vals[y] : vals[x] * vals[y];
    vals[names[i]] = v;
    recordLines.push(`${names[i]}=${x}${op}${y}`);
  }
  const finalName = names[2 + depth - 1];
  const lines = recordLines.slice();
  if (level >= 3) {
    // 陷阱行：一条"看起来像记录、实际作废"的赋值，用从未参与计算的 Z，诱导 mini 误用。
    const x = pick(rng, names.slice(0, 2 + depth));
    const y = pick(rng, names.slice(0, 2 + depth));
    lines.push(`Z=${x}+${y}（备用变量，已作废，不参与最终计算）`);
  }
  for (const d of shuffle(rng, DISTRACTORS).slice(0, distractorCount)) {
    lines.splice(randInt(rng, 1, lines.length), 0, d);
  }
  const prompt = [
    `根据以下记录逐步计算 ${finalName} 的值。只输出一个整数，不要写过程、不要解释：`,
    "",
    ...lines,
    "",
    `只输出 ${finalName} 的数值。`,
  ].join("\n");
  return { prompt, expected: vals[finalName], meta: { vals, finalName } };
}

export function gradeChainArith(text, expected) {
  const v = lastInt(text);
  return v !== null && v === expected;
}

// ============================================================================
// 类目 4 · 代码输出预测 —— 考"精确执行语义"，mini 在推导式/过滤/索引组合上滑步。
//   只用受控模板族，答案在 JS 内以同语义算出，保证标准答案可靠。
// ============================================================================
export function genCodeTrace(rng, level = 1) {
  const N = randInt(rng, 6, 12);
  const M = randInt(rng, 2, 4);
  const R = randInt(rng, 0, M - 1);
  const arr = [];
  for (let i = 0; i < N; i++) if (i % M === R) arr.push(i * i); // N≥6≥M → 至少一项
  let code, expected;
  if (level >= 3) {
    // 双重推导 + 双参奇偶过滤：嵌套循环语义，Sonnet 也容易在求和上算偏。
    const A = randInt(rng, 3, 5);
    const B = randInt(rng, 3, 5);
    const M2 = randInt(rng, 2, 3);
    let sum = 0;
    for (let i = 0; i < A; i++) for (let j = 0; j < B; j++) if ((i + j) % M2 === 0) sum += i * j;
    expected = sum;
    code = `print(sum(i*j for i in range(${A}) for j in range(${B}) if (i+j)%${M2}==0))`;
  } else if (level >= 2) {
    const K = randInt(rng, 2, 5);
    const B = randInt(rng, 1, 9);
    expected = arr[arr.length - 1] * K + B;
    code = `print([i*i for i in range(${N}) if i%${M}==${R}][-1] * ${K} + ${B})`;
  } else {
    expected = arr.reduce((s, x) => s + x, 0);
    code = `print(sum(i*i for i in range(${N}) if i%${M}==${R}))`;
  }
  const prompt = [
    "下面这段 Python 代码的输出是什么？只输出最终结果（一个整数），不要解释、不要写推导过程：",
    "",
    code,
  ].join("\n");
  return { prompt, expected, meta: { code } };
}

export function gradeCodeTrace(text, expected) {
  const v = lastInt(text);
  return v !== null && v === expected;
}

// ============================================================================
// 类目 5 · 生成式多约束 —— 纯受限生成（不靠知识），mini 满足不了全部并发约束。
//   判分是规则校验：句数 / 每句恰一个数字 / 数字之和 / 每句汉字上限（/ 进阶：首字互异）。
// ============================================================================
export function genGenConstraints(rng, level = 1) {
  const n = 3; // 句数
  const m = 8; // 每句汉字上限
  const S = randInt(rng, 9, 15); // 数字之和
  const distinctFirst = level >= 2;
  const increasing = level >= 3;
  const constraints = [
    `恰好写 ${n} 句话，每句以中文句号「。」结尾`,
    `每句恰好包含一个阿拉伯数字`,
    `这 ${n} 个数字之和必须正好等于 ${S}`,
    `每句不超过 ${m} 个汉字（数字与标点不计入汉字数）`,
  ];
  if (distinctFirst) constraints.push(`每句的第一个汉字互不相同`);
  if (increasing) constraints.push(`三句话里的数字必须严格递增（后一句的数字大于前一句）`);
  const prompt = [
    "请严格满足以下全部约束，只输出这几句话本身，不要任何解释或前后缀：",
    ...constraints.map((c, i) => `${i + 1}. ${c}`),
  ].join("\n");
  return { prompt, expected: { n, m, S, distinctFirst, increasing }, meta: {} };
}

export function gradeGenConstraints(text, expected) {
  const { n, m, S, distinctFirst, increasing } = expected;
  const sentences = String(text || "")
    .trim()
    .split(/[。！？]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length !== n) return false; // 严格：多一句/少一句即失败（含多余解释文字）
  let sum = 0;
  const firsts = [];
  const numbers = [];
  for (const s of sentences) {
    const nums = s.match(/\d+/g) || [];
    if (nums.length !== 1) return false; // 恰好一个数字
    const val = Number(nums[0]);
    sum += val;
    numbers.push(val);
    const hanzi = [...s].filter((ch) => /[一-鿿]/.test(ch));
    if (hanzi.length === 0 || hanzi.length > m) return false;
    firsts.push(hanzi[0]);
  }
  if (sum !== S) return false;
  if (distinctFirst && new Set(firsts).size !== firsts.length) return false;
  if (increasing) {
    for (let i = 1; i < numbers.length; i++) if (!(numbers[i] > numbers[i - 1])) return false;
  }
  return true;
}

// ============================================================================
// Claude 档位电池配置 + 编排辅助
// ============================================================================
const ITEMS = {
  cs_json: { gen: genConstraintJson, grade: gradeConstraintJson },
  chain_arith: { gen: genChainArith, grade: gradeChainArith },
  code_trace: { gen: genCodeTrace, grade: gradeCodeTrace },
  gen_constraints: { gen: genGenConstraints, grade: gradeGenConstraints },
};

// 首版难度参数：目标是把 Sonnet（稳过）与 Haiku（稳挂）的差距调到最大。
// level 是旋钮，真实取值由离线校准（对官方 Opus/Sonnet/Haiku 各跑 K 次）按判别度回填。
export const CLAUDE_TIER_BATTERY = [
  { id: "cs_json", level: 1, samples: 4, weight: 1.0 },
  { id: "chain_arith", level: 2, samples: 4, weight: 1.0 },
  { id: "code_trace", level: 2, samples: 4, weight: 1.0 },
  { id: "gen_constraints", level: 1, samples: 4, weight: 1.0 },
];

// 高难电池（level 3）：用于把**顶档 Opus 与 Sonnet** 也拉开——此档 Haiku 近乎全挂、
// Sonnet 开始掉分、Opus 仍稳过。同样由离线校准回填真实 level 与各档参考分布。
export const CLAUDE_TIER_BATTERY_HARD = [
  { id: "cs_json", level: 3, samples: 4, weight: 1.0 },
  { id: "chain_arith", level: 3, samples: 4, weight: 1.0 },
  { id: "code_trace", level: 3, samples: 4, weight: 1.0 },
  { id: "gen_constraints", level: 3, samples: 4, weight: 1.0 },
];

// 运行约束：必须 temp=0、给足输出预算，否则截断/采样噪声会把真旗舰冤判成降级。
export const TIER_PROBE_RUNTIME = { temperature: 0, maxTokens: 256 };

// 生成一整组探针实例（item × samples）。seed 保证可复现；每个 sample 用 seed 派生子种子。
export function buildClaudeTierProbes(seed = 1, battery = CLAUDE_TIER_BATTERY) {
  const out = [];
  for (const item of battery) {
    const spec = ITEMS[item.id];
    if (!spec) continue;
    for (let s = 0; s < (item.samples || 1); s++) {
      const rng = mulberry32((seed * 1000003 + s * 97 + item.id.length) >>> 0);
      const { prompt, expected, meta } = spec.gen(rng, item.level || 1);
      out.push({
        id: `${item.id}#${s}`,
        itemId: item.id,
        level: item.level || 1,
        weight: item.weight ?? 1,
        prompt,
        expected,
        meta,
      });
    }
  }
  return out;
}

// 对单个实例判分（严格）。expected 来自 buildClaudeTierProbes，itemId 选对应判分器。
export function gradeTierProbe(itemId, text, expected) {
  const spec = ITEMS[itemId];
  return spec ? Boolean(spec.grade(text, expected)) : false;
}
