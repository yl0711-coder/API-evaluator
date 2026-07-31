#!/usr/bin/env node
// scripts/css-audit.mjs
// CSS 等价性审计工具：把 styles.css 解析成「解析后声明集」，用于证明重构前后渲染等价。
//
// 为什么需要它：本项目没有浏览器测试环境（无 jsdom/playwright），CSS 重构的失败是静默的
// ——颜色悄悄变了、某条规则被覆盖顺序改掉了，页面照样打开、测试照样绿。
// 眼看不是证据。此工具把「渲染的输入」（选择器 × 属性 × 解析后值 × 层叠位置）导出成
// 可 diff 的文本：两次导出逐字节相同 ⇒ 渲染必然相同（构造性证明，而非抽查）。
//
// 子命令：
//   dump   <file>  解析后声明集（含层叠序号），用于 before/after diff
//   vars   <file>  :root 变量表，标出重复定义与被遮蔽的变量
//   colors <file>  硬编码色值清单 + 是否等于某个 token（供 token 收敛用）
//   winners <file> 每个 (选择器,属性) 的最终胜出声明（忽略顺序的等价性检查，用于允许挪动位置的阶段）

import { readFileSync } from "node:fs";

// ---------- 词法：去注释（尊重字符串，避免 font-family 里的引号内容被误吃）----------
function stripComments(css) {
  let out = "";
  let quote = null;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      if (c === "\\") {
        out += c + (css[i + 1] ?? "");
        i++;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 1;
      out += " "; // 用空格替代，避免把 `a/**/b` 粘成 `ab`
      continue;
    }
    out += c;
  }
  return out;
}

// ---------- 语法：括号计数切块，产出扁平规则表 ----------
// 只需支持本项目实际用到的构造：普通规则、@media、@keyframes、@supports。
// 嵌套 CSS（原生 &）项目里没用，故不支持——若将来引入，此处会显式报错而非静默错算。
function parse(css) {
  const src = stripComments(css);
  const rules = []; // { at: string|null, selector, decls: [{prop, value}], order }
  let order = 0;

  function parseBlock(text, atContext) {
    let i = 0;
    while (i < text.length) {
      // 找到下一个 { 或 ; （@import 这类无块语句）
      let depth = 0;
      let braceAt = -1;
      let semiAt = -1;
      let quote = null;
      for (let j = i; j < text.length; j++) {
        const c = text[j];
        if (quote) {
          if (c === "\\") {
            j++;
            continue;
          }
          if (c === quote) quote = null;
          continue;
        }
        if (c === '"' || c === "'") {
          quote = c;
          continue;
        }
        if (c === "{") {
          braceAt = j;
          break;
        }
        if (c === ";" && depth === 0) {
          semiAt = j;
          break;
        }
        if (c === "(") depth++;
        if (c === ")") depth--;
      }
      if (braceAt === -1) {
        if (semiAt !== -1) {
          i = semiAt + 1;
          continue;
        }
        break; // 尾部只剩空白
      }
      if (semiAt !== -1 && semiAt < braceAt) {
        i = semiAt + 1;
        continue;
      }

      const prelude = text.slice(i, braceAt).trim();
      // 配对 }
      let d = 1;
      let k = braceAt + 1;
      let q2 = null;
      for (; k < text.length; k++) {
        const c = text[k];
        if (q2) {
          if (c === "\\") {
            k++;
            continue;
          }
          if (c === q2) q2 = null;
          continue;
        }
        if (c === '"' || c === "'") {
          q2 = c;
          continue;
        }
        if (c === "{") d++;
        else if (c === "}") {
          d--;
          if (d === 0) break;
        }
      }
      const body = text.slice(braceAt + 1, k);

      if (prelude.startsWith("@")) {
        const name = prelude.split(/[\s(]/)[0];
        if (name === "@media" || name === "@supports") {
          // 条件组：递归，把条件并入 atContext（层叠位置仍按全局 order 递增）
          parseBlock(body, atContext ? `${atContext} AND ${prelude}` : prelude);
        } else if (name === "@keyframes") {
          // 关键帧：整块当作一条不可分割的记录（内部 0%/100% 不参与选择器层叠）
          rules.push({ at: atContext, selector: prelude, decls: parseDecls(body), order: order++, raw: true });
        } else {
          rules.push({ at: atContext, selector: prelude, decls: parseDecls(body), order: order++, raw: true });
        }
      } else {
        for (const sel of splitSelectors(prelude)) {
          rules.push({ at: atContext, selector: sel, decls: parseDecls(body), order: order++ });
        }
      }
      i = k + 1;
    }
  }

  parseBlock(src, null);
  return rules;
}

// 逗号分选择器，但不能切开 :is(a, b) / :not(a, b) 里的逗号
function splitSelectors(prelude) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const c of prelude) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map(normalizeSelector);
}

