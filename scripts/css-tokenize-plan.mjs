#!/usr/bin/env node
// scripts/css-tokenize-plan.mjs
// 产出「硬编码色值 → var(--token)」的替换计划，并区分阶段1（可证明等价）与阶段2（视觉变化）。
//
// 阶段1 只收「字面值与生效 token 完全相等」的出现点：替换后 resolved dump 必然逐字节不变，
// 是构造性等价证明。阶段2 收「值等于被遮蔽的旧调色板」的出现点：替换会改变渲染，需人过目。
//
// 关键设计：alpha 不同的 rgba（如 rgba(246,181,107,0.12)）**不能**直接换成 var(--accent)，
// 因为 token 是不透明色。这类只能走 color-mix() 或新增 alpha 阶梯 token，属于形态改变、
// 不在「零风险替换」范围内 → 单独列为「需 alpha 处理」桶，阶段1 不动它们。
//
// 用法: node scripts/css-tokenize-plan.mjs [file] [--stage1-json out.json]

import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "src/styles.css";
const jsonFlag = process.argv.indexOf("--stage1-json");
const css = readFileSync(file, "utf8");

const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length)); // 等长替换，保持偏移

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
const oldVars = blocks[0]?.vars ?? new Map();
const newVars = blocks[blocks.length - 1]?.vars ?? new Map();

function norm(v) {
  let s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{3,8}$/.test(s)) {
    let h = s.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length === 8 && h.slice(6) === "ff") h = h.slice(0, 6);
    return `#${h}`;
  }
  return s.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ");
}
const isPure = (v) => /^#[0-9a-fA-F]{3,8}$/.test(v.trim()) || /^(rgba?|hsla?)\([^)]*\)$/.test(v.trim());

