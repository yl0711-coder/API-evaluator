// tests/temperature-notice.test.mjs
// 「手填温度被上游拒收」提示卡的渲染契约。
//
// 背景：传输层遇到拒收自定义 temperature 的模型会就地删掉该参数并记住该模型
// （server/upstream-transport.mjs 的 TEMPERATURE_UNSUPPORTED_MODELS），之后同模型请求首发就不带。
// 这对工具自己的默认 0.2 是无声自愈；但用户在高级设置里手填过温度时，本轮跑的其实是模型默认温度，
// 报告数字会被误读成「我设的那个温度下的表现」。提示卡就是这条留痕的唯一出口，故钉住它：
// 0 次 / 老报告缺字段时必须完全不出卡（否则每份历史报告都会多一条假警告）。
import assert from "node:assert/strict";
import test from "node:test";
import { temperatureStrippedNotice } from "../src/formatters.js";

test("温度提示卡：没被摘过就不出卡（含老报告缺字段的情形）", () => {
  assert.equal(temperatureStrippedNotice(0, 10), "");
  assert.equal(temperatureStrippedNotice(undefined, 10), "");
  assert.equal(temperatureStrippedNotice(null, 10), "");
  // 负数/非数字属脏数据，同样不出卡而不是渲染出 "NaN 次请求"
  assert.equal(temperatureStrippedNotice("abc", 10), "");
  assert.equal(temperatureStrippedNotice(-1, 10), "");
});

test("温度提示卡：被摘过就出卡，并给出「几次/共几次」", () => {
  const html = temperatureStrippedNotice(3, 10);
  assert.match(html, /温度设置未生效/);
  assert.match(html, /3\/10 次请求/);
  // 分母缺失（未知总数）时只报次数，不渲染 "3/0"
  const noTotal = temperatureStrippedNotice(3, 0);
  assert.match(noTotal, /3 次请求/);
  assert.doesNotMatch(noTotal, /3\/0/);
});
