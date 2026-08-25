// tests/alert-digest-format.test.mjs
// 汇总邮件成文：标题信息量、按目标归并、多行 reason 的层次、以及【措辞纪律】——
// 无报警时绝不断言「全部稳定」，因为冷却期内仍在命中的规则不入队（既定取舍）。
import assert from "node:assert/strict";
import test from "node:test";

import { formatAlertDigest } from "../server/alert-digest-format.mjs";

const alert = (over = {}) => ({
  at: "2026-08-25T09:07:00.000Z",
  ruleId: "alr_1",
  ruleName: "成功率过低",
  ruleKind: "threshold",
  targetId: "p1",
  targetLabel: "claude-sonnet-5",
  reason: "规则「成功率过低」命中：claude-sonnet-5 的 successRate = 0.5（阈值 lt 0.8）",
  runId: "run-1",
  ...over,
});
const run = (over = {}) => ({
  at: "2026-08-25T09:00:00.000Z",
  targetId: "p1",
  targetLabel: "claude-sonnet-5",
  testType: "stability",
  runId: "run-1",
  successRate: 1,
  p95TotalMs: 32000,
  grade: null,
  ...over,
});

test("标题带上目标数与报警项数（收件箱里一眼可判断该不该点开）", () => {
  const { subject } = formatAlertDigest({
    alerts: [alert(), alert({ targetId: "p2", targetLabel: "gpt-4o", ruleId: "alr_2" })],
    runs: [],
  });
  assert.match(subject, /2 个目标 2 项报警/);
});

test("无报警时标题写「无新增报警」，不写「稳定」「正常」", () => {
  const { subject } = formatAlertDigest({ alerts: [], runs: [run()] });
  assert.match(subject, /无新增报警/);
  assert.doesNotMatch(subject, /稳定|正常|一切/);
});

// 本文件存在的核心理由。冷却期内仍在挂的渠道不入队 → 队列可能为空 →
// 若此时断言「一切正常」，就是把"我们已报过、现在不重复"讲成"没问题"。
test("【措辞纪律】无报警的正文不得出现「全部稳定」「一切正常」，且必须提示冷却期的影响", () => {
  const { body } = formatAlertDigest({ alerts: [], runs: [run({ successRate: 0 })] });
  assert.doesNotMatch(body, /全部稳定|一切正常|均正常|没有问题/);
  assert.match(body, /本时段没有新增报警/);
  assert.match(body, /冷却期/, "必须说明冷却期内的规则不重复计入");
  assert.match(body, /请看数字/, "必须把读者引向实测数字而非措辞");
  // 成功率 0 的那一行必须在，哪怕它没进报警列表
  assert.match(body, /0%/);
});

test("同一目标命中多条规则 → 归并到一处（读的是「这个渠道怎么了」）", () => {
  const { body } = formatAlertDigest({
    alerts: [alert(), alert({ ruleId: "alr_2", ruleName: "P95 过高", ruleKind: "stability-jitter" })],
    runs: [],
  });
  // 目标标题只出现一次
  assert.equal(body.split("■ claude-sonnet-5").length - 1, 1);
  assert.match(body, /成功率过低/);
  assert.match(body, /P95 过高/);
  assert.match(body, /\[稳定性抖动\]/, "复合规则应显示中文类型标签");
});

test("多行 reason（复合规则列多个越界项）逐行缩进，保持层次", () => {
  const { body } = formatAlertDigest({
    alerts: [
      alert({
        ruleKind: "stability-decline",
        ruleName: "稳定性退化",
        reason: "规则「稳定性退化」判定不合格：claude-sonnet-5\n  · 成功率中位数从 100% 跌到 78%，↓22pp\n  · P95 中位数 ×2.95",
      }),
    ],
    runs: [],
  });
  assert.match(body, /↓22pp/);
  assert.match(body, /×2\.95/);
  assert.match(body, /\[稳定性退化\]/);
});

test("实测数字表：同一目标跑了多次时取最后一次", () => {
  const { body } = formatAlertDigest({
    alerts: [],
    runs: [
      run({ at: "2026-08-25T08:00:00.000Z", successRate: 1, p95TotalMs: 30000 }),
      run({ at: "2026-08-25T09:00:00.000Z", successRate: 0.4, p95TotalMs: 88000 }),
    ],
  });
  assert.match(body, /40%/, "应显示最后一次的 40%");
  assert.match(body, /88000ms/);
  assert.doesNotMatch(body, /30000ms/, "较早那次不该出现");
});

test("缺测值显示为 -，不显示 0（0 与「没测到」必须可区分）", () => {
  const { body } = formatAlertDigest({
    alerts: [],
    runs: [run({ successRate: null, p95TotalMs: null, grade: null })],
  });
  const row = body.split("\n").find((l) => l.includes("claude-sonnet-5") && l.includes("|"));
  assert.ok(row, "应有该目标的数据行");
  assert.match(row, /\|\s*-\s*\|/, "缺测应显示为 -");
  assert.doesNotMatch(row, /\b0%/, "缺测不得显示成 0%");
});

test("真实的 0% 与 0ms 照常显示（全失败运行是真实观测）", () => {
  const { body } = formatAlertDigest({ alerts: [], runs: [run({ successRate: 0, p95TotalMs: 0 })] });
  assert.match(body, /0%/);
  assert.match(body, /0ms/);
});

