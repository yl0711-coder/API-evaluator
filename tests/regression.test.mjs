import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  toTrendPoint,
  buildTrendSeries,
  buildBaseline,
  detectRegression,
  collectBasicScenarioCaseIds,
  hasComparableMetric,
  summarizeRoundStats,
  BASIC_SCENARIO_GROUP,
} from "../server/regression.mjs";

const run = (over = {}) => ({
  runId: "r" + Math.random().toString(36).slice(2, 8),
  type: "stability",
  endedAt: new Date().toISOString(),
  successRate: 0.98,
  p95TotalMs: 2000,
  grade: null,
  actualConsumption: { totalTokens: 1000, estimatedCost: 0.01 },
  ...over,
});

test("toTrendPoint / buildTrendSeries 提取关键量", () => {
  const p = toTrendPoint(run({ runId: "x", successRate: 0.9, p95TotalMs: 1500 }));
  assert.equal(p.successRate, 0.9);
  assert.equal(p.p95Ms, 1500);
  assert.equal(p.totalTokens, 1000);
  assert.equal(buildTrendSeries([run(), run()]).length, 2);
});

test("toTrendPoint：quick-verify 无 successRate 字段时按 successCount/requestCount 补出（追溯进趋势）", () => {
  // 既有快检汇总只有 successCount/requestCount、无 successRate → 应补出成功率，进趋势与回归。
  const p = toTrendPoint({ runId: "qv", type: "quick-verify", endedAt: new Date().toISOString(), successCount: 4, requestCount: 6 });
  assert.equal(p.successRate, 4 / 6);
  // 有显式 successRate 时以其为准（新版快检直接写了）。
  const p2 = toTrendPoint({
    runId: "qv2",
    type: "quick-verify",
    endedAt: new Date().toISOString(),
    successRate: 0.5,
    successCount: 4,
    requestCount: 6,
  });
  assert.equal(p2.successRate, 0.5);
  // 非 quick-verify 且无 successRate → 不臆造（保持 null，不污染趋势）。
  const p3 = toTrendPoint({ runId: "sc", type: "scenario", endedAt: new Date().toISOString(), successCount: 4, requestCount: 6 });
  assert.equal(p3.successRate, null);
  // requestCount=0 → null（不除零）。
  const p4 = toTrendPoint({ runId: "qv0", type: "quick-verify", endedAt: new Date().toISOString(), successCount: 0, requestCount: 0 });
  assert.equal(p4.successRate, null);
});

test("buildBaseline：<2 同类样本 → insufficient；否则取中位", () => {
  assert.equal(buildBaseline([toTrendPoint(run())], { type: "stability" }).insufficient, true);
  const base = buildBaseline(
    [toTrendPoint(run({ successRate: 0.98 })), toTrendPoint(run({ successRate: 0.96 })), toTrendPoint(run({ successRate: 0.97 }))],
    { type: "stability" },
  );
  assert.equal(base.insufficient, false);
  assert.equal(base.successRate, 0.97);
});

test("detectRegression：首次 → baseline", () => {
  const r = detectRegression({ current: toTrendPoint(run({ runId: "first" })), history: [] });
  assert.equal(r.status, "baseline");
});

test("detectRegression：与基线一致 → stable", () => {
  const history = [run({ successRate: 0.98 }), run({ successRate: 0.97 }), run({ successRate: 0.98 })].map(toTrendPoint);
  const r = detectRegression({ current: toTrendPoint(run({ runId: "cur", successRate: 0.97 })), history });
  assert.equal(r.status, "stable");
});

test("detectRegression：成功率明显下跌 → regressed", () => {
  const history = [run({ successRate: 0.98 }), run({ successRate: 0.97 }), run({ successRate: 0.98 })].map(toTrendPoint);
  const cur = toTrendPoint(run({ runId: "cur", successRate: 0.7 })); // 97% → 70%
  const r = detectRegression({ current: cur, history });
  assert.equal(r.status, "regressed");
  assert.ok(r.changes.some((c) => c.metric === "success_rate"));
  assert.equal(r.severity, "high");
});

