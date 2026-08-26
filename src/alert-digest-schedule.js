// src/alert-digest-schedule.js
// 报警汇总的「星期 × 发信时刻列表 → cron」纯函数层（零 DOM、只依赖 cron-ui 的纯函数）。
//
// 【为什么单独成文件而不留在 alert-rules.js 里】alert-rules.js 导出的是 createAlertRules，
// 一进去就 requireElement，测试里没法调。若把这套映射留在里面，测试只能【复刻一份】——
// 那是拿副本跟自己比，改坏了真实映射测试照旧全绿。抽成纯函数后 UI 与测试 import 同一份。
// 同一取向见 src/cron-ui.js（那也是为可测而抽出的纯函数层）。
//
// 【为什么是「时刻列表」而不是「频率 + 起算时刻」】上一版给的是「每天两次/四次」这类预设，
// 由起算时刻等间隔推算 —— 于是「每天两次」被钉死成间隔 12 小时，想要 09:00 和 18:00
// 这种很正常的组合根本表达不出来。改为让用户直接列出要发信的时刻，几点就是几点。
//
// 【为什么用 cron 的 fixed 形态】把每个时刻单独列成一条表达式、用分号连接
// （`0 9 * * *;0 18 * * *`，后端 cron 引擎支持）。分钟原样保留，反解析也能精确还原。
// 相比之下 cron-ui 的小时级步长频率会把分钟字段固定成 0，用户选的分钟会被吞掉。
import { buildCron, parseScheduleFromJob } from "./cron-ui.js";

// 星期预设。custom 时用 daysCustom（[0..6]，0=周日）。
export const DAY_PRESETS = ["everyday", "weekday", "weekend", "custom"];

// 时刻数量上限。cron 是分号连接的，每个时刻一条表达式，太多会让配置文件里那行长到没法读；
// 12 条已远超实际需要（每天 12 封汇总信违背了这个功能的初衷）。
export const MAX_DIGEST_TIMES = 12;

// 越界一律判非法（返回 null），【不钳到边界】。
// 钳的话 25:00 会变成 23:00 —— 凭空造出一个用户没选过的发信时刻，而他无从发现。
// 判非法则该时刻被丢掉；若全部时刻都被丢掉，buildDigestCron 返回空串、保存被拒，
// 问题于是浮出水面而不是被悄悄圆掉。界面上时刻来自 <input type="time"> 不会越界，
// 越界只可能来自手改配置文件或伪造请求 —— 那两种情况更该报错而非猜。
const strictInt = (v, lo, hi) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n)) return null;
  return n >= lo && n <= hi ? n : null;
};

// 时刻列表归一化：丢掉非法项、按时间排序、去重。
// 排序+去重是刻意的：同一组时刻无论用户按什么顺序添加，都产出同一个 cron（幂等），
// 于是「打开页面按一次保存」不会改变任何东西。
export function normalizeDigestTimes(times) {
  const clean = (Array.isArray(times) ? times : [])
    .map((t) => ({ hour: strictInt(t?.hour, 0, 23), minute: strictInt(t?.minute, 0, 59) }))
    .filter((t) => t.hour !== null && t.minute !== null)
    .sort((a, b) => a.hour - b.hour || a.minute - b.minute);
  const out = [];
  for (const t of clean) {
    const prev = out[out.length - 1];
    if (!prev || prev.hour !== t.hour || prev.minute !== t.minute) out.push(t);
  }
  return out.slice(0, MAX_DIGEST_TIMES);
}

// 各星期预设对应的星期号集合。用于把「自选星期恰好等于某个预设」的情形归并回预设。
const PRESET_DAY_SETS = [
  ["everyday", [0, 1, 2, 3, 4, 5, 6]],
  ["weekday", [1, 2, 3, 4, 5]],
  ["weekend", [0, 6]],
];

