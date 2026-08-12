// tests/model-profile.test.mjs
// 「模型档案」页的纯函数：server/model-profile.mjs（按天可用性 / 指标历史 / 浏览器契约）
// + shared/sparkline.mjs + shared/uptime-strip.mjs。
//
// 这三个模块是本功能唯一有真实逻辑的部分（端点本身只是把它们串起来），也是无浏览器环境下
// 唯一能自动验证的部分，故边界覆盖得细一些。
import assert from "node:assert/strict";
import test from "node:test";
import { buildMetricHistories, buildModelProfileView, buildUptimeDays } from "../server/model-profile.mjs";
import { renderSparkline } from "../shared/sparkline.mjs";
import { renderUptimeStrip, summarizeUptime } from "../shared/uptime-strip.mjs";
import { toTrendPoint } from "../server/regression.mjs";

// 固定「现在」：用真实时钟会让跨日运行时的用例随机飘。
const NOW = Date.parse("2026-08-12T10:00:00+08:00");
const DAY = 86_400_000;
const at = (offsetDays, hour = 9) => new Date(NOW - offsetDays * DAY).toISOString().replace(/T\d\d/, `T${String(hour).padStart(2, "0")}`);

// —— buildUptimeDays ——

test("buildUptimeDays：窗口内每一天都出现，没测的天为 rounds:0（不能悄悄缩短时间轴）", () => {
  const days = buildUptimeDays([{ at: at(2), type: "stability", successRate: 1 }], { days: 5, now: NOW });
  assert.equal(days.length, 5, "长度必须恒为 days");
  assert.equal(days.filter((d) => d.rounds === 0).length, 4);
  const tested = days.filter((d) => d.rounds > 0);
  assert.equal(tested.length, 1);
  assert.equal(tested[0].successRate, 1);
});

test("buildUptimeDays：同一天多次运行取平均，并记下运行数", () => {
  const days = buildUptimeDays(
    [
      { at: at(1, 3), type: "stability", successRate: 1 },
      { at: at(1, 15), type: "stability", successRate: 0.8 },
    ],
    { days: 3, now: NOW },
  );
  const day = days.find((d) => d.rounds > 0);
  assert.equal(day.rounds, 2);
  assert.ok(Math.abs(day.successRate - 0.9) < 1e-9, `实际 ${day.successRate}`);
});

test("buildUptimeDays：时间升序，末位是今天", () => {
  const days = buildUptimeDays([], { days: 4, now: NOW });
  const dates = days.map((d) => d.date);
  assert.deepEqual(dates, [...dates].sort(), "必须时间升序");
  const today = new Date(NOW);
  const p2 = (x) => String(x).padStart(2, "0");
  assert.equal(dates[dates.length - 1], `${today.getFullYear()}-${p2(today.getMonth() + 1)}-${p2(today.getDate())}`);
});

test("buildUptimeDays：窗口外与未来时间的点都丢掉（脏数据/时钟回拨不该把条带撑歪）", () => {
  const days = buildUptimeDays(
    [
      { at: at(200), type: "stability", successRate: 1 }, // 远早于窗口
      { at: new Date(NOW + 5 * DAY).toISOString(), type: "stability", successRate: 1 }, // 未来
      { at: at(1), type: "stability", successRate: 0.5 }, // 窗口内
    ],
    { days: 7, now: NOW },
  );
  assert.equal(days.filter((d) => d.rounds > 0).length, 1);
});

test("buildUptimeDays：没有成功率的点不计入（null 不是 0）", () => {
  const days = buildUptimeDays([{ at: at(1), type: "scenario", successRate: null }], { days: 3, now: NOW });
  assert.equal(
    days.every((d) => d.rounds === 0),
    true,
    "successRate 为 null 的点不该被当成一次有效测试",
  );
});

test("buildUptimeDays：非数组 / 空输入不抛异常", () => {
  assert.equal(buildUptimeDays(null, { days: 3, now: NOW }).length, 3);
  assert.equal(buildUptimeDays(undefined, { days: 3, now: NOW }).filter((d) => d.rounds > 0).length, 0);
});

// —— buildMetricHistories ——