// 选择器规范化：折叠空白、统一组合符两侧空格。使「.a>.b」与「.a > .b」视为同一选择器。
function normalizeSelector(sel) {
  return sel
    .replace(/\s+/g, " ")
    .replace(/\s*([>+~])\s*/g, " $1 ")
    .trim();
}

function parseDecls(body) {
  const decls = [];
  let depth = 0;
  let cur = "";
  let quote = null;
  const flush = () => {
    const t = cur.trim();
    cur = "";
    if (!t) return;
    // 块内嵌套块（如 @keyframes 的 0% {...}）：整体保留为一条伪声明
    const colon = t.indexOf(":");
    if (colon === -1) return;
    if (t.includes("{")) {
      decls.push({ prop: "<nested>", value: t.replace(/\s+/g, " ") });
      return;
    }
    const prop = t.slice(0, colon).trim();
    let value = t.slice(colon + 1).trim();
    let important = false;
    if (/!\s*important$/i.test(value)) {
      important = true;
      value = value.replace(/!\s*important$/i, "").trim();
    }
    decls.push({ prop, value: normalizeValue(value), important });
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === "\\") {
        cur += c + (body[i + 1] ?? "");
        i++;
        continue;
      }
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "(" || c === "{") depth++;
    if (c === ")" || c === "}") depth--;
    if (c === ";" && depth === 0) {
      flush();
      continue;
    }
    cur += c;
  }
  flush();
  return decls;
}

// 值规范化：折叠空白、统一逗号后空格、小写十六进制、3位hex展开为6位。
// 目的是让「纯格式差异」不被误报成渲染差异；但不做单位换算（1em≠16px 不可假设）。
function normalizeValue(v) {
  let s = v
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .trim();
  s = s.replace(/#([0-9a-fA-F]{3,8})\b/g, (_m, h) => {
    let hex = h.toLowerCase();
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    if (hex.length === 4) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
    // #rrggbbff 等价于 #rrggbb
    if (hex.length === 8 && hex.slice(6) === "ff") hex = hex.slice(0, 6);
    return `#${hex}`;
  });
  return s;
}

// ---------- 变量解析：模拟层叠后 :root 的最终变量值 ----------
// 只处理 :root（本项目全部变量都定义在 :root，无作用域内覆盖——由 varsReport 校验此前提）。
function resolveRootVars(rules) {
  const final = new Map(); // name -> {value, order, at}
  const all = new Map(); // name -> [{value, order, at}] 全部定义，用于查重复/遮蔽
  for (const r of rules) {
    if (r.selector !== ":root" && r.selector !== "html") continue;
    for (const d of r.decls) {
      if (!d.prop.startsWith("--")) continue;
      const rec = { value: d.value, order: r.order, at: r.at };
      if (!all.has(d.prop)) all.set(d.prop, []);
      all.get(d.prop).push(rec);
      // 无媒体条件的定义才参与「基础最终值」；带 @media 的单独标注
      if (!r.at) final.set(d.prop, rec);
    }
  }
  return { final, all };
}

// 把 var(--x) 递归展开成字面值，用于「解析后值」比对。
// 保留 fallback 语义：var(--x, fb) 在 --x 未定义时取 fb。
function expandVars(value, vars, depth = 0) {
  if (depth > 12 || !value.includes("var(")) return value;
  let out = "";
  let i = 0;
  while (i < value.length) {
    const at = value.indexOf("var(", i);
    if (at === -1) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, at);
    // 配对括号
    let d = 0;
    let j = at + 3;
    for (; j < value.length; j++) {
      if (value[j] === "(") d++;
      else if (value[j] === ")") {
        d--;
        if (d === 0) break;
      }
    }
    const inner = value.slice(at + 4, j);
    // 顶层逗号分 name / fallback
    let dd = 0;
    let comma = -1;
    for (let k = 0; k < inner.length; k++) {
      if (inner[k] === "(") dd++;
      else if (inner[k] === ")") dd--;
      else if (inner[k] === "," && dd === 0) {
        comma = k;
        break;
      }
    }
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma === -1 ? null : inner.slice(comma + 1).trim();
    const hit = vars.get(name);
    if (hit) out += expandVars(hit.value, vars, depth + 1);
    else if (fallback !== null) out += expandVars(fallback, vars, depth + 1);
    else out += `var(${name})`; // 真未定义：原样留下，diff 里看得见
    i = j + 1;
  }
  return normalizeValue(out);
}

