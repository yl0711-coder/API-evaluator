// 模型对比内核（数据源无关）：把「报告中心 / Evaluation Report」里已有的评测报告 Markdown
// 解析成结构化指标，聚合成「对象画像」，再对比两个对象、产出一份 Markdown 对比报告。
//
// 第一阶段（POC）只被 scripts/compare-eval-reports.mjs 调用、对比 Evaluation Report/ 下两个文件夹；
// 第二阶段可直接复用本内核，换数据源（报告中心）+ 加前端/AI 叙述。
//
// 解析目标不止表面数字，还挖出报告里的诊断信息：错误分布、基线回归、
// 指纹横向对照（与同模型其它渠道是否一致）、准入分项、逐场景失败原因、按难度档位拆解，以支撑有深度的对比。
// 缺失值 `-` 一律解析为 null（不当 0）。
import { compareProportions, mcnemarTest, pairedTTest, wilcoxonSignedRank, wilsonInterval } from "./stats.mjs";
// 「场景结论」与报告里显示的那列同源：调同一个纯函数，而非解析它渲染出的文字（见 scenarioDataFromSummary）。
// reporting.mjs 无顶层 I/O（实测 import 14ms、不碰盘），故本模块仍是纯函数、可离线单测。
import { buildScenarioReviewAdvice } from "./reporting.mjs";

// —— 对比专用统计量（配对分析 / 效果量 / 两样本 bootstrap）——
// 依据 Miller 2024《Adding Error Bars to Evals》：同名场景是「配对」样本，应用配对差值（含相关项）
// 降方差、并报效果量与置信区间，而非只比两条独立置信区间是否重叠（过于保守、太笼统）。

// Pearson 相关：配对越正相关，配对法降低的方差越多（Miller 建议一并报告）。
function pearson(a, b) {
  const xs = [];
  const ys = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++)
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      xs.push(a[i]);
      ys.push(b[i]);
    }
  const m = xs.length;
  if (m < 2) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / m;
  const my = ys.reduce((s, v) => s + v, 0) / m;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < m; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

// Cliff's δ：非参数效果量（A 随机高于 B 的概率 − 反向概率）。阈值：<0.147 可忽略 / <0.33 小 / <0.474 中 / ≥0.474 大。
function cliffsDelta(a, b) {
  const A = a.filter(Number.isFinite);
  const B = b.filter(Number.isFinite);
  if (!A.length || !B.length) return { delta: null, magnitude: "样本不足" };
  let gt = 0;
  let lt = 0;
  for (const x of A)
    for (const y of B) {
      if (x > y) gt++;
      else if (x < y) lt++;
    }
  const delta = (gt - lt) / (A.length * B.length);
  const m = Math.abs(delta);
  return { delta, magnitude: m < 0.147 ? "可忽略" : m < 0.33 ? "小" : m < 0.474 ? "中" : "大" };
}

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
function quantileSorted(sorted, q) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
const median = (vals) => {
  const s = vals.filter(Number.isFinite).sort((x, y) => x - y);
  return s.length ? quantileSorted(s, 0.5) : null;
};
const p95stat = (vals) => {
  const s = vals.filter(Number.isFinite).sort((x, y) => x - y);
  return s.length ? quantileSorted(s, 0.95) : null;
};

// 两独立样本 bootstrap：给统计量差（如中位延迟差）的百分位置信区间（种子固定→可复现）。
function bootstrapDiffCI(aVals, bVals, { stat = median, resamples = 2000, seed = 1469598103, alpha = 0.05 } = {}) {
  const A = aVals.filter(Number.isFinite);
  const B = bVals.filter(Number.isFinite);
  if (A.length < 3 || B.length < 3) return { point: null, lower: null, upper: null, n: Math.min(A.length, B.length), note: "样本不足" };
  const rng = mulberry32(seed);
  const diffs = new Array(resamples);
  const ra = new Array(A.length);
  const rb = new Array(B.length);
  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < A.length; i++) ra[i] = A[Math.floor(rng() * A.length)];
    for (let i = 0; i < B.length; i++) rb[i] = B[Math.floor(rng() * B.length)];
    diffs[r] = stat(ra) - stat(rb);
  }
  diffs.sort((x, y) => x - y);
  return {
    point: stat(A) - stat(B),
    lower: quantileSorted(diffs, alpha / 2),
    upper: quantileSorted(diffs, 1 - alpha / 2),
    n: Math.min(A.length, B.length),
    statA: stat(A),
    statB: stat(B),
  };
}

// —— 基础文本工具 ——

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 抽取 `## <含 keyword 的标题>` 到下一个 `## ` 之间的整段（`### ` 子标题不算边界）。
function section(md, keyword) {
  const lines = String(md || "").split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]) && lines[i].includes(keyword)) {
      start = i;
      break;
    }
  }
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

// 收集某标题（## 或 ###）下紧跟的 `- …` 列表项文本（到空行/下一个标题为止）。
function collectBullets(md, keyword) {
  const lines = String(md || "").split(/\r?\n/);
  let i = lines.findIndex((l) => /^#{2,3}\s/.test(l) && l.includes(keyword));
  if (i < 0) return [];
  const out = [];
  for (i += 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{1,3}\s/.test(l)) break;
    const m = l.match(/^\s*-\s+(.*)/);
    if (m) out.push(m[1].trim());
    else if (l.trim() === "" && out.length) break;
  }
  return out;
}

// 取 `- 标签：值` / `- **标签**：值`（全角或半角冒号）的值（第一处）。
function kv(text, label) {
  const re = new RegExp(`(?:\\*\\*)?${escapeRe(label)}(?:\\*\\*)?\\s*[:：]\\s*(.+)`);
  const m = String(text || "").match(re);
  return m ? m[1].trim() : null;
}