test("buildMetricHistories：按类型切分——稳定性/场景/准入各走各的序列", () => {
  const series = [
    toTrendPoint({ runId: "a", type: "stability", endedAt: at(3), successRate: 0.9, p95TotalMs: 8000 }),
    toTrendPoint({ runId: "b", type: "quick-verify", endedAt: at(2), successRate: 1, p95TotalMs: 5000 }),
    toTrendPoint({ runId: "c", type: "scenario", endedAt: at(2), successRate: 0.7 }),
    toTrendPoint({ runId: "d", type: "admission", endedAt: at(1), successRate: 1, p95TotalMs: 4000, score: 82 }),
  ];
  const h = buildMetricHistories(series);
  // quick-verify 与 admission 也算「非场景」，都进稳定性成功率曲线（与 buildProfileTrend 同口径）
  assert.deepEqual(h["stability-rate"].values, [0.9, 1, 1]);
  assert.deepEqual(h["scenario-pass"].values, [0.7]);
  assert.deepEqual(h["admission-score"].values, [82]);
});

test("buildMetricHistories：空序列 → 全部为 null 且带原因（前端据此画占位而非空图）", () => {
  const h = buildMetricHistories([]);
  for (const [id, entry] of Object.entries(h)) {
    assert.equal(entry.values, null, `${id} 应为 null`);
    assert.ok(entry.reason && entry.reason.length > 0, `${id} 缺少 reason`);
  }
});

test("buildMetricHistories：质量分与首 Token 永远为 null——toTrendPoint 不产出这两个字段", () => {
  // 这是刻意的能力边界，不是 bug。若哪天 toTrendPoint 补了字段，本用例应当失败，提醒同步更新。
  const point = toTrendPoint({ type: "scenario", endedAt: at(1), successRate: 1, avgQualityScore: 88, p50FirstTokenMs: 700 });
  assert.equal("avgQualityScore" in point, false, "toTrendPoint 若已产出质量分，请同步补上历史曲线");
  assert.equal(
    Object.keys(point).some((k) => /first|ttft/i.test(k)),
    false,
    "toTrendPoint 若已产出首 Token，请同步补上历史曲线",
  );

  const h = buildMetricHistories([point]);
  assert.equal(h.quality.values, null);
  assert.equal(h["first-token"].values, null);
});

test("buildMetricHistories：花费为累计单调递增；无金额时为 null（不是 0）", () => {
  const withCost = buildMetricHistories([
    toTrendPoint({ type: "stability", endedAt: at(2), successRate: 1, actualConsumption: { estimatedCost: 0.1 } }),
    toTrendPoint({ type: "stability", endedAt: at(1), successRate: 1, actualConsumption: { estimatedCost: 0.25 } }),
  ]);
  assert.deepEqual(withCost.spend.values, [0.1, 0.35]);

  const noCost = buildMetricHistories([toTrendPoint({ type: "stability", endedAt: at(1), successRate: 1 })]);
  assert.equal(noCost.spend.values, null, "未配置单价时应为 null，不能报成 0 元");
});

test("buildMetricHistories：P95 全为空时该曲线为 null，不产生 [null,null]", () => {
  const h = buildMetricHistories([toTrendPoint({ type: "stability", endedAt: at(1), successRate: 1 })]);
  assert.equal(h["p95-latency"].values, null);
});

// —— buildModelProfileView ——

const emptyTrend = { series: [], rounds: [], regression: null };

test("buildModelProfileView：硬门槛按报告里的【中文测试项名】归一成 json/tool/stream 三态", () => {
  // 键是中文名，因为 aggregateSubject().admission.items 来自 markdown「## 4. 分项结果」表格。
  // 中文名出处：server/test-runner.mjs 的用例定义。已用真实报告核对过这五个名字。
  const view = buildModelProfileView({
    agg: {
      admission: {
        grade: "B",
        composite: 78.6,
        items: { 连通与模型响应: "通过", 结构化输出: "通过", 工具调用结构: "未通过" },
      },
    },
    trend: emptyTrend,
    target: { id: "t1" },
  });
  assert.equal(view.admission.hardGates.json, true, "结构化输出 → json");
  assert.equal(view.admission.hardGates.tool, false, "工具调用结构 → tool");
  assert.equal(view.admission.hardGates.stream, null, "缺项必须是 null（本次没测），不能算失败");
});

test("buildModelProfileView：「未通过」不得被 /通过/ 误判成通过", () => {
  const view = buildModelProfileView({
    agg: { admission: { items: { 流式响应结构: "未通过" } } },
    trend: emptyTrend,
    target: {},
  });
  assert.equal(view.admission.hardGates.stream, false);
});

