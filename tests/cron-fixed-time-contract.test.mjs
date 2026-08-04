import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 跨层契约：前端 buildCron 产出的固定时刻 cron，服务端 normalizeJob/validateJob/computeNextRunAt
// 必须照单全收。两侧各有自己的单测（tests/cron-ui.test.mjs 用手写 cron，tests/auto-test-store.test.mjs
// 也用手写 cron），但没人把 buildCron 的【真实输出】喂给服务端——格式一旦对不上，作业存不下来，
// 而这正是固定时刻功能上线时连续踩了两次的坑（c78fe56 → 63d6a0c）。
process.env.EVALUATOR_DATA_DIR = mkdtempSync(join(tmpdir(), "cron-contract-test-"));
process.env.EVALUATOR_SECRET_STORE = "memory";

const { buildCron, parseScheduleFromJob, describeSchedule } = await import("../src/cron-ui.js");
const { normalizeJob, validateJob, computeNextRunAt } = await import("../server/auto-test-store.mjs");

// 固定时刻的典型与边界组合。24 个时刻是服务端上限（validateJob）的上边界。
const SELECTIONS = [
  { label: "每天单个非整点", sel: { days: "everyday", freq: "fixed", fixedTimes: [{ hour: 1, minute: 30 }] } },
  {
    label: "工作日两个时刻",
    sel: {
      days: "weekday",
      freq: "fixed",
      fixedTimes: [
        { hour: 1, minute: 30 },
        { hour: 5, minute: 45 },
      ],
    },
  },
  {
    label: "周末跨零点边界",
    sel: {
      days: "weekend",
      freq: "fixed",
      fixedTimes: [
        { hour: 0, minute: 0 },
        { hour: 23, minute: 59 },
      ],
    },
  },
  {
    label: "自定义星期 + 整点/半点混合",
    sel: {
      days: "custom",
      daysCustom: [1, 3, 5],
      freq: "fixed",
      fixedTimes: [
        { hour: 9, minute: 0 },
        { hour: 17, minute: 30 },
      ],
    },
  },
  {
    label: "24 个时刻（服务端上限边界）",
    sel: { days: "everyday", freq: "fixed", fixedTimes: Array.from({ length: 24 }, (_, h) => ({ hour: h, minute: 15 })) },
  },
];

test("固定时刻跨层契约：buildCron 的输出经 normalizeJob 不被改写，且 validateJob 全部放行", () => {
  for (const { label, sel } of SELECTIONS) {
    const cron = buildCron(sel);
    const job = normalizeJob({ targetId: "t-contract", kind: "quick", cron, cronMode: "fixed" });
    // normalizeJob 对 cron 有长度截断（slice）——24 个时刻约 600 字符，不该被切。
    assert.equal(job.cron, cron, `${label}：normalizeJob 不该改写 cron（原 ${cron.length} 字符）`);
    assert.equal(job.cronMode, "fixed", `${label}：cronMode 应原样落库`);
    assert.equal(validateJob(job), null, `${label}：服务端应接受 UI 生成的 cron → ${cron}`);
    // 2026-01-05 是周一，五种星期组合都能在 366 天内命中。
    assert.ok(computeNextRunAt(job, Date.UTC(2026, 0, 5, 0, 0)), `${label}：应能算出 nextRunAt`);
  }
});

test("固定时刻跨层契约：超过 24 个时刻被明确拒绝，不静默截断成非法表达式", () => {
  const sel = { days: "everyday", freq: "fixed", fixedTimes: Array.from({ length: 30 }, (_, i) => ({ hour: i % 24, minute: i })) };
  const job = normalizeJob({ targetId: "t-contract", kind: "quick", cron: buildCron(sel), cronMode: "fixed" });
  const error = validateJob(job);
  assert.ok(error, "30 个固定时刻应被拒绝");
  // 报错要指对方向（说明上限是 24），而不是笼统的「表达式不合法」——后者会让用户去改星期/时段。
  assert.match(error, /24/, `错误信息应点明 24 个上限，实际：${error}`);
});

// 回归：作业卡片的定时文案。单个整点固定时刻（09:00）生成的 cron 与「每天一次 9 点」字面完全
// 相同（`0 9 * * *`），只能靠另存的 cronMode 分辨。编辑器一直做了这个校正，作业卡片漏了——
// 用户把作业配成「固定在 09:00 运行」，卡片上却写「每天 9:00 跑一次」，看着像自己没选对模式。
test("作业卡片文案：单个整点固定时刻按 cronMode 显示为固定时刻，不退化成「每天一次」", () => {
  const cron = buildCron({ days: "everyday", freq: "fixed", fixedTimes: [{ hour: 9, minute: 0 }] });
  assert.equal(cron, "0 9 * * *", "前提：单个 09:00 的 cron 与「每天一次 9 点」字面相同，故本用例才有意义");

  const asFixed = parseScheduleFromJob(cron, "fixed");
  assert.match(describeSchedule(asFixed), /固定在 09:00/, "带 cronMode=fixed 时应显示为固定时刻");

  // 无 cronMode 的老作业只能按「每天一次」回填（编辑器会额外 toast 提示核对）——这是有意的回落。
  const legacy = parseScheduleFromJob(cron, "");
  assert.match(describeSchedule(legacy), /每天 9:00 跑一次/, "无 cronMode 的历史作业保持原有回落行为");
});

test("作业卡片文案：多个固定时刻带 `;` 无歧义，不依赖 cronMode 也能完整列出", () => {
  const cron = buildCron({
    days: "weekday",
    freq: "fixed",
    fixedTimes: [
      { hour: 1, minute: 30 },
      { hour: 5, minute: 45 },
    ],
  });
  const text = describeSchedule(parseScheduleFromJob(cron, ""));
  assert.match(text, /工作日/);
  assert.match(text, /01:30/);
  assert.match(text, /05:45/);
});
