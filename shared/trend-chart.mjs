// shared/trend-chart.mjs
// 稳定性趋势图（无 DOM 依赖，纯数据 → SVG 字符串，便于单测）。前后端共用：前端在「稳定性趋势」页渲染，
// 后端在「自动测试巡检报告」里内联。放在 shared/（而非 src/）是刻意的——后端不应 import 前端源目录，
// 否则生产镜像不打包 src/ 会启动崩溃（见「14-0.5.7升级失败说明-镜像未打包src」）。
// 成功率(左轴 %) + 耗时(右轴 ms) 双轴同图：
//   · 耗时线只取【成功轮】——失败/超时轮不进线、不抬高右轴（否则一次超时把整条线压平）。
//   · 失败/超时轮改在底部以小三角标注（超时=琥珀、其它失败=红），保留「何时失败、什么失败」。
//   · 右轴上界取整数友好值（nice number），刻度形如 0 / 2,000 / 4,000。
//   · xMode='count'：每轮 1 点（密），成功率取所属运行成功率（逐运行阶梯），x 轴补稀疏时间刻度。
//   · xMode='hour'：按小时聚合，每小时 1 点（成功率=该小时通过率，耗时=该小时【成功轮】平均）。
import { escapeHtml } from "./escape.mjs";

// 右轴上界取「整数友好值」：按首位数字向上取整（3776→4000、1888→2000、45→50）。
function niceCeil(v) {
  if (!(v > 0)) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  return Math.ceil(v / base) * base;
}

// 非成功轮归类：超时(normalized_error==="timeout") vs 其它失败。
const failKind = (err) => (err === "timeout" ? "timeout" : "error");

