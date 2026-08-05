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
const coverageCount = (value) => {
  const match = String(value || "").match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
  return match ? { reportedCount: Number(match[1]), totalCount: Number(match[2]) } : null;
};

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
  if (t === "run" || t === "scenario" || t === "admission" || t === "load") return t;
  const head = String(md || "").slice(0, 200);
  if (head.includes("稳定性测试报告")) return "run";
  if (head.includes("场景测试报告")) return "scenario";
  if (head.includes("准入评测报告")) return "admission";
  if (head.includes("压力测试报告")) return "load";
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
    outputTokens: colIndex(headers, "输出 Tokens（含思考）"),
    outputTokenCoverage: colIndex(headers, "输出 Token 覆盖"),
    cacheReadTokens: colIndex(headers, "缓存命中 Tokens"),
    cacheReadTokenCoverage: colIndex(headers, "缓存 Token 覆盖"),
    p50FirstToken: colIndex(headers, "P50 首 Token"),
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
    const outputTokenCoverage = coverageCount(cell(cells, ci.outputTokenCoverage));
    const cacheReadTokenCoverage = coverageCount(cell(cells, ci.cacheReadTokenCoverage));
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
      outputTokens: num(cell(cells, ci.outputTokens)),
      outputTokenReportedCount: outputTokenCoverage?.reportedCount ?? null,
      outputTokenTotalCount: outputTokenCoverage?.totalCount ?? null,
      cacheReadTokens: num(cell(cells, ci.cacheReadTokens)),
      cacheReadTokenReportedCount: cacheReadTokenCoverage?.reportedCount ?? null,
      cacheReadTokenTotalCount: cacheReadTokenCoverage?.totalCount ?? null,
      // Markdown only stores the aggregate. It cannot be pooled safely, so keep samples empty.
      firstTokenSamples: [],
      firstTokenSampleCount: 0,
      p50FirstTokenMs: num(cell(cells, ci.p50FirstToken)),
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
      const firstTokenSamples = Array.isArray(s.firstTokenSamples) ? s.firstTokenSamples.filter(Number.isFinite) : [];
      scenarios.push({
        name,
        tier: scenarioTier(name),
        rate,
        succ: rate == null ? null : Math.round(rate * repeats),
        total: repeats,
        quality: numOrNull(s.avgQualityScore),
        avgMs: numOrNull(s.avgTotalMs),
        outputTokens: numOrNull(s.outputTokens),
        outputTokenReportedCount: numOrNull(s.outputTokenReportedCount),
        outputTokenTotalCount: numOrNull(s.outputTokenTotalCount),
        cacheReadTokens: numOrNull(s.cacheReadTokens),
        cacheReadTokenReportedCount: numOrNull(s.cacheReadTokenReportedCount),
        cacheReadTokenTotalCount: numOrNull(s.cacheReadTokenTotalCount),
        firstTokenSamples,
        firstTokenSampleCount: firstTokenSamples.length,
        p50FirstTokenMs: numOrNull(s.p50FirstTokenMs),
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

// —— 压力测试(load)报告解析 ——
// 压测报告有两种体（server/load-test.mjs）：单点（一个负载值一组数字）与扫描（负载→吞吐/尾延迟曲线表，
// 逐行即一个负载点）。二者在这里统一转成 { type:"load", mode, points:[...] }，points 即负载点数组，
// 单点报告只有 1 个元素。负载点用 (mode, offered) 做键——开环(req/s)与闭环(并发)量纲不同，不可互相配对，
// 故 mode 随每个 point 一起带出（虽然同一份报告内 mode 恒定，但下游按点配对时更方便直接从 point 上取）。
//
// 延迟分位在报告里以「0.80s」这类秒计文本呈现（load-test.mjs 的 fmtMs），需转回毫秒；「—」= 缺失(null)。
function secTextToMs(s) {
  const m = String(s || "").match(/(-?\d+(?:\.\d+)?)\s*s/);
  return m ? Math.round(Number(m[1]) * 1000) : null;
}
// 报告里的百分比是整数（load-test.mjs 的 pct：Math.round(v*100)），如 "80%" → 0.8。
function pctToRate(s) {
  const m = String(s || "").match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? Number(m[1]) / 100 : null;
}

// 单点报告的「错误构成」小节是纯 bullet 列表（非表格）：按 HTTP 状态码/超时分类统计 429 与 超时+5xx，
// 口径对齐扫描报告表格的「429」「超时+5xx」两列，方便单点/扫描两种来源在 aggregateSubject 里同构处理。
function parseLoadErrorBullets(errSectionText) {
  let http429 = 0;
  let timeoutAnd5xx = 0;
  let genSaturated = 0;
  for (const line of String(errSectionText || "").split(/\r?\n/)) {
    // 原因短语（上游可控的 statusText）可能自带冒号，故贪心吃到【行尾】的「：数字」再取计数，
    // 不能用 [^:：]* 停在短语内第一个冒号上（那会整行匹配失败 → 429/5xx 少计）。
    const httpM = line.match(/^-\s*HTTP\s+(\d+).*[:：]\s*(\d+)\s*$/);
    if (httpM) {
      const code = Number(httpM[1]);
      const count = Number(httpM[2]);
      if (code === 429) http429 += count;
      else if (code >= 500) timeoutAnd5xx += count;
      continue;
    }
    const timeoutM = line.match(/^-\s*超时[:：]\s*(\d+)/);
    if (timeoutM) {
      timeoutAnd5xx += Number(timeoutM[1]);
      continue;
    }
    const gsM = line.match(/^-\s*发生器受限[:：]\s*(\d+)/);
    if (gsM) genSaturated += Number(gsM[1]);
  }
  return { http429, timeoutAnd5xx, genSaturated };
}

export function parseLoadReport(md) {
  const text = String(md || "");
  const modeLine = (text.match(/^-\s*模式[:：].*$/m) || [""])[0];
  const mode = /开环/.test(modeLine) ? "open" : "closed";
  const isSweep = /##\s*负载\s*→\s*吞吐/.test(text);

  if (isSweep) {
    const { headers, rows } = parseTable(section(text, "负载 → 吞吐"));
    // 精确匹配（非 includes）：表头同时有「TTFT p95」和「p95」两列，colIndex 的 includes 匹配会让
    // "p95" 误命中排在前面的「TTFT p95」——这里两列都要，必须按去空格后的整串相等区分。
    const exactCol = (keyword) => headers.findIndex((h) => h.trim() === keyword);
    const ci = {
      qps: colIndex(headers, "QPS"),
      tok: colIndex(headers, "tok/s"),
      rate: colIndex(headers, "成功率"),
      p95: exactCol("p95"),
      p99: exactCol("p99"),
      p429: colIndex(headers, "429"),
      timeout5xx: colIndex(headers, "超时"),
      genSat: colIndex(headers, "发生器受限"),
    };
    const points = rows
      .map((cells) => ({
        mode,
        offered: num(cell(cells, 0)),
        qps: num(cell(cells, ci.qps)),
        tokensPerSecond: num(cell(cells, ci.tok)),
        successRate: pctToRate(cell(cells, ci.rate)),
        p95: secTextToMs(cell(cells, ci.p95)),
        p99: secTextToMs(cell(cells, ci.p99)),
        http429: num(cell(cells, ci.p429)),
        timeoutAnd5xx: num(cell(cells, ci.timeout5xx)),
        genSaturated: num(cell(cells, ci.genSat)),
      }))
      .filter((p) => Number.isFinite(p.offered));
    return { type: "load", mode, points };
  }

  // 单点报告。
  const offeredM = text.match(/^-\s*(?:并发|目标速率)[:：]\s*(\d+(?:\.\d+)?)/m);
  const s1 = section(text, "吞吐与成功率");
  const successM = s1.match(/成功：(\d+)（(\d+(?:\.\d+)?)%）\s*吞吐\s*QPS[:：]\s*([\d.]+)/);
  const tokM = s1.match(/输出吞吐[:：]\s*([\d.]+)\s*tok\/s/);
  const latRow = parseTable(section(text, "延迟分布"));
  const latCells = latRow.rows[0] || [];
  const errs = parseLoadErrorBullets(section(text, "错误构成"));
  const point = {
    mode,
    offered: offeredM ? Number(offeredM[1]) : null,
    qps: successM ? Number(successM[3]) : null,
    tokensPerSecond: tokM ? Number(tokM[1]) : null,
    successRate: successM ? Number(successM[2]) / 100 : null,
    p50: secTextToMs(latCells[0]),
    p90: secTextToMs(latCells[1]),
    p95: secTextToMs(latCells[2]),
    p99: secTextToMs(latCells[3]),
    max: secTextToMs(latCells[4]),
    avg: secTextToMs(latCells[5]),
    http429: errs.http429,
    timeoutAnd5xx: errs.timeoutAnd5xx,
    genSaturated: errs.genSaturated,
  };
  // offered 解析失败（报告头部格式意外）→ 空点集，与扫描路径的 Number.isFinite 护栏同规则：
  // 没有负载值的点无法参与 (mode, offered) 配对，留着只会在对比表里渲染出「负载 null」。
  return { type: "load", mode, points: Number.isFinite(point.offered) ? [point] : [] };
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
  if (type === "load") return { name, type, data: parseLoadReport(md) };
  return { name, type, data: null };
}

// 一份场景报告文件里【全部】场景名（一份报告可含多条场景行：批量测试选多个场景会落一个文件）。
// 解析不出任何场景行时按文件名兜底，保持与旧的单场景去重同口径。
function scenarioNamesOf(md, fallbackName) {
  const names = parseScenarioReport(md)
    .scenarios.map((s) => s.name)
    .filter(Boolean);
  return names.length ? names : [fallbackName];
}

// —— 选取「最近」报告 ——
// 入参 files: [{ name, md, mtimeMs }]（某一对象的全部匹配报告）。
// 取最新 1 份 run、最新 1 份 admission；scenario 按「场景名」去重、每个场景由「含它的最新文件」贡献
// （一份文件可含多条场景行，见下方贪心集合覆盖注释）。返回给 aggregateSubject 用的 [{ name, md }]。
// 纯函数（不读盘），便于离线单测。
export function pickRecentReports(files) {
  const withMeta = (files || []).map((f) => ({ ...f, type: detectReportType(f.name, f.md), mtimeMs: Number(f.mtimeMs) || 0 }));
  const byRecency = (a, b) => b.mtimeMs - a.mtimeMs;
  const picked = [];

  const latestRun = withMeta.filter((f) => f.type === "run").sort(byRecency)[0];
  if (latestRun) picked.push(latestRun);
  const latestAdm = withMeta.filter((f) => f.type === "admission").sort(byRecency)[0];
  if (latestAdm) picked.push(latestAdm);
  // load：同 run/admission，只取最新 1 份——压测报告本身就是一次运行的完整聚合（可含多个负载点），
  // 不像场景需要跨报告去重合并；多次压测通常是想看最新一次的容量表现，不做历史池化。
  const latestLoad = withMeta.filter((f) => f.type === "load").sort(byRecency)[0];
  if (latestLoad) picked.push(latestLoad);

  // scenario：目标是「每个场景名保留最新一份」。但一份报告文件可含【多条】场景行（批量测试选多个
  // 场景落一个文件），旧写法只拿 scenarios[0] 当整份文件的身份去重——两份多场景报告只要【首条】场景
  // 名相同，较旧那份里其余场景就被整份连坐丢弃、从此在共有/差集里彻底消失（本次修复的根因）。
  // 改为「贪心集合覆盖 + 行级授权」：从新到旧遍历，只要一份文件仍带来【尚未见过】的场景名就保留它，
  // 并把「这份文件实际贡献的场景名」记在 scenarioAllow 上——下游 aggregateSubject 只取每份文件被
  // 授权的行。由此每个场景名都由「含它的最新文件」独家供数：既不会被同批异名场景连累丢弃（原 bug），
  // 也不会让旧文件里同名场景的陈旧行混进聚合稀释最新结果（若只保留文件不做行级授权，重测某场景后
  // 旧数据仍会被按名池化进来，均值被陈旧结果拉偏）。
  const scen = withMeta.filter((f) => f.type === "scenario").sort(byRecency);
  const seen = new Set();
  for (const f of scen) {
    const names = scenarioNamesOf(f.md, f.name);
    const fresh = names.filter((n) => !seen.has(n));
    if (fresh.length) {
      for (const n of fresh) seen.add(n);
      picked.push({ ...f, scenarioAllow: fresh });
    }
  }
  return picked.map((f) => ({ name: f.name, md: f.md, ...(f.scenarioAllow ? { scenarioAllow: f.scenarioAllow } : {}) }));
}

// —— 等量对比：只保留两方【共有】的报告 ——
// 入参为两侧各自 pickRecentReports 的结果 [{name, md}]。为让「用于对比的报告数量」两方相等：
//   · 场景：只留两方都测过的同名场景（取交集），单方独有的丢弃；
//   · 稳定性(run) / 准入(admission)：仅当两方都有该类时才纳入，否则该类两方都不用。
//   · 压力测试(load)：**不做该类等量收紧**，单方独有的压测报告仍放行——压测报告内部是多负载点的
//     子结构，与场景更像，理应支持"仅一方测过某负载点"；具体到哪些负载点能配对留给 buildComparison。
// 由此 run/admission/scenario 三类两侧数量相等，但 load 类两侧数量可能不同（总数也可能不同）。
// 返回 [balancedA, balancedB]。纯函数、便于单测。
export function balanceCommonReports(pickedA, pickedB) {
  const tag = (files) => (files || []).map((f) => ({ ...f, type: detectReportType(f.name, f.md) }));
  // 一份场景报告文件的【有效】场景名：优先用 pickRecentReports 标注的行级授权 scenarioAllow
  // （= 该文件独家供数的场景名），无授权标注（直接调用本函数的老路径/测试）则退回文件里全部场景行。
  const namesOf = (f) => (Array.isArray(f.scenarioAllow) && f.scenarioAllow.length ? f.scenarioAllow : scenarioNamesOf(f.md, f.name));
  const A = tag(pickedA);
  const B = tag(pickedB);
  const has = (arr, t) => arr.some((f) => f.type === t);
  const keepRun = has(A, "run") && has(B, "run");
  const keepAdm = has(A, "admission") && has(B, "admission");
  // 两方共有的场景名：按【每份文件的有效场景名】取并集后再求交集，避免多场景报告只认首条场景导致
  // 共有场景漏判（与本次修复的根因同源）。
  const scenNamesB = new Set(B.filter((f) => f.type === "scenario").flatMap(namesOf));
  const common = new Set(
    A.filter((f) => f.type === "scenario")
      .flatMap(namesOf)
      .filter((n) => scenNamesB.has(n)),
  );
  // 场景文件：只要它【含有至少一个共有场景名】就保留（该文件里同批的单方独有场景会作为副产品带入，
  // 但下游 commonScenarioNames 按聚合后的场景名取交集、buildComparison 按名分 matched/onlyA/onlyB，
  // 独有场景不会污染「共有」口径与通过率判定）。
  // load：**放行**（不像 run/admission 要求双方都有才纳入）——压测报告内部是多负载点的子结构，
  // 与场景更像：一份报告里可能既有双方共有的负载点、也有单方独有的。若在这里按"整份报告要或不要"
  // 收紧，会把"A 有压测报告、B 没有"的报告在此处直接连整份丢弃，buildComparison 里专门写的
  // onlyA/onlyB「仅一方测过的负载点」判断永远轮不到执行，报告还会误报「两个对象都没有压力测试报告」
  // ——这不是口径收紧，是把真实数据静默删没了。具体到哪些负载点能配对/哪些单方独有，
  // 完全交给 buildComparison 按 (mode, offered) 精确匹配即可，此处不做文件级过滤。
  const keep = (f) =>
    f.type === "run"
      ? keepRun
      : f.type === "admission"
        ? keepAdm
        : f.type === "load"
          ? true
          : f.type === "scenario"
            ? namesOf(f).some((n) => common.has(n))
            : false;
  // trim 时保留 scenarioAllow：行级授权要一路带到 aggregateSubject 才生效，在这里丢掉等于白标。
  const trim = (arr) =>
    arr.filter(keep).map((f) => ({ name: f.name, md: f.md, ...(f.scenarioAllow ? { scenarioAllow: f.scenarioAllow } : {}) }));
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

// 取两方【单方独有】的场景（供「补齐单方场景」按钮用）：onlyA = A 测过但 B 没测过（需要在 B 上补），
// onlyB 反之。口径与 commonScenarioNames 一致（同样先按名聚合），只是取差集而非交集。
export function exclusiveScenarioNames(filesA, filesB) {
  const aggA = aggregateSubject({ files: filesA });
  const aggB = aggregateSubject({ files: filesB });
  const namesA = new Set(aggA.scenarios.map((s) => s.name));
  const namesB = new Set(aggB.scenarios.map((s) => s.name));
  return {
    onlyA: aggA.scenarios.filter((s) => !namesB.has(s.name)).map((s) => ({ name: s.name, tier: s.tier || null })),
    onlyB: aggB.scenarios.filter((s) => !namesA.has(s.name)).map((s) => ({ name: s.name, tier: s.tier || null })),
  };
}

// —— 对象画像聚合（全部聚合）——

// scenarioFilter?: Set<string> —— 若给定，只保留名在其中的场景【行】（在按名归组后过滤，
// 因此对「一份报告含多个场景」也精确到单个场景）。scenarioPass / tiers / quality 等一切场景派生量
// 都随之只算被选场景，令「用户自选场景」在多场景报告下也能真正生效。
// files: [{ name, md, mtimeMs, summary?, scenarioAllow? }] —— summary 为该报告的结构化数据（test_runs.raw_json），
// 由调用方（server.mjs 的 loadBalancedCompareFiles）从库里取；没有则回退解析 md。
// scenarioAllow 为 pickRecentReports 标注的行级授权（该文件独家供数的场景名）：一份多场景文件因携带
// 独有场景被保留时，其与更新文件重名的场景行不得混入聚合稀释最新结果——授权外的行在此按文件跳过。
// 本模块不连库，保持纯函数、可离线单测。

// 场景名匹配用的规范化：折叠空白 + 去首尾空白。授权名来自 md 表格解析（写入时换行被渲染成空格、
// 单元格被 trim），而行名在挂 DB summary 时是库里的原始 scenarioName——名字含换行/首尾空白时两边
// 字面不同但语义相同，规范化后才能对上；不规范化会把 DB 行误判为"授权外"而丢弃。
const normScenName = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();

export function aggregateSubject({ files = [], label, scenarioFilter } = {}) {
  const parsed = files.map((f) => ({
    ...parseOne(f.name, f.md, f.summary),
    allow: Array.isArray(f.scenarioAllow) && f.scenarioAllow.length ? new Set(f.scenarioAllow.map(normScenName)) : null,
  }));
  const runs = parsed.filter((p) => p.type === "run").map((p) => p.data);
  const scens = parsed.filter((p) => p.type === "scenario").map((p) => ({ data: p.data, allow: p.allow }));
  const adms = parsed.filter((p) => p.type === "admission").map((p) => p.data);
  const loads = parsed.filter((p) => p.type === "load").map((p) => p.data);
  // 所有文件的授权名并集（「已被认领」的场景名）。行级过滤的保底：一行只有在其名字被【别的文件】
  // 认领时才跳过；名字无人认领（md 渲染改变了名字导致与 DB 原始名对不上，如名字含 `|`）则放行——
  // 此时没有任何更新文件在供数同名场景，丢掉它就是纯数据丢失；放行最坏也只是旧行为的按名池化。
  const claimedScenNames = new Set(scens.flatMap((s) => (s.allow ? [...s.allow] : [])));

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

  // 场景：按名归组（跨多份报告求均值/池化）。带行级授权的文件（scenarioAllow）只贡献授权内的行——
  // 授权外的行是「更新文件里已有同名场景」的陈旧数据，混入会稀释最新结果。匹配走规范化名字，
  // 且仅在该名字确实被别的文件认领时才跳过（见 claimedScenNames 的保底说明）。
  const byName = new Map();
  for (const { data: sc, allow } of scens)
    for (const row of sc.scenarios) {
      if (allow) {
        const key = normScenName(row.name);
        if (!allow.has(key) && claimedScenNames.has(key)) continue;
      }
      if (!byName.has(row.name)) byName.set(row.name, []);
      byName.get(row.name).push(row);
    }
  const scenarios = [...byName.entries()]
    .filter(([name]) => !(scenarioFilter instanceof Set) || scenarioFilter.has(name))
    .map(([name, rows]) => {
      const succ = rows.reduce((s, r) => s + (r.succ || 0), 0);
      const total = rows.reduce((s, r) => s + (r.total || 0), 0);
      // Raw samples originate from structured scenario summaries. Do not synthesize samples from
      // a Markdown P50: mixing report-level percentiles would misstate the pooled percentile.
      const firstTokenSamples = rows.flatMap((r) => r.firstTokenSamples || []).filter(Number.isFinite);
      return {
        name,
        tier: rows[0].tier,
        runs: rows.length,
        quality: avg(rows.map((r) => r.quality)),
        rate: total ? succ / total : null,
        succ,
        total,
        avgMs: avg(rows.map((r) => r.avgMs)),
        // Retain partial usage totals but surface their coverage alongside the value.
        outputTokens:
          avg(rows.map((r) => r.outputTokens)) === null
            ? null
            : rows.reduce((sum, r) => sum + (Number.isFinite(r.outputTokens) ? r.outputTokens : 0), 0),
        outputTokenReportedCount: rows.every((r) => Number.isFinite(r.outputTokenReportedCount))
          ? rows.reduce((sum, r) => sum + r.outputTokenReportedCount, 0)
          : null,
        outputTokenTotalCount: rows.every((r) => Number.isFinite(r.outputTokenTotalCount))
          ? rows.reduce((sum, r) => sum + r.outputTokenTotalCount, 0)
          : null,
        cacheReadTokens:
          avg(rows.map((r) => r.cacheReadTokens)) === null
            ? null
            : rows.reduce((sum, r) => sum + (Number.isFinite(r.cacheReadTokens) ? r.cacheReadTokens : 0), 0),
        cacheReadTokenReportedCount: rows.every((r) => Number.isFinite(r.cacheReadTokenReportedCount))
          ? rows.reduce((sum, r) => sum + r.cacheReadTokenReportedCount, 0)
          : null,
        cacheReadTokenTotalCount: rows.every((r) => Number.isFinite(r.cacheReadTokenTotalCount))
          ? rows.reduce((sum, r) => sum + r.cacheReadTokenTotalCount, 0)
          : null,
        firstTokenSamples,
        firstTokenSampleCount: firstTokenSamples.length,
        p50FirstTokenMs: nearestRankPct(firstTokenSamples, 0.5),
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

  // 压力测试负载点：一份报告即代表「当次运行的完整聚合」，不做跨报告池化（噪音大、取最新更可信，
  // 与 run/scenario 的"多次累加提升样本量"性质不同——见 pickRecentReports 对 load 只留最新一份的注释）。
  // 正常情况下 loads 最多 1 份（pickRecentReports 已去重）；若异常多份，简单摊平——重复的
  // (mode, offered) 键由 buildComparison 显式去重（保留首个），两侧同一规则。
  const loadPoints = loads.flatMap((l) => l.points || []);

  return {
    label: displayLabel,
    channel: meta.channel || null,
    model: meta.model || null,
    reportCounts: { run: runs.length, scenario: scens.length, admission: adms.length, load: loads.length, total: files.length },
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
    loadPoints,
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

// —— 压测负载点：不完全一致时的降级比较 ——

// 同 mode 的负载点集合里，在 offered 两侧找最近的真实点做线性插值；offered 落在范围外
// （比 min 更小或比 max 更大）时不外推——外推值不可信，直接返回 null 让调用方留在 onlyA/onlyB。
// points 至少需要 2 个不同 offered 的点才能插值；只有 1 个点时无法确定斜率。
export function interpolateLoadPoint(points, offered) {
  const pts = (points || [])
    .filter((p) => Number.isFinite(p.offered))
    .slice()
    .sort((x, y) => x.offered - y.offered);
  if (pts.length < 2) return null;
  const lo = pts[0].offered;
  const hi = pts[pts.length - 1].offered;
  if (offered < lo || offered > hi) return null;
  // 精确落在某个真实点上（含边界）：直接复用该点，不必插值引入误差。
  const exact = pts.find((p) => p.offered === offered);
  if (exact) return { ...exact, offered, interpFrom: null };
  let left = pts[0];
  let right = pts[pts.length - 1];
  for (let i = 0; i < pts.length - 1; i += 1) {
    if (pts[i].offered <= offered && offered <= pts[i + 1].offered) {
      left = pts[i];
      right = pts[i + 1];
      break;
    }
  }
  const span = right.offered - left.offered;
  const t = span === 0 ? 0 : (offered - left.offered) / span;
  const lerp = (field) => {
    const lv = left[field];
    const rv = right[field];
    if (!Number.isFinite(lv) || !Number.isFinite(rv)) return null;
    return lv + (rv - lv) * t;
  };
  return {
    mode: left.mode,
    offered,
    qps: lerp("qps"),
    tokensPerSecond: lerp("tokensPerSecond"),
    successRate: lerp("successRate"),
    p95: lerp("p95"),
    p99: lerp("p99"),
    interpFrom: { left: left.offered, right: right.offered },
  };
}

// 轻量拐点检测：只依赖 parseLoadReport 已解析出的扁平字段（不耦合 load-test.mjs 内部的
// { errors:{}, latency:{} } 嵌套形状），逐点按 offered 升序判定「首个不健康点」的前一点为推荐容量。
// 判定简化为「成功率<99% 或出现 429」，不区分服务端/客户端饱和类型——report-compare 侧数据本来就
// 没有 genSaturated 判定所需的完整上下文，做不到 load-test.mjs 那么细，此处只求给出一个可用的参考点。
export function simpleKnee(points) {
  const pts = (points || []).filter((p) => Number.isFinite(p.offered)).sort((x, y) => x.offered - y.offered);
  if (!pts.length) return { index: -1, point: null };
  const unhealthy = (p) => (Number.isFinite(p.successRate) && p.successRate < 0.99) || (Number.isFinite(p.http429) && p.http429 > 0);
  if (unhealthy(pts[0])) return { index: -1, point: null };
  for (let i = 1; i < pts.length; i += 1) {
    if (unhealthy(pts[i])) return { index: i - 1, point: pts[i - 1] };
  }
  const last = pts.length - 1;
  return { index: last, point: pts[last] };
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

  // 页面摘要的质量均分也必须基于同一批可配对场景。仅保留双方都有质量分的行，
  // 否则单方独有场景会改变均分和高亮结果，和「共有场景对比」的口径相矛盾。
  const commonQualityPairs = matched.filter((m) => Number.isFinite(m.a.quality) && Number.isFinite(m.b.quality));
  const commonQuality = {
    meanA: avg(commonQualityPairs.map((m) => m.a.quality)),
    meanB: avg(commonQualityPairs.map((m) => m.b.quality)),
    n: commonQualityPairs.length,
  };
  const firstTokenLatency = buildPairedFirstTokenLatency(matched);

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

  // —— 压力测试负载点配对：键为 (mode, offered)，开环(req/s)与闭环(并发)量纲不同、绝不互相配对。——
  // 压测数字本身是大量请求聚合后的确定性统计量（非重复抽样），不套配对 t 检验/CI 那套统计功效手段
  // （那是为场景重复次数少、需要弥补抽样误差设计的），这里只看点估计差值/变化率，更诚实。
  const loadKey = (p) => `${p.mode}:${p.offered}`;
  // 同键去重（保留报告顺序里的第一个）：runLoadTest 的负载序列不去重（用户可输入 "30,30"），一份
  // 报告可含重复 (mode, offered) 点。不去重时 A 侧重复会产出重复的 matched 行，B 侧重复会被 Map
  // 覆盖静默吞掉——两侧行为还不一致。统一显式去重，两侧同一规则。
  const dedupeByKey = (pts) => {
    const seen = new Set();
    const out = [];
    for (const p of pts || []) {
      const k = loadKey(p);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
    return out;
  };
  const aLoadPts = dedupeByKey(a.loadPoints);
  const bLoadPts = dedupeByKey(b.loadPoints);
  const mapLoadB = new Map(bLoadPts.map((p) => [loadKey(p), p]));
  const loadMatched = [];
  const seenBKeys = new Set();
  for (const pa of aLoadPts) {
    const pb = mapLoadB.get(loadKey(pa));
    if (pb) {
      seenBKeys.add(loadKey(pa));
      loadMatched.push({
        mode: pa.mode,
        offered: pa.offered,
        a: pa,
        b: pb,
        qpsDelta: diff(pa.qps, pb.qps),
        p95Delta: diff(pa.p95, pb.p95),
        p99Delta: diff(pa.p99, pb.p99),
        successRateDelta: diff(pa.successRate, pb.successRate),
      });
    }
  }
  const loadOnlyA = aLoadPts.filter((p) => !mapLoadB.has(loadKey(p)));
  const loadOnlyB = bLoadPts.filter((p) => !seenBKeys.has(loadKey(p)));

  // —— 降级比较①：精确配不上时，在对方【同 mode】曲线上线性插值试一次。——
  // 只对「未被精确匹配收编」的独有点尝试，插值成功就从 onlyA/onlyB 里移走（不重复出现在两处）。
  // 跨 mode 的点永远插不出来（interpolateLoadPoint 按传入的同 mode 子集找区间），量纲不同不互相估。
  const loadInterpolatedMatched = [];
  const stillOnlyA = [];
  for (const pa of loadOnlyA) {
    const sameModeB = bLoadPts.filter((p) => p.mode === pa.mode);
    const interp = interpolateLoadPoint(sameModeB, pa.offered);
    if (interp) {
      loadInterpolatedMatched.push({
        mode: pa.mode,
        offered: pa.offered,
        a: pa,
        b: interp,
        qpsDelta: diff(pa.qps, interp.qps),
        p95Delta: diff(pa.p95, interp.p95),
        p99Delta: diff(pa.p99, interp.p99),
        successRateDelta: diff(pa.successRate, interp.successRate),
        interpolatedSide: "b",
        interpFrom: interp.interpFrom,
      });
    } else {
      stillOnlyA.push(pa);
    }
  }
  const stillOnlyB = [];
  for (const pb of loadOnlyB) {
    const sameModeA = aLoadPts.filter((p) => p.mode === pb.mode);
    const interp = interpolateLoadPoint(sameModeA, pb.offered);
    if (interp) {
      loadInterpolatedMatched.push({
        mode: pb.mode,
        offered: pb.offered,
        a: interp,
        b: pb,
        qpsDelta: diff(interp.qps, pb.qps),
        p95Delta: diff(interp.p95, pb.p95),
        p99Delta: diff(interp.p99, pb.p99),
        successRateDelta: diff(interp.successRate, pb.successRate),
        interpolatedSide: "a",
        interpFrom: interp.interpFrom,
      });
    } else {
      stillOnlyB.push(pb);
    }
  }

  // —— 降级比较②：逐点（含插值）比较完全没有结果时（跨 mode，或同 mode 但 offered 范围不重叠），
  // 退化成整条曲线的汇总特征值比较——推荐容量点 + 峰值 QPS/tok·s，不逐点比、只看曲线轮廓。——
  const peakOf = (pts, field) =>
    (pts || []).reduce((m, p) => (Number.isFinite(p[field]) && (m == null || p[field] > m) ? p[field] : m), null);
  const loadSummary =
    !loadMatched.length && !loadInterpolatedMatched.length && aLoadPts.length && bLoadPts.length
      ? {
          a: { knee: simpleKnee(aLoadPts), peakQps: peakOf(aLoadPts, "qps"), peakTokensPerSecond: peakOf(aLoadPts, "tokensPerSecond") },
          b: { knee: simpleKnee(bLoadPts), peakQps: peakOf(bLoadPts, "qps"), peakTokensPerSecond: peakOf(bLoadPts, "tokensPerSecond") },
        }
      : null;

  const loadComparison = {
    matched: loadMatched,
    interpolatedMatched: loadInterpolatedMatched,
    onlyA: stillOnlyA,
    onlyB: stillOnlyB,
    summary: loadSummary,
    // 去重后的两侧完整压测点集（未经共有性过滤），供综合评分算 goodput 用——
    // 不能用 matched/interpolatedMatched（那是"配对成功的子集"），综合评分要看的是
    // 各自曲线独立算出的拐点吞吐量，压测种类不一致也能各自算、互相比。
    aPoints: aLoadPts,
    bPoints: bLoadPts,
  };

  const cmpWithoutScore = {
    a,
    b,
    verdicts: { stability: stabVerdict, scenarioPass: scenVerdict },
    scenarioQuality: { matched, onlyA, onlyB, commonQuality },
    tierRows,
    pairedQuality,
    pairedPass,
    firstTokenLatency,
    latency,
    loadComparison,
  };
  return { ...cmpWithoutScore, overallScore: computeOverallScore(cmpWithoutScore) };
}

function comparisonViewWinner(valueA, valueB, direction) {
  if (direction === "none") return null;
  if (!Number.isFinite(valueA) || !Number.isFinite(valueB) || valueA === valueB) return null;
  const aWins = direction === "lower" ? valueA < valueB : valueA > valueB;
  return aWins ? "a" : "b";
}

function comparisonViewScenarioUsageTotals(matched, field, reportedCountField, totalCountField) {
  const combine = (side) => {
    const rows = (matched || []).map((row) => row[side]);
    const values = rows.map((row) => row[field]).filter(Number.isFinite);
    return {
      value: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
      reportedCount: rows.every((row) => Number.isFinite(row[reportedCountField]))
        ? rows.reduce((sum, row) => sum + row[reportedCountField], 0)
        : null,
      totalCount: rows.every((row) => Number.isFinite(row[totalCountField]))
        ? rows.reduce((sum, row) => sum + row[totalCountField], 0)
        : null,
    };
  };
  return { a: combine("a"), b: combine("b") };
}

function comparisonViewRow({ id, label, detail, format, unit, direction = "higher", valueA, valueB, coverageA = null, coverageB = null }) {
  const a = Number.isFinite(valueA) ? valueA : null;
  const b = Number.isFinite(valueB) ? valueB : null;
  return {
    id,
    label,
    detail: detail || null,
    format,
    unit,
    direction,
    valueA: a,
    valueB: b,
    coverageA,
    coverageB,
    winner: comparisonViewWinner(a, b, direction),
    status: a == null || b == null ? "insufficient" : "ready",
  };
}

function comparisonViewGoodput(points) {
  const point = simpleKnee(points).point;
  if (!Number.isFinite(point?.qps) || !Number.isFinite(point?.successRate)) return null;
  return point.qps * point.successRate;
}

// Browser-facing projection for the model comparison matrix. Keep this separate from the full
// comparison object so the UI consumes a deliberate, stable contract rather than report internals.
export function buildComparisonView(cmp) {
  const { a, b } = cmp;
  const score = cmp.overallScore || {};
  const aLatency = a.latency?.stats || {};
  const bLatency = b.latency?.stats || {};
  const commonQuality = cmp.scenarioQuality?.commonQuality || { meanA: null, meanB: null, n: 0 };
  const firstTokenLatency = cmp.firstTokenLatency || buildPairedFirstTokenLatency(cmp.scenarioQuality?.matched || []);
  const scenarioOutputTokens = comparisonViewScenarioUsageTotals(
    cmp.scenarioQuality?.matched || [],
    "outputTokens",
    "outputTokenReportedCount",
    "outputTokenTotalCount",
  );
  const scenarioCacheReadTokens = comparisonViewScenarioUsageTotals(
    cmp.scenarioQuality?.matched || [],
    "cacheReadTokens",
    "cacheReadTokenReportedCount",
    "cacheReadTokenTotalCount",
  );
  const summary = [
    comparisonViewRow({
      id: "overall-score",
      label: "综合相对分",
      detail: "A + B = 100，50 分为打平",
      format: "number",
      unit: "分",
      valueA: score.scoreA,
      valueB: score.scoreB,
    }),
    comparisonViewRow({
      id: "stability-rate",
      label: "稳定性成功率",
      detail: "近期稳定性测试",
      format: "percent",
      unit: "%",
      valueA: a.stability?.rate,
      valueB: b.stability?.rate,
    }),
    comparisonViewRow({
      id: "scenario-pass-rate",
      label: "场景通过率",
      detail: "仅计双方共有场景",
      format: "percent",
      unit: "%",
      valueA: a.scenarioPass?.rate,
      valueB: b.scenarioPass?.rate,
    }),
    comparisonViewRow({
      id: "scenario-output-tokens",
      label: "场景输出 Token（含思考）",
      detail: "仅计双方共有场景；不作为优劣评判",
      format: "tokens",
      unit: "Token",
      direction: "none",
      valueA: scenarioOutputTokens.a.value,
      valueB: scenarioOutputTokens.b.value,
      coverageA: { reportedCount: scenarioOutputTokens.a.reportedCount, totalCount: scenarioOutputTokens.a.totalCount },
      coverageB: { reportedCount: scenarioOutputTokens.b.reportedCount, totalCount: scenarioOutputTokens.b.totalCount },
    }),
    comparisonViewRow({
      id: "scenario-cache-read-tokens",
      label: "场景缓存命中 Token",
      detail: "仅计双方共有场景；不作为优劣评判",
      format: "tokens",
      unit: "Token",
      direction: "none",
      valueA: scenarioCacheReadTokens.a.value,
      valueB: scenarioCacheReadTokens.b.value,
      coverageA: { reportedCount: scenarioCacheReadTokens.a.reportedCount, totalCount: scenarioCacheReadTokens.a.totalCount },
      coverageB: { reportedCount: scenarioCacheReadTokens.b.reportedCount, totalCount: scenarioCacheReadTokens.b.totalCount },
    }),
    comparisonViewRow({
      id: "scenario-quality",
      label: "平均质量分",
      detail: `仅计双方共有且均有质量分的场景（${commonQuality.n} 个）`,
      format: "number",
      unit: "分",
      valueA: commonQuality.meanA,
      valueB: commonQuality.meanB,
    }),
    comparisonViewRow({
      id: "p95-latency",
      label: "P95 总耗时",
      detail: "稳定性测试轮次，越低越好",
      format: "milliseconds",
      unit: "ms",
      direction: "lower",
      valueA: aLatency.p95TotalMs,
      valueB: bLatency.p95TotalMs,
    }),
    comparisonViewRow({
      id: "p50-first-token",
      label: "P50 首 Token 延迟",
      detail: `仅计双方都有流式首 Token 样本的共有场景（${firstTokenLatency.pairedScenarioCount} 个）`,
      format: "milliseconds",
      unit: "ms",
      direction: "lower",
      valueA: firstTokenLatency.p50A,
      valueB: firstTokenLatency.p50B,
    }),
    comparisonViewRow({
      id: "admission-score",
      label: "准入综合分",
      detail: "身份与能力准入评测",
      format: "number",
      unit: "分",
      valueA: a.admission?.composite,
      valueB: b.admission?.composite,
    }),
    comparisonViewRow({
      id: "load-goodput",
      label: "压测推荐容量",
      detail: "推荐容量点的 QPS × 成功率",
      format: "number",
      unit: "有效 QPS",
      valueA: comparisonViewGoodput(cmp.loadComparison?.aPoints),
      valueB: comparisonViewGoodput(cmp.loadComparison?.bPoints),
    }),
  ];
  const scenarios = cmp.scenarioQuality.matched.map((row) => {
    const qualityA = Number.isFinite(row.a.quality) ? row.a.quality : null;
    const qualityB = Number.isFinite(row.b.quality) ? row.b.quality : null;
    return {
      name: row.name,
      tier: row.tier || null,
      winner: comparisonViewWinner(qualityA, qualityB, "higher"),
      status: qualityA == null || qualityB == null ? "insufficient" : "ready",
      a: {
        quality: qualityA,
        passRate: Number.isFinite(row.a.rate) ? row.a.rate : null,
        avgMs: Number.isFinite(row.a.avgMs) ? row.a.avgMs : null,
        outputTokens: Number.isFinite(row.a.outputTokens) ? row.a.outputTokens : null,
        outputTokenReportedCount: Number.isFinite(row.a.outputTokenReportedCount) ? row.a.outputTokenReportedCount : null,
        outputTokenTotalCount: Number.isFinite(row.a.outputTokenTotalCount) ? row.a.outputTokenTotalCount : null,
        cacheReadTokens: Number.isFinite(row.a.cacheReadTokens) ? row.a.cacheReadTokens : null,
        cacheReadTokenReportedCount: Number.isFinite(row.a.cacheReadTokenReportedCount) ? row.a.cacheReadTokenReportedCount : null,
        cacheReadTokenTotalCount: Number.isFinite(row.a.cacheReadTokenTotalCount) ? row.a.cacheReadTokenTotalCount : null,
        p50FirstTokenMs: Number.isFinite(row.a.p50FirstTokenMs) ? row.a.p50FirstTokenMs : null,
        issue: row.a.issue || null,
      },
      b: {
        quality: qualityB,
        passRate: Number.isFinite(row.b.rate) ? row.b.rate : null,
        avgMs: Number.isFinite(row.b.avgMs) ? row.b.avgMs : null,
        outputTokens: Number.isFinite(row.b.outputTokens) ? row.b.outputTokens : null,
        outputTokenReportedCount: Number.isFinite(row.b.outputTokenReportedCount) ? row.b.outputTokenReportedCount : null,
        outputTokenTotalCount: Number.isFinite(row.b.outputTokenTotalCount) ? row.b.outputTokenTotalCount : null,
        cacheReadTokens: Number.isFinite(row.b.cacheReadTokens) ? row.b.cacheReadTokens : null,
        cacheReadTokenReportedCount: Number.isFinite(row.b.cacheReadTokenReportedCount) ? row.b.cacheReadTokenReportedCount : null,
        cacheReadTokenTotalCount: Number.isFinite(row.b.cacheReadTokenTotalCount) ? row.b.cacheReadTokenTotalCount : null,
        p50FirstTokenMs: Number.isFinite(row.b.p50FirstTokenMs) ? row.b.p50FirstTokenMs : null,
        issue: row.b.issue || null,
      },
    };
  });
  return {
    subjects: {
      a: { label: a.label },
      b: { label: b.label },
    },
    summary,
    scenarios,
  };
}

// —— 综合评分（相对分）：把可用性/质量/压测/首 Token 延迟四个维度各压成 [-1,1] 的效应量，加权合成后
// 映射成两个对象的分数（和恒为100）。分数含义是"A 相对 B 综合谁更强、强多少"，不是绝对量表——
// 没有"90分=优秀"这类绝对基准，50分才是唯一有意义的锚点（打平）。——
const OVERALL_SCORE_WEIGHTS = { availability: 0.3, quality: 0.3, load: 0.3, firstToken: 0.1 };
const FIRST_TOKEN_MIN_PAIRED_SCENARIOS = 2;
const FIRST_TOKEN_MIN_SAMPLES_PER_SIDE = 3;

// Cohen's h 理论上界是 π（2·arcsin(1) − 2·arcsin(0) 的两倍），除以 π 压到 [-1,1]。
function cohensHEffect(v, labelA, labelB) {
  if (!v || String(v.verdict || "").includes("样本不足")) return null;
  const pa = v.a?.point;
  const pb = v.b?.point;
  if (!Number.isFinite(pa) || !Number.isFinite(pb)) return null;
  return cohensH(pa, pb) / Math.PI;
}

// 拐点吞吐量（goodput）比值 → 效应量：两边独立算 simpleKnee，不要求压测种类对齐，
// 这正是绕开"压测种类不一致就没法比"限制的关键——各自曲线各算各的拐点，只比结果。
// tanh(ln(ratio)/ln4)：4倍差距时效应量≈0.76，8倍≈0.96，1倍=0（打平）。
function loadGoodputEffect(aPoints, bPoints) {
  const aTested = Boolean(aPoints?.length);
  const bTested = Boolean(bPoints?.length);
  if (!aTested && !bTested) return null; // 双方都没有压测数据，不能拿"都没测"当打平
  // 只有一方做过压测：另一方是「从未测」而非「测了但挂了」——不能把"没数据"当 0% 成功率，
  // 那会让"从未压测"的一方在综合评分里被判定为满值劣势（本次修的根因）。数据不对等时不参与合成。
  if (aTested !== bTested) return null;
  const goodputOf = (pts) => {
    const { point } = simpleKnee(pts);
    if (!point) return 0; // 最低负载点就不健康 → 测不出可用容量，是真实测量结果，记 0
    if (!Number.isFinite(point.qps) || !Number.isFinite(point.successRate)) return null; // 数据解析失败（如表头漂移），不可信，不能当0
    return point.qps * point.successRate;
  };
  const ga = goodputOf(aPoints);
  const gb = goodputOf(bPoints);
  if (ga == null || gb == null) return null; // 任一方数据不可信解析，不参与合成
  if (ga === 0 && gb === 0) return 0;
  if (ga === 0 || gb === 0) return ga > gb ? 1 : -1; // 一方 0、一方 >0：对数比值不稳定，直接给方向明确的极值
  return Math.tanh(Math.log(ga / gb) / Math.log(4));
}

function buildPairedFirstTokenLatency(matched) {
  const paired = (matched || []).filter((row) => row.a.firstTokenSampleCount > 0 && row.b.firstTokenSampleCount > 0);
  const samplesA = paired.flatMap((row) => row.a.firstTokenSamples || []).filter(Number.isFinite);
  const samplesB = paired.flatMap((row) => row.b.firstTokenSamples || []).filter(Number.isFinite);
  const p50A = nearestRankPct(samplesA, 0.5);
  const p50B = nearestRankPct(samplesB, 0.5);
  return {
    pairedScenarioCount: paired.length,
    samplesA,
    samplesB,
    aN: samplesA.length,
    bN: samplesB.length,
    p50A,
    p50B,
    eligibleForOverall:
      paired.length >= FIRST_TOKEN_MIN_PAIRED_SCENARIOS &&
      samplesA.length >= FIRST_TOKEN_MIN_SAMPLES_PER_SIDE &&
      samplesB.length >= FIRST_TOKEN_MIN_SAMPLES_PER_SIDE &&
      Number.isFinite(p50A) &&
      Number.isFinite(p50B),
  };
}

function firstTokenLatencyEffect(firstTokenLatency) {
  if (!firstTokenLatency?.eligibleForOverall) return null;
  const { p50A, p50B } = firstTokenLatency;
  if (p50A === p50B) return 0;
  // A lower P50 is better. Guard the zero boundary before taking a logarithm.
  if (p50A <= 0 || p50B <= 0) return p50A < p50B ? 1 : -1;
  return Math.tanh(Math.log(p50B / p50A) / Math.log(4));
}

export function computeOverallScore(cmp) {
  const { a, b } = cmp;
  const dims = {
    availability: { effect: null, weight: 0 },
    quality: { effect: null, weight: 0 },
    load: { effect: null, weight: 0 },
    firstToken: { effect: null, weight: 0 },
  };

  const hAvail = [
    cohensHEffect(cmp.verdicts.stability, a.label, b.label),
    cohensHEffect(cmp.verdicts.scenarioPass, a.label, b.label),
  ].filter((v) => v != null);
  if (hAvail.length) dims.availability.effect = hAvail.reduce((s, v) => s + v, 0) / hAvail.length;

  const pq = cmp.pairedQuality;
  if (pq && pq.n >= 2 && Number.isFinite(pq.cliff?.delta)) dims.quality.effect = pq.cliff.delta;

  dims.load.effect = loadGoodputEffect(cmp.loadComparison?.aPoints, cmp.loadComparison?.bPoints);
  dims.firstToken.effect = firstTokenLatencyEffect(cmp.firstTokenLatency);

  let weightedSum = 0;
  let weightTotal = 0;
  for (const key of Object.keys(dims)) {
    if (!Number.isFinite(dims[key].effect)) continue; // 排除 null/undefined/NaN：NaN != null 为 true，仅判 == null 会让 NaN 漏网并污染合成分
    weightedSum += OVERALL_SCORE_WEIGHTS[key] * dims[key].effect;
    weightTotal += OVERALL_SCORE_WEIGHTS[key];
  }
  if (weightTotal === 0) return { scoreA: null, scoreB: null, effect: null, dims };

  // 按比例重新归一化：缺失维度的权重不会消失，也不会被当 0 分打平，而是分给仍参与的维度。
  for (const key of Object.keys(dims)) {
    dims[key].weight = Number.isFinite(dims[key].effect) ? OVERALL_SCORE_WEIGHTS[key] / weightTotal : 0;
  }
  const effect = weightedSum / weightTotal;
  const scoreA = Math.round(50 + 50 * effect);
  const scoreB = 100 - scoreA;
  return { scoreA, scoreB, effect, dims };
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
  const loadCountText = (rc) => (rc.load ? ` / 压测 ${rc.load}` : "");
  L.push(
    `- 对象 A：**${a.label}**（报告 ${a.reportCounts.total} 份：场景 ${a.reportCounts.scenario} / 稳定性 ${a.reportCounts.run} / 准入 ${a.reportCounts.admission}${loadCountText(a.reportCounts)}）`,
  );
  L.push(
    `- 对象 B：**${b.label}**（报告 ${b.reportCounts.total} 份：场景 ${b.reportCounts.scenario} / 稳定性 ${b.reportCounts.run} / 准入 ${b.reportCounts.admission}${loadCountText(b.reportCounts)}）`,
  );
  if (balancedToCommon) {
    L.push("");
    L.push(
      "> 为等量对比，双方仅采用**共有**的报告：同名场景取交集，稳定性 / 准入需两方都测过才纳入（单方独有的已排除）；压力测试按负载点单独判断——共有负载点参与对比，单方独有的负载点仍列出（见第6节），故两方报告数量可能不同。",
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

  // 综合评分（相对分）：紧跟结论速览之后，作为其补充；不占用后续小节编号。
  const os = cmp.overallScore;
  L.push("## 综合评分（相对分，A + B = 100）", "");
  if (os && os.scoreA != null) {
    L.push(`**对象A：${os.scoreA} 分　对象B：${os.scoreB} 分**`, "");
    L.push(
      "> 分数含义：不是绝对质量分，是「对象A 相对对象B 综合谁更强、强多少」的相对分，50 分为打平。按可用性 / 质量 / 压力测试 / 首 Token 延迟加权合成；压测用**拐点吞吐量**（推荐容量点的 QPS × 成功率）比较，不要求两侧压测种类一致。",
      "",
    );
    const dimLabel = { availability: "可用性", quality: "质量", load: "压力测试", firstToken: "首 Token 延迟" };
    const dimNote = {
      availability: "稳定性成功率 / 场景通过率的比例效果量均值",
      quality: "同名场景配对质量分效果量",
      load: "拐点吞吐量（goodput）比值",
      firstToken: "P50 首 Token 延迟；至少 2 个共同流式场景、每侧至少 3 个有效样本",
    };
    L.push("| 维度 | 权重 | 效应量(对象A相对对象B) | 说明 |", "|---|---:|---:|---|");
    for (const key of ["availability", "quality", "load", "firstToken"]) {
      const d = os.dims[key];
      const baseW = Math.round(OVERALL_SCORE_WEIGHTS[key] * 100);
      if (d.effect == null) {
        L.push(`| ${dimLabel[key]} | ${baseW}%（未参与：样本不足） | - | - |`);
      } else {
        const actualW = Math.round(d.weight * 100);
        const weightText = actualW === baseW ? `${baseW}%` : `${baseW}%（实际${actualW}%，已按比例归一化）`;
        L.push(`| ${dimLabel[key]} | ${weightText} | ${sgn(d.effect)} | ${dimNote[key]} |`);
      }
    }
    L.push("", "> 任一维度样本不足时不参与合成，权重按比例分给其余维度，不会被当作 0 分打平。", "");
  } else {
    L.push("> 数据不足，无法给出综合评分（可用性/质量/压测三个维度均样本不足）。", "");
  }
  L.push("");

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

  // 6. 压力测试对比。与第3节（准入）同惯例：小节标题始终出现，两方都没压测报告时给一句说明而非留空。
  const lc = cmp.loadComparison;
  L.push("## 6. 压力测试对比", "");
  const hasAnyLoadSignal = lc && (lc.matched.length || lc.interpolatedMatched.length || lc.onlyA.length || lc.onlyB.length || lc.summary);
  if (hasAnyLoadSignal) {
    L.push(
      "> 负载点按“模式（开环速率 req/s / 闭环并发）+ 负载值”精确配对；不同模式的点量纲不同，不互相比较。压测数字是单次运行的确定性聚合值（非重复抽样），故只看差值/变化率，不套置信区间。",
      "",
    );
    const loadRowCells = (mode, offered, ma, mb, unit) => [
      mode === "open" ? "开环" : "闭环",
      `${offered} ${unit}`,
      fmt(ma.qps),
      fmt(mb.qps),
      signed(diff(ma.qps, mb.qps)),
      pct(ma.successRate),
      pct(mb.successRate),
      fmt(ma.p95, " ms"),
      fmt(mb.p95, " ms"),
      signed(diff(ma.p95, mb.p95)),
      fmt(ma.p99, " ms"),
      fmt(mb.p99, " ms"),
      signed(diff(ma.p99, mb.p99)),
    ];
    if (lc.matched.length) {
      L.push(
        "| 模式 | 负载 | QPS(A) | QPS(B) | ΔQPS | 成功率(A) | 成功率(B) | p95(A) | p95(B) | Δp95 | p99(A) | p99(B) | Δp99 |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
      );
      for (const m of lc.matched) {
        const unit = m.mode === "open" ? "req/s" : "并发";
        L.push(`| ${loadRowCells(m.mode, m.offered, m.a, m.b, unit).join(" | ")} |`);
      }
      L.push("");
    } else if (!lc.interpolatedMatched.length && !lc.summary) {
      L.push("> 两个对象没有可配对的同负载点（模式或负载值均不一致），无法逐点对比。", "");
    }
    if (lc.interpolatedMatched.length) {
      L.push("> 以下负载点两侧数值不完全相等，已在同模式曲线上做**线性插值估计**，非实测数据，仅供参考：", "");
      L.push(
        "| 模式 | 负载 | QPS(A) | QPS(B) | ΔQPS | 成功率(A) | 成功率(B) | p95(A) | p95(B) | Δp95 | p99(A) | p99(B) | Δp99 | 估计方 | 插值区间 |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|",
      );
      for (const m of lc.interpolatedMatched) {
        const unit = m.mode === "open" ? "req/s" : "并发";
        const side = m.interpolatedSide === "a" ? "对象A" : "对象B";
        const from = m.interpFrom ? `${m.interpFrom.left}–${m.interpFrom.right}` : "—";
        L.push(`| ${loadRowCells(m.mode, m.offered, m.a, m.b, unit).join(" | ")} | ${side} | ${from} |`);
      }
      L.push("");
    }
    const loadName = (p) => `${p.mode === "open" ? "开环" : "闭环"} ${p.offered}${p.mode === "open" ? " req/s" : ""}`;
    if (lc.onlyA.length) L.push(`- 仅对象A 测过、且无法插值估计的负载点：${lc.onlyA.map((p) => escapeCell(loadName(p))).join("、")}`);
    if (lc.onlyB.length) L.push(`- 仅对象B 测过、且无法插值估计的负载点：${lc.onlyB.map((p) => escapeCell(loadName(p))).join("、")}`);
    if (lc.onlyA.length || lc.onlyB.length) L.push("");
    if (lc.summary) {
      L.push(
        "> 因两侧压测**模式不同或负载范围不重叠**，逐点与插值比较均无法进行，以下改为整条曲线的**汇总特征值比较**（非逐点比较）：",
        "",
      );
      const kneeLine = (label, s) => {
        const kp = s.knee.point;
        const kneeText = kp
          ? `${kp.mode === "open" ? "开环" : "闭环"} ${kp.offered}（QPS ${fmt(kp.qps)}，成功率 ${pct(kp.successRate)}，p99 ${fmt(kp.p99, " ms")}）`
          : "无（最低负载点即不健康）";
        L.push(
          `- ${label}：推荐容量点 ${kneeText}；峰值 QPS ${fmt(s.peakQps)}${s.peakTokensPerSecond != null ? `，峰值输出 ${fmt(s.peakTokensPerSecond)} tok/s` : ""}`,
        );
      };
      kneeLine("对象A", lc.summary.a);
      kneeLine("对象B", lc.summary.b);
      L.push("");
    }
  } else {
    L.push("> 两个对象都没有压力测试报告，跳过压测对比。", "");
  }
  L.push("");

  // 7. 总结
  L.push("## 7. 总结", "");
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
  L.push(
    `- 综合评分：可用性效果量用 **Cohen's h** 均值（除以 π 归一到 [-1,1]）；质量效果量用 **Cliff's δ**；压测效果量 = tanh(ln(A拐点吞吐量/B拐点吞吐量) / ln4)；首 Token 效果量 = tanh(ln(B P50/A P50) / ln4)（4 倍差距对应约 0.76，1 倍即打平）。四个维度按 ${Math.round(OVERALL_SCORE_WEIGHTS.availability * 100)}% / ${Math.round(OVERALL_SCORE_WEIGHTS.quality * 100)}% / ${Math.round(OVERALL_SCORE_WEIGHTS.load * 100)}% / ${Math.round(OVERALL_SCORE_WEIGHTS.firstToken * 100)}% 加权；首 Token 至少需要 2 个共同流式场景且每侧至少 3 个有效样本，缺失维度的权重按比例分给其余维度，不当 0 分处理；分数 = 50 ± 50×合成效应量，是相对分而非绝对量表。`,
  );
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
  // 压测负载点配对结果（有配对点才给；单方独有点仅计数提示，避免 AI 拿单侧数字硬比）。
  const lcp = cmp.loadComparison;
  if (lcp?.matched?.length) {
    facts.push(
      "压力测试(同负载点精确配对)：" +
        lcp.matched
          .map(
            (m) =>
              `${m.mode === "open" ? "开环" : "闭环"}${m.offered}: QPS 对象A ${fmt(m.a.qps)}/对象B ${fmt(m.b.qps)}，p99 对象A ${fmt(m.a.p99, "ms")}/对象B ${fmt(m.b.p99, "ms")}，成功率 对象A ${pct(m.a.successRate)}/对象B ${pct(m.b.successRate)}`,
          )
          .join("；"),
    );
  }
  if (lcp?.interpolatedMatched?.length) {
    facts.push(`压力测试(插值估计，非实测)：共 ${lcp.interpolatedMatched.length} 个负载点通过线性插值估算得到，叙述中须明确标注为估计值`);
  }
  if (lcp?.summary) {
    facts.push(
      `压力测试(曲线汇总对比，因模式或负载范围不重叠无法逐点比)：对象A 峰值QPS ${fmt(lcp.summary.a.peakQps)}/对象B 峰值QPS ${fmt(lcp.summary.b.peakQps)}`,
    );
  }
  if (lcp && (lcp.onlyA?.length || lcp.onlyB?.length)) {
    facts.push(
      `压测负载点覆盖差异：仅对象A测过 ${lcp.onlyA.length} 个、仅对象B测过 ${lcp.onlyB.length} 个（无法配对或插值，不作强弱依据）`,
    );
  }
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
  const os = cmp.overallScore;
  if (os?.scoreA != null) {
    facts.push(`综合评分（相对分，A+B=100，50分为打平）：对象A ${os.scoreA} 分 / 对象B ${os.scoreB} 分，合成效应量 E=${sgn(os.effect)}`);
  }
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