// 星期归一化。custom 但一天都没选 → 落回 everyday（否则 buildDow 会产出 "*"，
// 即「每天」，与用户看到的「自定义」标签不符；宁可把它显式变成 everyday）。
export function normalizeDigestDays({ days, daysCustom }) {
  const preset = DAY_PRESETS.includes(days) ? days : "everyday";
  if (preset !== "custom") return { days: preset, daysCustom: [] };
  const set = [...new Set((Array.isArray(daysCustom) ? daysCustom : []).map(Number).filter((n) => n >= 0 && n <= 6))].sort((a, b) => a - b);
  if (!set.length) return { days: "everyday", daysCustom: [] };
  // 【自选星期等于预设时必须归并】否则往返不幂等：勾「周六+周日」得 dow 字段 `0,6`，
  // 而反解析会认出它就是 weekend 预设、再建时 cron-ui 按预设写成 `6,0` ——
  // 触发的星期完全相同，但存进配置文件的字符串变了一次形态。
  // 后果是「打开页面、什么都不改、按一次保存」会改写配置文件，让人以为自己动了什么。
  // 归并后 custom[0,6] 与 weekend 从一开始就产出同一个表达式。
  const matched = PRESET_DAY_SETS.find(([, preset]) => preset.length === set.length && preset.every((d) => set.includes(d)));
  if (matched) return { days: matched[0], daysCustom: [] };
  return { days: "custom", daysCustom: set };
}

// 选择 → cron-ui 的选择对象。
export function digestSelection(sel) {
  const { days, daysCustom } = normalizeDigestDays(sel || {});
  return { days, daysCustom, freq: "fixed", fixedTimes: normalizeDigestTimes(sel?.times) };
}

// 选择 → cron 表达式。时刻列表为空时返回空串（调用方据此拒绝保存）。
export function buildDigestCron(sel) {
  const selection = digestSelection(sel);
  if (!selection.fixedTimes.length) return "";
  return buildCron(selection);
}

// cron → 选择。认不出返回 null（调用方据此提示用户，绝不猜着改写配置）。
// 返回 { days, daysCustom, times }。
// 【必须传 cronMode="fixed"】`0 HH * * *` 这个形状本身是歧义的：既可能是本页的
// 「固定在 HH:00 发信」，也可能是「每天一次」的老写法。parseScheduleFromCron 会猜成后者
// （freq:"once"），于是本函数拿不到 fixedTimes 而返回 null。
// 后果是【单个整点时刻的配置回读不出来】：存「每天 09:00」，重开页面变成「认不出」，
// 预览行提示手写表达式 —— 而 09:00 恰恰是最可能被选的时刻。
// 实测：单个 09:00 丢时刻；09:00+18:00 反而正常（分号形式无歧义）。
// parseScheduleFromJob(cron, "fixed") 就是为消除这个歧义存在的：本页只产 fixed 形态，
// 故一律按 fixed 解读。
export function parseDigestCron(cron) {
  const sel = parseScheduleFromJob(String(cron || "").trim(), "fixed");
  if (!sel.matched || sel.freq !== "fixed" || !sel.fixedTimes?.length) return null;
  if (!DAY_PRESETS.includes(sel.days)) return null;
  // 【超过上限判认不出，而不是截断】normalizeDigestTimes 会 slice 到 12 个。
  // 若在这里放过，回读一个手写的 15 时刻表达式会得到 12 个 —— 界面显示 12 个、看着正常，
  // 用户按一次保存就【静默删掉 3 个发信时刻】，而他无从发现少了哪几个。
  // 判认不出则原表达式被原样保住（UI 不猜着回填），与本页「绝不静默改写用户配置」一致。
  if (sel.fixedTimes.length > MAX_DIGEST_TIMES) return null;
  // custom 必须真的带上具体哪几天；空的 daysCustom 说明反解析没拿到，按认不出处理。
  if (sel.days === "custom" && !sel.daysCustom?.length) return null;
  return {
    days: sel.days,
    daysCustom: sel.days === "custom" ? [...sel.daysCustom].sort((a, b) => a - b) : [],
    times: normalizeDigestTimes(sel.fixedTimes),
  };
}

// 一句人话（用于预览行）。dayText 由调用方给（UI 与文档措辞不同），这里只拼时刻。
export function formatDigestTimes(times) {
  return normalizeDigestTimes(times)
    .map(({ hour, minute }) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`)
    .join("、");
}
