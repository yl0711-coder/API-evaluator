// src/cron-ui.js
// 下拉式定时调度 ↔ cron 表达式的纯函数层（零 DOM、零 import）。
// UI 收集「星期 × 时段 × 频率」三维选择 → buildCron 拼成 cron 字符串（后端 cron 引擎消费）；
// 编辑既有作业时 parseScheduleFromCron 把 cron 反解析回三维选择回填下拉。
// describeSchedule 给一句人话预览。时区语义由后端固定北京时间（见 server/cron-schedule.mjs）。
//
// 只生成受控格式，故反解析可按已知模式精确还原；认不得的 cron（旧手写/外部）→ matched:false，
// 调用方据此提示用户核对，绝不丢数据。

// 时段定义（小时，含端点）。白天 9-18；夜间 19-次日 8（跨午夜）；全天 0-23。
export const PERIOD_PRESETS = {
  allday: { startHour: 0, endHour: 23 },
  day: { startHour: 9, endHour: 18 },
  night: { startHour: 19, endHour: 8 },
};

// 分钟级频率 freq → 分钟步长（均能整除 60，跨小时边界触发均匀）。生成 `*/M`、小时字段无步长。
export const MINUTE_FREQ = { m6: 6, m10: 10, m12: 12, m15: 15, m20: 20, m30: 30 };

// 小时级频率 freq → 小时步长。生成分钟字段 `0`、小时字段带步长。
export const FREQ_STEP = { hourly: 1, h2: 2, h3: 3, h6: 6, h12: 12 };

// 星期预设 → dow 字段。
const DAYS_DOW = { everyday: "*", weekday: "1-5", weekend: "6,0" };

// 把 [startHour..endHour]（可跨午夜）按 step 展开成 cron 小时字段字符串。
// 不跨午夜：`a-b` 或带步长 `a-b/step`（step=1 时省略）。
// 跨午夜（start>end）：拆两段 `start-23` + `0-end`，各自带步长。
function hourField(startHour, endHour, step) {
  const seg = (lo, hi) => (step > 1 ? `${lo}-${hi}/${step}` : lo === hi ? `${lo}` : `${lo}-${hi}`);
  if (startHour <= endHour) return seg(startHour, endHour);
  return `${seg(startHour, 23)},${seg(0, endHour)}`;
}

// 由选择对象构造 cron。sel: { days, daysCustom?, period, startHour?, endHour?, freq, onceHour? }
//  - days: everyday|weekday|weekend|custom；custom 时 daysCustom 是 [0..6] 的数组（0=周日）
//  - period: allday|day|night|custom；custom 时用 startHour/endHour
//  - freq: m6|m10|m12|m15|m20|m30（分钟级）| hourly|h2|h3|h6|h12（小时级）| once（每天一次，用 onceHour）
export function buildCron(sel) {
  const dow = buildDow(sel);
  const freq = sel.freq || "hourly";

  if (freq === "once") {
    const h = clampHour(sel.onceHour, 9);
    return `0 ${h} * * ${dow}`;
  }

  const { startHour, endHour } = resolvePeriod(sel);
  const { minuteField, hourStep } = freqFields(sel);
  const hours = hourField(startHour, endHour, hourStep);
  return `${minuteField} ${hours} * * ${dow}`;
}

// freq → { minuteField, hourStep }。分钟级：*/M + 小时无步长；小时级：0 + 小时步长。
function freqFields(sel) {
  if (sel.freq in MINUTE_FREQ) return { minuteField: `*/${MINUTE_FREQ[sel.freq]}`, hourStep: 1 };
  return { minuteField: "0", hourStep: FREQ_STEP[sel.freq] || 1 };
}

function buildDow(sel) {
  if (sel.days === "custom") {
    const set = [...new Set((sel.daysCustom || []).map(Number).filter((n) => n >= 0 && n <= 6))].sort((a, b) => a - b);
    return set.length ? set.join(",") : "*";
  }
  return DAYS_DOW[sel.days] || "*";
}

function resolvePeriod(sel) {
  if (sel.period === "custom") {
    return { startHour: clampHour(sel.startHour, 0), endHour: clampHour(sel.endHour, 23) };
  }
  return PERIOD_PRESETS[sel.period] || PERIOD_PRESETS.allday;
}

function clampHour(v, dflt) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : dflt;
}

// 一句人话预览。
export function describeSchedule(sel) {
  const daysText = describeDays(sel);
  const freq = sel.freq || "hourly";
  if (freq === "once") {
    const h = clampHour(sel.onceHour, 9);
    return `${daysText}，每天 ${h}:00 跑一次`;
  }
  const { startHour, endHour } = resolvePeriod(sel);
  const windowText =
    sel.period === "allday" ? "全天" : startHour <= endHour ? `${startHour}-${endHour} 点` : `${startHour} 点至次日 ${endHour} 点`;
  const freqText =
    freq in MINUTE_FREQ
      ? `每 ${MINUTE_FREQ[freq]} 分钟`
      : { hourly: "每小时", h2: "每 2 小时", h3: "每 3 小时", h6: "每 6 小时", h12: "每 12 小时" }[freq];
  return `${daysText} ${windowText}，${freqText}一次`;
}