test("detectRegression：P95 翻倍 → regressed", () => {
  const history = [run({ p95TotalMs: 2000 }), run({ p95TotalMs: 2200 }), run({ p95TotalMs: 1900 })].map(toTrendPoint);
  const r = detectRegression({ current: toTrendPoint(run({ runId: "cur", p95TotalMs: 5000 })), history });
  assert.equal(r.status, "regressed");
  assert.ok(r.changes.some((c) => c.metric === "p95"));
});

test("detectRegression：准入等级下滑 ≥2 档 → regressed", () => {
  const history = [
    run({ type: "admission", grade: "A", successRate: 0.99 }),
    run({ type: "admission", grade: "A", successRate: 0.99 }),
  ].map(toTrendPoint);
  const cur = toTrendPoint(run({ runId: "cur", type: "admission", grade: "D", successRate: 0.99 }));
  const r = detectRegression({ current: cur, history });
  assert.equal(r.status, "regressed");
  assert.ok(r.changes.some((c) => c.metric === "grade"));
});

test("collectBasicScenarioCaseIds：只挑场景运行、按分组过滤、混合分组只取基础、无基础不入表", () => {
  assert.equal(BASIC_SCENARIO_GROUP, "基础");
  const summaries = [
    // 纯基础场景运行 → 取两个基础 id
    {
      runId: "sc1",
      type: "scenario",
      scenarios: [
        { id: "b1", group: "基础" },
        { id: "b2", group: "基础" },
      ],
    },
    // 混合分组 → 只取基础 id，丢 HLE
    {
      runId: "sc2",
      type: "scenario",
      scenarios: [
        { id: "b3", group: "基础" },
        { id: "h1", group: "HLE" },
      ],
    },
    // 无基础场景 → 不入表
    { runId: "sc3", type: "scenario", scenarios: [{ id: "h2", group: "HLE" }] },
    // 非场景运行 → 忽略
    { runId: "st1", type: "stability", scenarios: [{ id: "b9", group: "基础" }] },
    // 无 scenarios / 无 runId → 忽略
    { runId: "sc4", type: "scenario" },
    { type: "scenario", scenarios: [{ id: "b8", group: "基础" }] },
  ];
  const map = collectBasicScenarioCaseIds(summaries);
  assert.deepEqual([...map.keys()].sort(), ["sc1", "sc2"]);
  assert.deepEqual([...map.get("sc1")].sort(), ["b1", "b2"]);
  assert.deepEqual([...map.get("sc2")], ["b3"], "混合分组只取基础，绝不含 HLE");
  assert.equal(map.has("sc3"), false, "无基础场景不入表");
  assert.equal(map.has("st1"), false, "非场景运行忽略");
  // 自定义分组名亦可
  const custom = collectBasicScenarioCaseIds([{ runId: "x", type: "scenario", scenarios: [{ id: "k", group: "自建" }] }], "自建");
  assert.deepEqual([...custom.get("x")], ["k"]);
  // 空输入健壮
  assert.equal(collectBasicScenarioCaseIds(undefined).size, 0);
});

test("summarizeRoundStats：成功率=成功轮/总轮、P95 取 0.95 分位、空集合 → null", () => {
  const rounds = [
    { totalMs: 100, success: 1 },
    { totalMs: 200, success: 1 },
    { totalMs: 300, success: 0 },
    { totalMs: 400, success: 1 },
    { totalMs: 5000, success: 0 }, // 慢且失败 → 抬高 P95
  ];
  const s = summarizeRoundStats(rounds);
  assert.equal(s.successRate, 3 / 5);
  assert.equal(s.p95Ms, 5000); // ceil(5*0.95)-1 = 4 → 排序后第 5 个 = 5000
  // 无耗时的轮被剔除（不参与成功率与 P95）
  const s2 = summarizeRoundStats([
    { totalMs: 100, success: 1 },
    { totalMs: null, success: 0 },
  ]);
  assert.equal(s2.successRate, 1);
  assert.equal(s2.p95Ms, 100);
  // 空集合 → null（既不进图也不污染回归）
  assert.deepEqual(summarizeRoundStats([]), { successRate: null, p95Ms: null });
  assert.deepEqual(summarizeRoundStats(undefined), { successRate: null, p95Ms: null });
});