test("buildModelProfileView：没有准入报告时 admission 为 null，整体不崩", () => {
  const view = buildModelProfileView({ agg: {}, trend: emptyTrend, target: {} });
  assert.equal(view.admission, null);
  assert.equal(view.stability, null);
  assert.deepEqual(view.scenarios, []);
  assert.equal(view.uptime.length, 90);
});

test("buildModelProfileView：agg 整体缺失也不抛（端点可能拿不到任何报告）", () => {
  const view = buildModelProfileView({ agg: null, trend: null, target: {} });
  assert.equal(view.target.label, "未知对象");
  assert.deepEqual(view.reportCounts, { run: 0, scenario: 0, admission: 0, load: 0, total: 0 });
  assert.deepEqual(view.trend.rounds, []);
  assert.deepEqual(view.alerts, []);
});

test("buildModelProfileView：压测拐点算出「有效 QPS」= QPS × 成功率", () => {
  const view = buildModelProfileView({
    agg: { loadPoints: [{ mode: "open", offered: 30, qps: 10, successRate: 1, http429: 0 }] },
    trend: emptyTrend,
    target: {},
  });
  assert.equal(view.loadKnee.goodput, 10);
  assert.equal(view.loadKnee.concurrency, 30);
});

test("buildModelProfileView：首个压测点就不健康 → 无拐点（不能假装有容量）", () => {
  const view = buildModelProfileView({
    agg: { loadPoints: [{ mode: "open", offered: 10, qps: 5, successRate: 0.5, http429: 3 }] },
    trend: emptyTrend,
    target: {},
  });
  assert.equal(view.loadKnee, null);
});

test("buildModelProfileView：首 Token 取各场景 P50 的中位数，无流式样本时为 null", () => {
  const view = buildModelProfileView({
    agg: {
      scenarios: [
        { name: "a", p50FirstTokenMs: 500 },
        { name: "b", p50FirstTokenMs: 900 },
        { name: "c", p50FirstTokenMs: 700 },
      ],
    },
    trend: emptyTrend,
    target: {},
  });
  assert.equal(view.firstToken.p50Ms, 700);
  assert.equal(view.firstToken.scenarioCount, 3);

  const none = buildModelProfileView({ agg: { scenarios: [{ name: "a", p50FirstTokenMs: null }] }, trend: emptyTrend, target: {} });
  assert.equal(none.firstToken.p50Ms, null);
  assert.equal(none.firstToken.scenarioCount, 0);
});

test("buildModelProfileView：逐场景只透出页面用得到的字段（不把原始样本数组发给浏览器）", () => {
  const view = buildModelProfileView({
    agg: {
      scenarios: [
        { name: "s1", tier: "困难", quality: 80, rate: 0.9, avgMs: 3000, firstTokenSamples: [1, 2, 3], sampleResponse: "很长的回答……" },
      ],
    },
    trend: emptyTrend,
    target: {},
  });
  const keys = Object.keys(view.scenarios[0]);
  assert.equal(keys.includes("firstTokenSamples"), false, "原始样本数组不该发给浏览器");
  assert.equal(keys.includes("sampleResponse"), false, "样例回答全文不该发给浏览器");
  assert.equal(view.scenarios[0].name, "s1");
});

test("buildModelProfileView：报告收集的限流口径要带给前端（否则用户会把池化值当全部历史）", () => {
  const view = buildModelProfileView({ agg: {}, trend: emptyTrend, target: {} });
  assert.equal(view.coverage.runReportLimit, 6);
  assert.equal(view.coverage.scenarioFileLimit, 60);
});

test("buildModelProfileView：label 优先用 agg.label，缺失时回退渠道/模型", () => {
  assert.equal(buildModelProfileView({ agg: { label: "甲 / 乙" }, trend: emptyTrend, target: {} }).target.label, "甲 / 乙");
  assert.equal(buildModelProfileView({ agg: {}, trend: emptyTrend, target: { channel: "丙", model: "丁" } }).target.label, "丙 / 丁");
});

// —— shared/sparkline.mjs ——