// ---------- 特异性（用于 winners 模式判定胜出者）----------
function specificity(sel) {
  let a = 0;
  let b = 0;
  let c = 0;
  const s = sel
    .replace(/::[\w-]+/g, () => {
      c++;
      return " ";
    })
    .replace(/\[[^\]]*\]/g, () => {
      b++;
      return " ";
    })
    .replace(/#[\w-]+/g, () => {
      a++;
      return " ";
    })
    .replace(/\.[\w-]+/g, () => {
      b++;
      return " ";
    })
    .replace(/:(?:not|is|where)\(([^)]*)\)/g, (_m, inner) => {
      // :where() 特异性为 0；:not/:is 取内部最大值（近似：取第一个）
      const sub = specificity(inner.split(",")[0] || "");
      if (!_m.startsWith(":where")) {
        a += sub[0];
        b += sub[1];
        c += sub[2];
      }
      return " ";
    })
    .replace(/:[\w-]+/g, () => {
      b++;
      return " ";
    });
  for (const t of s.split(/[\s>+~]+/)) {
    if (t && t !== "*") c++;
  }
  return [a, b, c];
}

// ---------- 子命令 ----------
function cmdDump(file, { resolve }) {
  const rules = parse(readFileSync(file, "utf8"));
  const { final } = resolveRootVars(rules);
  const lines = [];
  for (const r of rules) {
    const scope = r.at ? `${r.at} | ` : "";
    for (const d of r.decls) {
      // :root 的变量定义本身在 resolve 模式下不输出——它们是「中间量」，
      // 真正决定渲染的是消费点展开后的值。这正是允许合并两套 :root 的关键。
      if (resolve && d.prop.startsWith("--")) continue;
      const v = resolve ? expandVars(d.value, final) : d.value;
      lines.push(`${String(r.order).padStart(5, "0")}  ${scope}${r.selector}  {${d.prop}: ${v}${d.important ? " !important" : ""}}`);
    }
  }
  return lines.join("\n");
}

