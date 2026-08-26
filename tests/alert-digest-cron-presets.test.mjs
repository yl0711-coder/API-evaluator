// tests/alert-digest-cron-presets.test.mjs
// 报警汇总的「哪几天 × 哪几个发信时刻」→ cron 的契约。
//
// 【为什么单独一个文件】这套控件是给非程序员用的：界面上没有 crontab 输入框，
// 用户看不到也改不了表达式，所以【生成得对不对全靠这里守】。一旦生成的表达式与界面显示不符，
// 用户没有任何手段发现——他只会觉得"汇总信怎么不按我选的时间来"。
//
// 断言的是【实际触发时刻】而非字符串长相：字符串比对只能证明"没变过"，证明不了"是对的"。
// 这里把表达式喂给真实 cron 引擎（server/cron-schedule.mjs）展开成触发小时/分钟/星期集合，
// 再与用户选的时刻比对。
//
// 历史教训两条，都是字符串比对发现不了的：
//  ① 曾用步长形态 `分 起点-23/步长` 生成，而 expandField 对裸数字带步长的 `3/6` 会取
//     lo=hi=3 —— 只展开出一个小时，「每 6 小时」静默变成「每天一次」。
//  ② 曾用 parseScheduleFromCron 反解析，而 `0 HH * * *` 对它是歧义的（既像「每天一次」
//     也像固定 HH:00），会被判成 freq:"once" —— 于是【单个整点时刻回读不出来】：
//     存「每天 09:00」重开页面变成「认不出」。而 09:00 恰恰是最可能被选的时刻。
import assert from "node:assert/strict";
import test from "node:test";

// 【必须 import 真实映射，不能在此复刻】复刻一份等于拿副本跟自己比：
// 改坏了 src/ 里的真实映射，测试照旧全绿。这个坑本轮已经踩过一次（选择器正则），故直接引用。
import {
  buildDigestCron,
  parseDigestCron,
  normalizeDigestTimes,
  normalizeDigestDays,
  formatDigestTimes,
  MAX_DIGEST_TIMES,
} from "../src/alert-digest-schedule.js";
import { parseCron } from "../server/cron-schedule.mjs";
import { computeNextRunAt } from "../server/auto-test-store.mjs";

const t = (hour, minute) => ({ hour, minute });

// 把（可能含分号的）cron 展开成 { hours, minutes, dows, pairs }。
// pairs 是「时:分」组合，用来确认不是笛卡尔积——分号形式下每条表达式各自成对，
// 只看 hours/minutes 集合会漏掉「09:07 + 18:30 被写成四个时刻」这类错误。
function expand(cron) {
  const hours = new Set();
  const minutes = new Set();
  const dows = new Set();
  const pairs = new Set();
  for (const expr of cron.split(";")) {
    const f = parseCron(expr.trim());
    for (const h of f.hour) {
      hours.add(h);
      for (const m of f.minute) pairs.add(`${h}:${m}`);
    }
    for (const m of f.minute) minutes.add(m);
    for (const d of f.dow) dows.add(d);
  }
  const sorted = (s) => [...s].sort((a, b) => a - b);
  return { hours: sorted(hours), minutes: sorted(minutes), dows: sorted(dows), pairs: [...pairs].sort() };
}

const ALL_DOWS = [0, 1, 2, 3, 4, 5, 6];

test("单个时刻：只在该时刻触发", () => {
  const { pairs, dows } = expand(buildDigestCron({ days: "everyday", times: [t(8, 30)] }));
  assert.deepEqual(pairs, ["8:30"]);
  assert.deepEqual(dows, ALL_DOWS);
});

// 这条是本次改进的核心诉求：旧版「每天两次」被钉死成间隔 12 小时，表达不出 09:00 + 18:00。
test("任意两个时刻（09:00 与 18:00）：不再被间隔 12 小时钉死", () => {
  const { pairs } = expand(buildDigestCron({ days: "everyday", times: [t(9, 0), t(18, 0)] }));
  assert.deepEqual(pairs, ["18:0", "9:0"].sort());
});