test("sparkline：空数据画占位虚线，而不是一条平线（「无历史」≠「历史是平的」）", () => {
  const svg = renderSparkline([]);
  assert.match(svg, /spark-empty/);
  assert.match(svg, /stroke-dasharray/);
  assert.doesNotMatch(svg, /polyline/);
  assert.match(renderSparkline([null, null]), /spark-empty/);
  assert.match(renderSparkline(null), /spark-empty/);
});

test("sparkline：单点画圆点、全同值走中线且不产生 NaN", () => {
  assert.match(renderSparkline([5]), /<circle/);
  assert.doesNotMatch(renderSparkline([5]), /<polyline/);
  const flat = renderSparkline([7, 7, 7]);
  assert.doesNotMatch(flat, /NaN/);
  assert.match(flat, /<polyline/);
});

test("sparkline：缺口处断线，不跨缺口凭空连直线", () => {
  const svg = renderSparkline([1, 2, null, 8, 9]);
  assert.equal((svg.match(/<polyline/g) || []).length, 2);
});

test("sparkline：异常点着红、无异常时不出现红色", () => {
  assert.match(renderSparkline([1, 2, 99, 3], { anomaly: (v) => v > 50 }), /#ff7a8a/);
  assert.doesNotMatch(renderSparkline([1, 2, 3], { anomaly: (v) => v > 50 }), /#ff7a8a/);
});

test("sparkline：aria-label 被转义", () => {
  const svg = renderSparkline([1, 2], { ariaLabel: '<img src=x onerror="alert(1)">' });
  assert.doesNotMatch(svg, /<img/);
  assert.match(svg, /&lt;img/);
});

// —— shared/uptime-strip.mjs ——

test("uptime-strip：三态各自着色，且「未测」画成矮条（形状区分，不只靠颜色）", () => {
  const svg = renderUptimeStrip(
    [
      { date: "2026-06-01", successRate: 1, rounds: 10 },
      { date: "2026-06-02", successRate: 0.97, rounds: 10 },
      { date: "2026-06-03", successRate: 0.5, rounds: 10 },
      { date: "2026-06-04", successRate: null, rounds: 0 },
    ],
    { height: 30 },
  );
  assert.match(svg, /#5fe3b0/);
  assert.match(svg, /#f6b56b/);
  assert.match(svg, /#ff7a8a/);
  // 未测：矮条 + 垂直居中
  assert.match(svg, /height="12"/);
  assert.match(svg, /未测/);
});

test("uptime-strip：rounds=0 即视为无数据，即便 successRate 有值", () => {
  const svg = renderUptimeStrip([{ date: "d", successRate: 1, rounds: 0 }]);
  assert.match(svg, /rgba\(255,255,255,0\.09\)/);
});

test("summarizeUptime：总成功率按运行数加权，不是按天平均", () => {
  const s = summarizeUptime([
    { date: "d1", successRate: 1, rounds: 100 },
    { date: "d2", successRate: 0, rounds: 10 },
  ]);
  assert.ok(Math.abs(s.overallRate - 100 / 110) < 1e-9, `实际 ${s.overallRate}`);
});

test("summarizeUptime：全未测时 overallRate 为 null —— 「没测」不能报成 0% 成功率", () => {
  const s = summarizeUptime([{ date: "d", successRate: null, rounds: 0 }]);
  assert.equal(s.overallRate, null);
  assert.equal(s.emptyDays, 1);
  assert.equal(s.coverage, 0);
});

test("summarizeUptime：分档计数与覆盖率", () => {
  const s = summarizeUptime([
    { date: "1", successRate: 1, rounds: 5 },
    { date: "2", successRate: 0.97, rounds: 5 },
    { date: "3", successRate: 0.5, rounds: 5 },
    { date: "4", successRate: null, rounds: 0 },
  ]);
  assert.deepEqual(
    { good: s.goodDays, warn: s.warnDays, bad: s.badDays, empty: s.emptyDays, tested: s.testedDays },
    { good: 1, warn: 1, bad: 1, empty: 1, tested: 3 },
  );
  assert.equal(s.coverage, 0.75);
});

test("uptime-strip：date 被转义；非数组入参不抛", () => {
  assert.doesNotMatch(renderUptimeStrip([{ date: "<script>x</script>", successRate: 1, rounds: 1 }]), /<script>/);
  assert.match(renderUptimeStrip(null), /<svg/);
  assert.equal(summarizeUptime(null).emptyDays, 0);
});
