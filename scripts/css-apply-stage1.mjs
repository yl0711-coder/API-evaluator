#!/usr/bin/env node
// scripts/css-apply-stage1.mjs
// 阶段1：把「字面值 === 当前生效 token 值」的硬编码色值改写为 token 引用。
// 设计目标：**零视觉变化**，且可用 css-audit dump --resolve 逐字节证明。
//
// 做法：
//   1. 合并两套 :root → 一套（旧块的 11 个变量全部被新块遮蔽，删除旧块不改变任何生效值；
//      但旧块里若有新块没有的变量则必须保留 —— 由脚本核对，不靠假设）。
//   2. 在 :root 补充 rgb 三元组 token（--accent-rgb 等），供半透明衍生色引用。
//   3. 按 plan.json 的 stage1 列表，从后往前替换（倒序避免偏移失效）。
//
// 白名单式：只改 plan.json 里明确列出的 index 位置，不做全文正则批量替换
// （失效方向朝安全倒：漏改一处 = 少一处 token 化；错改一处 = 视觉 bug）。
//
// 用法: node scripts/css-apply-stage1.mjs <in.css> <plan.json> <out.css>

import { readFileSync, writeFileSync } from "node:fs";

const [, , inFile, planFile, outFile] = process.argv;
if (!inFile || !planFile || !outFile) {
  console.error("用法: node scripts/css-apply-stage1.mjs <in.css> <plan.json> <out.css>");
  process.exit(2);
}

const css = readFileSync(inFile, "utf8");
const plan = JSON.parse(readFileSync(planFile, "utf8"));
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));

// ---- 定位两个 :root 块 ----
function rootBlocks(src) {
  const out = [];
  const re = /:root\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let d = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && d > 0; i++) {
      if (src[i] === "{") d++;
      else if (src[i] === "}") d--;
    }
    const vars = new Map();
    for (const dm of src.slice(m.index + m[0].length, i - 1).matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
      vars.set(dm[1], dm[2].trim());
    }
    out.push({ vars, start: m.index, end: i });
  }
  return out;
}

const blocks = rootBlocks(stripped);
if (blocks.length !== 2) {
  console.error(`预期 2 个 :root 块，实际 ${blocks.length} 个 —— 中止（前提不成立）`);
  process.exit(1);
}
const [oldBlock, newBlock] = blocks;

// ---- 安全前提核对：旧块是否有新块缺失的变量 ----
const orphans = [...oldBlock.vars.keys()].filter((k) => !newBlock.vars.has(k));
if (orphans.length) {
  console.error(`旧 :root 有 ${orphans.length} 个变量未被新块覆盖，删除会改变渲染：${orphans.join(", ")}`);
  console.error("中止 —— 需先把这些变量并入新块。");
  process.exit(1);
}
console.log(`✓ 前提核对：旧 :root 的 ${oldBlock.vars.size} 个变量全部被新块覆盖，可安全移除`);

// ---- 需要哪些 rgb 三元组 token ----
const needRgb = new Set();
for (const s of plan.stage1) {
  if (s.rgbToken) needRgb.add(s.rgbToken);
}
function toTriplet(hexOrRgb) {
  const v = hexOrRgb.trim().toLowerCase();
  if (v.startsWith("#")) {
    let h = v.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [Number.parseInt(h.slice(0, 2), 16), Number.parseInt(h.slice(2, 4), 16), Number.parseInt(h.slice(4, 6), 16)].join(", ");
  }
  const m = v.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  return m ? [m[1], m[2], m[3]].map((n) => Math.round(Number(n))).join(", ") : null;
}

const rgbLines = [];
for (const rgbTok of [...needRgb].sort()) {
  const base = rgbTok.replace(/-rgb$/, "");
  const val = newBlock.vars.get(base);
  if (!val) {
    console.error(`需要 ${rgbTok} 但新 :root 里没有 ${base} —— 中止`);
    process.exit(1);
  }
  const trip = toTriplet(val);
  if (!trip) {
    console.error(`${base} 的值 "${val}" 无法解析为 rgb 三元组 —— 中止`);
    process.exit(1);
  }
  rgbLines.push(`  ${rgbTok}: ${trip};`);
}

// ---- 执行替换：倒序（保持未处理位置的偏移有效）----
let out = css;
const edits = [...plan.stage1].sort((a, b) => b.index - a.index);
let applied = 0;
for (const e of edits) {
  const actual = out.slice(e.index, e.index + e.raw.length);
  if (actual !== e.raw) {
    console.error(`偏移校验失败 @${e.index}：期望 "${e.raw}"，实际 "${actual}" —— 中止（计划与文件不同步）`);
    process.exit(1);
  }
  const replacement = e.alpha !== undefined ? `rgba(var(${e.rgbToken}), ${e.alpha})` : `var(${e.token})`;
  out = out.slice(0, e.index) + replacement + out.slice(e.index + e.raw.length);
  applied++;
}
console.log(`✓ 已替换 ${applied} 处硬编码色值 → token 引用`);

// ---- 把 rgb 三元组 token 注入新 :root（在 --soft 行之后，或块末）----
// 注意：此时 out 里 newBlock 的偏移仍然有效吗？替换发生在 :root 之外与之内都有可能，
// 故重新定位而不复用旧偏移。
const blocks2 = rootBlocks(out.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length)));
const nb = blocks2[blocks2.length - 1];
const insertAt = out.lastIndexOf("\n", nb.end - 2) + 1;
const injection = `  /* rgb 三元组：供 rgba(var(--x-rgb), a) 复用同一颜色的半透明衍生。\n     与 --x 同源，改一处即可同时改不透明色与所有半透明层。 */\n${rgbLines.join("\n")}\n`;
out = out.slice(0, insertAt) + injection + out.slice(insertAt);
console.log(`✓ 已注入 ${rgbLines.length} 个 rgb 三元组 token`);

// ---- 移除旧 :root 块（其全部变量已被新块遮蔽，删除不改变生效值）----
const blocks3 = rootBlocks(out.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length)));
const ob = blocks3[0];
// 连同紧随其后的空行一起删掉，避免留下两个空行
let delEnd = ob.end;
while (delEnd < out.length && (out[delEnd] === "\n" || out[delEnd] === "\r")) delEnd++;
out = out.slice(0, ob.start) + out.slice(delEnd);
console.log(`✓ 已移除被完全遮蔽的旧 :root 块（${oldBlock.vars.size} 个变量）`);

writeFileSync(outFile, out, "utf8");
console.log(`\n已写出：${outFile}`);
