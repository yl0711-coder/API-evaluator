// src/trend-export.js
// 稳定性趋势页的 CSV 导出（纯函数、无 DOM，便于单测）。刻意导出**两份**表——
// 两者的分析粒度不同，硬塞进一张表会得到一堆空列：
//   ① 历次运行（series，每次运行一行）：成功率 / P95 / 等级 / 成本，看跨时间的趋势与掉级；
//   ② 逐轮请求（rounds，每个请求一行）：耗时 / 成败 / 错误类型，看延迟分布与失败时刻。
// 两份表用「运行ID」列关联（rounds 的运行ID 就是 series 里那个），可在 Excel / pandas 里 join。
//
// 格式取舍（因为是给数据分析用，不是给人读的）：
//   · 不放表头之上的说明行——那会让 read_csv / Power Query 直接解析失败。渠道与模型改成每行都带的列，
//     于是多个模型各导一份后可以直接首尾相接成一张大表，行仍可区分。
//   · 数值列输出**原始数值**（成功率是 0-1 的小数，不是 "80.0%" 字符串），不必再在分析侧反解析。
//   · 时间给两列：ISO8601（机读、可排序、带时区）+ 本地时间（人读、核对用）。
import { formatDateTime, toCsvText } from "./client-utils.js";
import { formatTaskType } from "./formatters.js";

// 数值列：缺测输出空单元格（而非 0）。
// 注意 `Number(null) === 0`、`Number("") === 0` 都是有限数，只用 Number.isFinite 判不出「没这个值」，
// 会把「本次没报出成功率」写成 0——那是编造数据。故先挡掉 null / undefined / 空串。
function num(value, digits = 6) {
  if (value === null || value === undefined || value === "") return "";
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : "";
}

function text(value) {
  return value === null || value === undefined ? "" : String(value);
}

const SERIES_HEADER = [
  "渠道",
  "模型",
  "时间(ISO8601)",
  "时间(本地)",
  "运行类型",
  "运行类型(原始)",
  "运行ID",
  "成功率(0-1)",
  "P95耗时(ms)",
  "评分",
  "等级",
  "总Token",
  "成本(USD)",
];

const ROUNDS_HEADER = ["渠道", "模型", "时间(ISO8601)", "时间(本地)", "运行ID", "耗时(ms)", "成功(1/0)", "错误类型", "所属运行成功率(0-1)"];

// 历次运行 → CSV。时间升序（与后端 series 一致），便于直接画时序图。
export function buildTrendSeriesCsv(series, meta = {}) {
  const channel = text(meta.channelLabel);
  const model = text(meta.modelLabel);
  const rows = [SERIES_HEADER];
  for (const point of series || []) {
    if (!point) continue;
    rows.push([
      channel,
      model,
      text(point.at),
      formatDateTime(point.at),
      formatTaskType(point.type),
      text(point.type),
      text(point.runId),
      num(point.successRate),
      num(point.p95Ms, 3),
      num(point.score, 3),
      text(point.grade),
      num(point.totalTokens, 0),
      num(point.cost),
    ]);
  }
  return toCsvText(rows);
}

// 逐轮请求 → CSV。成功轮的「错误类型」为空；失败轮给归一化后的错误码（timeout / upstream_5xx …），
// 与趋势图底部标注同源，可直接按它分组统计失败构成。
export function buildTrendRoundsCsv(rounds, meta = {}) {
  const channel = text(meta.channelLabel);
  const model = text(meta.modelLabel);
  const rows = [ROUNDS_HEADER];
  for (const round of rounds || []) {
    if (!round) continue;
    rows.push([
      channel,
      model,
      text(round.at),
      formatDateTime(round.at),
      text(round.runId),
      num(round.ms, 3),
      round.ok ? 1 : 0,
      text(round.err),
      num(round.runRate),
    ]);
  }
  return toCsvText(rows);
}

// Windows / macOS 都不接受的文件名字符 → 下划线；空白折叠。空名回落到占位词，
// 避免生成 "稳定性趋势_历次运行___20260820.csv" 这种看不出是谁的文件。
function safeFileNamePart(value, fallback) {
  const cleaned = String(value ?? "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}

// 本地时间戳 YYYYMMDD-HHmm：同一天多次导出不互相覆盖。
function stamp(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

export function trendExportFilename(kind, meta = {}, now = new Date()) {
  const label = kind === "rounds" ? "逐轮请求" : "历次运行";
  const channel = safeFileNamePart(meta.channelLabel, "未知渠道");
  const model = safeFileNamePart(meta.modelLabel, "未知模型");
  return `稳定性趋势_${label}_${channel}_${model}_${stamp(now)}.csv`;
}