// 文本里第一个数字（去千分位、忽略单位）；`-` / 空 / 无数字 → null。
function num(s) {
  if (s == null) return null;
  const t = String(s).replace(/,/g, "").trim();
  if (t === "" || t === "-") return null;
  const m = t.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// "100% (10/10)" / "80% (8/10)" / "0%" → { rate, succ, total }（succ/total 缺则 null）。
function pctCount(s) {
  if (s == null) return { rate: null, succ: null, total: null };
  const str = String(s);
  const p = str.match(/(\d+(?:\.\d+)?)\s*%/);
  const c = str.match(/\((\d+)\s*\/\s*(\d+)\)/);
  return {
    rate: p ? Number(p[1]) / 100 : null,
    succ: c ? Number(c[1]) : null,
    total: c ? Number(c[2]) : null,
  };
}

// 宽松解析 GFM 表：返回 { headers, rows }。数据行可能没有前导 `|`（本项目报告即如此），
// 按去掉首尾空单元后从左对齐到表头。取「靠左」的列（API/场景/成功率/质量分…）稳定可靠。
function parseTable(sectionText) {
  const lines = String(sectionText || "").split(/\r?\n/);
  const sepIdx = lines.findIndex((l) => /^\s*\|?\s*-{2,}/.test(l) && l.includes("---"));
  if (sepIdx < 1) return { headers: [], rows: [] };
  const splitCells = (line) => {
    let cells = line.split("|").map((c) => c.trim());
    while (cells.length && cells[0] === "") cells.shift();
    while (cells.length && cells[cells.length - 1] === "") cells.pop();
    return cells;
  };
  const headers = splitCells(lines[sepIdx - 1]);
  const rows = [];
  for (let i = sepIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) break; // 表结束
    if (/^##\s/.test(line)) break;
    rows.push(splitCells(line));
  }
  return { headers, rows };
}

function colIndex(headers, keyword) {
  return headers.findIndex((h) => h.includes(keyword));
}
const cell = (cells, i) => (i >= 0 && i < cells.length ? cells[i] : null);

// 场景「问题摘要」是否为错误型失败（限流/超时/连接等，属可用性问题）而非能力型低分（如答案字段不符）。
// 区分二者很关键：因超时得 0 分不等于「档位降级（换了更弱的模型）」。
const ERROR_ISSUE_RE = /rate.?limit|限流|timeout|超时|\berror\b|拒绝服务|连接|服务不可用|429|5\d\d/i;
const isErrorIssue = (s) => ERROR_ISSUE_RE.test(String(s || ""));

function avg(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (!clean.length) return null;
  return clean.reduce((s, v) => s + v, 0) / clean.length;
}

// 场景名 → 难度档位/类别（用于「档位降级」视角的分层对比）。
export function scenarioTier(name) {
  const n = String(name || "");
  if (/^HardcoreLogic/i.test(n)) return "HardcoreLogic 逻辑谜题";
  if (/^HLE/i.test(n)) return "HLE 专家难题";
  if (/^LiveBench/i.test(n)) return "LiveBench 抗污染";
  if (/安全|红线|越狱|拒答|拒绝/.test(n)) return "安全红线";
  if (/写作/.test(n)) return "写作";
  return "基础/常识";
}

// —— 文件名解析（镜像 src/report-id.js 的 parseReportId）——

export function parseReportBaseName(name) {
  const base = String(name || "").replace(/\.(md|html)$/i, "");
  const parts = base.split("_");
  const dateIdx = parts.findIndex((p) => /^\d{8}$/.test(p));
  if (dateIdx < 1) return { channel: null, model: null, type: null, date: null };
  const type = parts[dateIdx - 1];
  const date = parts[dateIdx];
  const head = parts.slice(0, dateIdx - 1);
  const channel = head.length >= 2 ? head.slice(0, -1).join("_") : null;
  const model = head.length >= 2 ? head[head.length - 1] : head[0] || null;
  return { channel, model, type, date };
}

export function detectReportType(name, md) {
  const t = parseReportBaseName(name).type;
  if (t === "run" || t === "scenario" || t === "admission") return t;
  const head = String(md || "").slice(0, 200);
  if (head.includes("稳定性测试报告")) return "run";
  if (head.includes("场景测试报告")) return "scenario";
  if (head.includes("准入评测报告")) return "admission";
  return t || "unknown";
}

// —— 单份报告解析 ——

// 错误分布段：`- rate_limited: 2` → {rate_limited:2}；`- 无` → {}。
function parseErrorDist(sectionText) {
  const out = {};
  for (const line of String(sectionText || "").split(/\r?\n/)) {
    const m = line.match(/^\s*-\s*([A-Za-z0-9_]+)\s*[:：]\s*(\d+)/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

export function parseRunReport(md) {
  const s4 = section(md, "专业汇总结论");
  const s3 = section(md, "测试对象");
  const review = section(md, "复核"); // 高敏感结论（token 虚报等）
  const sr = pctCount(kv(s4, "成功率"));
  const fs = (kv(s4, "最快/最慢") || "").split("/");
  const infl = review.match(/×\s*(\d+(?:\.\d+)?)/);
  const baselineText = kv(s4, "基线回归");
  // 单轮明细：延迟统计口径 = 成功轮 + 所有【有耗时记录】的失败轮（超时/限流/其它失败一律按其实际总耗时计入，
  // 反映失败等待对体验的真实拖累）；仅无总耗时记录（如「-」）的轮次排除。latencyRounds 供第二小节重算 avg/P50/P95/P99。
  const detail = parseTable(section(md, "单轮明细"));
  const iRes = colIndex(detail.headers, "结果");
  const iTot = colIndex(detail.headers, "总耗时");
  const iFB = colIndex(detail.headers, "首包");
  const latencyRounds = [];
  for (const cells of detail.rows) {
    const total = num(cell(cells, iTot));
    if (!Number.isFinite(total)) continue; // 无总耗时记录 → 排除
    const firstByte = num(cell(cells, iFB));
    latencyRounds.push({ total, firstByte: Number.isFinite(firstByte) ? firstByte : null, success: /成功/.test(cell(cells, iRes) || "") });
  }
  const latencySamples = latencyRounds.map((r) => r.total);
  return {
    type: "run",
    rate: sr.rate,
    succ: sr.succ,
    total: sr.total,
    ci95Text: (kv(s4, "成功率 95% 置信区间") || "").replace(/（.*/, "").trim() || null,
    avgFirstByteMs: num(kv(s4, "平均首包")),
    avgTotalMs: num(kv(s4, "平均总耗时")),
    p50TotalMs: num(kv(s4, "P50 总耗时")),
    p95TotalMs: num(kv(s4, "慢请求参考 P95")),
    p99TotalMs: num(kv(s4, "尾部延迟 P99")),
    minMs: fs[0] != null ? num(fs[0]) : null,
    maxMs: fs[1] != null ? num(fs[1]) : null,
    avgOutputChars: num(kv(s4, "平均输出字符")),
    inputTokens: num(kv(s4, "输入 tokens 合计")),
    outputTokens: num(kv(s4, "输出 tokens 合计")),
    estCost: num(kv(s4, "估算成本")),
    rounds: num(kv(s3, "测试轮数")),
    concurrency: num(kv(s3, "并发数")),
    latencySamples,
    latencyRounds,
    errorCounts: parseErrorDist(section(md, "错误分布")),
    baselineText,
    baselineRegressed: /退化|↓|⚠️/.test(baselineText || ""),
    billingAudit: kv(s4, "计费审计") || null,
    tokenInflation: infl ? Number(infl[1]) : null,
  };
}

export function parseScenarioReport(md) {
  const s2 = section(md, "专业分析摘要");
  const repeats = num(kv(s2, "每个场景重复次数")) || 1;
  const { headers, rows } = parseTable(section(md, "场景明细"));
  const ci = {
    name: colIndex(headers, "场景"),
    rate: colIndex(headers, "成功率"),
    quality: colIndex(headers, "平均质量分"),
    avgMs: colIndex(headers, "平均耗时"),
    p95: colIndex(headers, "慢请求参考 P95"),
    issue: colIndex(headers, "问题摘要"),
    conclusion: colIndex(headers, "场景结论"),
  };
  const scenarios = [];
  for (const cells of rows) {
    const name = cell(cells, ci.name);
    if (!name) continue;
    const pc = pctCount(cell(cells, ci.rate));
    const total = repeats;
    // 「模型样例回答」列可能含 `|`（如表格重排答案），使其右侧列错位——此时不信任 问题摘要/场景结论。
    // 靠左的成功率/质量分/耗时/P95 在样例回答列之前，仍可靠。
    const overflow = cells.length > headers.length;
    scenarios.push({
      name,
      tier: scenarioTier(name),
      rate: pc.rate,
      succ: pc.rate == null ? null : Math.round(pc.rate * total),
      total,
      quality: num(cell(cells, ci.quality)),
      avgMs: num(cell(cells, ci.avgMs)),
      p95: num(cell(cells, ci.p95)),
      issue: overflow ? "" : (cell(cells, ci.issue) || "").trim(),
      conclusion: overflow ? "" : (cell(cells, ci.conclusion) || "").trim(),
      errored: overflow ? false : isErrorIssue(cell(cells, ci.issue)),
    });
  }
  return { type: "scenario", repeats, scenarios };
}

// —— 场景报告：从结构化 summary 直接构造（不解析 markdown）——
// 数据源＝test_runs.raw_json，即当初喂给 formatScenarioReport 的同一个 summary 对象。
// 这条路取代 parseScenarioReport 成为主路径；md 解析退居兜底（老报告/孤儿报告仍走它）。
//
// 为什么值得换：parseScenarioReport 靠中文表头找列（colIndex(headers,"平均质量分")），
// 表头一改就返回 -1、整条链静默降级成 null，对比结果悄悄算错且不报错（B2）。
// 而这些数字本来就以原生数值存在库里，没必要从渲染后的表格里再猜回来。
//
// 实证（227 份真实报告的差分实验）：compare 实际会读到的 145 份场景报告全部单 API、
// 100% 有 raw_json；两条路取出的 成功率/质量分/耗时/P95 零分歧。
// 唯一的表示差异是「全失败场景」——md 写「-」解析得 null，库里存 0，库侧更精确。
//
// 返回值刻意与 parseScenarioReport 逐字段同形，便于二者互换与等价测试。
export function scenarioDataFromSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  const results = Array.isArray(summary.results) ? summary.results : [];
  if (!results.length) return null;
  const repeats = Number(summary.repeats) || 1;
  const scenarios = [];
  for (const result of results) {
    for (const s of result.scenarios || []) {
      const name = s.scenarioName;
      if (!name) continue;
      // 与 reporting 同源：问题摘要列＝`issues.join("; ") || "-"`（见 reporting.mjs 场景明细表构造）。
      // 空 issues 必须给 "-" 而非 ""：下游 aggregateSubject 用 `rows.map(r=>r.issue).filter(Boolean)[0]`
      // 挑代表值，"-" 是 truthy 而 "" 是 falsy，两者会选出不同的行 —— 给 "" 就是静默改行为。
      // （契约测试第一次跑就抓到了这点。）
      const issue = (Array.isArray(s.issues) ? s.issues.join("; ") : "") || "-";
      const rate = typeof s.successRate === "number" ? s.successRate : null;
      scenarios.push({
        name,
        tier: scenarioTier(name),
        rate,
        succ: rate == null ? null : Math.round(rate * repeats),
        total: repeats,
        quality: numOrNull(s.avgQualityScore),
        avgMs: numOrNull(s.avgTotalMs),
        p95: numOrNull(s.p95TotalMs),
        issue,
        // 场景结论：调 reporting 的同一个纯函数，而不是解析它渲染出的那列文字。
        conclusion: buildScenarioReviewAdvice(s).verdict || "",
        errored: isErrorIssue(issue),
      });
    }
  }
  return { type: "scenario", repeats, scenarios };
}

const numOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// —— 稳定性(run)报告：用结构化 summary 覆盖那些靠 kv() 查中文标签得来的数值 ——
// 入参 base ＝ parseRunReport(md) 的结果；summary ＝ test_runs.raw_json。
// 返回 base 的副本，数值字段改用库里的原生值。
//
// 为什么是「覆盖」而非「完全取代」（与 scenario 的做法不同）：
//   parseRunReport 的 16 个数值字段靠 kv(s4,"平均首包") 这类中文标签取值，标签一改就返回 null——
//   这些字段库里都有（已核实 compare 可读的 38 份 run 报告 100% 齐全），故全部改从库里取。
//   但 latencySamples/latencyRounds 是逐轮原始样本，被 slimSummaryForStorage 砍掉了，库里没有；
//   而它们要喂 bootstrapDiffCI 算两模型延迟差的置信区间，是对比的统计核心，不能丢。
//   逐轮数据只在 test_requests 里，取它就得按 case_id 过滤——那张表是所有请求的共享日志，
//   混着准入探测、指纹探测，以及 ai-report-analysis（生成报告里那段 AI 分析的 LLM 调用，
//   34 个 run 中招）。差分实验实测：不过滤就会把 23 秒的 AI 调用当成一次测试轮，
//   平均耗时从 9285ms 变成 12733ms —— 那是在造一个新的静默算错。
//   故本次不碰 test_requests：样本继续从 md 的「单轮明细」表拿。
//
// 残留耦合与它为何可接受：单轮明细表仍靠 3 个表头（结果/总耗时/首包）解析。
//   但此时聚合值已来自库，万一表头变了 → latencyRounds 为空 → latencyStatsFrom 会
//   自动回退到这些聚合值并标 recomputed:false（那是它本就有的兜底）。
//   即：从「静默算错」变成「优雅降级为正确的聚合值」，只损失 bootstrap 置信区间。
//   契约测试 tests/report-compare-contract.test.mjs 另行钉住这 3 个表头。
//
// 不覆盖的字段（库里没有对应结构化值，仍从 md 来）：
//   ci95Text / baselineText / baselineRegressed / billingAudit / tokenInflation —— 均为文本或从文本反推。
export function overlayRunDataFromSummary(base, summary) {
  if (!base || !summary || typeof summary !== "object") return base;
  const pick = (key, fallback) => (typeof summary[key] === "number" && Number.isFinite(summary[key]) ? summary[key] : fallback);
  const rounds = pick("rounds", base.rounds);
  const rate = typeof summary.successRate === "number" ? summary.successRate : base.rate;
  const succ = pick("successCount", base.succ);
  return {
    ...base,
    rate,
    succ,
    // total：md 的成功率写作「80% (8/10)」，pctCount 从括号里取分母；库里对应 rounds。
    total: pick("rounds", base.total),
    avgFirstByteMs: pick("avgFirstByteMs", base.avgFirstByteMs),
    avgTotalMs: pick("avgTotalMs", base.avgTotalMs),
    p50TotalMs: pick("p50TotalMs", base.p50TotalMs),
    p95TotalMs: pick("p95TotalMs", base.p95TotalMs),
    p99TotalMs: pick("p99TotalMs", base.p99TotalMs),
    minMs: pick("minTotalMs", base.minMs),
    maxMs: pick("maxTotalMs", base.maxMs),
    avgOutputChars: pick("avgOutputChars", base.avgOutputChars),
    inputTokens: pick("inputTokens", base.inputTokens),
    outputTokens: pick("outputTokens", base.outputTokens),
    estCost: pick("estimatedCost", base.estCost),
    rounds,
    concurrency: pick("concurrency", base.concurrency),
    // errorCounts：库里是 { normalized_error: count } 对象，与 parseErrorDist 的产出同形。
    errorCounts: summary.errorCounts && typeof summary.errorCounts === "object" ? summary.errorCounts : base.errorCounts,
  };
}

export function parseAdmissionReport(md) {
  const s1 = section(md, "准入结论");
  const s3 = section(md, "关键指标");
  const s7 = section(md, "模型纯度与渠道风险");
  const s8 = section(md, "模型指纹追踪");
  const sr = pctCount(kv(s3, "成功率"));
  const tokenizer = kv(s3, "分词器指纹核验") || "";
  const slope = tokenizer.match(/slope\s*=\s*(-?\d+(?:\.\d+)?)/i);
  const r2 = tokenizer.match(/R²\s*=\s*(-?\d+(?:\.\d+)?)/i);

  // 分项结果：测试项 → 结果（通过/失败）。
  const items = {};
  const t4 = parseTable(section(md, "分项结果"));
  const iItem = colIndex(t4.headers, "测试项");
  const iRes = colIndex(t4.headers, "结果");
  for (const cells of t4.rows) {
    const k = cell(cells, iItem);
    if (k) items[k] = cell(cells, iRes);
  }

  // 横向对照（同模型多渠道）：与同模型其它渠道是否一致。
  const crossLine = (s8.split(/\r?\n/).find((l) => l.includes("横向对照（同模型多渠道）")) || "").trim();
  const fam = s8.match(/标称家族[:：]\s*([^；;]+)[；;]\s*模型自述家族[:：]\s*(\S+)/);

  // 计费口径：实际上游请求数 vs 逻辑请求数 → 膨胀倍数。（标签含括号，需带上再匹配冒号。）
  const upstreamReq = num(kv(s3, "实际上游请求数（计费口径）"));
  const logicReq = num((s3.match(/^-\s*请求数\s*[:：]\s*(.+)/m) || [])[1]);

  return {
    type: "admission",
    grade: kv(s1, "准入等级"),
    composite: num(kv(s1, "综合分")),
    conclusion: kv(s1, "结论"),
    rate: sr.rate,
    succ: sr.succ,
    total: sr.total,
    avgMs: num(kv(s3, "平均耗时")),
    p95TotalMs: num(kv(s3, "慢请求参考 P95")),
    inputTokens: num(kv(s3, "输入 tokens 合计")),
    outputTokens: num(kv(s3, "输出 tokens 合计")),
    purityScore: num(kv(s7, "纯度分")),
    purityConfidence: kv(s7, "证据置信度"),
    nominalConsistency: kv(s3, "标称一致性"),
    tokenizerSlope: slope ? Number(slope[1]) : null,
    tokenizerR2: r2 ? Number(r2[1]) : null,
    tokenAuditCoverage: kv(s3, "Token 审计覆盖率"),
    items,
    nominalFamily: fam ? fam[1].trim() : null,
    selfFamily: fam ? fam[2].trim() : null,
    crossChannelText: crossLine.replace(/^-\s*/, "") || null,
    crossChannelMismatch: /显著不同|挂羊头/.test(crossLine),
    riskSignals: collectBullets(md, "风险信号"),
    upstreamReq,
    logicReq,
    upstreamMultiplier: upstreamReq && logicReq ? upstreamReq / logicReq : null,
  };
}

// summary：该报告对应的结构化数据（test_runs.raw_json），由调用方从库里取来挂在 file 上；
// 取不到就是 undefined。目前只有场景报告走结构化路，其余仍解析 markdown。
//
// 为什么场景报告优先读结构化数据：解析 md 靠中文表头找列，表头一改就静默降级成 null、
// 对比结果悄悄算错且不报错（B2）。而这些数字本来就以原生数值存在库里。
// md 解析保留为兜底——老报告、孤儿报告、库不可用时仍要能对比。
function parseOne(name, md, summary) {
  const type = detectReportType(name, md);
  if (type === "run") {
    // 稳定性：数值字段改从库里取（覆盖），逐轮样本仍从 md 拿 —— 原因见 overlayRunDataFromSummary。
    const base = parseRunReport(md);
    return { name, type, data: summary ? overlayRunDataFromSummary(base, summary) : base, source: summary ? "db+md" : "md" };
  }
  if (type === "scenario") {
    const structured = summary ? scenarioDataFromSummary(summary) : null;
    return { name, type, data: structured || parseScenarioReport(md), source: structured ? "db" : "md" };
  }
  if (type === "admission") return { name, type, data: parseAdmissionReport(md) };
  return { name, type, data: null };
}

// —— 选取「最近」报告 ——
// 入参 files: [{ name, md, mtimeMs }]（某一对象的全部匹配报告）。
// 取最新 1 份 run、最新 1 份 admission；scenario 按「场景名」去重、每个场景保留最新一份。
// 返回给 aggregateSubject 用的 [{ name, md }]。纯函数（不读盘），便于离线单测。
export function pickRecentReports(files) {
  const withMeta = (files || []).map((f) => ({ ...f, type: detectReportType(f.name, f.md), mtimeMs: Number(f.mtimeMs) || 0 }));
  const byRecency = (a, b) => b.mtimeMs - a.mtimeMs;
  const picked = [];

  const latestRun = withMeta.filter((f) => f.type === "run").sort(byRecency)[0];
  if (latestRun) picked.push(latestRun);
  const latestAdm = withMeta.filter((f) => f.type === "admission").sort(byRecency)[0];
  if (latestAdm) picked.push(latestAdm);

  // scenario：按场景名保留最新一份（每份场景报告只测一个场景）。
  const scen = withMeta.filter((f) => f.type === "scenario").sort(byRecency);
  const seen = new Set();
  for (const f of scen) {
    const name = parseScenarioReport(f.md).scenarios[0]?.name || f.name; // 无法解析场景名时按文件名兜底去重
    if (seen.has(name)) continue;
    seen.add(name);
    picked.push(f);
  }
  return picked.map((f) => ({ name: f.name, md: f.md }));
}

// —— 等量对比：只保留两方【共有】的报告 ——
// 入参为两侧各自 pickRecentReports 的结果 [{name, md}]。为让「用于对比的报告数量」两方相等：
//   · 场景：只留两方都测过的同名场景（取交集），单方独有的丢弃；
//   · 稳定性(run) / 准入(admission)：仅当两方都有该类时才纳入，否则该类两方都不用。
// 由此两侧逐类数量相等、总数也相等（以较少一方为准）。返回 [balancedA, balancedB]。纯函数、便于单测。
export function balanceCommonReports(pickedA, pickedB) {
  const tag = (files) => (files || []).map((f) => ({ ...f, type: detectReportType(f.name, f.md) }));
  const scenName = (f) => parseScenarioReport(f.md).scenarios[0]?.name || f.name; // 与 pickRecentReports 同口径
  const A = tag(pickedA);
  const B = tag(pickedB);
  const has = (arr, t) => arr.some((f) => f.type === t);
  const keepRun = has(A, "run") && has(B, "run");
  const keepAdm = has(A, "admission") && has(B, "admission");
  const namesB = new Set(B.filter((f) => f.type === "scenario").map(scenName));
  const common = new Set(
    A.filter((f) => f.type === "scenario")
      .map(scenName)
      .filter((n) => namesB.has(n)),
  );
  const keep = (f) =>
    f.type === "run" ? keepRun : f.type === "admission" ? keepAdm : f.type === "scenario" ? common.has(scenName(f)) : false;
  const trim = (arr) => arr.filter(keep).map((f) => ({ name: f.name, md: f.md }));
  return [trim(A), trim(B)];
}

// 取两方【共有】的同名场景（名 + A 侧档位），供「选择要对比哪些场景」界面列出。
// 口径与 buildComparison 的 matched 完全一致：先各自 aggregateSubject 把每份报告里的
// 全部场景行按名归组（一份场景报告可含多个场景），再按名取交集——因此这里返回的数量
// 与最终对比报告的「共有场景数」相等，不会再出现「报告 19、界面 10」的偏差。
export function commonScenarioNames(filesA, filesB) {
  const aggA = aggregateSubject({ files: filesA });
  const aggB = aggregateSubject({ files: filesB });
  const namesB = new Set(aggB.scenarios.map((s) => s.name));
  return aggA.scenarios.filter((s) => namesB.has(s.name)).map((s) => ({ name: s.name, tier: s.tier || null }));
}

// —— 对象画像聚合（全部聚合）——

// scenarioFilter?: Set<string> —— 若给定，只保留名在其中的场景【行】（在按名归组后过滤，
// 因此对「一份报告含多个场景」也精确到单个场景）。scenarioPass / tiers / quality 等一切场景派生量
// 都随之只算被选场景，令「用户自选场景」在多场景报告下也能真正生效。
// files: [{ name, md, mtimeMs, summary? }] —— summary 为该报告的结构化数据（test_runs.raw_json），
// 由调用方（server.mjs 的 loadBalancedCompareFiles）从库里取；没有则回退解析 md。
// 本模块不连库，保持纯函数、可离线单测。
export function aggregateSubject({ files = [], label, scenarioFilter } = {}) {
  const parsed = files.map((f) => parseOne(f.name, f.md, f.summary));
  const runs = parsed.filter((p) => p.type === "run").map((p) => p.data);
  const scens = parsed.filter((p) => p.type === "scenario").map((p) => p.data);
  const adms = parsed.filter((p) => p.type === "admission").map((p) => p.data);

  let displayLabel = label || null;
  if (!displayLabel) {
    for (const f of files) {
      const cn = kv(f.md, "配置名称");
      if (cn) {
        displayLabel = cn;
        break;
      }
    }
  }
  const meta = files.length ? parseReportBaseName(files[0].name) : {};
  if (!displayLabel) displayLabel = [meta.channel, meta.model].filter(Boolean).join(" / ") || "未知对象";

  // 稳定性：池化 succ/total，延迟点值按轮数加权平均。
  let sSucc = 0;
  let sTotal = 0;
  let hasStab = false;
  const latAgg = (key) => {
    const pairs = runs.map((r) => ({ v: r[key], w: r.rounds || 1 })).filter((x) => Number.isFinite(x.v));
    if (!pairs.length) return null;
    const wsum = pairs.reduce((s, x) => s + x.w, 0);
    return pairs.reduce((s, x) => s + x.v * x.w, 0) / wsum;
  };
  for (const r of runs) {
    if (Number.isFinite(r.succ) && Number.isFinite(r.total)) {
      sSucc += r.succ;
      sTotal += r.total;
      hasStab = true;
    }
  }
  const stability = hasStab
    ? {
        succ: sSucc,
        total: sTotal,
        rate: sTotal ? sSucc / sTotal : null,
        avgTotalMs: latAgg("avgTotalMs"),
        avgFirstByteMs: latAgg("avgFirstByteMs"),
        p50TotalMs: latAgg("p50TotalMs"),
        p95TotalMs: latAgg("p95TotalMs"),
        p99TotalMs: latAgg("p99TotalMs"),
        roundsTotal: runs.reduce((s, r) => s + (r.rounds || 0), 0),
      }
    : null;

  // 稳定性诚信信号：错误分布合并、基线回归、token 虚报、计费审计。
  const errorCounts = {};
  for (const r of runs) for (const [k, v] of Object.entries(r.errorCounts || {})) errorCounts[k] = (errorCounts[k] || 0) + v;
  const regressedRun = runs.find((r) => r.baselineRegressed);
  const tokenInflation = runs.map((r) => r.tokenInflation).filter(Number.isFinite);
  const integrity = {
    errorCounts,
    baselineRegressed: Boolean(regressedRun),
    baselineText: regressedRun?.baselineText || null,
    tokenInflation: tokenInflation.length ? Math.max(...tokenInflation) : null,
    billingAudit: runs.map((r) => r.billingAudit).find((t) => t && /疑似|异常/.test(t)) || null,
  };

  // 场景：按名归组（跨多份报告求均值/池化）。
  const byName = new Map();
  for (const sc of scens)
    for (const row of sc.scenarios) {
      if (!byName.has(row.name)) byName.set(row.name, []);
      byName.get(row.name).push(row);
    }
  const scenarios = [...byName.entries()]
    .filter(([name]) => !(scenarioFilter instanceof Set) || scenarioFilter.has(name))
    .map(([name, rows]) => {
      const succ = rows.reduce((s, r) => s + (r.succ || 0), 0);
      const total = rows.reduce((s, r) => s + (r.total || 0), 0);
      return {
        name,
        tier: rows[0].tier,
        runs: rows.length,
        quality: avg(rows.map((r) => r.quality)),
        rate: total ? succ / total : null,
        succ,
        total,
        avgMs: avg(rows.map((r) => r.avgMs)),
        p95: avg(rows.map((r) => r.p95)),
        issue: rows.map((r) => r.issue).filter(Boolean)[0] || "",
        conclusion: rows.map((r) => r.conclusion).filter(Boolean)[0] || "",
        errored: rows.some((r) => r.errored),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));

  const scenSucc = scenarios.reduce((s, r) => s + (r.succ || 0), 0);
  const scenTotal = scenarios.reduce((s, r) => s + (r.total || 0), 0);
  const scenarioPass = { succ: scenSucc, total: scenTotal, rate: scenTotal ? scenSucc / scenTotal : null };
  const qualityMean = avg(scenarios.map((s) => s.quality));

  // 按难度档位拆解（通过率池化 + 质量均值）。
  const tierMap = new Map();
  for (const s of scenarios) {
    if (!tierMap.has(s.tier)) tierMap.set(s.tier, []);
    tierMap.get(s.tier).push(s);
  }
  const tiers = [...tierMap.entries()].map(([tier, arr]) => {
    const succ = arr.reduce((x, s) => x + (s.succ || 0), 0);
    const total = arr.reduce((x, s) => x + (s.total || 0), 0);
    return {
      tier,
      count: arr.length,
      passRate: total ? succ / total : null,
      quality: avg(arr.map((s) => s.quality)),
      errored: arr.filter((s) => s.errored).length,
    };
  });

  const admissionParsed = parsed.filter((p) => p.type === "admission");
  admissionParsed.sort((a, b) => (parseReportBaseName(b.name).date || "").localeCompare(parseReportBaseName(a.name).date || ""));
  const admission = admissionParsed[0]?.data || null;

  const tokenIn = runs.reduce((s, r) => s + (r.inputTokens || 0), 0) + adms.reduce((s, r) => s + (r.inputTokens || 0), 0);
  const tokenOut = runs.reduce((s, r) => s + (r.outputTokens || 0), 0) + adms.reduce((s, r) => s + (r.outputTokens || 0), 0);

  return {
    label: displayLabel,
    channel: meta.channel || null,
    model: meta.model || null,
    reportCounts: { run: runs.length, scenario: scens.length, admission: adms.length, total: files.length },
    stability,
    integrity,
    latency: (() => {
      const rounds = runs.flatMap((r) => r.latencyRounds || []);
      return { samples: runs.flatMap((r) => r.latencySamples || []), rounds, stats: latencyStatsFrom(rounds, stability) };
    })(),
    scenarioPass,
    quality: { mean: qualityMean, n: scenarios.filter((s) => Number.isFinite(s.quality)).length },
    scenarios,
    tiers,
    admission,
    tokens: { input: tokenIn, output: tokenOut },
  };
}

// —— 两对象对比 ——

function diff(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return x - y;
}

// 最近秩百分位（与稳定性报告口径一致：sorted[ceil(p·n)-1]），空集合→null。
function nearestRankPct(values, p) {
  const arr = (values || [])
    .filter(Number.isFinite)
    .slice()
    .sort((x, y) => x - y);
  if (!arr.length) return null;
  return arr[Math.min(arr.length - 1, Math.max(0, Math.ceil(p * arr.length) - 1))];
}
function meanOf(values) {
  const arr = (values || []).filter(Number.isFinite);
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
}
// 从「成功 + 所有有耗时的失败」轮次算延迟统计；无单轮明细则退回报告聚合值（成功轮口径）。
function latencyStatsFrom(rounds, fallback) {
  if (!rounds || !rounds.length) return { ...(fallback || {}), failed: 0, recomputed: false };
  const tot = rounds.map((r) => r.total);
  const fb = rounds.map((r) => r.firstByte);
  return {
    avgTotalMs: meanOf(tot),
    avgFirstByteMs: meanOf(fb),
    p50TotalMs: nearestRankPct(tot, 0.5),
    p95TotalMs: nearestRankPct(tot, 0.95),
    p99TotalMs: nearestRankPct(tot, 0.99),
    failed: rounds.filter((r) => !r.success).length,
    recomputed: true,
  };
}

export function buildComparison(a, b) {
  const stabVerdict =
    a.stability && b.stability
      ? compareProportions(a.stability.succ, a.stability.total, b.stability.succ, b.stability.total, { labelA: a.label, labelB: b.label })
      : { significant: false, verdict: "样本不足", method: "wilson-ci-overlap" };
  // 同名场景配对（两方共有）。
  const mapB = new Map(b.scenarios.map((s) => [s.name, s]));
  const matched = [];
  for (const sa of a.scenarios) {
    const sb = mapB.get(sa.name);
    if (sb) matched.push({ name: sa.name, tier: sa.tier, a: sa, b: sb, delta: diff(sa.quality, sb.quality) });
  }
  const namesA = new Set(a.scenarios.map((s) => s.name));
  const onlyA = a.scenarios.filter((s) => !mapB.has(s.name)).map((s) => s.name);
  const onlyB = b.scenarios.filter((s) => !namesA.has(s.name)).map((s) => s.name);

  // 场景通过率只用【两方共有】的同名场景（matched）：单方独有的场景不计入通过率及其判定，
  // 使 A、B 在同一批场景上比较。覆盖各自 scenarioPass，令报告展示与统计判定同口径。
  const commonPass = (key) => {
    let succ = 0;
    let total = 0;
    for (const m of matched) {
      succ += m[key].succ || 0;
      total += m[key].total || 0;
    }
    return { succ, total, rate: total ? succ / total : null };
  };
  a.scenarioPass = commonPass("a");
  b.scenarioPass = commonPass("b");
  const scenVerdict = compareProportions(a.scenarioPass.succ, a.scenarioPass.total, b.scenarioPass.succ, b.scenarioPass.total, {
    labelA: a.label,
    labelB: b.label,
  });

  // 档位并排（两边并集）。
  const tierNames = [...new Set([...a.tiers.map((t) => t.tier), ...b.tiers.map((t) => t.tier)])];
  const tierRows = tierNames.map((tier) => ({
    tier,
    a: a.tiers.find((t) => t.tier === tier) || null,
    b: b.tiers.find((t) => t.tier === tier) || null,
  }));

  // —— 配对分析（同名场景）：质量分配对差 + 效果量 + 胜平负 + 通过率 McNemar ——
  const qa = [];
  const qb = [];
  let win = 0;
  let loss = 0;
  let tie = 0;
  let mcB = 0; // A 过、B 不过
  let mcC = 0; // A 不过、B 过
  for (const m of matched) {
    if (Number.isFinite(m.a.quality) && Number.isFinite(m.b.quality)) {
      qa.push(m.a.quality);
      qb.push(m.b.quality);
      if (m.a.quality > m.b.quality) win++;
      else if (m.a.quality < m.b.quality) loss++;
      else tie++;
    }
    const aPass = m.a.rate === 1;
    const bPass = m.b.rate === 1;
    if (aPass && !bPass) mcB++;
    else if (!aPass && bPass) mcC++;
  }
  const pt = pairedTTest(qa, qb);
  const se = qa.length >= 2 && Number.isFinite(pt.sd) ? pt.sd / Math.sqrt(pt.n) : null;
  const pairedQuality = {
    n: qa.length,
    meanDiff: qa.length ? pt.meanDiff : null,
    se,
    ci: se != null ? [pt.meanDiff - 1.96 * se, pt.meanDiff + 1.96 * se] : null,
    pT: qa.length >= 2 ? pt.pValue : null,
    pWilcoxon: qa.length ? wilcoxonSignedRank(qa, qb).pValue : null,
    cliff: cliffsDelta(qa, qb),
    corr: pearson(qa, qb),
    win,
    tie,
    loss,
    signP: mcnemarTest(win, loss).pValue,
  };
  const pairedPass = { ...mcnemarTest(mcB, mcC), b: mcB, c: mcC };

  // —— 延迟分布对比：成功轮次总耗时的中位/尾部差 + bootstrap 置信区间 ——
  const latency = {
    aN: a.latency.samples.length,
    bN: b.latency.samples.length,
    median: bootstrapDiffCI(a.latency.samples, b.latency.samples, { stat: median }),
    p95: bootstrapDiffCI(a.latency.samples, b.latency.samples, { stat: p95stat }),
  };

  return {
    a,
    b,
    verdicts: { stability: stabVerdict, scenarioPass: scenVerdict },
    scenarioQuality: { matched, onlyA, onlyB },
    tierRows,
    pairedQuality,
    pairedPass,
    latency,
  };
}

// —— Markdown 产出 ——

function round(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return Math.abs(n) >= 100 || Number.isInteger(n) ? Math.round(n).toLocaleString("en-US") : n.toFixed(1);
}
const fmt = (v, unit = "") => (v == null || Number.isNaN(v) ? "-" : `${round(v)}${unit}`);
const pct = (v) => (v == null || Number.isNaN(v) ? "-" : `${(v * 100).toFixed(1)}%`);
function signed(v, unit = "") {
  if (v == null || Number.isNaN(v)) return "-";
  return `${v > 0 ? "+" : v < 0 ? "−" : "±"}${round(Math.abs(v))}${unit}`;
}
// 带符号（用于差值/CI 边界，0 记 +0）；CI 文案；p 值；两位小数（效果量/相关）。
const sgn = (v, unit = "") => (v == null || Number.isNaN(v) ? "-" : `${v < 0 ? "−" : "+"}${round(Math.abs(v))}${unit}`);
const fmtCI = (ci, unit = "") =>
  ci && Number.isFinite(ci[0]) && Number.isFinite(ci[1]) ? `[${sgn(ci[0], unit)}, ${sgn(ci[1], unit)}]` : "样本不足";
const fmtP = (p) => (p == null ? "-" : p < 0.001 ? "<0.001" : p.toFixed(3));
const r2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : "-");
const ciExcludesZero = (ci) => Boolean(ci) && Number.isFinite(ci[0]) && Number.isFinite(ci[1]) && (ci[0] > 0 || ci[1] < 0);
const escapeCell = (s) =>
  String(s ?? "")
    .replace(/\\+$/g, "")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
// 诊断表里的问题摘要可能较长，截断到可读长度（保留信息、不撑破表格）。
const shortText = (s, n = 36) => {
  const t = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const stabCell = (s) => (s.stability ? `${pct(s.stability.rate)}（${s.stability.succ}/${s.stability.total}）` : "-");
const passCell = (s) => (s.scenarioPass.total ? `${pct(s.scenarioPass.rate)}（${s.scenarioPass.succ}/${s.scenarioPass.total}）` : "-");

// 把时间戳（ISO 字符串 / Date / 缺省=当前）格式化为北京时间（UTC+8）`YYYY-MM-DD HH:mm:ss`，供报告展示。
function beijingTime(input) {
  const d = input ? new Date(input) : new Date();
  if (Number.isNaN(d.getTime())) return String(input);
  return d
    .toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    .replace(/\//g, "-");
}

export function formatCompareReportMarkdown(cmp, { generatedAt, aiNarrative, balancedToCommon } = {}) {
  const { a, b } = cmp;
  const L = [];
  L.push("# 模型对比报告", "");
  L.push(`生成时间：${beijingTime(generatedAt)}（北京时间）`, "");
  L.push(
    `- 对象 A：**${a.label}**（报告 ${a.reportCounts.total} 份：场景 ${a.reportCounts.scenario} / 稳定性 ${a.reportCounts.run} / 准入 ${a.reportCounts.admission}）`,
  );
  L.push(
    `- 对象 B：**${b.label}**（报告 ${b.reportCounts.total} 份：场景 ${b.reportCounts.scenario} / 稳定性 ${b.reportCounts.run} / 准入 ${b.reportCounts.admission}）`,
  );
  if (balancedToCommon) {
    L.push("");
    L.push(
      "> 为等量对比，双方仅采用**共有**的报告：同名场景取交集，稳定性 / 准入需两方都测过才纳入（单方独有的已排除），故两方报告数量相同。",
    );
  }
  L.push("");

  // 0. 结论速览：启用 AI 叙述时，直接用 AI 叙述作为结论速览；否则用机械速览（总评 + 逐维度表）。
  L.push("## 结论速览", "");
  if (aiNarrative && String(aiNarrative).trim()) {
    L.push(String(aiNarrative).trim(), "");
    L.push("> 本节由「设置」里配置的 AI 总结模型基于下方结构化数据生成，仅供参考；具体数字与判定以下各小节为准。", "");
  } else {
    const overview = synthesize(cmp);
    L.push(`**总评：** ${overview.headline}`, "");
    L.push("| 维度 | 结论 | 对象A | 对象B |", "|---|---|---|---|");
    for (const r of overview.rows) L.push(`| ${escapeCell(r.dim)} | ${escapeCell(r.verdict)} | ${escapeCell(r.a)} | ${escapeCell(r.b)} |`);
    L.push("");
    L.push("> 依据两个对象在报告中心已有的评测报告聚合对比。延迟为长尾分布、样本有限，仅作参考。", "");
  }

  // 1. 可用性与通过率
  L.push("## 1. 可用性与通过率", "");
  L.push("| 指标 | 对象A | 对象B | 判定 |", "|---|---|---|---|");
  const verdictCell = (v) => {
    const d = decisiveProportion(v, a.label, b.label);
    return d.winner ? `${d.text}（${d.effect}）` : d.text;
  };
  L.push(`| 稳定性成功率 | ${stabCell(a)} | ${stabCell(b)} | ${verdictCell(cmp.verdicts.stability)} |`);
  L.push(`| 场景通过率 | ${passCell(a)} | ${passCell(b)} | ${verdictCell(cmp.verdicts.scenarioPass)} |`);
  L.push("");
  const pp = cmp.pairedPass;
  L.push(
    `- 配对通过率检验（同名场景 n=${cmp.scenarioQuality.matched.length}）：两边结果不一致的场景里，对象A过/对象B不过=${pp.b}、对象A不过/对象B过=${pp.c}，${pp.method === "none" ? "没有结果不一致的场景 → 无法判定" : `p=${fmtP(pp.pValue)}${pp.pValue < 0.05 ? " → **差异显著**" : ""}`}`,
  );
  L.push("> 同名场景是同一批题目上的配对结果，通过率只看两边结果不一致的场景做头对头比较，比各自独立区间是否重叠更能分辨差异。");
  const ea = errSummary(a);
  const eb = errSummary(b);
  if (ea || eb) L.push(`- 稳定性错误分布：对象A ${ea || "无"} · 对象B ${eb || "无"}`);
  L.push("");

  // 2. 延迟（含失败轮：见表格下方说明；口径见 aggregateSubject 的 latency.stats）
  const la = a.latency?.stats || {};
  const lb = b.latency?.stats || {};
  L.push("## 2. 延迟（稳定性轮次，含失败轮，长尾/样本有限，仅供参考）", "");
  L.push("| 指标 | 对象A | 对象B | 对象A−对象B |", "|---:|---:|---:|---:|");
  for (const [label, key] of [
    ["平均总耗时", "avgTotalMs"],
    ["平均首包", "avgFirstByteMs"],
    ["P50 总耗时", "p50TotalMs"],
    ["慢请求 P95", "p95TotalMs"],
    ["尾部 P99", "p99TotalMs"],
  ]) {
    const va = la[key];
    const vb = lb[key];
    L.push(`| ${label} | ${fmt(va, " ms")} | ${fmt(vb, " ms")} | ${signed(diff(va, vb), " ms")} |`);
  }
  L.push("");
  if (la.recomputed || lb.recomputed) {
    L.push(`> 上表延迟已**包含所有有耗时记录的失败轮**——计入失败：对象A ${la.failed} 轮、对象B ${lb.failed} 轮。`);
    L.push("");
  }
  const lat = cmp.latency;
  L.push(`- 延迟样本量（含失败轮）：对象A n=${lat.aN} · 对象B n=${lat.bN}`);
  if (lat.median.point != null)
    L.push(
      `- 中位总耗时差 对象A−对象B = ${sgn(lat.median.point, " ms")}，95% 置信区间 ${fmtCI([lat.median.lower, lat.median.upper], " ms")}（对象A 中位 ${fmt(lat.median.statA, " ms")} / 对象B 中位 ${fmt(lat.median.statB, " ms")}）${ciExcludesZero([lat.median.lower, lat.median.upper]) ? " → **中位延迟差异显著**" : ""}`,
    );
  if (lat.p95.point != null)
    L.push(`- P95 总耗时差 对象A−对象B = ${sgn(lat.p95.point, " ms")}，95% 置信区间 ${fmtCI([lat.p95.lower, lat.p95.upper], " ms")}`);
  L.push("> 延迟是长尾分布，用中位数/尾部而非平均值；两组独立、区间由重采样估计（随机种子固定、可复现）。");
  L.push("");

  // 3. 准入分项与身份纯度
  L.push("## 3. 准入分项与身份纯度", "");
  if (a.admission || b.admission) {
    L.push("| 指标 | 对象A | 对象B |", "|---|---|---|");
    L.push(`| 准入等级 | ${a.admission?.grade ?? "-"} | ${b.admission?.grade ?? "-"} |`);
    L.push(`| 综合分 | ${fmt(a.admission?.composite)} | ${fmt(b.admission?.composite)} |`);
    L.push(`| 纯度分 | ${fmt(a.admission?.purityScore)} | ${fmt(b.admission?.purityScore)} |`);
    L.push(`| 分词器 slope | ${fmt(a.admission?.tokenizerSlope)} | ${fmt(b.admission?.tokenizerSlope)} |`);
    L.push(`| 分词器 R² | ${fmt(a.admission?.tokenizerR2)} | ${fmt(b.admission?.tokenizerR2)} |`);
    L.push(`| 标称/自述家族 | ${escapeCell(famCell(a.admission))} | ${escapeCell(famCell(b.admission))} |`);
    // 分项通过/失败
    const items = [
      ...new Set([...(a.admission ? Object.keys(a.admission.items) : []), ...(b.admission ? Object.keys(b.admission.items) : [])]),
    ];
    if (items.length) {
      L.push("");
      L.push("准入分项结果：", "");
      L.push("| 分项 | 对象A | 对象B |", "|---|---|---|");
      for (const it of items) L.push(`| ${escapeCell(it)} | ${a.admission?.items?.[it] ?? "-"} | ${b.admission?.items?.[it] ?? "-"} |`);
    }
    L.push("");
  } else {
    L.push("> 两个对象都没有准入报告，跳过身份/纯度对比。", "");
  }
  L.push("");

  // 4. 按难度档位拆解
  L.push("## 4. 按难度档位拆解", "");
  L.push("| 档位 | 对象A 通过率 | 对象A 均分 | 对象B 通过率 | 对象B 均分 | 均分差(对象A−对象B) |", "|---:|---:|---:|---:|---:|---:|");
  for (const r of cmp.tierRows) {
    const qa = r.a?.quality;
    const qb = r.b?.quality;
    L.push(
      `| ${r.tier} | ${r.a ? pct(r.a.passRate) : "-"} | ${fmt(qa)} | ${r.b ? pct(r.b.passRate) : "-"} | ${fmt(qb)} | ${signed(diff(qa, qb))} |`,
    );
  }
  L.push("");
  const errNote = (subj) =>
    subj.tiers
      .filter((t) => t.errored > 0)
      .map((t) => `${t.tier}(${t.errored})`)
      .join("、");
  const ena = errNote(a);
  const enb = errNote(b);
  if (ena || enb) L.push(`- 含错误型失败（限流/超时，属可用性问题、非能力低分）的档位：对象A: ${ena || "无"} · 对象B: ${enb || "无"}`);
  L.push("");

  // 5. 逐场景诊断
  L.push("## 5. 逐场景诊断（配对场景，含失败原因）", "");
  L.push(
    `- 总体平均质量分：对象A ${fmt(a.quality.mean)}（${a.quality.n} 个场景） · 对象B ${fmt(b.quality.mean)}（${b.quality.n} 个场景） · 对象A−对象B ${signed(diff(a.quality.mean, b.quality.mean))}`,
  );
  const pq = cmp.pairedQuality;
  L.push("");
  if (cmp.scenarioQuality.matched.length) {
    L.push("| 场景 | 档位 | 对象A 质量 | 对象B 质量 | 对象A−对象B | 对象A 问题 | 对象B 问题 |", "|---|---|---|---|---|---|---|");
    for (const m of cmp.scenarioQuality.matched) {
      L.push(
        `| ${escapeCell(m.name)} | ${escapeCell(m.tier)} | ${fmt(m.a.quality)} | ${fmt(m.b.quality)} | ${signed(m.delta)} | ${escapeCell(shortText(m.a.issue) || "—")} | ${escapeCell(shortText(m.b.issue) || "—")} |`,
      );
    }
    L.push("");
    const big = cmp.scenarioQuality.matched.filter((m) => Number.isFinite(m.delta) && Math.abs(m.delta) >= 40);
    if (big.length) {
      L.push("差距显著的场景（|Δ|≥40，值得人工复核原始回答）：");
      for (const m of big) {
        const winner = m.delta > 0 ? a.label : b.label;
        const loser = m.delta > 0 ? b.label : a.label;
        const loserIssue = m.delta > 0 ? m.b.issue : m.a.issue;
        L.push(
          `- **${escapeCell(m.name)}**：${winner} ${fmt(Math.abs(m.delta))} 分优于 ${loser}；落后方问题：${escapeCell(shortText(loserIssue, 60) || "未记录")}。`,
        );
      }
      L.push("");
    }
  } else {
    L.push("> 两个对象没有测过相同名称的场景，无法逐场景配对对比。", "");
  }
  if (cmp.scenarioQuality.onlyA.length) L.push(`- 仅对象A 测过：${cmp.scenarioQuality.onlyA.map(escapeCell).join("、")}`);
  if (cmp.scenarioQuality.onlyB.length) L.push(`- 仅对象B 测过：${cmp.scenarioQuality.onlyB.map(escapeCell).join("、")}`);
  L.push("");
  // 配对差值分析：统计口径细节、非主线结论，放本节最下方，以「> 注释」呈现（同第 2/4 节末尾说明的样式）。
  if (pq.n >= 1) {
    L.push(`> **配对差值分析**（同名场景 n=${pq.n}，同一批题目上配对比较，比各自独立平均更能分辨差异）：`);
    L.push(
      `> · 质量分平均差 对象A−对象B = ${sgn(pq.meanDiff)}${pq.ci ? `，95% 置信区间 ${fmtCI(pq.ci)}` : "（样本不足，无区间）"} → ${pq.ci ? (ciExcludesZero(pq.ci) ? "**差异显著（区间不含 0）**" : "**区间含 0**") : "样本不足"}`,
    );
    if (pq.corr != null)
      L.push(`> · 配对相关 r=${r2(pq.corr)}（正相关时配对比较更稳）；符号秩 p=${fmtP(pq.pWilcoxon)}；配对均值检验 p=${fmtP(pq.pT)}`);
    L.push(
      `> · 效果量 δ=${pq.cliff.delta != null ? r2(pq.cliff.delta) : "-"}（${pq.cliff.magnitude}，阈值 0.15/0.33/0.47=小/中/大）；胜/平/负（对象A 视角）= ${pq.win}/${pq.tie}/${pq.loss}，符号检验 p=${fmtP(pq.signP)}`,
      "",
    );
  }

  // 6. 总结
  L.push("## 6. 总结", "");
  for (const line of overallConclusions(cmp)) L.push(`- ${line}`);
  L.push("");

  L.push("## 方法学与免责", "");
  L.push(
    "- 同名场景为**配对样本**：质量分用配对差值 + 95% CI（Miller 2024《Adding Error Bars to Evals》），通过率头对头用 **McNemar**（只看结果不一致的场景），比「两条独立置信区间是否重叠」更有功效。",
  );
  L.push(
    "- 效果量：质量分用 **Cliff's δ**（非参数；阈值 0.147/0.33/0.474 = 小/中/大）+ 胜平负符号检验；成功率/通过率用 **Cohen's h**（两比例效应量 h = 2·arcsin√p₁ − 2·arcsin√p₂；阈值 0.2/0.5/0.8 = 小/中/大，量纲无关、0/1 边界稳定）。回答「差多少」而不只是「差不差」。",
  );
  L.push("- 单对象成功率仍给 Wilson 置信区间；延迟重尾，用中位/P95 的两样本 bootstrap 百分位 CI（种子固定、可复现），不用均值。");
  L.push(
    "- 显著性判据：看差值的 95% CI 是否含 0。为便于决策，成功率/质量类结论一律按点估计给出「谁更好」；若区间重叠或含 0（统计证据尚不充分），请结合样本量谨慎采纳。",
  );
  L.push("- 质量分为规则化评分，非人工质量评审；身份/纯度判断均为黑盒概率结论，仅「疑似 / 需上游解释」。");
  L.push("- 本报告依据既有评测报告聚合，未重新发起请求；标注 |Δ|≥40 的场景建议人工复核原始回答。");
  return L.join("\n");
}

function famCell(adm) {
  if (!adm) return "-";
  if (adm.nominalFamily || adm.selfFamily) return `标称 ${adm.nominalFamily || "?"} / 自述 ${adm.selfFamily || "?"}`;
  return adm.nominalConsistency || "-";
}
function errSummary(s) {
  const e = Object.entries(s.integrity.errorCounts || {});
  return e.length ? e.map(([k, v]) => `${k}×${v}`).join("、") : "";
}

// Cohen's h：两比例的效应量 = 2·arcsin(√p1) − 2·arcsin(√p2)。量纲无关、在 0/1 边界也有定义。
function cohensH(p1, p2) {
  const phi = (p) => 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, p))));
  return phi(p1) - phi(p2);
}
// |h| 档位（Cohen 惯例阈值 0.2 / 0.5 / 0.8）。
function hMagnitude(h) {
  const a = Math.abs(h);
  return a < 0.2 ? "可忽略" : a < 0.5 ? "小" : a < 0.8 ? "中" : "大";
}

// 激进判定：即便置信区间重叠、统计证据不足，也按点估计给出「谁更好」。
// 返回 { winner, loser, significant, text, effect }；effect 为两比例效应量 Cohen's h（含 小/中/大 档位）。
// 样本不足或完全持平时 winner=null、effect=""。
function decisiveProportion(v, labelA, labelB) {
  if (!v || String(v.verdict || "").includes("样本不足")) return { winner: null, significant: false, text: "样本不足", effect: "" };
  const pa = v.a?.point;
  const pb = v.b?.point;
  if (!Number.isFinite(pa) || !Number.isFinite(pb) || pa === pb) return { winner: null, significant: false, text: "两者相当", effect: "" };
  const winner = pa > pb ? labelA : labelB;
  const loser = pa > pb ? labelB : labelA;
  const significant = Boolean(v.significant);
  const h = cohensH(pa, pb);
  return {
    winner,
    loser,
    significant,
    text: significant ? `${winner} 明显优于 ${loser}` : `${winner} 更好`,
    effect: `效应量 h ${r2(Math.abs(h))}，${hMagnitude(h)}`,
  };
}

// 综合投票：可用性 / 通过率 / 质量三项各按点估计投一票，得票多者为整体更优方（激进：不要求显著）。
function overallVote(cmp) {
  const { a, b } = cmp;
  const votes = [];
  const add = (v) => {
    const d = decisiveProportion(v, a.label, b.label);
    if (d.winner) votes.push(d.winner);
  };
  add(cmp.verdicts.stability);
  add(cmp.verdicts.scenarioPass);
  const pq = cmp.pairedQuality;
  if (pq && pq.n >= 2 && pq.ci && pq.meanDiff !== 0) votes.push(pq.meanDiff > 0 ? a.label : b.label);
  const scoreA = votes.filter((w) => w === a.label).length;
  const scoreB = votes.filter((w) => w === b.label).length;
  const winner = scoreA > scoreB ? a.label : scoreB > scoreA ? b.label : null;
  return { scoreA, scoreB, winner, total: votes.length, lead: Math.max(scoreA, scoreB) };
}

// 结论速览：产出「一句总评 headline + 逐维度结构化行」。每行 { dim, verdict, metrics }，其中
// verdict 已含信号图标前缀（✅ 显著优势 / ≈ 无显著差异 / ⚠️ 风险或降级 / ❓ 样本不足 / ℹ️ 仅参考），
// metrics 承载密集数字。发射端把 rows 排成「维度 | 结论 | 关键指标」表格，让结论与数字分列、便于扫读。
function synthesize(cmp) {
  const { a, b } = cmp;
  const rows = [];

  // —— 可用性两行：稳定性成功率 / 场景通过率。激进判定：按点估计给出谁更好，
  // 显著→✅；仅点估计领先→↗；样本不足→❓；完全持平→≈。——
  const availVerdict = (v) => {
    const d = decisiveProportion(v, a.label, b.label);
    if (!d.winner) return d.text === "样本不足" ? "❓ 样本不足" : "≈ 两者相当";
    return `${d.significant ? "✅" : "↗"} ${d.text}（${d.effect}）`;
  };
  rows.push({ dim: "稳定性成功率", verdict: availVerdict(cmp.verdicts.stability), a: stabCell(a), b: stabCell(b) });
  rows.push({ dim: "场景通过率", verdict: availVerdict(cmp.verdicts.scenarioPass), a: passCell(a), b: passCell(b) });

  // —— 质量分（配对差值）：激进判定，按 A−B 符号给出更高方，只标注是否达显著。——
  const pq = cmp.pairedQuality;
  if (pq && pq.n >= 2 && pq.ci) {
    const sig = ciExcludesZero(pq.ci);
    const tie = pq.meanDiff === 0;
    const better = pq.meanDiff > 0 ? a.label : b.label;
    const stat = `对象A−对象B ${sgn(pq.meanDiff)}，95% 置信区间 ${fmtCI(pq.ci)}，效果量 δ ${r2(pq.cliff.delta)}，胜/平/负 ${pq.win}/${pq.tie}/${pq.loss}`;
    rows.push({
      dim: `质量分（配对 n=${pq.n}）`,
      verdict: tie ? `≈ 两者相当（${stat}）` : sig ? `✅ ${better} 显著更高（${stat}）` : `↗ ${better} 更高（${stat}）`,
      a: `均分 ${fmt(a.quality.mean)}`,
      b: `均分 ${fmt(b.quality.mean)}`,
    });
  }

  // —— 延迟（P95，含失败轮，长尾/样本有限，仅参考）——
  const pa = a.latency?.stats?.p95TotalMs;
  const pb = b.latency?.stats?.p95TotalMs;
  if (Number.isFinite(pa) && Number.isFinite(pb) && Math.abs(pa - pb) >= 1) {
    const faster = pa < pb ? a.label : b.label;
    rows.push({ dim: "延迟（P95）", verdict: `ℹ️ ${faster} 更快（仅参考）`, a: `P95 ${round(pa)} ms`, b: `P95 ${round(pb)} ms` });
  }

  // —— 一句话总评（激进）：综合可用性/通过率/质量三项点估计投票，力求给出整体谁更好。——
  const ov = overallVote(cmp);
  let headline;
  if (ov.winner) headline = `综合来看，${ov.winner} 更好（可用性 / 通过率 / 质量三项里 ${ov.lead}/${ov.total} 项领先）`;
  else if (ov.total === 0) headline = "两者在各维度上基本相当（样本有限，暂难分高下）";
  else headline = `两者互有胜负、各擅其长（需按最看重的维度取舍）`;

  return { headline, rows };
}

function overallConclusions(cmp) {
  const out = [];
  const { a, b } = cmp;
  const sd = decisiveProportion(cmp.verdicts.stability, a.label, b.label);
  const pd = decisiveProportion(cmp.verdicts.scenarioPass, a.label, b.label);
  const tail = (d) => (d.significant ? "（差异显著）" : "（点估计领先）");
  out.push(sd.winner ? `稳定性成功率：**${sd.text}**${tail(sd)}。` : `稳定性成功率：${sd.text}。`);
  out.push(pd.winner ? `场景通过率：**${pd.text}**${tail(pd)}。` : `场景通过率：${pd.text}。`);
  const pq = cmp.pairedQuality;
  if (pq && pq.n >= 2 && pq.ci) {
    const better = pq.meanDiff > 0 ? a.label : b.label;
    out.push(
      pq.meanDiff === 0
        ? `质量分（同名场景配对）：两者相当（对象A−对象B=0 分）。`
        : `质量分（同名场景配对）：**${better} 更高**（对象A−对象B=${sgn(pq.meanDiff)} 分，95% 置信区间 ${fmtCI(pq.ci)}，效果量 δ=${r2(pq.cliff.delta)}）。`,
    );
  } else {
    const qd = diff(a.quality.mean, b.quality.mean);
    if (qd != null)
      out.push(
        qd === 0
          ? `平均质量分：两者相当（配对样本不足，仅作描述）。`
          : `平均质量分：**${qd > 0 ? a.label : b.label} 更高**（对象A−对象B ${signed(qd)} 分，配对样本不足，仅作参考）。`,
      );
  }
  const ld = diff(a.latency?.stats?.p95TotalMs, b.latency?.stats?.p95TotalMs);
  if (ld != null && Math.abs(ld) >= 1)
    out.push(`P95 延迟：**${ld < 0 ? a.label : b.label} 更快**约 ${fmt(Math.abs(ld), " ms")}（延迟长尾、含失败轮）。`);
  // 综合判断（激进）：多数维度点估计领先者即整体更优。
  const ov = overallVote(cmp);
  out.push(
    ov.winner
      ? `**综合判断：${ov.winner} 整体更优**——在可用性、通过率、质量里于 ${ov.lead}/${ov.total} 项维度领先。若这些维度对你等权，优先选它。`
      : `**综合判断：两者互有胜负、整体相当**——建议按你最看重的维度（可用性 / 通过率 / 质量 / 延迟）取舍。`,
  );
  return out;
}

// —— 可选 AI 叙述：把结构化对比拼成一段中文提示词（纯函数，供端点喂给已配置的 AI 总结模型）——
export function buildCompareAnalysisPrompt(cmp) {
  const { a, b } = cmp;
  const facts = [];
  facts.push(`对象A(所用模型)=${a.label}；对象B(要对比的模型)=${b.label}`);
  facts.push(
    `稳定性成功率：对象A ${stabCell(a)}，对象B ${stabCell(b)}；场景通过率：对象A ${passCell(a)}，对象B ${passCell(b)}（配对通过率检验 p=${fmtP(cmp.pairedPass.pValue)}）`,
  );
  facts.push(
    "按难度档位(通过率/均分)：" +
      cmp.tierRows
        .map(
          (r) =>
            `${r.tier}: 对象A ${r.a ? pct(r.a.passRate) : "-"}/${fmt(r.a?.quality)}，对象B ${r.b ? pct(r.b.passRate) : "-"}/${fmt(r.b?.quality)}`,
        )
        .join("；"),
  );
  const pq = cmp.pairedQuality;
  if (pq.n)
    facts.push(
      `配对质量差 对象A−对象B=${sgn(pq.meanDiff)}（95% 置信区间 ${pq.ci ? fmtCI(pq.ci) : "样本不足"}），效果量 δ=${pq.cliff.delta != null ? r2(pq.cliff.delta) : "-"}(${pq.cliff.magnitude})，胜/平/负=${pq.win}/${pq.tie}/${pq.loss}`,
    );
  if (cmp.latency.median.point != null)
    facts.push(
      `中位延迟差 对象A−对象B=${sgn(cmp.latency.median.point, " ms")}（95% 置信区间 ${fmtCI([cmp.latency.median.lower, cmp.latency.median.upper], " ms")}）`,
    );
  for (const s of [a, b]) {
    const risks = [];
    if (s.integrity.baselineRegressed) risks.push("稳定性退化");
    if (s.admission?.crossChannelMismatch) risks.push("指纹与同模型其它渠道不一致");
    const err = errSummary(s);
    if (err) risks.push(`稳定性错误 ${err}`);
    if (risks.length) facts.push(`${s.label} 风险：${risks.join("、")}`);
  }
  const ov = overallVote(cmp);
  facts.push(
    ov.winner
      ? `综合点估计：${ov.winner} 在可用性/通过率/质量里于 ${ov.lead}/${ov.total} 项领先，整体更优`
      : "综合点估计：两者互有胜负、整体相当",
  );
  return [
    "你是资深 AI 评测分析师，判断果断、但措辞委婉得体、对两方都留有分寸。下面是对两个模型（对象A=所用模型，对象B=要对比的模型）依据既有评测报告做的结构化对比（含点估计与统计判定）。",
    "请用中文写一段 150–300 字的对比叙述，要求：",
    "1) 就可用性、质量/难档能力、延迟分别给出明确的「谁更占优」结论（按点估计判断，不回避表态、不用「难分伯仲 / 不好说」之类和稀泥的措辞）；但用词委婉——多用「更稳一些 / 略胜一筹 / 更从容」这类表达，对落后一方点到为止、留出正面空间；统计上不显著时可温和提示一句「差距尚未被统计确认」；",
    "2) 给出一个清晰但不生硬的总体倾向：整体上更推荐哪一个（须与上面「综合点估计」一致）；",
    "3) 委婉点出最值得留意的风险，并给一句得体的使用建议。",
    "不要编造数据中没有的数字，不要输出 Markdown 标题或表格，只写正文段落，语气专业、克制、有分寸。",
    "",
    "对比数据：",
    ...facts.map((f) => `- ${f}`),
  ].join("\n");
}

export { wilsonInterval };
