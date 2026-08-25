// src/alert-digest-schedule.js
// 报警汇总的「人话预设 → cron 选择对象」纯函数层（零 DOM、只依赖 cron-ui 的纯函数）。
//
// 【为什么单独成文件而不留在 alert-rules.js 里】alert-rules.js 导出的是 createAlertRules，
// 一进去就 requireElement，测试里没法调。若把这套映射留在里面，测试只能【复刻一份】——
// 那是拿副本跟自己比，改坏了真实映射测试照旧全绿。抽成纯函数后 UI 与测试 import 同一份。
// 同一取向见 src/cron-ui.js（那也是为可测而抽出的纯函数层）。
//
// 【为什么用 fixed 形态】cron-ui 的小时级频率（h6/h12）会把分钟字段固定成 0，
// 于是「每 6 小时，从 09:07 起」变成 09:00 那一档，用户选的分钟被吞掉。
// fixed 形态把每个时刻单独列出（`7 3 * * *;7 9 * * *;…`，分号分隔，后端 cron 引擎支持），
// 分钟原样保留，且反解析能精确还原。
import { buildCron, parseScheduleFromCron } from "./cron-ui.js";

// 界面上的五个预设。值即 <select> 的 option value。
export const DIGEST_FREQ = { daily: "daily", twiceDaily: "h12", fourTimesDaily: "h6", weekdayOnly: "weekday", weekly: "weekly" };

export const WEEKLY_FREQ = "weekly";

// 频率 → 一天里的若干时刻（从 hour:minute 起算，等间隔推，跨午夜取模）。
export function digestTimesOfDay(hour, minute, freq) {
  const step = freq === "h6" ? 6 : freq === "h12" ? 12 : 0;
  if (!step) return [{ hour, minute }];
  const out = [];
  for (let h = 0; h < 24; h += step) out.push({ hour: (hour + h) % 24, minute });
  return out;
}

// 预设 → cron-ui 的选择对象。
export function digestSelection({ freq, hour, minute, weekday = 1 }) {
  const fixedTimes = digestTimesOfDay(hour, minute, freq);
  if (freq === WEEKLY_FREQ) return { days: "custom", daysCustom: [weekday], freq: "fixed", fixedTimes };
  if (freq === "weekday") return { days: "weekday", freq: "fixed", fixedTimes };
  return { days: "everyday", freq: "fixed", fixedTimes };
}

// 预设 → cron 表达式。
export function buildDigestCron(sel) {
  return buildCron(digestSelection(sel));
}

// cron → 预设。认不出返回 null（调用方据此提示用户，绝不猜着改写配置）。
// 返回 { freq, hour, minute, weekday }：hour/minute 取当天最早那个时刻。
export function parseDigestCron(cron) {
  const sel = parseScheduleFromCron(String(cron || "").trim());
  if (!sel.matched || sel.freq !== "fixed" || !sel.fixedTimes?.length) return null;
  const times = [...sel.fixedTimes].sort((a, b) => a.hour - b.hour || a.minute - b.minute);
  let freq = null;
  let weekday = 1;
  if (times.length === 1) {
    if (sel.days === "weekday") freq = "weekday";
    else if (sel.days === "custom") {
      if (sel.daysCustom?.length !== 1) return null; // 多天的自定义组合本页表达不出
      freq = WEEKLY_FREQ;
      weekday = sel.daysCustom[0];
    } else freq = "daily";
  } else if (sel.days === "everyday") {
    freq = { 2: "h12", 4: "h6" }[times.length] || null;
  }
  if (!freq) return null;
  return { freq, hour: times[0].hour, minute: times[0].minute, weekday };
}
