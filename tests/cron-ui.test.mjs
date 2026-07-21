import assert from "node:assert/strict";
import test from "node:test";
import { buildCron, describeSchedule, parseScheduleFromCron } from "../src/cron-ui.js";

test("buildCron：工作日白天每 2 小时", () => {
  assert.equal(buildCron({ days: "weekday", period: "day", freq: "h2" }), "0 9-18/2 * * 1-5");
});

test("buildCron：每天全天每小时", () => {
  assert.equal(buildCron({ days: "everyday", period: "allday", freq: "hourly" }), "0 0-23 * * *");
});

test("buildCron：分钟级频率 → 分钟字段 */M（小时字段无步长）", () => {
  assert.equal(buildCron({ days: "everyday", period: "day", freq: "m30" }), "*/30 9-18 * * *");
  assert.equal(buildCron({ days: "everyday", period: "allday", freq: "m6" }), "*/6 0-23 * * *");
  assert.equal(buildCron({ days: "everyday", period: "allday", freq: "m15" }), "*/15 0-23 * * *");
  assert.equal(buildCron({ days: "weekday", period: "day", freq: "m20" }), "*/20 9-18 * * 1-5");
});

test("buildCron：周末每 12 小时", () => {
  assert.equal(buildCron({ days: "weekend", period: "allday", freq: "h12" }), "0 0-23/12 * * 6,0");
});

test("buildCron：夜间跨午夜 → 拆两段", () => {
  // 夜间 19-次日8，每 6 小时
  assert.equal(buildCron({ days: "everyday", period: "night", freq: "h6" }), "0 19-23/6,0-8/6 * * *");
});

test("buildCron：每天一次 → 单个钟点", () => {
  assert.equal(buildCron({ days: "everyday", period: "allday", freq: "once", onceHour: 3 }), "0 3 * * *");
});

test("buildCron：自定义星期（周一三五）", () => {
  assert.equal(buildCron({ days: "custom", daysCustom: [1, 3, 5], period: "allday", freq: "hourly" }), "0 0-23 * * 1,3,5");
});

test("buildCron：自定义时段（22-次日6，每小时）→ 跨午夜两段无步长", () => {
  assert.equal(buildCron({ days: "everyday", period: "custom", startHour: 22, endHour: 6, freq: "hourly" }), "0 22-23,0-6 * * *");
});

test("describeSchedule：人话预览", () => {
  assert.equal(describeSchedule({ days: "weekday", period: "day", freq: "h2" }), "工作日 9-18 点，每 2 小时一次");
  assert.equal(describeSchedule({ days: "everyday", period: "allday", freq: "once", onceHour: 3 }), "每天，每天 3:00 跑一次");
  assert.equal(describeSchedule({ days: "weekend", period: "night", freq: "h6" }), "周末 19 点至次日 8 点，每 6 小时一次");
});

// ── 往返：受控格式必须闭环 ──
const ROUND_TRIP_CASES = [
  { days: "weekday", period: "day", freq: "h2" },
  { days: "everyday", period: "allday", freq: "hourly" },
  { days: "everyday", period: "day", freq: "m30" },
  { days: "everyday", period: "allday", freq: "m6" },
  { days: "weekend", period: "allday", freq: "h12" },
  { days: "everyday", period: "night", freq: "h6" },
  { days: "everyday", period: "allday", freq: "once", onceHour: 3 },
  { days: "custom", daysCustom: [1, 3, 5], period: "allday", freq: "hourly" },
];

test("往返：parseScheduleFromCron(buildCron(x)) 还原关键维度", () => {
  for (const sel of ROUND_TRIP_CASES) {
    const cron = buildCron(sel);
    const back = parseScheduleFromCron(cron);
    assert.equal(back.matched, true, `应识别：${cron}`);
    assert.equal(back.days, sel.days, `days 还原：${cron}`);
    assert.equal(back.freq, sel.freq, `freq 还原：${cron}`);
    if (sel.days === "custom") assert.deepEqual(back.daysCustom, sel.daysCustom, `daysCustom 还原：${cron}`);
    // 再 build 一次应得到同一 cron（结构闭环）
    assert.equal(buildCron(back), cron, `二次 build 一致：${cron}`);
  }
});

test("parseScheduleFromCron：识别夜间预设时段", () => {
  const back = parseScheduleFromCron("0 19-23/6,0-8/6 * * *");
  assert.equal(back.matched, true);
  assert.equal(back.period, "night");
  assert.equal(back.freq, "h6");
});

test("parseScheduleFromCron：认不得的 cron → matched:false，不抛，附默认回落", () => {
  for (const bad of ["", "0 9 * *", "0 9 1 * *" /* dom 非* */, "15 9 * * 1" /* 分钟非0/30/合法步长 */, "*/7 9-18 * * *" /* 7 不整除60 */]) {
    const back = parseScheduleFromCron(bad);
    assert.equal(back.matched, false, `应认不得：${bad}`);
    assert.equal(back.days, "everyday", "回落默认 days");
    assert.equal(back.freq, "hourly", "回落默认 freq");
  }
});

test("parseScheduleFromCron：星期 0,6 与 6,0 都识别为周末", () => {
  assert.equal(parseScheduleFromCron("0 0-23 * * 6,0").days, "weekend");
  assert.equal(parseScheduleFromCron("0 0-23 * * 0,6").days, "weekend");
});

// ── 分钟级频率（下拉固定档 6/10/12/15/20/30 分钟）──

test("parseScheduleFromCron：各分钟级步长还原为对应 freq", () => {
  assert.equal(parseScheduleFromCron("*/6 0-23 * * *").freq, "m6");
  assert.equal(parseScheduleFromCron("*/10 0-23 * * *").freq, "m10");
  assert.equal(parseScheduleFromCron("*/12 0-23 * * *").freq, "m12");
  assert.equal(parseScheduleFromCron("*/15 0-23 * * *").freq, "m15");
  assert.equal(parseScheduleFromCron("*/20 0-23 * * *").freq, "m20");
  assert.equal(parseScheduleFromCron("*/30 0-23 * * *").freq, "m30");
});

test("parseScheduleFromCron：非预设分钟步长（*/7）认不得", () => {
  assert.equal(parseScheduleFromCron("*/7 0-23 * * *").matched, false);
});

test("describeSchedule：分钟级人话", () => {
  assert.equal(describeSchedule({ days: "everyday", period: "allday", freq: "m6" }), "每天 全天，每 6 分钟一次");
  assert.equal(describeSchedule({ days: "weekday", period: "day", freq: "m20" }), "工作日 9-18 点，每 20 分钟一次");
});

test("往返：分钟级频率 build→parse→build 闭环", () => {
  for (const freq of ["m6", "m10", "m12", "m15", "m20", "m30"]) {
    const sel = { days: "weekday", period: "day", freq };
    const cron = buildCron(sel);
    const back = parseScheduleFromCron(cron);
    assert.equal(back.matched, true, `应识别：${cron}`);
    assert.equal(back.freq, freq, `freq 还原：${cron}`);
    assert.equal(buildCron(back), cron, `二次 build 一致：${cron}`);
  }
});