// 生效 token（新块）的「纯色」反查：规范化字面值 -> token 名（优先语义名）
const SEMANTIC_PREFERENCE = [
  "--bad",
  "--good",
  "--blue",
  "--accent",
  "--bg",
  "--panel",
  "--panel-strong",
  "--card",
  "--text",
  "--text-2",
  "--muted",
  "--line",
  "--soft",
  "--coral",
  "--mint",
  "--sky",
];
const byValue = new Map();
for (const [name, value] of newVars) {
  if (!isPure(value)) continue;
  const k = norm(value);
  if (!byValue.has(k)) byValue.set(k, []);
  byValue.get(k).push(name);
}
for (const list of byValue.values()) {
  list.sort((a, b) => {
    const ia = SEMANTIC_PREFERENCE.indexOf(a);
    const ib = SEMANTIC_PREFERENCE.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}
// 旧块纯色反查（用于阶段2 归类）
const oldByValue = new Map();
for (const [name, value] of oldVars) {
  if (!isPure(value)) continue;
  const k = norm(value);
  if (!oldByValue.has(k)) oldByValue.set(k, []);
  oldByValue.get(k).push(name);
}

// 收集所有出现点（跳过 :root 块内部）
const inRoot = (idx) => blocks.some((b) => idx >= b.start && idx < b.end);
const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;

const stage1 = []; // 字面值 === 生效 token 值 → 零风险
const stage2 = []; // 字面值 === 被遮蔽的旧 token 值 → 视觉变化
const alphaBucket = new Map(); // 半透明衍生色（token 是不透明色，不能直换）
const other = new Map(); // 两套都不匹配

const lineOf = (idx) => stripped.slice(0, idx).split("\n").length;

for (const m of stripped.matchAll(COLOR)) {
  if (inRoot(m.index)) continue;
  const raw = m[0];
  const k = norm(raw);
  const line = lineOf(m.index);
  const newHit = byValue.get(k);
  const oldHit = oldByValue.get(k);

  if (newHit) {
    stage1.push({ line, raw, token: newHit[0], index: m.index });
    continue;
  }
  if (oldHit) {
    // 旧调色板的不透明色 → 阶段2 可换成对应新 token
    const newVal = newVars.get(oldHit[0]);
    stage2.push({ line, raw, oldToken: oldHit[0], newValue: newVal ? norm(newVal) : null, index: m.index });
    continue;
  }
  // 半透明衍生：rgb 三元组匹配某 token，但 alpha ≠ 1。
  //
  // 这类可以用 **rgb 三元组 token** 做到可证明等价：
  //   :root { --accent-rgb: 246, 181, 107 }
  //   background: rgba(var(--accent-rgb), 0.12)
  // 展开后与原字面值逐字节相同（已由 css-audit --resolve 验证），且不依赖 color-mix()
  // ——本项目有 WKWebView 使用场景，且全站尚未用过任何现代颜色函数，故不引入 color-mix。
  //
  // 分流关键：base rgb 等于**当前生效**token 值 → 阶段1（零视觉变化）；
  //           只等于**被遮蔽的旧**token 值 → 阶段2（换成新值会改变渲染）。
  const rgbm = k.match(/^rgba?\(\s*([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/);
  if (rgbm && rgbm[4] !== undefined) {
    const base = `#${[rgbm[1], rgbm[2], rgbm[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
    const bn = byValue.get(base);
    const bo = oldByValue.get(base);
    if (bn) {
      // base 就是生效值 → 可证明等价
      stage1.push({ line, raw, token: bn[0], alpha: rgbm[4], rgbToken: `${bn[0]}-rgb`, index: m.index });
      continue;
    }
    if (bo) {
      stage2.push({
        line,
        raw,
        oldToken: bo[0],
        alpha: rgbm[4],
        newValue: newVars.get(bo[0]) ? norm(newVars.get(bo[0])) : null,
        index: m.index,
      });
      continue;
    }
  }
  if (!other.has(k)) other.set(k, { n: 0, lines: [] });
  const o = other.get(k);
  o.n++;
  if (o.lines.length < 6) o.lines.push(line);
}

console.log(`# Token 化替换计划 — ${file}`);
console.log(`\n:root 块数：${blocks.length}；旧块变量 ${oldVars.size} 个，新块变量 ${newVars.size} 个`);

console.log(`\n## 阶段1 · 零风险替换（字面值 === 当前生效 token 值）：${stage1.length} 处`);
const g1 = new Map();
for (const s of stage1) {
  const k = s.alpha !== undefined ? `${norm(s.raw)} -> rgba(var(${s.rgbToken}), ${s.alpha})` : `${norm(s.raw)} -> var(${s.token})`;
  if (!g1.has(k)) g1.set(k, []);
  g1.get(k).push(s.line);
}
for (const [k, lines] of [...g1].sort((a, z) => z[1].length - a[1].length)) {
  console.log(`   ${k}  ×${lines.length}   行 ${lines.slice(0, 10).join(", ")}${lines.length > 10 ? " ..." : ""}`);
}

console.log(`\n## 阶段2 · 视觉变化（字面值 === 被遮蔽的旧 token 值 → 换成新值）：${stage2.length} 处`);
const g2 = new Map();
for (const s of stage2) {
  const k =
    s.alpha !== undefined
      ? `${norm(s.raw)} (旧${s.oldToken}衍生) -> rgba(var(${s.oldToken}-rgb), ${s.alpha})  [新base ${s.newValue}]`
      : `${norm(s.raw)} (旧${s.oldToken}) -> var(${s.oldToken}) = ${s.newValue}`;
  if (!g2.has(k)) g2.set(k, []);
  g2.get(k).push(s.line);
}
for (const [k, lines] of [...g2].sort((a, z) => z[1].length - a[1].length)) {
  console.log(`   ${k}  ×${lines.length}   行 ${lines.slice(0, 10).join(", ")}${lines.length > 10 ? " ..." : ""}`);
}

const alphaFromOld = [...alphaBucket.entries()].filter(([, v]) => v.fromOld);
console.log(
  `\n## 半透明衍生色（token 为不透明色，不能直接替换）：${[...alphaBucket.values()].reduce((s, v) => s + v.n, 0)} 处 / ${alphaBucket.size} 个`,
);
console.log(`   其中 rgb 只匹配【旧】调色板的：${alphaFromOld.length} 个 —— 这些也是旧皮肤遗留，属阶段2 范围但需 color-mix/alpha 阶梯方案`);
for (const [k, v] of [...alphaBucket].sort((a, z) => z[1].n - a[1].n).slice(0, 24)) {
  console.log(`   ${k}  ×${v.n}   行 ${v.lines.join(", ")}`);
}

console.log(`\n## 两套都不匹配（独立色值）：${[...other.values()].reduce((s, v) => s + v.n, 0)} 处 / ${other.size} 个`);
for (const [k, v] of [...other].sort((a, z) => z[1].n - a[1].n).slice(0, 20)) {
  console.log(`   ${k}  ×${v.n}   行 ${v.lines.join(", ")}`);
}

if (jsonFlag !== -1) {
  const out = process.argv[jsonFlag + 1];
  writeFileSync(out, JSON.stringify({ stage1, stage2 }, null, 2), "utf8");
  console.log(`\n已写出机读计划：${out}`);
}
