// uptime-strip.mjs —— 按天聚合的可用性 → 竖条带 SVG。无 DOM 依赖的纯函数。
//
// 模式来自状态页（Atlassian Statuspage / Better Stack / Instatus）：一排细竖条，一条一天。
// 它补上了大趋势图的盲区——大图是「最近 200 轮」，条带是「最近 90 天」，
// 后者才是运营者真想问的「这个渠道这个月靠不靠得住」。
//
// 关键约束（本项目特有，与通用状态页不同）：
// 状态页的服务是 7×24 被探测的，每天必有数据。而我们的测试是**人/定时任务触发**的，
// 完全可能某天根本没测。所以必须有第三态「无数据」——把「没测」画成绿色是撒谎，
// 画成红色是诬告。三态：好 / 降级 / 无数据。
import { escapeHtml } from "./escape.mjs";

/**
 * @param {Array<{date:string, successRate:number|null, rounds?:number}>} days
 *        时间升序，一天一项。successRate 为 null 或 rounds=0 → 无数据态。
 * @param {object} [opts]
 * @param {number} [opts.height=34]
 * @param {number} [opts.barWidth=4]
 * @param {number} [opts.gap=2]
 * @param {number} [opts.goodAt=0.99] ≥ 此值算「好」
 * @param {number} [opts.warnAt=0.95] ≥ 此值算「降级」，低于则「故障」
 * @param {object} [opts.colors]
 * @returns {string} SVG 字符串
 */
export function renderUptimeStrip(days, opts = {}) {
  const {
    height = 34,
    barWidth = 4,
    gap = 2,
    goodAt = 0.99,
    warnAt = 0.95,
    colors = { good: "#5fe3b0", warn: "#f6b56b", bad: "#ff7a8a", empty: "rgba(255,255,255,0.09)" },
  } = opts;

  const src = Array.isArray(days) ? days : [];
  if (!src.length) {
    return `<svg class="ustrip" viewBox="0 0 100 ${height}" width="100%" height="${height}" role="img" aria-label="暂无可用性历史"></svg>`;
  }

  const step = barWidth + gap;
  const width = src.length * step - gap;

  const bars = src
    .map((d, i) => {
      const noData = !Number.isFinite(d?.successRate) || d?.rounds === 0;
      const rate = d?.successRate;
      const fillColor = noData ? colors.empty : rate >= goodAt ? colors.good : rate >= warnAt ? colors.warn : colors.bad;
      // 无数据态刻意画成**矮条**（40% 高）而非全高浅色：形状上就与有数据的日子区分开，
      // 不必依赖颜色分辨——色弱用户也能看出来。
      const h = noData ? Math.round(height * 0.4) : height;
      const yPos = noData ? Math.round((height - h) / 2) : 0;
      const tip = noData
        ? `${d?.date || ""} · 未测`
        : `${d?.date || ""} · 成功率 ${(rate * 100).toFixed(1)}%${Number.isFinite(d?.rounds) ? ` · ${d.rounds} 轮` : ""}`;
      return `<rect x="${i * step}" y="${yPos}" width="${barWidth}" height="${h}" rx="1" fill="${fillColor}"><title>${escapeHtml(tip)}</title></rect>`;
    })
    .join("");

  const summary = summarizeUptime(src, { goodAt, warnAt });
  const label = `最近 ${src.length} 天可用性：${summary.goodDays} 天正常、${summary.warnDays} 天降级、${summary.badDays} 天故障、${summary.emptyDays} 天未测`;

  // preserveAspectRatio="none" 让条带随容器宽度伸展，条数不变——90 条在窄屏也不会溢出。
  return `<svg class="ustrip" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${escapeHtml(label)}" preserveAspectRatio="none">${bars}</svg>`;
}

/** 条带的文字摘要。与 renderUptimeStrip 用同一套阈值，避免图文口径分叉。 */
export function summarizeUptime(days, { goodAt = 0.99, warnAt = 0.95 } = {}) {
  const src = Array.isArray(days) ? days : [];
  let goodDays = 0;
  let warnDays = 0;
  let badDays = 0;
  let emptyDays = 0;
  let succ = 0;
  let total = 0;
  for (const d of src) {
    if (!Number.isFinite(d?.successRate) || d?.rounds === 0) {
      emptyDays += 1;
      continue;
    }
    if (d.successRate >= goodAt) goodDays += 1;
    else if (d.successRate >= warnAt) warnDays += 1;
    else badDays += 1;
    if (Number.isFinite(d.rounds)) {
      succ += d.successRate * d.rounds;
      total += d.rounds;
    }
  }
  const testedDays = goodDays + warnDays + badDays;
  return {
    goodDays,
    warnDays,
    badDays,
    emptyDays,
    testedDays,
    // 加权总成功率：按轮数加权，不是按天平均——测 1 轮的一天不该和测 50 轮的一天等权。
    overallRate: total > 0 ? succ / total : null,
    coverage: src.length ? testedDays / src.length : 0,
  };
}