test("regression_alerts 往返 + queryProfileRunSummaries", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "regression-test-"));
  process.env.EVALUATOR_DATA_DIR = dataDir;
  try {
    const db = await import(`../server/db.mjs?case=${Date.now()}`);
    if (!(await db.isSqliteAvailable())) return;
    await db.recordTestRun(
      {
        runId: "run-1",
        type: "stability",
        profileId: "p1",
        profileName: "渠道A",
        successRate: 0.98,
        successCount: 49,
        endedAt: new Date().toISOString(),
      },
      { type: "stability" },
    );
    await db.recordRegressionAlert({
      profileId: "p1",
      profileName: "渠道A",
      runId: "run-2",
      runType: "stability",
      severity: "high",
      summary: "成功率从 98% 跌到 70%",
      createdAt: new Date().toISOString(),
    });
    const summaries = await db.queryProfileRunSummaries("p1");
    assert.ok(summaries.length >= 1);
    assert.equal(summaries[0].runId, "run-1");
    const alerts = await db.queryRegressionAlerts({ profileId: "p1" });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].severity, "high");
  } finally {
    delete process.env.EVALUATOR_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});

// 让场景点进入 series 后暴露的一个既有隐患：detectRegression 原先按「changes 为空 → stable」推结论，
// 于是「一个指标都没报出来」与「所有指标都正常」得到同一个结论——把「无从判断」说成「未见退化」。
// 触发场景：场景运行只跑了非「基础」组，trend-service 无逐轮可回填 → 该点成功率/P95 皆 null。
test("detectRegression：本次无任何可比指标 → incomparable，绝不谎称 stable", () => {
  const prior = [
    toTrendPoint(run({ runId: "a", type: "scenario", successRate: 0.9, p95TotalMs: 1000 })),
    toTrendPoint(run({ runId: "b", type: "scenario", successRate: 0.9, p95TotalMs: 1000 })),
  ];
  // 成功率/P95/等级全缺（grade 显式为 null，run() 默认即 null）
  const naked = toTrendPoint({ runId: "c", type: "scenario", endedAt: new Date().toISOString() });
  assert.equal(naked.successRate, null);
  assert.equal(naked.p95Ms, null);
  const v = detectRegression({ current: naked, history: [...prior, naked] });
  assert.equal(v.status, "incomparable");
  assert.equal(v.severity, "none");
  assert.deepEqual(v.changes, []);
  assert.match(v.verdict, /未报出可比指标/);

  // 仍要能判出真实退化（新分支不能把正常判定吞掉）
  const dropped = toTrendPoint(run({ runId: "d", type: "scenario", successRate: 0.5, p95TotalMs: 1000 }));
  assert.equal(detectRegression({ current: dropped, history: [...prior, dropped] }).status, "regressed");
  // 只报出 P95（无成功率）也算可比
  const onlyP95 = toTrendPoint({ runId: "e", type: "scenario", p95TotalMs: 9000, endedAt: new Date().toISOString() });
  const v3 = detectRegression({ current: onlyP95, history: [...prior, onlyP95] });
  assert.equal(v3.status, "regressed");
  assert.deepEqual(
    v3.changes.map((c) => c.metric),
    ["p95"],
  );
});

// hasComparableMetric 的核心陷阱：不能用 Number.isFinite(Number(v)) 判「有没有报出来」，
// 因为 Number(null)===0、Number("")===0 都是有限值 —— 那样 null 会被当成「报出了 0」通过。
test("hasComparableMetric：null/undefined/'' 视为未报出；0 与 0% 是真实数值", () => {
  assert.equal(hasComparableMetric({ successRate: null, p95Ms: null, grade: null }), false);
  assert.equal(hasComparableMetric({}), false);
  assert.equal(hasComparableMetric(null), false);
  assert.equal(hasComparableMetric({ successRate: null, p95Ms: "", grade: "" }), false);
  // 成功率 0（全失败）是真实观测，必须可比 —— 这正是最该判退化的情形
  assert.equal(hasComparableMetric({ successRate: 0, p95Ms: null }), true);
  assert.equal(hasComparableMetric({ successRate: null, p95Ms: 0 }), true);
  assert.equal(hasComparableMetric({ successRate: null, p95Ms: null, grade: "F" }), true);
});

