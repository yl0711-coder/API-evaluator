import assert from "node:assert/strict";
import test from "node:test";
import { parseCron, cronMatches, cronNextAfter } from "../server/cron-schedule.mjs";

// 北京时间 UTC+8：构造某个「北京钟点」对应的 UTC 时间戳。
// 例：北京 2026-01-05(周一) 09:30 → UTC 2026-01-05 01:30。
function bjMs(y, mo, d, h, mi) {
  return Date.UTC(y, mo - 1, d, h - 8, mi, 0, 0);
}

test("parseCron: 合法表达式解析出各字段集合", () => {
  const f = parseCron("0 9-18 * * 1-5");
  assert.equal(f.minute.has(0), true);
  assert.equal(f.hour.has(9), true);
  assert.equal(f.hour.has(18), true);
  assert.equal(f.hour.has(8), false);
  assert.equal(f.hour.has(19), false);
  assert.equal(f.dow.has(1), true);
  assert.equal(f.dow.has(5), true);
  assert.equal(f.dow.has(0), false);
  assert.equal(f.domStar, true);
  assert.equal(f.dowStar, false);
});

test("parseCron: 步长 / 列举 / 范围步长", () => {
  assert.deepEqual(
    [...parseCron("*/15 * * * *").minute].sort((a, b) => a - b),
    [0, 15, 30, 45],
  );
  assert.deepEqual(
    [...parseCron("0,6,19 * * * *").minute].sort((a, b) => a - b),
    [0, 6, 19],
  );
  assert.deepEqual(
    [...parseCron("0-30/10 * * * *").minute].sort((a, b) => a - b),
    [0, 10, 20, 30],
  );
});

test("parseCron: 星期 7 与 0 都是周日", () => {
  assert.equal(parseCron("0 0 * * 7").dow.has(0), true);
  assert.equal(parseCron("0 0 * * 0").dow.has(0), true);
});

test("parseCron: 非法表达式抛错", () => {
  assert.throws(() => parseCron("0 9 * *"), /5 个字段/); // 字段不足
  assert.throws(() => parseCron("0 9 * * * *"), /5 个字段/); // 字段过多
  assert.throws(() => parseCron("60 * * * *"), /越界/); // 分钟 60 越界
  assert.throws(() => parseCron("* 24 * * *"), /越界/); // 小时 24 越界
  assert.throws(() => parseCron("* * 0 * *"), /越界/); // 日 0 越界（日从 1 起）
  assert.throws(() => parseCron("* * * 13 *"), /越界/); // 月 13 越界
  assert.throws(() => parseCron("* * * * 8"), /越界/); // 星期 8 越界
  assert.throws(() => parseCron("5-1 * * * *"), /越界/); // 范围倒置
  assert.throws(() => parseCron("*/0 * * * *"), /步长/); // 步长 0
  assert.throws(() => parseCron("a * * * *"), /数值非法/); // 非数字
  assert.throws(() => parseCron("0,,5 * * * *"), /空片段/); // 空片段
});

test("cronMatches: 工作日白天每小时命中/不命中", () => {
  const f = parseCron("0 9-18 * * 1-5");
  assert.equal(cronMatches(f, bjMs(2026, 1, 5, 9, 0)), true); // 周一 09:00
  assert.equal(cronMatches(f, bjMs(2026, 1, 5, 18, 0)), true); // 周一 18:00
  assert.equal(cronMatches(f, bjMs(2026, 1, 5, 9, 1)), false); // 分钟不是 0
  assert.equal(cronMatches(f, bjMs(2026, 1, 5, 8, 0)), false); // 08:00 不在 9-18
  assert.equal(cronMatches(f, bjMs(2026, 1, 3, 9, 0)), false); // 周六
});

