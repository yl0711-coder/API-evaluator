#!/usr/bin/env node
// scripts/css-stage2-plan.mjs
// 阶段2 计划：把「旧皮肤遗留色」收敛到当前生效的语义 token（**会改变渲染**）。
//
// 为什么单独一个脚本、而不是继续用 css-tokenize-plan.mjs：
// 阶段1 已经删掉了被完全遮蔽的旧 :root，于是"旧调色板"在文件里不再有出处可读。
// 旧值必须作为**显式数据**钉在这里（下表来自阶段1 之前的实测审计，git 历史可查），
// 而不是从某个还存在的块里推断——推断会随文件变化而静默失效。
//
// 每条映射都标注了「旧值 → 新值」和语义理由，供人过目后再执行。
// 用法: node scripts/css-stage2-plan.mjs [file] [--json out.json]

import { readFileSync, writeFileSync } from "node:fs";

// 旧皮肤调色板（v0.7.0 之前 styles.css 第 1 个 :root 的值，已于阶段1 移除）
// → 当前生效 token 名。用户已决定：以新皮肤（Aurora Console）为准。
const OLD_PALETTE = [
  { old: "#08111f", token: "--bg", note: "底色/深色面板底" },
  { old: "#101b2e", token: "--panel-strong", note: "强调面板底" },
  { old: "rgba(14, 24, 40, 0.84)", token: "--panel", note: "面板底（旧为半透明）" },
  { old: "#f5f0df", token: "--text", note: "正文色（旧为暖白）" },
  { old: "#91a0b7", token: "--muted", note: "次要文字" },
  { old: "#25334a", token: "--line", note: "描边" },
  { old: "#62dba7", token: "--good", note: "成功/通过" },
  { old: "#f06d7d", token: "--bad", note: "失败/危险" },
  { old: "#6da9ff", token: "--blue", note: "信息/链接" },
  { old: "rgba(255, 255, 255, 0.055)", token: "--soft", note: "极淡叠色" },
];

const file = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "src/styles.css";
const jsonIdx = process.argv.indexOf("--json");
const css = readFileSync(file, "utf8");
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));

// 当前生效 token 表（唯一 :root）
const rm = /:root\s*\{/.exec(stripped);
let rootStart = -1;
let rootEnd = -1;
const vars = new Map();
if (rm) {
  let d = 1;
  let i = rm.index + rm[0].length;
  for (; i < stripped.length && d > 0; i++) {
    if (stripped[i] === "{") d++;
    else if (stripped[i] === "}") d--;
  }
  rootStart = rm.index;
  rootEnd = i;
  for (const dm of stripped.slice(rm.index + rm[0].length, i - 1).matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
    vars.set(dm[1], dm[2].trim());
  }
}
const inRoot = (i) => i >= rootStart && i < rootEnd;

function tripletOf(hex) {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((o) => Number.parseInt(h.slice(o, o + 2), 16));
}

const edits = [];
const report = [];

for (const entry of OLD_PALETTE) {
  const newVal = vars.get(entry.token);
  if (!newVal) {
    report.push({ ...entry, status: "SKIP", reason: `当前 :root 无 ${entry.token}` });
    continue;
  }
  const hits = [];

  // ① 不透明形式：旧字面值整体出现
  const litRe = new RegExp(entry.old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*"), "gi");
  for (const m of stripped.matchAll(litRe)) {
    if (inRoot(m.index)) continue;
    hits.push({ index: m.index, raw: m[0], to: `var(${entry.token})`, kind: "opaque" });
  }

  // ② 半透明衍生：rgba(旧三元组, a) → rgba(var(--token-rgb), a)
  if (/^#[0-9a-fA-F]{6}$/.test(entry.old)) {
    const [r, g, b] = tripletOf(entry.old);
    const re = new RegExp(`rgba?\\(\\s*${r}\\s*,\\s*${g}\\s*,\\s*${b}\\s*,\\s*([\\d.]+)\\s*\\)`, "g");
    for (const m of stripped.matchAll(re)) {
      if (inRoot(m.index)) continue;
      hits.push({ index: m.index, raw: m[0], to: `rgba(var(${entry.token}-rgb), ${m[1]})`, kind: "alpha", alpha: m[1] });
    }
  }

  if (hits.length) edits.push(...hits.map((h) => ({ ...h, token: entry.token, oldBase: entry.old, newBase: newVal, note: entry.note })));
  report.push({
    ...entry,
    newVal,
    status: hits.length ? "PLAN" : "NONE",
    count: hits.length,
    opaque: hits.filter((h) => h.kind === "opaque").length,
    alpha: hits.filter((h) => h.kind === "alpha").length,
  });
}

const lineOf = (i) => stripped.slice(0, i).split("\n").length;

console.log(`# 阶段2 计划 · 旧皮肤遗留色 → 语义 token（会改变渲染）— ${file}\n`);
console.log(`| 语义 | 旧值(现渲染) | 新值(收敛后) | 不透明 | 半透明衍生 | 合计 |`);
console.log(`|---|---|---|---|---|---|`);
for (const r of report) {
  if (r.status === "NONE" || r.status === "SKIP") continue;
  console.log(`| ${r.note} \`${r.token}\` | \`${r.old}\` | \`${r.newVal}\` | ${r.opaque} | ${r.alpha} | **${r.count}** |`);
}
const totalOpaque = edits.filter((e) => e.kind === "opaque").length;
const totalAlpha = edits.filter((e) => e.kind === "alpha").length;
console.log(`\n合计 **${edits.length} 处**（不透明 ${totalOpaque} + 半透明衍生 ${totalAlpha}）`);

console.log(`\n## 受影响位置明细（按语义分组）`);
const byToken = new Map();
for (const e of edits) {
  if (!byToken.has(e.token)) byToken.set(e.token, []);
  byToken.get(e.token).push(e);
}
for (const [tok, list] of byToken) {
  const r = report.find((x) => x.token === tok);
  console.log(`\n### ${tok}（${r.note}）：${r.old} → ${r.newVal}，${list.length} 处`);
  const byRaw = new Map();
  for (const e of list) {
    const k = `${e.raw} -> ${e.to}`;
    if (!byRaw.has(k)) byRaw.set(k, []);
    byRaw.get(k).push(lineOf(e.index));
  }
  for (const [k, lines] of [...byRaw].sort((a, z) => z[1].length - a[1].length)) {
    console.log(`   ${k}  ×${lines.length}  行 ${lines.slice(0, 12).join(", ")}${lines.length > 12 ? " ..." : ""}`);
  }
}

if (jsonIdx !== -1) {
  const out = process.argv[jsonIdx + 1];
  writeFileSync(out, JSON.stringify({ edits }, null, 2), "utf8");
  console.log(`\n已写出机读计划：${out}（${edits.length} 处）`);
}