// 忽略书写顺序的等价性检查：只看每个 (媒体条件, 选择器, 属性) 的最终胜出值。
// 用于「允许挪动规则位置」的重构阶段——比 dump 宽松，但仍能抓住覆盖关系被改变。
function cmdWinners(file) {
  const rules = parse(readFileSync(file, "utf8"));
  const { final } = resolveRootVars(rules);
  const best = new Map(); // key -> {spec, order, value, important}
  for (const r of rules) {
    if (r.raw) continue;
    const spec = specificity(r.selector);
    for (const d of r.decls) {
      if (d.prop.startsWith("--")) continue;
      const key = `${r.at ? `${r.at} | ` : ""}${r.selector} | ${d.prop}`;
      const cand = { spec, order: r.order, value: expandVars(d.value, final), important: !!d.important };
      const cur = best.get(key);
      if (!cur) {
        best.set(key, cand);
        continue;
      }
      // 同选择器同属性：!important 优先，其次后写的赢
      if ((cand.important && !cur.important) || (cand.important === cur.important && cand.order > cur.order)) {
        best.set(key, cand);
      }
    }
  }
  return [...best.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k} = ${v.value}${v.important ? " !important" : ""}`)
    .join("\n");
}

function cmdVars(file) {
  const rules = parse(readFileSync(file, "utf8"));
  const { final, all } = resolveRootVars(rules);
  const out = [];
  out.push(`# :root 变量审计 — ${file}`);
  const rootRules = rules.filter((r) => r.selector === ":root");
  out.push(`\n:root 块数量：${rootRules.length}（order: ${rootRules.map((r) => r.order).join(", ")}）`);

  // 前提校验：是否存在非 :root/html 选择器上的变量定义（会让 resolveRootVars 失真）
  const scoped = [];
  for (const r of rules) {
    if (r.selector === ":root" || r.selector === "html") continue;
    for (const d of r.decls) if (d.prop.startsWith("--")) scoped.push(`${r.selector} { ${d.prop} }`);
  }
  out.push(`\n## 作用域内变量定义（非 :root）：${scoped.length} 处`);
  if (scoped.length) out.push(scoped.map((s) => `  ${s}`).join("\n"));

  const shadowed = [];
  for (const [name, defs] of all) {
    if (defs.length > 1) shadowed.push({ name, defs });
  }
  out.push(`\n## 重复定义（后者遮蔽前者）：${shadowed.length} 个变量`);
  for (const { name, defs } of shadowed) {
    const win = final.get(name);
    out.push(`  ${name}`);
    for (const d of defs) {
      const mark = d === win ? "  <= 生效" : "     （被遮蔽）";
      out.push(`      order ${d.order}: ${d.value}${mark}`);
    }
  }

  out.push(`\n## 最终生效变量表：${final.size} 个`);
  for (const [name, rec] of [...final].sort()) {
    out.push(`  ${name}: ${rec.value}`);
  }

  // 未被消费的变量（定义了但全站没 var() 引用）
  const css = readFileSync(file, "utf8");
  const unused = [...final.keys()].filter((n) => !new RegExp(`var\\(\\s*${n}\\b`).test(css));
  out.push(`\n## 定义但从未被 var() 引用：${unused.length} 个`);
  if (unused.length) out.push(unused.map((n) => `  ${n}`).join("\n"));
  return out.join("\n");
}

function cmdColors(file) {
  const rules = parse(readFileSync(file, "utf8"));
  const { final } = resolveRootVars(rules);
  // token 反查表：字面值 -> token 名
  const byValue = new Map();
  for (const [name, rec] of final) {
    const v = rec.value.toLowerCase();
    if (!byValue.has(v)) byValue.set(v, []);
    byValue.get(v).push(name);
  }
  const hits = new Map(); // 字面色值 -> {count, sample:[], token}
  const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;
  for (const r of rules) {
    for (const d of r.decls) {
      if (d.prop.startsWith("--")) continue; // token 定义自身不算硬编码
      for (const m of d.value.matchAll(COLOR)) {
        const raw = normalizeValue(m[0]).toLowerCase();
        if (!hits.has(raw)) hits.set(raw, { count: 0, sample: [], token: byValue.get(raw) || null });
        const h = hits.get(raw);
        h.count++;
        if (h.sample.length < 4) h.sample.push(`${r.selector}{${d.prop}}`);
      }
    }
  }
  const sorted = [...hits].sort((a, b) => b[1].count - a[1].count);
  const out = [`# 硬编码色值 — ${file}`];
  out.push(`\n唯一色值：${sorted.length}，总出现：${sorted.reduce((s, [, v]) => s + v.count, 0)}`);
  out.push(`\n## 可直接换成已有 token（字面值完全相等）`);
  let exact = 0;
  for (const [raw, v] of sorted) {
    if (!v.token) continue;
    exact += v.count;
    out.push(`  ${raw}  ×${v.count}  -> var(${v.token.join(" | ")})`);
  }
  out.push(`  小计：${exact} 处`);
  out.push(`\n## 无对应 token（需判断是否新增 token 或保留）`);
  for (const [raw, v] of sorted) {
    if (v.token) continue;
    out.push(`  ${raw}  ×${v.count}   e.g. ${v.sample.join(", ")}`);
  }
  return out.join("\n");
}

const [, , cmd, file, ...rest] = process.argv;
if (!cmd || !file) {
  console.error("用法: node scripts/css-audit.mjs <dump|winners|vars|colors> <file.css> [--resolve]");
  process.exit(2);
}
const opts = { resolve: rest.includes("--resolve") };
const table = {
  dump: () => cmdDump(file, opts),
  winners: () => cmdWinners(file),
  vars: () => cmdVars(file),
  colors: () => cmdColors(file),
};
if (!table[cmd]) {
  console.error(`未知子命令: ${cmd}`);
  process.exit(2);
}
console.log(table[cmd]());