test("cronMatches: 周末每 12 小时", () => {
  const f = parseCron("0 */12 * * 6,0");
  assert.equal(cronMatches(f, bjMs(2026, 1, 3, 0, 0)), true); // 周六 00:00
  assert.equal(cronMatches(f, bjMs(2026, 1, 3, 12, 0)), true); // 周六 12:00
  assert.equal(cronMatches(f, bjMs(2026, 1, 4, 0, 0)), true); // 周日 00:00
  assert.equal(cronMatches(f, bjMs(2026, 1, 3, 6, 0)), false); // 周六 06:00 不是 12 的倍数
  assert.equal(cronMatches(f, bjMs(2026, 1, 5, 0, 0)), false); // 周一
});

test("cronMatches: dom∧dow 的 OR 规则（两者都非 * → 命中任一即触发）", () => {
  // 每月 1 号 或 每周一 的 00:00
  const f = parseCron("0 0 1 * 1");
  assert.equal(cronMatches(f, bjMs(2026, 3, 1, 0, 0)), true); // 3/1 是周日，但 dom=1 命中
  assert.equal(cronMatches(f, bjMs(2026, 3, 2, 0, 0)), true); // 3/2 是周一，dow 命中
  assert.equal(cronMatches(f, bjMs(2026, 3, 3, 0, 0)), false); // 3/3 周二、非 1 号 → 都不命中
});

test("cronMatches: dom 与 dow 一方为 * 时按 AND", () => {
  const f = parseCron("0 0 15 * *"); // 每月 15 号（dow=*）
  assert.equal(cronMatches(f, bjMs(2026, 1, 15, 0, 0)), true);
  assert.equal(cronMatches(f, bjMs(2026, 1, 16, 0, 0)), false);
});

test("cronNextAfter: 工作日白天，从周一 09:30 → 下一个整点 10:00", () => {
  const from = bjMs(2026, 1, 5, 9, 30);
  const next = cronNextAfter("0 9-18 * * 1-5", from);
  assert.equal(next, bjMs(2026, 1, 5, 10, 0));
});

test("cronNextAfter: 工作日多个固定时刻，01:00 后应在 05:00 运行并跳过周末", () => {
  assert.equal(cronNextAfter("0 1,5 * * 1-5", bjMs(2026, 1, 5, 1, 30)), bjMs(2026, 1, 5, 5, 0));
  assert.equal(cronNextAfter("0 1,5 * * 1-5", bjMs(2026, 1, 9, 5, 0)), bjMs(2026, 1, 12, 1, 0));
});

test("cronNextAfter: 周五 18:00 之后跳到下周一 09:00（跳过周末）", () => {
  const from = bjMs(2026, 1, 9, 18, 0); // 周五 18:00
  const next = cronNextAfter("0 9-18 * * 1-5", from);
  assert.equal(next, bjMs(2026, 1, 12, 9, 0)); // 下周一 09:00
});

test("cronNextAfter: */15 步进，从 12:07 → 12:15", () => {
  const from = bjMs(2026, 1, 5, 12, 7);
  assert.equal(cronNextAfter("*/15 * * * *", from), bjMs(2026, 1, 5, 12, 15));
});

test("cronNextAfter: 跨月 —— 1/31 23:00 之后的每月 1 号 00:00 → 2/1 00:00", () => {
  const from = bjMs(2026, 1, 31, 23, 0);
  assert.equal(cronNextAfter("0 0 1 * *", from), bjMs(2026, 2, 1, 0, 0));
});

test("cronNextAfter: 严格晚于当前分钟（正好命中当前分钟也要取下一次）", () => {
  const from = bjMs(2026, 1, 5, 10, 0); // 恰好命中 0 9-18 * * 1-5
  const next = cronNextAfter("0 9-18 * * 1-5", from);
  assert.equal(next, bjMs(2026, 1, 5, 11, 0)); // 不是自己，是下一个整点
});

test("cronNextAfter: fromMs 带秒也对齐到整分钟", () => {
  const from = bjMs(2026, 1, 5, 9, 30) + 45_000; // 09:30:45
  const next = cronNextAfter("0 9-18 * * 1-5", from);
  assert.equal(next, bjMs(2026, 1, 5, 10, 0));
});
