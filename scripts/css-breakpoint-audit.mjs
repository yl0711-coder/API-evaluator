#!/usr/bin/env node
// scripts/css-breakpoint-audit.mjs
// 响应式断点审计：找出「同一选择器+属性在多个 max-width 断点里被设值」的重叠情况，
// 并按断点归类每个块管的是什么。
//
// 为什么需要：本项目 7 个 max-width 断点（1180/1080/980×2/960/860/760）是历史上
// 「哪个页面挤了就补一个」堆出来的，没有统一尺度。max-width 断点是**层层嵌套生效**的
// （760px 屏幕会同时命中 760/860/960/980/1080/1180 全部六个），所以：
//   - 同一 (选择器,属性) 在多个断点出现 → 后写的赢，可能是刻意的渐进覆盖，也可能是冲突
//   - 断点值相同却分散在文件多处 → 纯粹的组织问题，合并即可
//
// 本脚本只做**测绘与报告**，不改文件。判断哪些是刻意渐进、哪些是冲突，需要人看。

import { readFileSync } from "node:fs";

const file = process.argv[2] || "src/styles.css";
const css = readFileSync(file, "utf8");
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));

// 提取每个 @media 块：条件、起止偏移、内部规则
function mediaBlocks(src) {
  const out = [];
  const re = /@media[^{]*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let d = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && d > 0; i++) {
      if (src[i] === "{") d++;
      else if (src[i] === "}") d--;
    }
    const cond = m[0].slice(6, -1).trim();
    out.push({
      cond,
      body: src.slice(m.index + m[0].length, i - 1),
      start: m.index,
      end: i,
      line: src.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

// 解析块内的规则（选择器 -> 属性列表）
function rulesOf(body) {
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(body))) {
    const sels = m[1]
      .split(",")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const props = [];
    for (const decl of m[2].split(";")) {
      const c = decl.indexOf(":");
      if (c === -1) continue;
      props.push({
        prop: decl.slice(0, c).trim(),
        value: decl
          .slice(c + 1)
          .replace(/\s+/g, " ")
          .trim(),
      });
    }
    for (const sel of sels) rules.push({ sel, props });
  }
  return rules;
}

const blocks = mediaBlocks(stripped);
const widthBlocks = [];
const featureBlocks = [];
for (const b of blocks) {
  const w = /max-width:\s*(\d+)px/.exec(b.cond);
  if (w) widthBlocks.push({ ...b, px: Number(w[1]) });
  else featureBlocks.push(b);
}

console.log(`# 响应式断点审计 — ${file}\n`);
console.log(`max-width 断点块：${widthBlocks.length} 个；特性查询块（prefers-* 等）：${featureBlocks.length} 个\n`);

// 断点值 -> 块列表（找出「同一断点值分散多处」）
const byPx = new Map();
for (const b of widthBlocks) {
  if (!byPx.has(b.px)) byPx.set(b.px, []);
  byPx.get(b.px).push(b);
}
console.log(`## 断点清单（按宽度降序 = 生效叠加顺序）\n`);
console.log(`| 断点 | 块数 | 位置(行) | 规则数 | 管什么 |`);
console.log(`|---|---|---|---|---|`);
for (const px of [...byPx.keys()].sort((a, z) => z - a)) {
  const list = byPx.get(px);
  const rules = list.flatMap((b) => rulesOf(b.body));
  const sels = [...new Set(rules.map((r) => r.sel))];
  const gist = sels.slice(0, 4).join(", ") + (sels.length > 4 ? ` …(共${sels.length})` : "");
  console.log(
    `| ${px}px | ${list.length}${list.length > 1 ? " ⚠️分散" : ""} | ${list.map((b) => b.line).join(", ")} | ${rules.length} | ${gist} |`,
  );
}

// 同一 (选择器,属性) 跨断点重复设值
const hits = new Map(); // "sel|prop" -> [{px, value, line}]
for (const b of widthBlocks) {
  for (const r of rulesOf(b.body)) {
    for (const p of r.props) {
      const k = `${r.sel}|${p.prop}`;
      if (!hits.has(k)) hits.set(k, []);
      hits.get(k).push({ px: b.px, value: p.value, line: b.line });
    }
  }
}
const overlaps = [...hits].filter(([, v]) => v.length > 1);
console.log(`\n## 跨断点重复设值：${overlaps.length} 处 (选择器,属性)\n`);
if (overlaps.length) {
  console.log(`max-width 是叠加生效的（窄屏命中所有更大的断点），故同一属性在多个断点出现时**最窄的那个赢**。`);
  console.log(`若各断点值相同 → 冗余，可删；值不同 → 需确认是刻意的渐进覆盖。\n`);
  for (const [k, v] of overlaps) {
    const [sel, prop] = k.split("|");
    const sameValue = new Set(v.map((x) => x.value)).size === 1;
    console.log(`   ${sel} { ${prop} }  ${sameValue ? "【各断点同值 → 冗余】" : "【值不同 → 渐进覆盖?】"}`);
    for (const x of [...v].sort((a, z) => z.px - a.px)) {
      console.log(`      ${String(x.px).padStart(4)}px (行 ${x.line}): ${x.value}`);
    }
  }
}

// 特性查询块
console.log(`\n## 特性查询块`);
for (const b of featureBlocks) {
  const rules = rulesOf(b.body);
  console.log(`   行 ${b.line}: ${b.cond}  —— ${rules.length} 条规则`);
}