test("三个时刻、分钟各不相同：每个时刻的分钟都保住，且不产生笛卡尔积", () => {
  const { pairs } = expand(buildDigestCron({ days: "everyday", times: [t(9, 7), t(13, 15), t(19, 45)] }));
  assert.deepEqual(pairs, ["13:15", "19:45", "9:7"].sort());
  assert.equal(pairs.length, 3, "三个时刻就是三个组合，不该变成 3×3");
});

test("整点时刻不被压掉（分钟 0 不是 falsy 缺省）", () => {
  const { pairs } = expand(buildDigestCron({ days: "everyday", times: [t(0, 0)] }));
  assert.deepEqual(pairs, ["0:0"]);
});

test("只在工作日：dow 为 1-5", () => {
  const { dows, pairs } = expand(buildDigestCron({ days: "weekday", times: [t(9, 0)] }));
  assert.deepEqual(dows, [1, 2, 3, 4, 5]);
  assert.deepEqual(pairs, ["9:0"]);
});

test("只在周末：dow 为 0 与 6", () => {
  assert.deepEqual(expand(buildDigestCron({ days: "weekend", times: [t(10, 20)] })).dows, [0, 6]);
});

test("自选星期几：多天全部保留（不能只留第一天）", () => {
  const { dows } = expand(buildDigestCron({ days: "custom", daysCustom: [1, 3, 5], times: [t(9, 7)] }));
  assert.deepEqual(dows, [1, 3, 5]);
});

test("自选星期几 × 多时刻：星期与时刻都完整", () => {
  const { dows, pairs } = expand(buildDigestCron({ days: "custom", daysCustom: [2, 4], times: [t(9, 0), t(21, 30)] }));
  assert.deepEqual(dows, [2, 4]);
  assert.deepEqual(pairs, ["21:30", "9:0"].sort());
});

// 端点会拒绝算不出下一个时刻的 cron（回 400）。任何选择都不该踩到。
test("全部 24×60 分钟组合都能被端点接受", () => {
  const bad = [];
  for (let hour = 0; hour < 24; hour++) {
    for (const minute of [0, 1, 7, 30, 59]) {
      for (const days of ["everyday", "weekday", "weekend"]) {
        const cron = buildDigestCron({ days, times: [t(hour, minute)] });
        if (computeNextRunAt({ cron }, Date.now()) === null) bad.push(`${days} ${hour}:${minute} → "${cron}"`);
      }
    }
  }
  assert.deepEqual(bad, [], `以下选择会被端点拒绝：\n  ${bad.join("\n  ")}`);
});

test("每个星期几单独选都能被端点接受", () => {
  for (const d of ALL_DOWS) {
    const cron = buildDigestCron({ days: "custom", daysCustom: [d], times: [t(9, 0)] });
    assert.notEqual(computeNextRunAt({ cron }, Date.now()), null, `周${d} → "${cron}"`);
  }
});

// —— 往返 ——
// 【回归：整点时刻回读不出来】见文件头教训②。这一组必须覆盖 minute=0。
test("往返：单个整点时刻能原样回读（曾因 cron 歧义丢失）", () => {
  const cron = buildDigestCron({ days: "everyday", times: [t(9, 0)] });
  const back = parseDigestCron(cron);
  assert.ok(back, `"${cron}" 应能回读，实得 null`);
  assert.deepEqual(back.times, [t(9, 0)]);
  assert.equal(back.days, "everyday");
});

test("往返：工作日 + 单个整点时刻（同一歧义的另一种形状）", () => {
  const back = parseDigestCron(buildDigestCron({ days: "weekday", times: [t(9, 0)] }));
  assert.ok(back);
  assert.equal(back.days, "weekday");
  assert.deepEqual(back.times, [t(9, 0)]);
});

test("往返：全部整点 × 全部星期预设都不丢时刻", () => {
  const bad = [];
  for (let hour = 0; hour < 24; hour++) {
    for (const days of ["everyday", "weekday", "weekend"]) {
      const cron = buildDigestCron({ days, times: [t(hour, 0)] });
      const back = parseDigestCron(cron);
      if (!back || back.times.length !== 1 || back.times[0].hour !== hour || back.days !== days) {
        bad.push(`${days} ${hour}:00 → "${cron}" → ${JSON.stringify(back)}`);
      }
    }
  }
  assert.deepEqual(bad, [], `以下整点配置回读失真：\n  ${bad.join("\n  ")}`);
});

