// server/cron-schedule.mjs
// 极简 crontab 调度：解析标准 5 字段（分 时 日 月 周）并算出下一次触发时刻。
// 零依赖、纯函数。给自动测试作业提供「工作日/周末 × 白天/黑夜不同频率」的调度能力。
//
// 时区：固定北京时间（UTC+8）。中国自 1991 起无夏令时，北京时间恒为 UTC+8，
// 故把 UTC 时间戳 +8h 后读 getUTC* 即得北京钟点/星期，无需 Intl/时区库，无夏令时坑。
//
// 支持语法：* / 具体值 / a-b 范围 / */n 步长 / a-b/n / a,b,c 列举。
// 星期 0-7（0 和 7 都是周日）。不支持秒级、宏（@daily）、L/W/# 扩展。

const BEIJING_OFFSET_MS = 8 * 3600 * 1000; // UTC+8 恒定

// 5 个字段的取值域（min/max 均含端点）。星期上界取 7，解析时再把 7 归一成 0。
const FIELD_BOUNDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dom", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dow", min: 0, max: 7 },
];

// 展开单个字段的一个逗号段为数值集合。token 形如 * / 5 / 1-5 / */15 / 0-30/10。
function expandField(token, min, max) {
  const stepSplit = token.split("/");
  if (stepSplit.length > 2) throw new Error(`字段片段非法：${token}`);
  const rangePart = stepSplit[0];
  const step = stepSplit.length === 2 ? Number(stepSplit[1]) : 1;
  if (!Number.isInteger(step) || step < 1) throw new Error(`步长非法：${token}`);

  let lo;
  let hi;
  if (rangePart === "*") {
    lo = min;
    hi = max;
  } else if (rangePart.includes("-")) {
    const [a, b] = rangePart.split("-");
    lo = Number(a);
    hi = Number(b);
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`范围非法：${token}`);
  } else {
    lo = Number(rangePart);
    hi = lo;
    if (!Number.isInteger(lo)) throw new Error(`数值非法：${token}`);
  }
  if (lo < min || hi > max || lo > hi) throw new Error(`字段越界：${token}（允许 ${min}-${max}）`);

  const out = [];
  for (let v = lo; v <= hi; v += step) out.push(v);
  return out;
}

// 解析完整 cron 表达式 → { minute, hour, dom, month, dow, domStar, dowStar }。
// 各字段是 Set<number>；domStar/dowStar 记录该字段是否为 *（用于 dom∧dow 的 OR 规则）。
export function parseCron(expr) {
  const parts = String(expr ?? "")
    .trim()
    .split(/\s+/);
  if (parts.length !== 5) throw new Error("cron 必须是 5 个字段：分 时 日 月 周");

  const sets = parts.map((part, i) => {
    const { min, max } = FIELD_BOUNDS[i];
    const values = new Set();
    for (const seg of part.split(",")) {
      if (seg === "") throw new Error(`字段有空片段：${part}`);
      for (const v of expandField(seg, min, max)) {
        // 星期 7 归一成 0（都是周日）
        values.add(i === 4 && v === 7 ? 0 : v);
      }
    }
    return values;
  });

  return {
    minute: sets[0],
    hour: sets[1],
    dom: sets[2],
    month: sets[3],
    dow: sets[4],
    domStar: parts[2] === "*",
    dowStar: parts[4] === "*",
  };
}

// ms 时刻（按北京时间读字段）是否匹配已解析的 cron 字段。
export function cronMatches(fields, ms) {
  const bj = new Date(ms + BEIJING_OFFSET_MS);
  const minute = bj.getUTCMinutes();
  const hour = bj.getUTCHours();
  const dom = bj.getUTCDate();
  const month = bj.getUTCMonth() + 1;
  const dow = bj.getUTCDay(); // 0=周日

  if (!fields.minute.has(minute)) return false;
  if (!fields.hour.has(hour)) return false;
  if (!fields.month.has(month)) return false;

  // dom∧dow 的 POSIX OR 规则：两者都受限（非 *）时，命中任一即算匹配；
  // 否则按各自约束做 AND。
  const domHit = fields.dom.has(dom);
  const dowHit = fields.dow.has(dow);
  if (!fields.domStar && !fields.dowStar) return domHit || dowHit;
  return domHit && dowHit;
}

// 从 fromMs 之后的下一分钟起，逐分钟扫描，返回下次匹配的 ms（毫秒对齐到整分钟，秒=0）。
// 366 天内无匹配返回 null（防非法/永不触发的表达式吊死）。
export function cronNextAfter(expr, fromMs = Date.now()) {
  const fields = parseCron(expr);
  // 对齐到下一个整分钟：先归零秒/毫秒，再 +1 分钟（确保严格晚于 fromMs 所在分钟）。
  const start = new Date(fromMs);
  start.setUTCSeconds(0, 0);
  let cursor = start.getTime() + 60_000;
  const limit = cursor + 366 * 24 * 60 * 60 * 1000;
  for (; cursor <= limit; cursor += 60_000) {
    if (cronMatches(fields, cursor)) return cursor;
  }
  return null;
}