// options.windowHours>0 时（仅按时间模式）：只看最近 N 小时的趋势——以数据里最新一轮的时刻为锚
// （而非当前墙钟，数据陈旧时也不会整片空白），保留 [maxAt−N 小时, maxAt] 内的轮次。
export function renderTrendChart(rounds, xMode, { windowHours = 0 } = {}) {
  let src = rounds || [];
  if (xMode === "hour" && windowHours > 0) {
    const times = src.map((r) => Date.parse(r?.at)).filter(Number.isFinite);
    if (times.length) {
      const minT = Math.max(...times) - windowHours * 3600000;
      src = src.filter((r) => {
        const t = Date.parse(r?.at);
        return Number.isFinite(t) && t >= minT;
      });
    }
  }
  const all = src.filter((r) => r && Number.isFinite(r.ms));
  if (all.length < 1) return xMode === "hour" && windowHours > 0 ? "所选时间范围内暂无数据。" : "暂无历史数据。";

  const W = 680;
  const H = 220;
  const pad = { l: 44, r: 54, t: 28, b: 40 }; // 顶部留出图例带（原来图例贴边被裁）
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

  let points; // [{ rate(0..1|null), ms(成功时的耗时或桶内成功均值|null), ok?, err?, frac, at, n?, timeoutN?, failN? }]
  let xTicks = []; // [{ frac, ms }]（ms=该刻度时刻，渲染时按需省略重复日期）
  let fails = []; // 失败/超时标注 [{ frac, kind:'timeout'|'error', at, n }]
  if (xMode === "hour") {
    const buckets = new Map();
    for (const r of all) {
      const t = Date.parse(r.at);
      if (!Number.isFinite(t)) continue;
      const hourMs = Math.floor(t / 3600000) * 3600000;
      let b = buckets.get(hourMs);
      if (!b) {
        b = { hourMs, ok: 0, n: 0, okN: 0, sumMsOk: 0, timeoutN: 0, failN: 0 };
        buckets.set(hourMs, b);
      }
      b.n += 1;
      if (r.ok) {
        b.ok += 1;
        b.okN += 1;
        b.sumMsOk += r.ms; // 只累加成功轮耗时
      } else if (failKind(r.err) === "timeout") b.timeoutN += 1;
      else b.failN += 1;
    }
    const arr = [...buckets.values()].sort((a, b) => a.hourMs - b.hourMs);
    if (!arr.length) return "暂无历史数据。";
    const t0 = arr[0].hourMs;
    const span = arr[arr.length - 1].hourMs - t0 || 1;
    points = arr.map((b) => ({
      rate: b.n ? b.ok / b.n : null,
      ms: b.okN ? b.sumMsOk / b.okN : null, // 桶内成功轮平均；全失败桶为 null（不画线）
      frac: (b.hourMs - t0) / span,
      at: new Date(b.hourMs).toISOString(),
      n: b.n,
      timeoutN: b.timeoutN,
      failN: b.failN,
    }));
    for (const p of points) {
      if (p.timeoutN > 0) fails.push({ frac: p.frac, kind: "timeout", at: p.at, n: p.timeoutN });
      if (p.failN > 0) fails.push({ frac: p.frac, kind: "error", at: p.at, n: p.failN });
    }
    const k = Math.min(6, arr.length);
    xTicks = Array.from({ length: k }, (_, i) => {
      const idx = k === 1 ? 0 : Math.round((i * (arr.length - 1)) / (k - 1));
      return { frac: (arr[idx].hourMs - t0) / span, ms: arr[idx].hourMs };
    });
  } else {
    const n = all.length;
    points = all.map((r, i) => ({
      rate: r.runRate != null ? r.runRate : null,
      ms: r.ms,
      ok: Boolean(r.ok),
      err: r.err || "",
      frac: n === 1 ? 0.5 : i / (n - 1),
      at: r.at,
    }));
    // 失败/超时轮：每个非成功轮一枚底部标注。
    fails = points.filter((p) => !p.ok).map((p) => ({ frac: p.frac, kind: failKind(p.err), at: p.at, n: 1 }));
    // x 轴稀疏时间刻度（count 模式此前完全没有）。
    const k = Math.min(6, n);
    xTicks = Array.from({ length: k }, (_, i) => {
      const idx = k === 1 ? 0 : Math.round((i * (n - 1)) / (k - 1));
      return { frac: n === 1 ? 0.5 : idx / (n - 1), ms: Date.parse(points[idx].at) };
    });
  }

  // 耗时线只连成功点：count=ok且有耗时；hour=成功均值非空的桶。
  const msPts = xMode === "hour" ? points.filter((p) => p.ms != null) : points.filter((p) => p.ok && Number.isFinite(p.ms));
  // 右轴上界由【成功轮】耗时决定（①核心）；无任何成功轮则回退到全体耗时，保证轴仍有刻度。
  const successMs = msPts.map((p) => p.ms);
  const scaleBase = successMs.length ? Math.max(...successMs) : Math.max(...points.map((p) => p.ms).filter(Number.isFinite), 1);
  const maxMs = niceCeil(scaleBase);

  const px = (frac) => pad.l + innerW * frac;
  const pyRate = (rate) => pad.t + innerH * (1 - rate);
  const pyMs = (ms) => pad.t + innerH * (1 - ms / maxMs);
  const baselineY = pyRate(0);

  const gridRate = [0, 0.5, 1]
    .map(
      (v) =>
        `<line x1="${pad.l}" y1="${pyRate(v).toFixed(1)}" x2="${W - pad.r}" y2="${pyRate(v).toFixed(1)}" stroke="#25334a"/>` +
        `<text x="${pad.l - 6}" y="${(pyRate(v) + 4).toFixed(1)}" fill="#91a0b7" font-size="11" text-anchor="end">${v * 100}%</text>` +
        `<text x="${W - pad.r + 6}" y="${(pyRate(v) + 4).toFixed(1)}" fill="#6aa0e0" font-size="11" text-anchor="start">${Math.round(maxMs * v).toLocaleString("en-US")}</text>`,
    )
    .join("");
  // x 轴时间刻度：① 像素间距过近的丢弃；② 同一天的相邻刻度省略重复日期（只留 HH:MM）；
  // ③ 文本完全相同的丢弃——避免多个「07-09 18:00」挤成一团、难以看清。
  const MIN_TICK_GAP = 56; // viewBox 单位；标签约 30–62 宽，56 间距足够不叠
  const p2 = (x) => String(x).padStart(2, "0");
  const tickDay = (ms) => new Date(ms).toDateString();
  const tickDate = (ms) => `${p2(new Date(ms).getMonth() + 1)}-${p2(new Date(ms).getDate())}`;
  const tickTime = (ms) => (xMode === "hour" ? `${p2(new Date(ms).getHours())}:00` : `${p2(new Date(ms).getHours())}:${p2(new Date(ms).getMinutes())}`);
  let lastX = -Infinity;
  let lastText = null;
  let lastDay = null;
  const xticks = xTicks
    .filter((t) => Number.isFinite(t.ms))
    .map((t) => {
      const x = px(t.frac);
      if (lastText != null && x - lastX < MIN_TICK_GAP) return ""; // 太近
      const day = tickDay(t.ms);
      const text = (day === lastDay ? "" : `${tickDate(t.ms)} `) + tickTime(t.ms);
      if (text === lastText) return ""; // 与上一个保留刻度完全相同
      lastX = x;
      lastText = text;
      lastDay = day;
      return `<text x="${x.toFixed(1)}" y="${H - 12}" fill="#91a0b7" font-size="10" text-anchor="middle">${escapeHtml(text)}</text>`;
    })
    .join("");

  const msLine = msPts.length
    ? `<polyline points="${msPts.map((p) => `${px(p.frac).toFixed(1)},${pyMs(p.ms).toFixed(1)}`).join(" ")}" fill="none" stroke="#5b9bd5" stroke-width="1.6" opacity="0.9"/>`
    : "";
  const ratePts = points.filter((p) => p.rate != null);
  const rateLine = ratePts.length
    ? `<polyline points="${ratePts.map((p) => `${px(p.frac).toFixed(1)},${pyRate(p.rate).toFixed(1)}`).join(" ")}" fill="none" stroke="#f6b56b" stroke-width="2"/>`
    : "";
  // 圆点：hour 模式每桶一个；count 模式仅在成功率变化处（运行边界）画，避免逐轮堆叠。
  let prevRate = null;
  const rateDots = ratePts
    .map((p, i) => {
      const boundary = xMode === "hour" || i === 0 || p.rate !== prevRate;
      prevRate = p.rate;
      if (!boundary) return "";
      const color = p.rate >= 0.95 ? "#7bd88f" : p.rate >= 0.8 ? "#f6b56b" : "#ff8a8a";
      const tip = `${String(p.at || "").replace("T", " ").slice(0, 16)} · 成功率 ${Math.round(p.rate * 100)}% · 耗时 ${p.ms != null ? Math.round(p.ms) + "ms" : "—"}${p.n ? ` · ${p.n} 轮` : ""}`;
      return `<circle cx="${px(p.frac).toFixed(1)}" cy="${pyRate(p.rate).toFixed(1)}" r="3" fill="${color}"><title>${escapeHtml(tip)}</title></circle>`;
    })
    .join("");

  // 失败/超时底部标注：0% 线下方的小三角，超时=琥珀、其它失败=红；原生 title 悬浮说明。
  const failMarks = fails
    .map((f) => {
      const color = f.kind === "timeout" ? "#f6b56b" : "#ff8a8a";
      const x = px(f.frac);
      const tip = `${String(f.at || "").replace("T", " ").slice(0, 16)} · ${f.kind === "timeout" ? "超时" : "失败"}${f.n > 1 ? ` ×${f.n}` : ""}`;
      return `<path d="M ${x.toFixed(1)},${(baselineY + 4).toFixed(1)} l -3,6 l 6,0 z" fill="${color}"><title>${escapeHtml(tip)}</title></path>`;
    })
    .join("");

  // 图例整体下移到顶部留白带内（原来贴 y=0 被容器裁掉一截）。
  const legY = 10;
  const tri = (x, c) => `<path d="M ${x + 4},${legY} l -4,6 l 8,0 z" fill="${c}"/>`;
  const legend =
    `<g font-size="11">` +
    `<rect x="${pad.l}" y="${legY}" width="12" height="3" fill="#f6b56b"/><text x="${pad.l + 16}" y="${legY + 5}" fill="#91a0b7">成功率(左)</text>` +
    `<rect x="${pad.l + 84}" y="${legY}" width="12" height="3" fill="#5b9bd5"/><text x="${pad.l + 100}" y="${legY + 5}" fill="#91a0b7">耗时ms(右)</text>` +
    `${tri(pad.l + 180, "#f6b56b")}<text x="${pad.l + 192}" y="${legY + 5}" fill="#91a0b7">超时</text>` +
    `${tri(pad.l + 230, "#ff8a8a")}<text x="${pad.l + 242}" y="${legY + 5}" fill="#91a0b7">失败</text>` +
    `</g>`;

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="成功率与耗时趋势">${gridRate}${xticks}${msLine}${rateLine}${rateDots}${failMarks}${legend}</svg>`;
}