test("往返：多时刻 + 自选星期几完整还原", () => {
  const sel = { days: "custom", daysCustom: [1, 3, 5], times: [t(9, 0), t(13, 15), t(21, 45)] };
  const back = parseDigestCron(buildDigestCron(sel));
  assert.equal(back.days, "custom");
  assert.deepEqual(back.daysCustom, [1, 3, 5]);
  assert.deepEqual(back.times, sel.times);
});

// 幂等：回填后不改任何选项直接再保存，应生成完全相同的表达式。
// 否则「打开页面按一次保存」就会悄悄改变发信节奏。
test("回填后原样再保存 → 表达式不变", () => {
  const cases = [
    { days: "everyday", times: [t(9, 0)] },
    { days: "everyday", times: [t(9, 0), t(18, 0)] },
    { days: "weekday", times: [t(8, 30)] },
    { days: "weekend", times: [t(10, 20)] },
    { days: "custom", daysCustom: [1, 3, 5], times: [t(9, 7)] },
    { days: "custom", daysCustom: [0, 6], times: [t(23, 59), t(0, 0)] },
  ];
  for (const sel of cases) {
    const first = buildDigestCron(sel);
    const again = buildDigestCron(parseDigestCron(first));
    assert.equal(again, first, `不幂等：首次 "${first}"，回填再存 "${again}"`);
  }
});

// —— 归一化 ——

test("时刻列表：排序 + 去重（同一组时刻无论添加顺序都产出同一个 cron）", () => {
  assert.deepEqual(normalizeDigestTimes([t(18, 0), t(9, 0), t(18, 0)]), [t(9, 0), t(18, 0)]);
  const a = buildDigestCron({ days: "everyday", times: [t(18, 0), t(9, 0)] });
  const b = buildDigestCron({ days: "everyday", times: [t(9, 0), t(18, 0)] });
  assert.equal(a, b, "添加顺序不该影响结果");
});

test("时刻列表：非法项被丢掉，不产出坏 cron", () => {
  assert.deepEqual(normalizeDigestTimes([t(25, 0), t(-1, 0), t(9, 60), t(9, -1), t(9, 30)]), [t(9, 30)]);
  assert.deepEqual(normalizeDigestTimes([null, undefined, {}, "x", t(9, 0)]), [t(9, 0)]);
  assert.deepEqual(normalizeDigestTimes(null), []);
});

test(`时刻列表上限 ${MAX_DIGEST_TIMES} 个`, () => {
  const many = Array.from({ length: 30 }, (_, i) => t(i % 24, i));
  assert.equal(normalizeDigestTimes(many).length, MAX_DIGEST_TIMES);
});

test("时刻列表为空 → cron 为空串（调用方据此拒绝保存）", () => {
  assert.equal(buildDigestCron({ days: "everyday", times: [] }), "");
  assert.equal(buildDigestCron({ days: "everyday" }), "");
  assert.equal(buildDigestCron(null), "");
});

test("星期：脏预设落回 everyday", () => {
  assert.deepEqual(normalizeDigestDays({ days: "bogus" }), { days: "everyday", daysCustom: [] });
  assert.deepEqual(normalizeDigestDays({}), { days: "everyday", daysCustom: [] });
});

// custom 但一天都没勾：buildDow 会产出 "*"（即每天），与界面显示的「自己选星期几」不符。
// 归一化把它显式变成 everyday，让存下去的东西和读回来的一致。
test("星期：custom 但一天都没勾 → 落回 everyday（避免显示与实际不符）", () => {
  assert.deepEqual(normalizeDigestDays({ days: "custom", daysCustom: [] }), { days: "everyday", daysCustom: [] });
  const cron = buildDigestCron({ days: "custom", daysCustom: [], times: [t(9, 0)] });
  assert.deepEqual(parseDigestCron(cron).days, "everyday", "回读也该是 everyday，不能是 custom");
});

test("星期：越界与重复的星期号被清理", () => {
  assert.deepEqual(normalizeDigestDays({ days: "custom", daysCustom: [1, 1, 7, -1, 3] }), { days: "custom", daysCustom: [1, 3] });
});