// 修复场景 profile_id 后的关键安全属性：历史里突然多出的 scenario 点不得改变 stability 的基线。
// buildBaseline 按 type 过滤，故两类各自成基线；否则老渠道会因"多出一批点"被误判退化。
test("场景点进入历史后不污染 stability 基线（基线按 type 隔离）", () => {
  const stabilityHistory = [
    run({ runId: "s1", type: "stability", successRate: 0.98, p95TotalMs: 2000 }),
    run({ runId: "s2", type: "stability", successRate: 0.97, p95TotalMs: 2100 }),
  ].map(toTrendPoint);
  const before = buildBaseline(stabilityHistory, { type: "stability" });

  // 混入两个成功率低得多的场景点（若不按 type 隔离，中位数会被拉低 → 后续 stability 判定失真）
  const withScenario = [
    ...stabilityHistory,
    toTrendPoint(run({ runId: "c1", type: "scenario", successRate: 0.6, p95TotalMs: 9000 })),
    toTrendPoint(run({ runId: "c2", type: "scenario", successRate: 0.55, p95TotalMs: 9500 })),
  ];
  const after = buildBaseline(withScenario, { type: "stability" });
  assert.deepEqual(after, before, "stability 基线不受新增场景点影响");

  // 且当前是 stability 运行时，判定仍走 stability 基线 → 不因场景点误报退化
  const verdict = detectRegression({
    current: toTrendPoint(run({ runId: "s3", type: "stability", successRate: 0.97, p95TotalMs: 2050 })),
    history: withScenario,
  });
  assert.equal(verdict.status, "stable");
  // 场景点自成基线（n=2），互不干扰
  assert.equal(buildBaseline(withScenario, { type: "scenario" }).n, 2);
});

// 回归护栏：场景运行必须带 profile_id 才能进「稳定性趋势」页。
// 历史缺陷（2026-08-12 发现）：buildScenarioSummary 是多模型聚合体、顶层无 profileId，
// runScenarioTest 写单模型报告时未补，导致 test_runs.profile_id 恒 NULL →
// queryProfileRunSummaries 的 WHERE profile_id=? 永远查不到场景运行 →
// buildProfileTrend 拿不到 scenario summary → 趋势页里从来没有场景数据。
test("场景运行带 profileId 时，buildProfileTrend 能取到场景点并回填基础场景成功率", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "trend-scenario-"));
  process.env.EVALUATOR_DATA_DIR = dataDir;
  try {
    const stamp = Date.now();
    const db = await import(`../server/db.mjs?case=${stamp}`);
    if (!(await db.isSqliteAvailable())) return;
    const { buildProfileTrend } = await import(`../server/trend-service.mjs?case=${stamp}`);

    // 一次场景运行：两个「基础」组场景 + 一个非基础场景（后者不该进趋势）。
    await db.recordTestRun(
      {
        runId: "scene-1",
        type: "scenario",
        profileId: "p1",
        profileName: "渠道A",
        startedAt: "2026-08-10T10:00:00Z",
        endedAt: "2026-08-10T10:05:00Z",
        scenarios: [
          { id: "basic-a", group: BASIC_SCENARIO_GROUP },
          { id: "basic-b", group: BASIC_SCENARIO_GROUP },
          { id: "other-c", group: "编程" },
        ],
      },
      { type: "scenario" },
    );
    // 逐轮明细：基础组 2 成 1 败（成功率 2/3），非基础组那轮必须被丢弃。
    const req = (over) => ({
      runId: "scene-1",
      profileId: "p1",
      totalMs: 1000,
      success: true,
      startedAt: "2026-08-10T10:01:00Z",
      ...over,
    });
    await db.recordRequest(req({ requestId: "q1", caseId: "basic-a", totalMs: 1000, success: true }));
    await db.recordRequest(req({ requestId: "q2", caseId: "basic-a", totalMs: 2000, success: true }));
    await db.recordRequest(req({ requestId: "q3", caseId: "basic-b", totalMs: 3000, success: false }));
    await db.recordRequest(req({ requestId: "q4", caseId: "other-c", totalMs: 9000, success: false }));

    const { series, rounds } = await buildProfileTrend("p1");
    const scenePt = series.find((p) => p.runId === "scene-1");
    assert.ok(scenePt, "场景运行必须出现在趋势 series 里（profile_id 已入库）");
    assert.equal(scenePt.type, "scenario");
    assert.equal(scenePt.successRate, 2 / 3, "成功率按「基础」组逐轮现算回填");
    // 逐轮只保留基础组的 3 轮，非基础组的 other-c 被丢弃。
    assert.equal(rounds.length, 3, "只有「基础」组轮次进图");
    assert.ok(!rounds.some((r) => r.ms === 9000), "非基础组轮次不进图");
  } finally {
    delete process.env.EVALUATOR_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});