// 「没跑测试」比「跑了但都正常」严重得多：作业可能被停用或熔断了。
test("完全没有运行记录 → 明确提示去查作业是否被停用/熔断", () => {
  const { body } = formatAlertDigest({ alerts: [], runs: [] });
  assert.match(body, /没有完成任何测试/);
  assert.match(body, /停用|熔断/);
});

test("时间范围：有上次汇总时刻则显示区间，否则显示「截至」", () => {
  const withFrom = formatAlertDigest(
    { alerts: [], runs: [] },
    { windowFrom: "2026-08-24T09:07:00.000Z", windowTo: "2026-08-25T09:07:00.000Z" },
  );
  assert.match(withFrom.body, /2026-08-24 09:07 ~ 2026-08-25 09:07/);
  const noFrom = formatAlertDigest({ alerts: [], runs: [] }, { windowTo: "2026-08-25T09:07:00.000Z" });
  assert.match(noFrom.body, /截至 2026-08-25 09:07/);
});

test("入参缺失/非法一律不抛错（best-effort 链路上的纯函数）", () => {
  for (const input of [undefined, null, {}, { alerts: null, runs: "x" }]) {
    const r = formatAlertDigest(input);
    assert.ok(r.subject, "总要有标题");
    assert.ok(r.body, "总要有正文");
  }
});

test("targetLabel 缺失时回落 targetId，再回落「未知目标」", () => {
  const { body } = formatAlertDigest({
    alerts: [alert({ targetLabel: "", targetId: "p9" })],
    runs: [run({ targetLabel: "", targetId: "" })],
  });
  assert.match(body, /p9/);
  assert.match(body, /未知目标/);
});

// —— 重复命中折叠 ——
// 冷却时长（默认 1h）与汇总周期（可能 24h）是两个独立的量：一个持续挂着的渠道每过一个冷却期
// 就重新入队一条。实测（冷却 1h + 每 2h 一测 + 24h 汇总）一封信里会出现 12 条逐字相同的报警行 ——
// 那只是把「邮件太多」换成「一封信里太吵」，收敛邮件数量的初衷落空。

test("同一规则×目标×原因重复命中 → 折叠成一行并记次数", () => {
  const many = Array.from({ length: 12 }, (_, i) => alert({ at: `2026-08-25T${String(i + 1).padStart(2, "0")}:00:00.000Z` }));
  const { subject, body } = formatAlertDigest({ alerts: many, runs: [] });
  assert.match(subject, /1 项报警/, "标题按去重后计——12 次同一问题不是 12 个问题");
  assert.doesNotMatch(subject, /12 项/);
  // 正文里该行只出现一次
  const hits = body.split("\n").filter((l) => l.includes("[阈值] 成功率过低"));
  assert.equal(hits.length, 1, "重复行必须折叠成一行");
  assert.match(hits[0], /共 12 次/, "次数必须保留，看得出响了多少回");
  assert.match(hits[0], /01:00 ~ 2026-08-25 12:00/, "持续区间必须保留，看得出持续多久");
  assert.match(body, /共 12 次命中，重复的已按次数折叠/, "必须说明折叠过，否则读者怀疑漏报");
});

test("只命中一次时不显示次数与区间（不给单次事件添噪）", () => {
  const { body } = formatAlertDigest({ alerts: [alert()], runs: [] });
  const row = body.split("\n").find((l) => l.includes("[阈值]"));
  assert.doesNotMatch(row, /共 \d+ 次/);
  assert.doesNotMatch(row, /~/);
  assert.match(body, /新增报警 1 项/);
  assert.doesNotMatch(body, /折叠/);
});

test("原因不同 → 不折叠（是两个不同的问题）", () => {
  const { subject, body } = formatAlertDigest({
    alerts: [alert({ reason: "成功率 30%" }), alert({ reason: "成功率 10%" })],
    runs: [],
  });
  assert.match(subject, /2 项报警/);
  assert.match(body, /成功率 30%/);
  assert.match(body, /成功率 10%/);
});

test("同规则不同目标 → 不折叠（各自是独立故障）", () => {
  const { subject, body } = formatAlertDigest({
    alerts: [alert(), alert({ targetId: "p2", targetLabel: "gpt-4o" })],
    runs: [],
  });
  assert.match(subject, /2 个目标 2 项报警/);
  assert.match(body, /■ claude-sonnet-5/);
  assert.match(body, /■ gpt-4o/);
});

// 并发入队时 at 未必严格有序，折叠取的应是极值而非首尾元素。
test("乱序入队 → 区间取真正的最早与最晚", () => {
  const { body } = formatAlertDigest({
    alerts: [
      alert({ at: "2026-08-25T15:00:00.000Z" }),
      alert({ at: "2026-08-25T03:00:00.000Z" }),
      alert({ at: "2026-08-25T09:00:00.000Z" }),
    ],
    runs: [],
  });
  const row = body.split("\n").find((l) => l.includes("[阈值]"));
  assert.match(row, /03:00 ~ 2026-08-25 15:00/, "应取最早 03:00 与最晚 15:00，而非数组首尾");
  assert.match(row, /共 3 次/);
});
