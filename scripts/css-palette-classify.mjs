#!/usr/bin/env node
// scripts/css-palette-classify.mjs
// 把硬编码色值按「来自哪套调色板」归类。
//
// 缘起：css-audit.mjs colors 报出 121 个唯一硬编码色值 / 225 处出现。但「有硬编码」只是症状。
// 观察到多个字面值恰好等于**第一套 :root（已被第二套遮蔽的旧皮肤）**的变量值 —— 若成立，
// 说明全站当前渲染的是**两套调色板的混合体**：旧值以字面量形式活着，新值以 token 形式生效。
// 这比「变量没贯彻」严重得多，是真正的根因。本脚本用计算验证该假设，而不是靠眼看色号相近。
//
// 方法：解析两套 :root 的变量值 → 提取其 rgb 三元组 → 把每个硬编码色值（含 rgba 的任意 alpha）
// 的 rgb 三元组去比对，命中即归类为「旧调色板 / 新调色板 / 两者相同 / 都不是」。

import { readFileSync } from "node:fs";

const file = process.argv[2] || "src/styles.css";
const css = readFileSync(file, "utf8");

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, " ");
}

// 取出所有 :root 块（按出现顺序），解析其中的 --var: value
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
    const body = src.slice(m.index + m[0].length, i - 1);
    const vars = new Map();
    for (const dm of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
      vars.set(dm[1], dm[2].trim());
    }
    out.push(vars);
  }
  return out;
}

function hexToRgb(hex) {
  let h = hex.replace("#", "").toLowerCase();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length === 4) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length < 6) return null;
  return [Number.parseInt(h.slice(0, 2), 16), Number.parseInt(h.slice(2, 4), 16), Number.parseInt(h.slice(4, 6), 16)];
}

function rgbOf(value) {
  const v = value.trim().toLowerCase();
  if (v.startsWith("#")) return hexToRgb(v);
  const m = v.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (m) return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
  return null;
}

const blocks = rootBlocks(stripComments(css));
if (blocks.length < 2) {
  console.log(`只找到 ${blocks.length} 个 :root 块 —— 若已完成合并，本脚本的「新旧混合」判断不再适用。`);
}

// 建立 rgb -> token名 的反查（分别针对旧块/新块）
// 只把「本身就是一个纯色」的 token 建进反查索引。
//
// 为什么必须加这道过滤（这是本脚本第一版的真实 bug，差点得出错误结论）：
// 新 :root 里的 --shadow-card 值为
//   8px 10px 22px -8px rgba(109, 169, 255, 0.22), 20px 26px 52px -18px rgba(109, 169, 255, 0.3)
// 它是 box-shadow 复合值，内部**嵌着旧蓝 rgba(109,169,255)**。若不过滤，rgbOf() 会把这个
// 内嵌 rgb 当成 --shadow-card 的「颜色」，于是旧蓝被误判为「新调色板也有」，
// 大量旧皮肤遗留色被错误归入「③新旧同值 → 安全可换」桶 —— 一个静默的错误结论。
function isPureColor(value) {
  const v = value.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return true;
  // 单个 rgb()/rgba()/hsl() 函数调用，且后面没有别的内容
  return /^(rgba?|hsla?)\([^)]*\)$/.test(v);
}

function paletteIndex(vars) {
  const idx = new Map();
  for (const [name, value] of vars) {
    if (!isPureColor(value)) continue;
    const rgb = rgbOf(value);
    if (!rgb) continue;
    const key = rgb.join(",");
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push(name);
  }
  return idx;
}

const oldIdx = paletteIndex(blocks[0] ?? new Map());
const newIdx = paletteIndex(blocks[blocks.length - 1] ?? new Map());

// 扫描所有硬编码色值出现点（排除 :root 块内部，即 token 定义自身）
const withoutRoots = (() => {
  let s = stripComments(css);
  for (const m of [...s.matchAll(/:root\s*\{/g)].reverse()) {
    let d = 1;
    let i = m.index + m[0].length;
    for (; i < s.length && d > 0; i++) {
      if (s[i] === "{") d++;
      else if (s[i] === "}") d--;
    }
    s = s.slice(0, m.index) + s.slice(i);
  }
  return s;
})();

const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;
const buckets = { oldOnly: new Map(), newOnly: new Map(), both: new Map(), neither: new Map() };
let total = 0;
for (const m of withoutRoots.matchAll(COLOR)) {
  const raw = m[0].toLowerCase().replace(/\s+/g, " ");
  const rgb = rgbOf(raw);
  if (!rgb) continue;
  total++;
  const key = rgb.join(",");
  const inOld = oldIdx.get(key);
  const inNew = newIdx.get(key);
  const bucket = inOld && inNew ? "both" : inOld ? "oldOnly" : inNew ? "newOnly" : "neither";
  const label = raw;
  const b = buckets[bucket];
  if (!b.has(label)) b.set(label, { n: 0, tokens: inOld || inNew || [] });
  b.get(label).n++;
}

const sum = (b) => [...b.values()].reduce((s, v) => s + v.n, 0);
const show = (title, b, note) => {
  console.log(`\n## ${title}：${sum(b)} 处 / ${b.size} 个唯一值`);
  if (note) console.log(`   ${note}`);
  for (const [raw, v] of [...b].sort((a, z) => z[1].n - a[1].n)) {
    console.log(`   ${raw.padEnd(30)} ×${String(v.n).padEnd(3)} ${v.tokens.length ? `≈ ${v.tokens.join(" | ")}` : ""}`);
  }
};

console.log(`# 调色板归类 — ${file}`);
console.log(`\n:root 块数：${blocks.length}；硬编码色值出现总数（不含 token 定义自身）：${total}`);
show("① 仅匹配【旧】调色板（旧皮肤遗留，与生效 token 不一致 → 视觉不统一的根因）", buckets.oldOnly);
show("② 仅匹配【新】调色板（值正确，只是没走 token → 安全可换）", buckets.newOnly);
show("③ 新旧同值（如 --accent 两套一致 → 安全可换）", buckets.both);
show("④ 两套都不匹配（独立色值，需人判断：新增 token / 保留 / 归并到语义色）", buckets.neither);

console.log(`\n---\n小结：`);
console.log(`  旧调色板遗留：${sum(buckets.oldOnly)} 处  ← 这些位置渲染的是被遮蔽的旧色`);
console.log(`  可安全 token 化：${sum(buckets.newOnly) + sum(buckets.both)} 处`);
console.log(`  待人工判断：${sum(buckets.neither)} 处`);
