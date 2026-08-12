// sparkline.mjs —— 数字数组 → 内联 SVG 字符串。无 DOM 依赖的纯函数。
//
// 放成独立纯函数（而不是写在某个 demo 里）照的是 shared/trend-chart.mjs 的先例：
// 便于单测、也便于后端将来在报告里内联同样的图形。
//
// Tufte 对 sparkline 的定义是「word-sized graphics」——词大小、能放在任何放得下一个数字的地方。
// 所以默认尺寸刻意做得小（100×22），且**不画坐标轴、不画网格、不画图例**：
// 一切非数据像素都是噪音。他明确给的技法是「用单个彩点标出关键值（当前值/异常）」，
// 这里实现为 markLast + anomaly 两个开关。
import { escapeHtml } from "./escape.mjs";

// 归一化到 [0,1]。全同值时返回中线（0.5）——否则 (v-min)/(max-min) 会是 0/0。
function normalize(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (!nums.length) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min;
  return { min, max, span, at: (v) => (span === 0 ? 0.5 : (v - min) / span) };
}

/**
 * @param {Array<number|null>} values 时间升序的数值序列；null/非有限值视为缺口（断线）
 * @param {object} [opts]
 * @param {number} [opts.width=100]
 * @param {number} [opts.height=22]
 * @param {string} [opts.color="currentColor"] 线色；默认继承文字色，便于随语义色变化
 * @param {boolean} [opts.markLast=true] 是否在末点画一个圆点（Tufte 的「当前值」标记）
 * @param {string} [opts.lastColor] 末点颜色，默认同 color
 * @param {(v:number, i:number)=>boolean} [opts.anomaly] 判定某点是否异常；异常点额外标红
 * @param {string} [opts.anomalyColor="#ff7a8a"]
 * @param {boolean} [opts.fill=false] 是否在线下填充极淡的面积（提升小尺寸下的可读性）
 * @param {string} [opts.ariaLabel]
 * @returns {string} SVG 字符串；无有效数据时返回一条极淡的占位横线
 */
export function renderSparkline(values, opts = {}) {
  const {
    width = 100,
    height = 22,
    color = "currentColor",
    markLast = true,
    lastColor,
    anomaly,
    anomalyColor = "#ff7a8a",
    fill = false,
    ariaLabel,
  } = opts;

  const src = Array.isArray(values) ? values : [];
  const norm = normalize(src);
  const pad = 3; // 上下留 3px，否则末点圆会被 viewBox 切掉
  const innerH = height - pad * 2;

  // 无数据 → 一条占位虚线，明确表达「这个指标没有历史」而不是「历史是平的」。
  // 这两件事在评测工具里差别很大，不能画成同一个样子。
  if (!norm) {
    return `<svg class="spark spark-empty" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeHtml(ariaLabel || "暂无历史数据")}"><line x1="0" y1="${(height / 2).toFixed(1)}" x2="${width}" y2="${(height / 2).toFixed(1)}" stroke="currentColor" stroke-width="1" stroke-dasharray="2 3" opacity="0.28"/></svg>`;
  }

  const n = src.length;
  const x = (i) => (n === 1 ? width / 2 : (i / (n - 1)) * width);
  const y = (v) => pad + innerH * (1 - norm.at(v));

  // 分段：遇到缺口就断线，不跨缺口连直线（那会凭空发明数据）。
  const segments = [];
  let cur = [];
  src.forEach((v, i) => {
    if (Number.isFinite(v)) cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    else if (cur.length) {
      segments.push(cur);
      cur = [];
    }
  });
  if (cur.length) segments.push(cur);

  const lines = segments
    .map((pts) =>
      pts.length === 1
        ? `<circle cx="${pts[0].split(",")[0]}" cy="${pts[0].split(",")[1]}" r="1.4" fill="${color}"/>`
        : `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join("");

  // 面积填充：只对最长的一段做，避免多段各自填充出奇怪的形状。
  let area = "";
  if (fill && segments.length) {
    const longest = segments.reduce((a, b) => (b.length > a.length ? b : a));
    if (longest.length > 1) {
      const first = longest[0].split(",")[0];
      const last = longest[longest.length - 1].split(",")[0];
      area = `<polygon points="${first},${height - pad} ${longest.join(" ")} ${last},${height - pad}" fill="${color}" opacity="0.1"/>`;
    }
  }

  // 异常点标记
  let anomalyDots = "";
  if (typeof anomaly === "function") {
    anomalyDots = src
      .map((v, i) =>
        Number.isFinite(v) && anomaly(v, i)
          ? `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="1.9" fill="${anomalyColor}"/>`
          : "",
      )
      .join("");
  }

  // 末点（当前值）
  let lastDot = "";
  if (markLast) {
    for (let i = src.length - 1; i >= 0; i -= 1) {
      if (Number.isFinite(src[i])) {
        lastDot = `<circle cx="${x(i).toFixed(1)}" cy="${y(src[i]).toFixed(1)}" r="2.1" fill="${lastColor || color}"/>`;
        break;
      }
    }
  }

  const label = ariaLabel || `趋势，${n} 个点，最小 ${norm.min}，最大 ${norm.max}`;
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeHtml(label)}" preserveAspectRatio="none">${area}${lines}${anomalyDots}${lastDot}</svg>`;
}
