#!/usr/bin/env node
// scripts/css-apply-stage2.mjs
// 阶段2：把旧皮肤遗留色收敛到当前生效的语义 token。**会改变渲染**（这是目的，不是副作用）。
//
// 与阶段1 的关键区别：阶段1 能用「解析后声明集逐字节相同」自证等价；阶段2 不能，
// 因为改变颜色就是目的。所以这里的安全性靠**别的**保证：
//   1. 白名单：只改 css-stage2-plan.mjs 产出的 index 位置，不做全文正则批量替换。
//      失效方向朝安全倒——漏改一处 = 少收敛一处；错改一处 = 视觉 bug。
//   2. 偏移校验：每处替换前先核对该位置的实际字符与计划记录一致，不一致立即中止。
//   3. 变更清单：产出「哪个选择器的哪个属性、从什么色变成什么色」的可读报告，供人过目。
//
// 用法: node scripts/css-apply-stage2.mjs <in.css> <plan.json> <out.css> [--report out.md]

import { readFileSync, writeFileSync } from "node:fs";

const [, , inFile, planFile, outFile] = process.argv;
const repIdx = process.argv.indexOf("--report");
if (!inFile || !planFile || !outFile) {
  console.error("用法: node scripts/css-apply-stage2.mjs <in.css> <plan.json> <out.css> [--report out.md]");
  process.exit(2);
}

const css = readFileSync(inFile, "utf8");
const { edits } = JSON.parse(readFileSync(planFile, "utf8"));
if (!Array.isArray(edits) || !edits.length) {
  console.error("计划为空 —— 中止");
  process.exit(1);
}

// 为报告服务：定位某个偏移所属的「选择器 + 属性」。
// 用注释等长空白化后的文本做定位，避免注释内容干扰。
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));

function contextOf(index) {
  // 属性名：从 index 往左找最近的 `{` 或 `;`，取其后到 `:` 之间
  let l = index;
  while (l > 0 && stripped[l] !== "{" && stripped[l] !== ";") l--;
  const declHead = stripped.slice(l + 1, index);
  const prop = (declHead.split(":")[0] || "").trim();

  // 选择器：从 l 往左找 `{` 的配对起点，取其前一段 prelude
  let b = l;
  while (b > 0 && stripped[b] !== "{") b--;
  let s = b - 1;
  let depth = 0;
  while (s > 0) {
    const c = stripped[s];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth === 0) break;
      depth--;
    } else if ((c === ";" || c === "\n") && depth === 0) {
      // 走到上一条声明/规则边界即可停
      const ahead = stripped.slice(s + 1, b).trim();
      if (ahead && !ahead.startsWith("@")) break;
    }
    s--;
  }
  const selector = stripped
    .slice(s + 1, b)
    .replace(/\s+/g, " ")
    .trim();
  const line = stripped.slice(0, index).split("\n").length;
  return { selector: selector || "(未定位)", prop: prop || "(未定位)", line };
}

// 倒序替换，保持未处理位置偏移有效
const sorted = [...edits].sort((a, b) => b.index - a.index);
let out = css;
const applied = [];

for (const e of sorted) {
  const actual = out.slice(e.index, e.index + e.raw.length);
  if (actual !== e.raw) {
    console.error(`偏移校验失败 @${e.index}：期望 "${e.raw}"，实际 "${actual}" —— 中止（计划与文件不同步，请重新生成计划）`);
    process.exit(1);
  }
  const ctx = contextOf(e.index);
  out = out.slice(0, e.index) + e.to + out.slice(e.index + e.raw.length);
  applied.push({ ...e, ...ctx });
}

writeFileSync(outFile, out, "utf8");
console.log(`✓ 已替换 ${applied.length} 处旧皮肤遗留色 → 语义 token`);

// 分组统计
const byToken = new Map();
for (const a of applied) {
  if (!byToken.has(a.token)) byToken.set(a.token, []);
  byToken.get(a.token).push(a);
}
console.log("");
for (const [tok, list] of [...byToken].sort((a, z) => z[1].length - a[1].length)) {
  const one = list[0];
  console.log(`  ${tok.padEnd(16)} ${one.oldBase} → ${one.newBase}   ${list.length} 处`);
}

if (repIdx !== -1) {
  const path = process.argv[repIdx + 1];
  const lines = [
    `# 阶段2 变更清单 · 旧皮肤遗留色 → 语义 token`,
    ``,
    `共 ${applied.length} 处。以下按语义分组，列出每个受影响的「选择器 → 属性」。`,
    ``,
  ];
  for (const [tok, list] of [...byToken].sort((a, z) => z[1].length - a[1].length)) {
    const one = list[0];
    lines.push(`## \`${tok}\`（${one.note}）：\`${one.oldBase}\` → \`${one.newBase}\`，${list.length} 处`, ``);
    lines.push(`| 行 | 选择器 | 属性 | 原值 | 新值 |`, `|---|---|---|---|---|`);
    for (const a of [...list].sort((x, y) => x.line - y.line)) {
      lines.push(`| ${a.line} | \`${a.selector}\` | \`${a.prop}\` | \`${a.raw}\` | \`${a.to}\` |`);
    }
    lines.push(``);
  }
  writeFileSync(path, lines.join("\n"), "utf8");
  console.log(`\n已写出变更清单：${path}`);
}
