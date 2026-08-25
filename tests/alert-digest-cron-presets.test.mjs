// tests/alert-digest-cron-presets.test.mjs
// 报警汇总页那五个「人话」预设 → cron 表达式的契约。
//
// 【为什么单独一个文件】这五个预设是给非程序员用的：界面上没有 crontab 输入框，
// 用户看不到也改不了表达式，所以【生成得对不对全靠这里守】。一旦生成的表达式与标签不符，
// 用户没有任何手段发现——他只会觉得"汇总信怎么不按我选的时间来"。
//
// 断言的是【实际触发时刻】而非字符串长相：字符串比对只能证明"没变过"，
// 证明不了"是对的"。这里把表达式喂给真实 cron 引擎（server/cron-schedule.mjs）展开成
// 触发小时/分钟集合，再与标签承诺的时刻比对。
//
// 历史教训：曾用步长形态 `分 起点-23/步长` 生成，而本项目的 expandField 对裸数字带步长的
// `3/6` 会取 lo=hi=3 —— 只展开出一个小时，「每 6 小时」静默变成「每天一次」。
// 字符串比对不会发现这件事，展开成小时集合才会。
import assert from "node:assert/strict";
import test from "node:test";

// 【必须 import 真实映射，不能在此复刻】复刻一份等于拿副本跟自己比：
// 改坏了 src/ 里的真实映射，测试照旧全绿。这个坑本轮已经踩过一次（选择器正则），故直接引用。
import { buildDigestCron, parseDigestCron, WEEKLY_FREQ } from "../src/alert-digest-schedule.js";
import { parseCron } from "../server/cron-schedule.mjs";
import { computeNextRunAt } from "../server/auto-test-store.mjs";

const ALL_FREQS = ["daily", "h12", "h6", "weekday", WEEKLY_FREQ];

// 把（可能含分号的）cron 展开成 { hours, minutes, dows }。
function expand(cron) {
  const hours = new Set();
  const minutes = new Set();
  const dows = new Set();
  for (const expr of cron.split(";")) {
    const f = parseCron(expr.trim());
    for (const h of f.hour) hours.add(h);
    for (const m of f.minute) minutes.add(m);
    for (const d of f.dow) dows.add(d);
  }
  const sorted = (s) => [...s].sort((a, b) => a - b);
  return { hours: sorted(hours), minutes: sorted(minutes), dows: sorted(dows) };
}

test("每天一次：只在选定的那一个时刻触发", () => {
  const { hours, minutes } = expand(buildDigestCron({ freq: "daily", hour: 9, minute: 7 }));
  assert.deepEqual(hours, [9]);
  assert.deepEqual(minutes, [7], "分钟必须保住——步长形态会把它压成 0");
});

test("每天两次：间隔 12 小时，分钟保住", () => {
  const { hours, minutes } = expand(buildDigestCron({ freq: "h12", hour: 9, minute: 7 }));
  assert.deepEqual(hours, [9, 21], "09:07 与 21:07");
  assert.deepEqual(minutes, [7]);
});

test("每天四次：间隔 6 小时，分钟保住", () => {
  const { hours, minutes } = expand(buildDigestCron({ freq: "h6", hour: 9, minute: 7 }));
  assert.deepEqual(hours, [3, 9, 15, 21], "从 09:07 起算，等间隔推到 03/09/15/21");
  assert.deepEqual(minutes, [7]);
});

// 这一条钉住那个历史缺陷：绝不能只展开出一个小时。
test("每天四次/两次绝不退化成每天一次（历史缺陷：`3/6` 只展开出一个小时）", () => {
  for (let hour = 0; hour < 24; hour++) {
    const c6 = buildDigestCron({ freq: "h6", hour, minute: 7 });
    assert.equal(expand(c6).hours.length, 4, `${hour} 点起算应有 4 个触发小时，实得 "${c6}"`);
    const c12 = buildDigestCron({ freq: "h12", hour, minute: 30 });
    assert.equal(expand(c12).hours.length, 2, `${hour} 点起算应有 2 个触发小时，实得 "${c12}"`);
  }
});

test("只在工作日：dow 为 1-5，不含周末", () => {
  const { hours, minutes, dows } = expand(buildDigestCron({ freq: "weekday", hour: 9, minute: 7 }));
  assert.deepEqual(dows, [1, 2, 3, 4, 5]);
  assert.deepEqual(hours, [9]);
  assert.deepEqual(minutes, [7]);
});