// 认不出的表达式必须回 null，让 UI 提示用户而不是猜着回填。
test("认不出的 cron → 返回 null（绝不猜着改写用户配置）", () => {
  for (const cron of [
    "*/5 * * * *", // 分钟级步长
    "0 9-18/2 * * 1-5", // 时段+步长：自动测试页的形态
    "7 9 1 * *", // 限定日期
    "",
    "垃圾",
  ]) {
    assert.equal(parseDigestCron(cron), null, `"${cron}" 应判认不出`);
  }
});

// 【回归：静默删掉发信时刻】normalizeDigestTimes 会 slice 到 MAX_DIGEST_TIMES。
// 若 parseDigestCron 放过超上限的表达式，回读手写的 15 时刻配置会得到 12 个 ——
// 界面显示 12 个、看着完全正常，用户按一次保存就静默删掉 3 个发信时刻，且无从发现少了哪几个。
// 实测丢的是 12:00/13:00/14:00。判认不出则原表达式被原样保住。
test(`超过 ${MAX_DIGEST_TIMES} 个时刻的手写表达式 → 判认不出，而不是截断`, () => {
  const over = Array.from({ length: MAX_DIGEST_TIMES + 1 }, (_, i) => `0 ${i} * * *`).join(";");
  assert.equal(parseDigestCron(over), null, "超上限必须判认不出，否则保存会静默删掉多出来的时刻");
  // 正好等于上限的仍要认得出，别把边界连坐。
  const exact = Array.from({ length: MAX_DIGEST_TIMES }, (_, i) => `0 ${i} * * *`).join(";");
  assert.equal(parseDigestCron(exact)?.times.length, MAX_DIGEST_TIMES, "正好 12 个应能回读");
});

test("formatDigestTimes：补零 + 顿号分隔 + 排序", () => {
  assert.equal(formatDigestTimes([t(18, 0), t(9, 7)]), "09:07、18:00");
  assert.equal(formatDigestTimes([]), "");
});

// —— 自选星期等于预设时归并回预设 ——
// 【回归：不幂等】勾「周六+周日」会得 dow 字段 `0,6`，而反解析认出它就是 weekend 预设、
// 再建时 cron-ui 按预设写成 `6,0` —— 触发星期完全相同，但配置文件里的字符串变了一次形态。
// 后果是「打开页面、什么都不改、按一次保存」会改写配置文件，让人以为自己动了什么。
test("自选星期恰好等于预设 → 归并成该预设（否则往返不幂等）", () => {
  assert.deepEqual(normalizeDigestDays({ days: "custom", daysCustom: [0, 6] }), { days: "weekend", daysCustom: [] });
  assert.deepEqual(normalizeDigestDays({ days: "custom", daysCustom: [1, 2, 3, 4, 5] }), { days: "weekday", daysCustom: [] });
  assert.deepEqual(normalizeDigestDays({ days: "custom", daysCustom: [0, 1, 2, 3, 4, 5, 6] }), { days: "everyday", daysCustom: [] });
  // 乱序输入也要认出来
  assert.deepEqual(normalizeDigestDays({ days: "custom", daysCustom: [6, 0] }), { days: "weekend", daysCustom: [] });
});

test("自选星期与预设都不等 → 保持 custom", () => {
  assert.deepEqual(normalizeDigestDays({ days: "custom", daysCustom: [1, 3, 5] }), { days: "custom", daysCustom: [1, 3, 5] });
  assert.deepEqual(normalizeDigestDays({ days: "custom", daysCustom: [1] }), { days: "custom", daysCustom: [1] });
  // 工作日少一天 → 不是 weekday
  assert.deepEqual(normalizeDigestDays({ days: "custom", daysCustom: [1, 2, 3, 4] }), { days: "custom", daysCustom: [1, 2, 3, 4] });
});

test("自选星期等于预设时，产出的 cron 与直接选预设逐字相同", () => {
  const times = [t(9, 0)];
  assert.equal(
    buildDigestCron({ days: "custom", daysCustom: [0, 6], times }),
    buildDigestCron({ days: "weekend", times }),
    "custom[0,6] 与 weekend 必须产出同一个表达式",
  );
  assert.equal(buildDigestCron({ days: "custom", daysCustom: [1, 2, 3, 4, 5], times }), buildDigestCron({ days: "weekday", times }));
});