function describeDays(sel) {
  if (sel.days === "everyday") return "每天";
  if (sel.days === "weekday") return "工作日";
  if (sel.days === "weekend") return "周末";
  const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const set = [...new Set((sel.daysCustom || []).map(Number))].sort((a, b) => a - b);
  return set.length ? set.map((d) => names[d]).join("、") : "每天";
}

// 反解析：cron → 选择对象 + matched。认不得则 matched:false（附默认选择供回落）。
export function parseScheduleFromCron(cron) {
  const fallback = {
    days: "everyday",
    daysCustom: [],
    period: "allday",
    startHour: 0,
    endHour: 23,
    freq: "hourly",
    onceHour: 9,
    matched: false,
  };
  const parts = String(cron || "")
    .trim()
    .split(/\s+/);
  if (parts.length !== 5) return fallback;
  const [minute, hour, dom, month, dowRaw] = parts;
  // 日/月必须是 *（我们从不生成别的）；否则认不得。
  if (dom !== "*" || month !== "*") return fallback;

  const days = parseDow(dowRaw);
  if (!days) return fallback;

  // 每天一次：minute=0，hour 是单个 0-23 整数。
  if (minute === "0" && /^\d+$/.test(hour)) {
    const h = Number(hour);
    if (h >= 0 && h <= 23) return { ...days, period: "custom", startHour: h, endHour: h, freq: "once", onceHour: h, matched: true };
  }

  // 窗口内频率。minute：*/M（分钟级）或 0（小时级）；hour：受控格式。
  const win = parseHourField(hour);
  if (!win) return fallback;

  let freq;
  const stepMatch = minute.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    // 分钟级：只认预设分钟步长，且此模式下小时字段不带步长。
    const m = Number(stepMatch[1]);
    freq = minuteFreqOf(m);
    if (!freq || win.step !== 1) return fallback;
  } else if (minute === "0") {
    freq = stepToFreq(win.step); // 1/2/3/6/12 → 小时级预设
    if (!freq) return fallback;
  } else {
    return fallback;
  }

  const period = matchPeriod(win.startHour, win.endHour);
  return {
    ...days,
    period: period || "custom",
    startHour: win.startHour,
    endHour: win.endHour,
    freq,
    onceHour: 9,
    matched: true,
  };
}

function parseDow(dowRaw) {
  if (dowRaw === "*") return { days: "everyday", daysCustom: [] };
  if (dowRaw === "1-5") return { days: "weekday", daysCustom: [] };
  if (dowRaw === "6,0" || dowRaw === "0,6") return { days: "weekend", daysCustom: [] };
  // 自定义：逗号分隔的 0-6 整数集
  if (/^(\d)(,\d)*$/.test(dowRaw)) {
    const set = [...new Set(dowRaw.split(",").map(Number))].filter((n) => n >= 0 && n <= 6).sort((a, b) => a - b);
    if (set.length) return { days: "custom", daysCustom: set };
  }
  return null;
}

// 解析小时字段 → { startHour, endHour, step }。支持 `a`、`a-b`、`a-b/n`、`a-23/n,0-b/n`（跨午夜）。
function parseHourField(field) {
  if (field.includes(",")) {
    // 跨午夜两段：前段以 -23 结尾，后段以 0- 开头，步长须一致。
    const segs = field.split(",");
    if (segs.length !== 2) return null;
    const a = parseHourSeg(segs[0]);
    const b = parseHourSeg(segs[1]);
    if (!a || !b || a.hi !== 23 || b.lo !== 0 || a.step !== b.step) return null;
    return { startHour: a.lo, endHour: b.hi, step: a.step };
  }
  const s = parseHourSeg(field);
  if (!s) return null;
  return { startHour: s.lo, endHour: s.hi, step: s.step };
}

function parseHourSeg(seg) {
  const stepSplit = seg.split("/");
  if (stepSplit.length > 2) return null;
  const step = stepSplit.length === 2 ? Number(stepSplit[1]) : 1;
  if (!Number.isInteger(step) || step < 1) return null;
  const range = stepSplit[0];
  if (/^\d+$/.test(range)) {
    const v = Number(range);
    if (v < 0 || v > 23) return null;
    return { lo: v, hi: v, step };
  }
  const m = range.match(/^(\d+)-(\d+)$/);
  if (!m) return null;
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  if (lo < 0 || hi > 23 || lo > hi) return null;
  return { lo, hi, step };
}

function stepToFreq(step) {
  if (step === 1) return "hourly";
  return { 2: "h2", 3: "h3", 6: "h6", 12: "h12" }[step] || null;
}

// 分钟步长 M → 分钟级 freq（MINUTE_FREQ 的反查）；非预设步长返回 null。
function minuteFreqOf(m) {
  return Object.keys(MINUTE_FREQ).find((k) => MINUTE_FREQ[k] === m) || null;
}

function matchPeriod(startHour, endHour) {
  for (const [name, { startHour: s, endHour: e }] of Object.entries(PERIOD_PRESETS)) {
    if (s === startHour && e === endHour) return name;
  }
  return null;
}