test("每周一次：只在选定的那一天", () => {
  for (const weekday of [0, 1, 3, 6]) {
    const cron = buildDigestCron({ freq: WEEKLY_FREQ, hour: 9, minute: 7, weekday });
    assert.deepEqual(expand(cron).dows, [weekday], `每周 ${weekday} → "${cron}"`);
  }
});

// 端点会拒绝算不出下一个时刻的 cron（回 400）。五个预设都不该踩到。
test("所有预设 × 全部时刻都能被端点接受（computeNextRunAt 不返回 null）", () => {
  const bad = [];
  for (const freq of ALL_FREQS) {
    for (let hour = 0; hour < 24; hour++) {
      for (const minute of [0, 7, 30, 59]) {
        const cron = buildDigestCron({ freq, hour, minute });
        if (computeNextRunAt({ cron }, Date.now()) === null) bad.push(`${freq} ${hour}:${minute} → "${cron}"`);
      }
    }
  }
  assert.deepEqual(bad, [], `以下预设会被端点拒绝：\n  ${bad.join("\n  ")}`);
});

test("五个预设都能反解析回同一个预设（存盘再打开不失真）", () => {
  const bad = [];
  for (const freq of ALL_FREQS) {
    for (let hour = 0; hour < 24; hour++) {
      const cron = buildDigestCron({ freq, hour, minute: 7 });
      const back = parseDigestCron(cron);
      if (back?.freq !== freq) bad.push(`${freq} ${hour}:07 → "${cron}" → 回填成 ${back?.freq ?? "认不出"}`);
    }
  }
  assert.deepEqual(bad, [], `以下预设回填后变了：\n  ${bad.join("\n  ")}`);
});

test("每周一次：反解析要还原星期几", () => {
  for (const weekday of [0, 1, 5, 6]) {
    const back = parseDigestCron(buildDigestCron({ freq: WEEKLY_FREQ, hour: 9, minute: 7, weekday }));
    assert.equal(back.weekday, weekday);
  }
});

// 幂等：回填后不改任何选项直接再保存，应生成完全相同的表达式。
// 「每天四次」回填显示的是当天首个时刻（09:07 → 03:07），若不幂等，
// 每次打开页面按一次保存都会把节奏往前挪一格。
test("回填后原样再保存 → 表达式不变（打开页面按保存不会挪动节奏）", () => {
  for (const freq of ALL_FREQS) {
    for (const hour of [0, 9, 22, 23]) {
      const first = buildDigestCron({ freq, hour, minute: 7 });
      const back = parseDigestCron(first);
      const again = buildDigestCron({ freq: back.freq, hour: back.hour, minute: back.minute, weekday: back.weekday });
      assert.equal(again, first, `${freq} ${hour}:07 不幂等：首次 "${first}"，回填再存 "${again}"`);
    }
  }
});

test("跨午夜的起算时刻：仍是 4 个等间隔时刻", () => {
  const { hours, minutes } = expand(buildDigestCron({ freq: "h6", hour: 22, minute: 7 }));
  assert.deepEqual(hours, [4, 10, 16, 22]);
  assert.deepEqual(minutes, [7]);
});

test("分钟为 0 时也照常工作（不因 falsy 被当成缺省）", () => {
  const { hours, minutes } = expand(buildDigestCron({ freq: "h12", hour: 8, minute: 0 }));
  assert.deepEqual(hours, [8, 20]);
  assert.deepEqual(minutes, [0]);
});

// 认不出的表达式必须回 null，让 UI 提示用户而不是猜着回填。
test("认不出的 cron → parseDigestCron 返回 null（绝不猜着改写用户配置）", () => {
  for (const cron of [
    "*/5 * * * *", // 分钟级步长：本页没有这个预设
    "0 9-18/2 * * 1-5", // 时段+步长：自动测试页的形态，本页表达不出
    "7 9 1 * *", // 限定日期
    "7 9,13,17 * * *", // 3 个时刻：不对应任何预设
    "",
    "垃圾",
  ]) {
    assert.equal(parseDigestCron(cron), null, `"${cron}" 应判认不出`);
  }
});

// 多天的自定义星期组合（如周一+周四）本页表达不出，必须判认不出而非错当成「每周一次」。
test("自定义多天组合 → 认不出（不能错当成每周一次而丢掉其余那几天）", () => {
  assert.equal(parseDigestCron("7 9 * * 1,4"), null);
});
