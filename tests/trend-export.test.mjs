// tests/trend-export.test.mjs
// 稳定性趋势页的 CSV 导出（纯函数 → CSV 文本）。这份表是拿去做数据分析的，所以钉住的重点不是好看，
// 而是「分析侧能不能直接用」：数值列是不是原始数值、缺测是不是空而非 0、行是不是可直接首尾相接。
import assert from "node:assert/strict";
import test from "node:test";
import { buildTrendRoundsCsv, buildTrendSeriesCsv, trendExportFilename } from "../src/trend-export.js";

const META = { channelLabel: "渠道甲", modelLabel: "claude-sonnet-5" };
// 表格行（不含表头）；CSV 用 CRLF 分行。
const bodyLines = (csv) => csv.split("\r\n").slice(1);

test("历次运行 CSV：首行是表头，每次运行一行，数值给原始值（成功率是 0-1 小数）", () => {
  const csv = buildTrendSeriesCsv(
    [
      {
        runId: "r1",
        type: "batch-stability",
        at: "2026-08-10T10:00:00Z",
        successRate: 0.8,
        p95Ms: 1800,
        score: 88.5,
        grade: "A",
        totalTokens: 1200,
        cost: 0.0123,
      },
    ],
    META,
  );

  const [header, ...rows] = csv.split("\r\n");
  assert.match(header, /^"渠道","模型","时间\(ISO8601\)"/, "首行必须就是表头——上面再加说明行会让 read_csv 直接解析失败");
  assert.equal(rows.length, 1);
  // 成功率必须是 0.8 而不是 "80.0%"：分析侧不该再反解析百分号。
  assert.match(rows[0], /"0\.8","1800","88\.5","A","1200","0\.0123"$/);
  // 渠道/模型写进每一行，多个模型各导一份后可直接拼成一张大表。
  assert.match(rows[0], /^"渠道甲","claude-sonnet-5",/);
  // 运行类型给中文 + 原始值两列：中文给人看，原始值供分组统计。
  assert.match(rows[0], /"批量稳定性测试","batch-stability","r1"/);
});

test("缺测指标导出为空单元格，不能变成 0（Number(null) === 0 的坑）", () => {
  // 只跑非「基础」组的场景运行就是这个形状：成功率/P95 皆为 null。写成 0 等于编造「成功率 0%」。
  const csv = buildTrendSeriesCsv(
    [{ runId: "r1", type: "scenario", at: "2026-08-10T10:00:00Z", successRate: null, p95Ms: null, score: null, grade: null }],
    META,
  );
  const row = bodyLines(csv)[0];
  assert.match(row, /"场景测试","scenario","r1","","","","","",""$/, "成功率/P95/评分/等级/Token/成本 全为空单元格");
  assert.ok(!/"0"/.test(row), "任何一列都不该出现被 Number(null) 变出来的 0");
});

test("成功率 0 与 P95 0 是真实观测，必须原样导出（不能跟缺测混为一谈）", () => {
  const csv = buildTrendSeriesCsv([{ runId: "r1", type: "stability", at: "2026-08-10T10:00:00Z", successRate: 0, p95Ms: 0 }], META);
  assert.match(bodyLines(csv)[0], /"0","0",/, "全败的运行成功率就是 0，与「没报出成功率」是两件事");
});

test("逐轮请求 CSV：每个请求一行，成败给 1/0，失败带归一化错误类型", () => {
  const csv = buildTrendRoundsCsv(
    [
      { at: "2026-08-10T10:01:00Z", ms: 1000, ok: 1, err: "", runId: "r1", runRate: 0.5 },
      { at: "2026-08-10T10:02:00Z", ms: 30000, ok: 0, err: "timeout", runId: "r1", runRate: 0.5 },
    ],
    META,
  );
  const rows = bodyLines(csv);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /"r1","1000","1","","0\.5"$/, "成功轮：错误类型为空");
  assert.match(rows[1], /"r1","30000","0","timeout","0\.5"$/, "超时轮：ok=0 且带 timeout，可按此分组统计失败构成");
});

test("两份表用「运行ID」列关联：逐轮里的 runId 就是历次运行里的那个", () => {
  const seriesCsv = buildTrendSeriesCsv([{ runId: "run-x", type: "stability", at: "2026-08-10T10:00:00Z", successRate: 1 }], META);
  const roundsCsv = buildTrendRoundsCsv([{ at: "2026-08-10T10:01:00Z", ms: 900, ok: 1, err: "", runId: "run-x", runRate: 1 }], META);
  assert.ok(seriesCsv.includes('"run-x"') && roundsCsv.includes('"run-x"'));
  assert.ok(seriesCsv.split("\r\n")[0].includes("运行ID") && roundsCsv.split("\r\n")[0].includes("运行ID"));
});

test("CSV 注入防护：渠道名以 = 开头时前置单引号，Excel 不会把它当公式求值", () => {
  const csv = buildTrendSeriesCsv([{ runId: "r1", type: "stability", at: "2026-08-10T10:00:00Z" }], {
    channelLabel: '=cmd|" /C calc"!A0',
    modelLabel: "m",
  });
  assert.match(bodyLines(csv)[0], /^"'=cmd\|"" \/C calc""!A0"/, "= 开头前置单引号，内部双引号翻倍转义");
});

test("空数据也产出表头（分析脚本读到 0 行而不是解析失败）；缺字段/空洞条目不炸", () => {
  for (const csv of [buildTrendSeriesCsv([], META), buildTrendSeriesCsv(null, META), buildTrendSeriesCsv([null, undefined], META)]) {
    assert.equal(csv.split("\r\n").filter((l) => l.trim()).length, 1, "只剩表头一行");
  }
  assert.equal(buildTrendRoundsCsv([], META).split("\r\n").length, 1);
  // 元信息缺失时留空，不写 "undefined"。
  assert.match(buildTrendSeriesCsv([{ runId: "r1", at: "2026-08-10T10:00:00Z" }], {}), /\r\n"","",/);
});

test("文件名：带渠道/模型/时间戳，非法字符替换，缺名给占位词", () => {
  const at = new Date(2026, 7, 20, 9, 5); // 本地时间 2026-08-20 09:05
  assert.equal(trendExportFilename("series", META, at), "稳定性趋势_历次运行_渠道甲_claude-sonnet-5_20260820-0905.csv");
  assert.equal(trendExportFilename("rounds", META, at), "稳定性趋势_逐轮请求_渠道甲_claude-sonnet-5_20260820-0905.csv");
  // 路径分隔符与 Windows 保留字符不能出现在文件名里，否则浏览器保存会失败或被截断。
  const risky = trendExportFilename("series", { channelLabel: "a/b:c*d", modelLabel: 'x?y"z<>|' }, at);
  assert.equal(risky, "稳定性趋势_历次运行_a_b_c_d_x_y_z____20260820-0905.csv");
  assert.ok(!/[\\/:*?"<>|]/.test(risky), "文件名里不得残留任何路径分隔符或 Windows 保留字符");
  assert.match(trendExportFilename("series", {}, at), /_未知渠道_未知模型_/);
});
