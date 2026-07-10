// tests/report-html.test.mjs
// 报告 Markdown → HTML 渲染（server/report-html.mjs）：可信 SVG 穿透（```chart-svg 原样内联）、
// 普通代码/正文仍转义（不可被注入脚本）、基本结构。
import assert from "node:assert/strict";
import test from "node:test";

import { renderReportHtml } from "../server/report-html.mjs";

test("chart-svg 围栏：内容原样内联（不转义），普通代码/正文仍转义", () => {
  const md = [
    "# 标题",
    "",
    "```chart-svg",
    '<div style="background:#000"><svg><text>hi</text></svg></div>',
    "```",
    "",
    "```",
    "<script>bad()</script>",
    "```",
    "",
    "正文含 <b>标签</b> 应被转义。",
  ].join("\n");
  const html = renderReportHtml(md, "t");
  // 可信 SVG 原样内联
  assert.ok(html.includes("<svg><text>hi</text></svg>"), "chart-svg 应原样内联");
  assert.ok(html.includes('<div style="background:#000">'), "chart-svg 容器 div 原样保留");
  // 普通代码块仍转义（防注入）
  assert.ok(html.includes("&lt;script&gt;"), "普通代码块里的 <script> 应被转义");
  assert.ok(!html.includes("<script>bad()</script>"), "绝不能原样输出脚本");
  // 普通正文里的 HTML 也被转义
  assert.ok(html.includes("&lt;b&gt;标签&lt;/b&gt;"), "正文 HTML 应被转义");
  // 基本结构
  assert.ok(html.includes("<h1>标题</h1>"));
});

test("未终止的 chart-svg 围栏不抛、不吐残标签", () => {
  const md = "# t\n\n```chart-svg\n<svg></svg>\n"; // 少了收口 ```
  assert.doesNotThrow(() => renderReportHtml(md, "t"));
});

test("svg 别名围栏同样穿透", () => {
  const html = renderReportHtml("```svg\n<svg id='x'></svg>\n```", "t");
  assert.ok(html.includes("<svg id='x'></svg>"));
});