// 场景点入库带出的第二个隐患：buildProfileTrend 原先无条件拿 series 末点当 current。
// 只跑非「基础」组的场景运行无逐轮可回填 → 该点无任何指标；它一旦成为末点，就会把该 profile
// 原本正常的 stability 判定挤掉（前端只在 regressed/stable 时显示横幅，其余静默隐藏）。
// 修法：取「最近一个报出可比指标的点」判定。无指标的运行不携带退化信息，跳过它才与入库前一致。
test("无指标的场景运行成为最新点时，不挤掉该 profile 原有的退化判定", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "trend-latest-"));
  process.env.EVALUATOR_DATA_DIR = dataDir;
  try {
    const stamp = `${Date.now()}-latest`;
    const db = await import(`../server/db.mjs?case=${stamp}`);
    if (!(await db.isSqliteAvailable())) return;
    const { buildProfileTrend } = await import(`../server/trend-service.mjs?case=${stamp}`);

    // 三次正常 stability（基线充足且一致）→ 应判 stable
    for (const [i, sr] of [
      [1, 0.98],
      [2, 0.97],
      [3, 0.97],
    ]) {
      await db.recordTestRun(
        {
          runId: `stab-${i}`,
          type: "stability",
          profileId: "p1",
          successRate: sr,
          startedAt: `2026-08-0${i}T10:00:00Z`,
          endedAt: `2026-08-0${i}T10:05:00Z`,
        },
        { type: "stability" },
      );
    }
    const before = await buildProfileTrend("p1");
    assert.equal(before.regression?.status, "stable", "前置条件：三次一致的 stability → stable");

    // 再来一次「只跑非基础组」的场景运行：无逐轮可回填 → 该点成功率/P95 皆 null，且时间最晚。
    await db.recordTestRun(
      {
        runId: "scene-nonbasic",
        type: "scenario",
        profileId: "p1",
        startedAt: "2026-08-04T10:00:00Z",
        endedAt: "2026-08-04T10:05:00Z",
        scenarios: [{ id: "hard-1", group: "编程硬核" }],
      },
      { type: "scenario" },
    );

    const after = await buildProfileTrend("p1");
    // 该点确实进了 series（修复的初衷：场景数据要可见），但不该抢走判定。
    const last = after.series[after.series.length - 1];
    assert.equal(last.runId, "scene-nonbasic", "无指标的场景点仍在 series 里（表格可见）");
    assert.equal(last.successRate, null);
    assert.equal(after.regression?.status, "stable", "判定仍取最近一个可比点，横幅不消失");
  } finally {
    delete process.env.EVALUATOR_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});

// —— toTrendPoint 的 null 判别（曾用 isNum = Number.isFinite(Number(v))）——
// Number(null)===0、Number("")===0 都是有限值，于是「没报出来」被读成「报出了 0」。
// 下面三个用例各钉住一种已复现的真实故障，改回 isNum 会分别失败。

