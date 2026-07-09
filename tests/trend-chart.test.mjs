// tests/trend-chart.test.mjs
// 稳定性趋势图渲染（纯函数 → SVG 字符串）：
//   ① 耗时线只取成功轮、失败/超时轮改为底部标注、右轴由成功轮定标不被离群超时压平；
//   ② count 模式补时间刻度；⑤ 右轴上界取整数友好值。
import assert from "node:assert/strict";
import test from "node:test";
import { renderTrendChart } from "../src/trend-chart.js";

const at = (h, m = 0) => `2026-07-09T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
// 抽出指定 stroke 的 polyline 顶点数（用于判定耗时线连了几个点）。
const msLineVerts = (svg) => {
  const m = svg.match(/<polyline points="([^"]+)" fill="none" stroke="#5b9bd5"/);
  return m ? m[1].trim().split(/\s+/).length : 0;
};

test("① 耗时线只取成功轮：中间夹一个超时轮 → 线只连成功点，右轴不被 30s 超时压平", () => {
  const rounds = [
    { at: at(10, 0), ms: 1000, ok: 1, err: "", runRate: 0.75 },
    { at: at(10, 1), ms: 2000, ok: 1, err: "", runRate: 0.75 },
    { at: at(10, 2), ms: 30000, ok: 0, err: "timeout", runRate: 0.75 }, // 超时：不进线、不定标
    { at: at(10, 3), ms: 3000, ok: 1, err: "", runRate: 0.75 },
  ];
  const svg = renderTrendChart(rounds, "count");
  assert.equal(msLineVerts(svg), 3, "耗时线只连 3 个成功轮");
  // 右轴由成功轮最大(3000)定标 → niceCeil=3000；不应出现 30,000。
  assert.ok(svg.includes("3,000"), "右轴顶为成功轮定的 3,000");
  assert.ok(!svg.includes("30,000"), "超时的 30000 不参与定标");
});

test("① 失败/超时底部标注：超时=琥珀三角带「超时」，其它失败=红三角带「失败」", () => {
  const rounds = [
    { at: at(10, 0), ms: 1000, ok: 1, err: "", runRate: 0.5 },
    { at: at(10, 1), ms: 30000, ok: 0, err: "timeout", runRate: 0.5 },
    { at: at(10, 2), ms: 800, ok: 0, err: "upstream_5xx", runRate: 0.5 },
  ];
  const svg = renderTrendChart(rounds, "count");
  assert.match(svg, /fill="#f6b56b"><title>[^<]*超时/u, "超时 → 琥珀三角 + 超时 tooltip");
  assert.match(svg, /fill="#ff8a8a"><title>[^<]*失败/u, "其它失败 → 红三角 + 失败 tooltip");
});

test("⑤ 右轴整数化：成功轮最大 3776 → 顶标签 4,000（而非 3776）", () => {
  const rounds = [
    { at: at(9, 0), ms: 1200, ok: 1, err: "", runRate: 1 },
    { at: at(9, 1), ms: 3776, ok: 1, err: "", runRate: 1 },
  ];
  const svg = renderTrendChart(rounds, "count");
  assert.ok(svg.includes("4,000"), "上界向上取整到 4,000");
  assert.ok(!svg.includes("3776"), "不出现原始 3776");
});

test("② count 模式补时间刻度：x 轴出现 MM-DD HH:MM 文本", () => {
  const rounds = Array.from({ length: 5 }, (_, i) => ({ at: at(10, i), ms: 1000 + i * 100, ok: 1, err: "", runRate: 1 }));
  const svg = renderTrendChart(rounds, "count");
  // x 轴标签行 y=208（H-12）；改前 count 模式此处完全没有文本。
  assert.match(svg, /<text x="[\d.]+" y="208"[^>]*>\d{2}-\d{2} \d{2}:\d{2}<\/text>/, "count 模式有时间刻度");
});

test("x 轴时间刻度不挤成一团：同分钟去重、同日只显示一次日期；图例不贴顶被裁", () => {
  // 30 轮跨约 2 分钟：改前会渲染 6 个几乎相同的「MM-DD HH:00」挤在一起。
  const b0 = Date.parse("2026-07-09T10:00:00Z");
  const rounds = Array.from({ length: 30 }, (_, i) => ({ at: new Date(b0 + i * 4000).toISOString(), ms: 2000 + (i % 5) * 300, ok: 1, err: "", runRate: 1 }));
  const svg = renderTrendChart(rounds, "count");
  const labels = [...svg.matchAll(/<text x="[\d.]+" y="208"[^>]*>([^<]+)<\/text>/g)].map((m) => m[1]);
  // 去重后应明显变少（不再是 6 个），且相邻文本不重复。
  assert.ok(labels.length <= 4 && labels.length >= 1, `刻度应稀释到 ≤4 个，实际 ${labels.length}: ${labels.join(" | ")}`);
  assert.equal(new Set(labels).size, labels.length, "刻度文本不应出现重复");
  // 日期只在第一个刻度出现一次，其余是纯 HH:MM。
  const withDate = labels.filter((t) => /\d{2}-\d{2}/.test(t));
  assert.equal(withDate.length, 1, "同一天日期只显示一次");
  assert.ok(/^\d{2}:\d{2}$/.test(labels[labels.length - 1]), "后续刻度为纯时间");
  // 图例整体位于顶部留白带内（y=10），不再贴 y=0/1 被容器裁切。
  assert.ok(!svg.includes('y="1"') && !svg.includes("M 228,0"), "图例不再贴顶(y=0/1)");
  assert.match(svg, /<rect x="44" y="10"/, "图例下移到 y=10 的留白带");
});

test("hour 模式：桶内耗时只用成功轮平均，超时计入底部标注", () => {
  const rounds = [
    { at: at(10, 5), ms: 1000, ok: 1, err: "", runRate: 0.66 },
    { at: at(10, 20), ms: 3000, ok: 1, err: "", runRate: 0.66 }, // 同一小时 → 成功均值 2000
    { at: at(10, 40), ms: 30000, ok: 0, err: "timeout", runRate: 0.66 },
  ];
  const svg = renderTrendChart(rounds, "hour");
  assert.equal(msLineVerts(svg), 1, "单个小时桶 → 1 个成功均值点");
  assert.ok(svg.includes("2,000"), "右轴由成功均值 2000 定标");
  assert.match(svg, /fill="#f6b56b"><title>[^<]*超时/u, "超时计入底部标注");
});

test("时间范围：按时间模式下 windowHours 只保留最近 N 小时（以最新一轮为锚）", () => {
  // 跨 30 小时的数据：+0h、+5h、+25h、+29h 各一个成功轮（用基准时刻偏移，避免 ISO 小时越界）。
  const base = Date.parse("2026-07-09T00:00:00Z");
  const atH = (h) => new Date(base + h * 3600000).toISOString();
  const rounds = [
    { at: atH(0), ms: 1000, ok: 1, err: "", runRate: 1 },
    { at: atH(5), ms: 2000, ok: 1, err: "", runRate: 1 },
    { at: atH(25), ms: 3000, ok: 1, err: "", runRate: 1 },
    { at: atH(29), ms: 4000, ok: 1, err: "", runRate: 1 },
  ];
  const verts = (svg) => (svg.match(/stroke="#5b9bd5"/) ? svg.match(/<polyline points="([^"]+)" fill="none" stroke="#5b9bd5"/)[1].trim().split(/\s+/).length : 0);
  // 全部：4 个小时桶。
  assert.equal(verts(renderTrendChart(rounds, "hour", { windowHours: 0 })), 4, "全部 → 4 桶");
  // 最近 6 小时（锚=29h → 保留 ≥23h 的：25h、29h 两轮）。
  assert.equal(verts(renderTrendChart(rounds, "hour", { windowHours: 6 })), 2, "最近 6h → 2 桶");
  // 最近 3 小时（保留 ≥26h：仅 29h 一轮）。
  assert.equal(verts(renderTrendChart(rounds, "hour", { windowHours: 3 })), 1, "最近 3h → 1 桶");
  // count 模式忽略 windowHours（仍按次数全量）。
  assert.equal(verts(renderTrendChart(rounds, "count", { windowHours: 3 })), 4, "count 模式不受时间范围影响");
  // 窗口过窄导致空 → 专门文案。
  const empty = renderTrendChart([{ at: at(0), ms: 1000, ok: 1, err: "", runRate: 1 }], "hour", { windowHours: 3 });
  assert.ok(empty.includes("<svg") || empty.includes("暂无"), "极端窗口下不报错");
});

test("边界：0 点占位；1 点可渲染；全失败无耗时线但有失败标注与右轴刻度", () => {
  assert.equal(renderTrendChart([], "count"), "暂无历史数据。");
  const one = renderTrendChart([{ at: at(10), ms: 1000, ok: 1, err: "", runRate: 1 }], "count");
  assert.match(one, /<svg/, "单点仍渲染 SVG");

  const allFail = renderTrendChart(
    [
      { at: at(10, 0), ms: 30000, ok: 0, err: "timeout", runRate: 0 },
      { at: at(10, 1), ms: 800, ok: 0, err: "network_error", runRate: 0 },
    ],
    "count",
  );
  assert.ok(!allFail.includes('stroke="#5b9bd5"'), "全失败 → 无耗时线");
  assert.match(allFail, /fill="#f6b56b"><title>[^<]*超时/u, "全失败仍标注超时");
  assert.match(allFail, /y="[\d.]+"[^>]*text-anchor="start">[\d,]+<\/text>/, "右轴仍有数字刻度");
});
