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

// —— 对比专用统计量（配对分析 / 效果量 / 两样本 bootstrap）——
// 依据 Miller 2024《Adding Error Bars to Evals》：同名场景是「配对」样本，应用配对差值（含相关项）
// 降方差、并报效果量与置信区间，而非只比两条独立置信区间是否重叠（过于保守、太笼统）。

// Pearson 相关：配对越正相关，配对法降低的方差越多（Miller 建议一并报告）。
function pearson(a, b) {
  const xs = [];
  const ys = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { xs.push(a[i]); ys.push(b[i]); }
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
  for (const x of A) for (const y of B) { if (x > y) gt++; else if (x < y) lt++; }
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
  return { point: stat(A) - stat(B), lower: quantileSorted(diffs, alpha / 2), upper: quantileSorted(diffs, 1 - alpha / 2), n: Math.min(A.length, B.length), statA: stat(A), statB: stat(B) };
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
  // 单轮明细：成功轮次的总耗时样本（用于延迟分布对比 / bootstrap CI）。
  const detail = parseTable(section(md, "单轮明细"));
  const iRes = colIndex(detail.headers, "结果");
  const iTot = colIndex(detail.headers, "总耗时");
  const latencySamples = [];
  for (const cells of detail.rows) {
    const t = num(cell(cells, iTot));
    if (/成功/.test(cell(cells, iRes) || "") && Number.isFinite(t)) latencySamples.push(t);
  }
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

function parseOne(name, md) {
  const type = detectReportType(name, md);
  if (type === "run") return { name, type, data: parseRunReport(md) };
  if (type === "scenario") return { name, type, data: parseScenarioReport(md) };
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

// —— 对象画像聚合（全部聚合）——

export function aggregateSubject({ files = [], label } = {}) {
  const parsed = files.map((f) => parseOne(f.name, f.md));
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
  for (const sc of scens) for (const row of sc.scenarios) {
    if (!byName.has(row.name)) byName.set(row.name, []);
    byName.get(row.name).push(row);
  }
  const scenarios = [...byName.entries()]
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
    return { tier, count: arr.length, passRate: total ? succ / total : null, quality: avg(arr.map((s) => s.quality)), errored: arr.filter((s) => s.errored).length };
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
    latency: { samples: runs.flatMap((r) => r.latencySamples || []) },
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

export function buildComparison(a, b) {
  const stabVerdict =
    a.stability && b.stability
      ? compareProportions(a.stability.succ, a.stability.total, b.stability.succ, b.stability.total, { labelA: a.label, labelB: b.label })
      : { significant: false, verdict: "样本不足", method: "wilson-ci-overlap" };
  const scenVerdict = compareProportions(a.scenarioPass.succ, a.scenarioPass.total, b.scenarioPass.succ, b.scenarioPass.total, { labelA: a.label, labelB: b.label });

  const mapB = new Map(b.scenarios.map((s) => [s.name, s]));
  const matched = [];
  for (const sa of a.scenarios) {
    const sb = mapB.get(sa.name);
    if (sb) matched.push({ name: sa.name, tier: sa.tier, a: sa, b: sb, delta: diff(sa.quality, sb.quality) });
  }
  const namesA = new Set(a.scenarios.map((s) => s.name));
  const onlyA = a.scenarios.filter((s) => !mapB.has(s.name)).map((s) => s.name);
  const onlyB = b.scenarios.filter((s) => !namesA.has(s.name)).map((s) => s.name);

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
const fmtCI = (ci, unit = "") => (ci && Number.isFinite(ci[0]) && Number.isFinite(ci[1]) ? `[${sgn(ci[0], unit)}, ${sgn(ci[1], unit)}]` : "样本不足");
const fmtP = (p) => (p == null ? "-" : p < 0.001 ? "<0.001" : p.toFixed(3));
const r2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : "-");
const ciExcludesZero = (ci) => Boolean(ci) && Number.isFinite(ci[0]) && Number.isFinite(ci[1]) && (ci[0] > 0 || ci[1] < 0);
const escapeCell = (s) => String(s ?? "").replace(/\\+$/g, "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
// 诊断表里的问题摘要可能较长，截断到可读长度（保留信息、不撑破表格）。
const shortText = (s, n = 36) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const stabCell = (s) => (s.stability ? `${pct(s.stability.rate)}（${s.stability.succ}/${s.stability.total}）` : "-");
const passCell = (s) => (s.scenarioPass.total ? `${pct(s.scenarioPass.rate)}（${s.scenarioPass.succ}/${s.scenarioPass.total}）` : "-");

export function formatCompareReportMarkdown(cmp, { generatedAt, aiNarrative } = {}) {
  const { a, b } = cmp;
  const L = [];
  L.push("# 模型对比报告", "");
  L.push(`生成时间：${generatedAt || new Date().toISOString()}`, "");
  L.push(`- 对象 A：**${a.label}**（报告 ${a.reportCounts.total} 份：场景 ${a.reportCounts.scenario} / 稳定性 ${a.reportCounts.run} / 准入 ${a.reportCounts.admission}）`);
  L.push(`- 对象 B：**${b.label}**（报告 ${b.reportCounts.total} 份：场景 ${b.reportCounts.scenario} / 稳定性 ${b.reportCounts.run} / 准入 ${b.reportCounts.admission}）`);
  L.push("");

  // 0. 结论速览
  L.push("## 结论速览", "");
  for (const line of synthesize(cmp)) L.push(`- ${line}`);
  L.push("");
  L.push("> 依据两个对象在报告中心已有的评测报告聚合对比。成功率类指标按 Wilson 置信区间是否重叠做保守判定：区间重叠 → 不下「A 优于 B」。延迟为重尾分布、样本有限，仅作参考。", "");

  // 1. 可用性与通过率
  L.push("## 1. 可用性与通过率", "");
  L.push("| 指标 | A | B | 判定 |", "|---|---:|---:|---|");
  L.push(`| 稳定性成功率 | ${stabCell(a)} | ${stabCell(b)} | ${cmp.verdicts.stability.verdict} |`);
  L.push(`| 场景通过率 | ${passCell(a)} | ${passCell(b)} | ${cmp.verdicts.scenarioPass.verdict} |`);
  L.push("");
  const pp = cmp.pairedPass;
  L.push(`- 配对通过率检验（McNemar，同名场景 n=${cmp.scenarioQuality.matched.length}）：不一致对 b(A过/B不过)=${pp.b}、c(A不过/B过)=${pp.c}，${pp.method === "none" ? "无不一致对→无法判定" : `p=${fmtP(pp.pValue)} → ${pp.pValue < 0.05 ? "**差异显著**" : "差异不显著（不一致对太少，功效不足）"}`}`);
  L.push("> 同名场景为配对样本，通过率头对头用 McNemar（只看两边结果不一致的场景），比独立置信区间是否重叠更有功效（Miller 2024）。");
  const ea = errSummary(a);
  const eb = errSummary(b);
  if (ea || eb) L.push(`- 稳定性错误分布：A ${ea || "无"} · B ${eb || "无"}`);
  L.push("");

  // 2. 延迟
  L.push("## 2. 延迟（稳定性轮次，重尾/样本有限，仅供参考）", "");
  L.push("| 指标 | A | B | A−B |", "|---|---:|---:|---:|");
  for (const [label, key] of [["平均总耗时", "avgTotalMs"], ["平均首包", "avgFirstByteMs"], ["P50 总耗时", "p50TotalMs"], ["慢请求 P95", "p95TotalMs"], ["尾部 P99", "p99TotalMs"]]) {
    const va = a.stability?.[key];
    const vb = b.stability?.[key];
    L.push(`| ${label} | ${fmt(va, " ms")} | ${fmt(vb, " ms")} | ${signed(diff(va, vb), " ms")} |`);
  }
  L.push("");
  const lat = cmp.latency;
  L.push(`- 成功轮次延迟样本量：A n=${lat.aN} · B n=${lat.bN}`);
  if (lat.median.point != null) L.push(`- 中位总耗时差 A−B = ${sgn(lat.median.point, " ms")}，bootstrap 95% CI ${fmtCI([lat.median.lower, lat.median.upper], " ms")}（A 中位 ${fmt(lat.median.statA, " ms")} / B 中位 ${fmt(lat.median.statB, " ms")}）→ ${ciExcludesZero([lat.median.lower, lat.median.upper]) ? "**中位延迟差异显著**" : "中位延迟差异不显著（CI 含 0）"}`);
  if (lat.p95.point != null) L.push(`- P95 总耗时差 A−B = ${sgn(lat.p95.point, " ms")}，bootstrap 95% CI ${fmtCI([lat.p95.lower, lat.p95.upper], " ms")}`);
  L.push("> 延迟重尾，用中位/尾部而非均值；两组独立、用两样本 bootstrap 百分位 CI（种子固定，可复现）。");
  L.push("");

  // 3. 准入分项与身份纯度
  L.push("## 3. 准入分项与身份纯度", "");
  if (a.admission || b.admission) {
    L.push("| 指标 | A | B |", "|---|---:|---:|");
    L.push(`| 准入等级 | ${a.admission?.grade ?? "-"} | ${b.admission?.grade ?? "-"} |`);
    L.push(`| 综合分 | ${fmt(a.admission?.composite)} | ${fmt(b.admission?.composite)} |`);
    L.push(`| 纯度分 | ${fmt(a.admission?.purityScore)} | ${fmt(b.admission?.purityScore)} |`);
    L.push(`| 分词器 slope（应≈1） | ${fmt(a.admission?.tokenizerSlope)} | ${fmt(b.admission?.tokenizerSlope)} |`);
    L.push(`| 分词器 R² | ${fmt(a.admission?.tokenizerR2)} | ${fmt(b.admission?.tokenizerR2)} |`);
    L.push(`| 标称/自述家族 | ${escapeCell(famCell(a.admission))} | ${escapeCell(famCell(b.admission))} |`);
    L.push(`| 横向指纹对照 | ${escapeCell(a.admission?.crossChannelMismatch ? "⚠️ 与同模型其它渠道显著不同" : a.admission?.crossChannelText || "-")} | ${escapeCell(b.admission?.crossChannelMismatch ? "⚠️ 与同模型其它渠道显著不同" : b.admission?.crossChannelText || "-")} |`);
    // 分项通过/失败
    const items = [...new Set([...(a.admission ? Object.keys(a.admission.items) : []), ...(b.admission ? Object.keys(b.admission.items) : [])])];
    if (items.length) {
      L.push("");
      L.push("准入分项结果：", "");
      L.push("| 分项 | A | B |", "|---|---|---|");
      for (const it of items) L.push(`| ${escapeCell(it)} | ${a.admission?.items?.[it] ?? "-"} | ${b.admission?.items?.[it] ?? "-"} |`);
    }
    L.push("");
    for (const subj of [a, b]) {
      if (subj.admission?.crossChannelMismatch) L.push(`- ⚠️ ${subj.label}：疑似非标称模型——该渠道与同模型其它渠道指纹显著不同（需上游解释）。`);
    }
    L.push("> 分词器 slope 明显偏离 1（且 R² 不高）= 疑似非标称家族/换代；均为黑盒概率判断，仅作「疑似」信号。", "");
  } else {
    L.push("> 两个对象都没有准入报告，跳过身份/纯度对比。", "");
  }
  L.push("");

  // 4. 按难度档位拆解
  L.push("## 4. 按难度档位拆解", "");
  L.push("| 档位 | A 通过率 | A 均分 | B 通过率 | B 均分 | 均分差(A−B) |", "|---|---:|---:|---:|---:|---:|");
  for (const r of cmp.tierRows) {
    const qa = r.a?.quality;
    const qb = r.b?.quality;
    L.push(`| ${r.tier} | ${r.a ? pct(r.a.passRate) : "-"} | ${fmt(qa)} | ${r.b ? pct(r.b.passRate) : "-"} | ${fmt(qb)} | ${signed(diff(qa, qb))} |`);
  }
  L.push("");
  const errNote = (subj) => subj.tiers.filter((t) => t.errored > 0).map((t) => `${t.tier}(${t.errored})`).join("、");
  const ena = errNote(a);
  const enb = errNote(b);
  if (ena || enb) L.push(`- 含错误型失败（限流/超时，属可用性问题、非能力低分）的档位：A: ${ena || "无"} · B: ${enb || "无"}`);
  L.push("> HardcoreLogic / HLE / LiveBench 属抗污染/专家难档。判断档位降级须先剔除限流/超时的错误轮：仅当双方都成功作答、某方在难档质量分仍系统性更低时，才是降级信号（详见结论速览）。", "");

  // 5. 逐场景诊断
  L.push("## 5. 逐场景诊断（配对场景，含失败原因）", "");
  L.push(`- 总体平均质量分：A ${fmt(a.quality.mean)}（${a.quality.n} 个场景） · B ${fmt(b.quality.mean)}（${b.quality.n} 个场景） · A−B ${signed(diff(a.quality.mean, b.quality.mean))}`);
  const pq = cmp.pairedQuality;
  if (pq.n >= 1) {
    L.push(`- **配对差值分析**（同名场景 n=${pq.n}，Miller 2024 配对法；比独立均值差更有功效）：`);
    L.push(`  - 质量分平均差 A−B = ${sgn(pq.meanDiff)}${pq.ci ? `，95% CI ${fmtCI(pq.ci)}` : "（样本不足，无 CI）"} → ${pq.ci ? (ciExcludesZero(pq.ci) ? "**差异显著（CI 不含 0）**" : "**未达显著（CI 含 0）**") : "样本不足"}`);
    if (pq.corr != null) L.push(`  - 配对相关 r=${r2(pq.corr)}（正相关时配对法可降低方差）；Wilcoxon 符号秩 p=${fmtP(pq.pWilcoxon)}；配对 t p=${fmtP(pq.pT)}`);
    L.push(`  - 效果量 Cliff's δ=${pq.cliff.delta != null ? r2(pq.cliff.delta) : "-"}（${pq.cliff.magnitude}，阈值 0.15/0.33/0.47=小/中/大）；胜/平/负（A 视角）= ${pq.win}/${pq.tie}/${pq.loss}，符号检验 p=${fmtP(pq.signP)}`);
  }
  L.push("");
  if (cmp.scenarioQuality.matched.length) {
    L.push("| 场景 | 档位 | A 质量 | B 质量 | A−B | A 问题 | B 问题 |", "|---|---|---:|---:|---:|---|---|");
    for (const m of cmp.scenarioQuality.matched) {
      L.push(`| ${escapeCell(m.name)} | ${escapeCell(m.tier)} | ${fmt(m.a.quality)} | ${fmt(m.b.quality)} | ${signed(m.delta)} | ${escapeCell(shortText(m.a.issue) || "—")} | ${escapeCell(shortText(m.b.issue) || "—")} |`);
    }
    L.push("");
    const big = cmp.scenarioQuality.matched.filter((m) => Number.isFinite(m.delta) && Math.abs(m.delta) >= 40);
    if (big.length) {
      L.push("差距显著的场景（|Δ|≥40，值得人工复核原始回答）：");
      for (const m of big) {
        const winner = m.delta > 0 ? a.label : b.label;
        const loser = m.delta > 0 ? b.label : a.label;
        const loserIssue = m.delta > 0 ? m.b.issue : m.a.issue;
        L.push(`- **${escapeCell(m.name)}**：${winner} ${fmt(Math.abs(m.delta))} 分优于 ${loser}；落后方问题：${escapeCell(shortText(loserIssue, 60) || "未记录")}。`);
      }
      L.push("");
    }
  } else {
    L.push("> 两个对象没有测过相同名称的场景，无法逐场景配对对比。", "");
  }
  if (cmp.scenarioQuality.onlyA.length) L.push(`- 仅 A 测过：${cmp.scenarioQuality.onlyA.map(escapeCell).join("、")}`);
  if (cmp.scenarioQuality.onlyB.length) L.push(`- 仅 B 测过：${cmp.scenarioQuality.onlyB.map(escapeCell).join("、")}`);
  L.push("");

  // 6. 总结
  L.push("## 6. 总结", "");
  for (const line of overallConclusions(cmp)) L.push(`- ${line}`);
  L.push("");

  if (aiNarrative && String(aiNarrative).trim()) {
    L.push("## AI 叙述分析", "");
    L.push(String(aiNarrative).trim(), "");
    L.push("> 以上由「设置」里配置的 AI 总结模型基于本报告的结构化数据生成，仅供参考，不覆盖上面的统计判定。", "");
  }

  L.push("## 方法学与免责", "");
  L.push("- 同名场景为**配对样本**：质量分用配对差值 + 95% CI（Miller 2024《Adding Error Bars to Evals》），通过率头对头用 **McNemar**（只看结果不一致的场景），比「两条独立置信区间是否重叠」更有功效。");
  L.push("- 效果量用 **Cliff's δ**（非参数；阈值 0.147/0.33/0.474 = 小/中/大）+ 胜平负符号检验，回答「差多少」而不只是「差不差」。");
  L.push("- 单对象成功率仍给 Wilson 置信区间；延迟重尾，用中位/P95 的两样本 bootstrap 百分位 CI（种子固定、可复现），不用均值。");
  L.push("- 显著性判据：差值的 95% CI 是否含 0（含 0 = 未达显著）。小样本功效不足时明确标注，不据此下优劣定论。");
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

// 结论速览：把可用性、档位质量、风险信号、延迟综合成几条「有观点」的话。
function synthesize(cmp) {
  const { a, b } = cmp;
  const out = [];
  const sv = cmp.verdicts.stability;
  const pv = cmp.verdicts.scenarioPass;
  out.push(`可用性：稳定性成功率 A ${stabCell(a)} vs B ${stabCell(b)} → ${sv.significant ? `**${sv.verdict}**` : "差异不显著（样本小，暂不下定论）"}；场景通过率判定 ${pv.significant ? `**${pv.verdict}**` : "差异不显著"}。`);

  // 难档能力对比（HardcoreLogic/HLE/LiveBench）——用配对同名难档场景，并区分「错误型失败」与「能力型低分」。
  // 因超时/限流得 0 分是可用性问题，不等于档位降级；故 apples-to-apples 只比双方都成功作答的难档场景。
  const hard = new Set(["HardcoreLogic 逻辑谜题", "HLE 专家难题", "LiveBench 抗污染"]);
  const hardMatched = cmp.scenarioQuality.matched.filter((m) => hard.has(m.tier) && Number.isFinite(m.a.quality) && Number.isFinite(m.b.quality));
  const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
  if (hardMatched.length) {
    const rawA = mean(hardMatched.map((m) => m.a.quality));
    const rawB = mean(hardMatched.map((m) => m.b.quality));
    const answered = hardMatched.filter((m) => !m.a.errored && !m.b.errored);
    const ansA = mean(answered.map((m) => m.a.quality));
    const ansB = mean(answered.map((m) => m.b.quality));
    const rawGap = rawA != null && rawB != null ? rawA - rawB : null;
    const ansGap = ansA != null && ansB != null ? ansA - ansB : null;
    const errDrivenBy = hardMatched.filter((m) => (m.a.errored && !m.b.errored) || (m.b.errored && !m.a.errored));
    if (rawGap != null && Math.abs(rawGap) >= 5 && ansGap != null && Math.abs(ansGap) < 5) {
      const who = errDrivenBy.map((m) => (m.a.errored ? a.label : b.label));
      out.push(`难档能力：原始难档均分看似有差距（A ${round(rawA)} / B ${round(rawB)}），但主要由 ${errDrivenBy.length} 个限流/超时轮次拉低（${[...new Set(who)].join("、")}）；只比双方都成功作答的难档场景时两者接近（A ${round(ansA)} / B ${round(ansB)}）——属**可用性**问题而非档位降级。`);
    } else if (ansGap != null && Math.abs(ansGap) >= 5) {
      out.push(`难档能力：在双方都成功作答的难档场景，${ansGap > 0 ? a.label : b.label} 仍明显更高（A ${round(ansA)} / B ${round(ansB)}），**存在档位降级嫌疑**，建议人工复核难档原始回答。`);
    } else {
      out.push(`难档能力（抗污染/专家题）：两者接近（作答场景均分 A ${round(ansA ?? rawA)} / B ${round(ansB ?? rawB)}）。`);
    }
  }

  // 配对质量结论（具体量化，非笼统）。
  const pq = cmp.pairedQuality;
  if (pq && pq.n >= 2 && pq.ci) {
    const sig = ciExcludesZero(pq.ci);
    const better = pq.meanDiff > 0 ? a.label : b.label;
    out.push(`质量分（配对 n=${pq.n}）：${sig ? `**${better} 显著更高**` : "**两者无显著差异**"}，A−B=${sgn(pq.meanDiff)} 分（95% CI ${fmtCI(pq.ci)}），效果量 Cliff's δ=${r2(pq.cliff.delta)}（${pq.cliff.magnitude}），胜/平/负=${pq.win}/${pq.tie}/${pq.loss}${sig ? "" : "；样本少、功效不足，暂不下优劣定论"}。`);
  }

  // 风险信号汇总。
  for (const subj of [a, b]) {
    const risks = [];
    if (subj.integrity.baselineRegressed) risks.push("稳定性相比基线明显退化");
    if (subj.admission?.crossChannelMismatch) risks.push("指纹与同模型其它渠道不一致");
    const err = errSummary(subj);
    if (err) risks.push(`稳定性错误 ${err}`);
    if (risks.length) out.push(`⚠️ ${subj.label} 风险：${risks.join("；")}。`);
  }

  // 延迟。
  const pa = a.stability?.p95TotalMs;
  const pb = b.stability?.p95TotalMs;
  if (Number.isFinite(pa) && Number.isFinite(pb) && Math.abs(pa - pb) >= 1) out.push(`延迟：P95 ${pa < pb ? a.label : b.label} 更快（${round(Math.min(pa, pb))} ms vs ${round(Math.max(pa, pb))} ms，重尾/样本有限，仅参考）。`);
  return out;
}

function overallConclusions(cmp) {
  const out = [];
  const { a, b } = cmp;
  const sv = cmp.verdicts.stability;
  const pv = cmp.verdicts.scenarioPass;
  out.push(`稳定性成功率：${sv.significant ? `**${sv.verdict}**（Wilson CI 不重叠，差异显著）` : `${sv.verdict}（CI 重叠或样本不足，不下优劣结论）`}`);
  out.push(`场景通过率：${pv.significant ? `**${pv.verdict}**（差异显著）` : `${pv.verdict}（不显著或样本不足）`}`);
  const pq = cmp.pairedQuality;
  if (pq && pq.n >= 2 && pq.ci) {
    out.push(`质量分（配对差值）：A−B=${sgn(pq.meanDiff)}，95% CI ${fmtCI(pq.ci)}，${ciExcludesZero(pq.ci) ? "**显著**" : "未达显著"}；Cliff's δ=${r2(pq.cliff.delta)}（${pq.cliff.magnitude}）`);
  } else {
    const qd = diff(a.quality.mean, b.quality.mean);
    if (qd != null) out.push(`平均质量分：A−B ${signed(qd)}（配对样本不足，仅描述性）`);
  }
  const ld = diff(a.stability?.p95TotalMs, b.stability?.p95TotalMs);
  if (ld != null && Math.abs(ld) >= 1) out.push(`P95 延迟：${ld < 0 ? a.label : b.label} 更快（差 ${signed(Math.abs(ld), " ms")}，仅参考）`);
  for (const subj of [a, b]) {
    const adm = subj.admission;
    if (adm && Number.isFinite(adm.tokenizerSlope) && Math.abs(adm.tokenizerSlope - 1) > 0.5) out.push(`⚠️ ${subj.label}：分词器 slope=${round(adm.tokenizerSlope)} 明显偏离 1，疑似非标称家族/换代（需上游解释）。`);
  }
  return out;
}

// —— 可选 AI 叙述：把结构化对比拼成一段中文提示词（纯函数，供端点喂给已配置的 AI 总结模型）——
export function buildCompareAnalysisPrompt(cmp) {
  const { a, b } = cmp;
  const facts = [];
  facts.push(`A(所用模型)=${a.label}；B(要对比的模型)=${b.label}`);
  facts.push(`稳定性成功率：A ${stabCell(a)}，B ${stabCell(b)}；场景通过率：A ${passCell(a)}，B ${passCell(b)}（McNemar p=${fmtP(cmp.pairedPass.pValue)}）`);
  facts.push(
    "按难度档位(通过率/均分)：" +
      cmp.tierRows.map((r) => `${r.tier}: A ${r.a ? pct(r.a.passRate) : "-"}/${fmt(r.a?.quality)}，B ${r.b ? pct(r.b.passRate) : "-"}/${fmt(r.b?.quality)}`).join("；"),
  );
  const pq = cmp.pairedQuality;
  if (pq.n) facts.push(`配对质量差 A−B=${sgn(pq.meanDiff)}（95%CI ${pq.ci ? fmtCI(pq.ci) : "样本不足"}），Cliff's δ=${pq.cliff.delta != null ? r2(pq.cliff.delta) : "-"}(${pq.cliff.magnitude})，胜/平/负=${pq.win}/${pq.tie}/${pq.loss}`);
  if (cmp.latency.median.point != null) facts.push(`中位延迟差 A−B=${sgn(cmp.latency.median.point, " ms")}（95%CI ${fmtCI([cmp.latency.median.lower, cmp.latency.median.upper], " ms")}）`);
  for (const s of [a, b]) {
    const risks = [];
    if (s.integrity.baselineRegressed) risks.push("稳定性退化");
    if (s.admission?.crossChannelMismatch) risks.push("指纹与同模型其它渠道不一致");
    const err = errSummary(s);
    if (err) risks.push(`稳定性错误 ${err}`);
    if (risks.length) facts.push(`${s.label} 风险：${risks.join("、")}`);
  }
  return [
    "你是资深 AI 评测分析师。下面是对两个模型（A=所用模型，B=要对比的模型）依据既有评测报告做的结构化对比（已含统计显著性判定）。",
    "请用中文写一段 150–300 字的对比叙述，要求：",
    "1) 分别就可用性、难档能力、延迟谁更好给出判断，但务必尊重显著性——置信区间含 0 或样本不足时不要断言优劣；",
    "2) 指出最值得关注的风险；3) 给出一句使用建议。",
    "不要编造数据中没有的数字，不要输出 Markdown 标题或表格，只写正文段落。",
    "",
    "对比数据：",
    ...facts.map((f) => `- ${f}`),
  ].join("\n");
}

export { wilsonInterval };