// ① 假 0 造成误报：跑了 0 条记录的空运行本该「无从判断」，却被判「↓100pp，明显退化」。
// 来源：test-runner.mjs:229 在 records 为空时显式写 successRate: null，
// p95TotalMs = percentile([], .95) = null；存盘走 JSON，null 原样留在 raw_json 里。
test("toTrendPoint：空运行的 null 指标不得变成 0（否则对着满分基线误报 ↓100pp）", () => {
  // 经 JSON 往返，模拟从 test_runs.raw_json 读回
  const emptyRun = JSON.parse(
    JSON.stringify({
      runId: "qv-empty",
      type: "quick-verify",
      endedAt: new Date().toISOString(),
      requestCount: 0,
      successCount: 0,
      successRate: null,
      avgTotalMs: 0,
      p95TotalMs: null,
    }),
  );
  const p = toTrendPoint(emptyRun);
  assert.equal(p.successRate, null, "null 成功率不得读成 0");
  assert.equal(p.p95Ms, null, "null P95 不得读成 0");
  // 兜底必须生效：假 0 会让 hasComparableMetric 误判「报出了指标」，绕过 incomparable 分支
  assert.equal(hasComparableMetric(p), false);

  const history = [
    toTrendPoint(run({ runId: "h1", type: "quick-verify", successRate: 1, p95TotalMs: 30000 })),
    toTrendPoint(run({ runId: "h2", type: "quick-verify", successRate: 1, p95TotalMs: 31000 })),
    toTrendPoint(run({ runId: "h3", type: "quick-verify", successRate: 1, p95TotalMs: 29000 })),
  ];
  const v = detectRegression({ current: p, history: [...history, p] });
  assert.equal(v.status, "incomparable", "空运行应判无从比对，而非退化");
  assert.equal(v.severity, "none");
  assert.deepEqual(v.changes, []);
});

// ② 全失败运行：成功率 0 是真实观测（要保留、要能判退化），但 P95 无成功请求可统计 → null。
// 假 0 会让「全挂的一次」在趋势图上显示成 0ms，即最快的一次。
test("toTrendPoint：全失败运行保留 successRate=0，但 P95 仍为 null（不显示成 0ms）", () => {
  const p = toTrendPoint(
    JSON.parse(
      JSON.stringify({ runId: "st-fail", type: "stability", endedAt: new Date().toISOString(), successRate: 0, p95TotalMs: null }),
    ),
  );
  assert.equal(p.successRate, 0, "成功率 0 是真值，不能当缺失丢掉");
  assert.equal(p.p95Ms, null, "无成功请求 → P95 缺失，不得读成 0ms");
  assert.equal(hasComparableMetric(p), true, "成功率 0 可比 —— 这正是最该判退化的情形");

  // 且真退化仍要报得出来（修复不能把正常判定吞掉）
  const history = [
    toTrendPoint(run({ runId: "h1", successRate: 1, p95TotalMs: 2000 })),
    toTrendPoint(run({ runId: "h2", successRate: 1, p95TotalMs: 2100 })),
  ];
  const v = detectRegression({ current: p, history: [...history, p] });
  assert.equal(v.status, "regressed");
  assert.deepEqual(
    v.changes.map((c) => c.metric),
    ["success_rate"],
    "只报成功率；P95 缺失不参与，不臆造 P95 变化",
  );
});

// ③ 假阴性（比误报更值得修）：median 的过滤同样漏 null，null 占多数时 P95 基线中位数变成 0，
// 于是 `baseline.p95Ms > 0` 不成立 → P95 维彻底静默，×4 的真实劣化被判 stable。
test("buildBaseline：null 的 P95 不参与中位数（否则 P95 基线塌成 0，真劣化判成 stable）", () => {
  const pt = (runId, successRate, p95Ms) => ({
    runId,
    type: "stability",
    at: new Date().toISOString(),
    successRate,
    p95Ms,
    score: null,
    grade: null,
  });
  // 3 次全失败（P95 无从统计）+ 2 次正常
  const prior = [pt("h1", 1, 30000), pt("h2", 1, 29000), pt("h3", 0, null), pt("h4", 0, null), pt("h5", 0, null)];

  const b = buildBaseline(prior, { type: "stability" });
  assert.equal(b.p95Ms, 29500, "只对真实报出的 29000/30000 取中位，null 不算 0");

  const cur = pt("cur", 1, 120000); // 约 30s → 120s，×4
  const v = detectRegression({ current: cur, history: [...prior, cur] });
  assert.ok(
    v.changes.some((c) => c.metric === "p95"),
    "×4 的 P95 劣化必须报出（假 0 塌基线时这里会静默）",
  );
});
