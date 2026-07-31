// tests/css-tokens.test.mjs
// 结构守卫：styles.css 的 token 层不得退化。
//
// 背景（见 CHANGELOG v0.7.1）：历史上"MODERN SKIN"皮肤升级是**追加**一套 :root 到文件末尾，
// 靠书写顺序覆盖旧变量，旧 :root 原地留着。结果全站长期渲染**两套调色板的混合体**：
// 新值走 token 生效，旧值以硬编码字面量继续活着（如"失败"同时存在 #f06d7d 与 #ff7a8a 两种红）。
//
// 这类退化是静默的：页面照常打开、测试照常绿，只是颜色悄悄不一致。本测试把
// "只能有一套 :root" 钉成机读契约，让下一次皮肤改动无法用"再追加一层"的方式蒙混过去。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const css = readFileSync(join(root, "src", "styles.css"), "utf8");
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, " ");

test("styles.css 只能有一个 :root 块（禁止再用「末尾追加一套变量」的方式做皮肤覆盖）", () => {
  const count = [...stripped.matchAll(/:root\s*\{/g)].length;
  assert.equal(
    count,
    1,
    `发现 ${count} 个 :root 块。皮肤改动请**就地修改**唯一那套 token，` +
      "不要追加第二套靠顺序覆盖——那会让旧调色板的硬编码字面值继续渲染，产生新旧混合。",
  );
});

// 取出唯一 :root 的变量表
function rootVars() {
  const m = /:root\s*\{/.exec(stripped);
  if (!m) return new Map();
  let d = 1;
  let i = m.index + m[0].length;
  for (; i < stripped.length && d > 0; i++) {
    if (stripped[i] === "{") d++;
    else if (stripped[i] === "}") d--;
  }
  const vars = new Map();
  for (const dm of stripped.slice(m.index + m[0].length, i - 1).matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
    vars.set(dm[1], dm[2].trim());
  }
  return vars;
}

test("每个 --x-rgb 三元组与对应 --x 同源（防止改了不透明色却忘了改半透明衍生）", () => {
  const vars = rootVars();
  const mismatched = [];
  for (const [name, value] of vars) {
    if (!name.endsWith("-rgb")) continue;
    const base = name.slice(0, -4);
    const baseVal = vars.get(base);
    assert.ok(baseVal, `${name} 存在但 ${base} 不存在`);
    // --x 是 #rrggbb，--x-rgb 应是其十进制三元组
    const hm = /^#([0-9a-fA-F]{6})$/.exec(baseVal.trim());
    if (!hm) continue; // 非纯 hex（如 rgba/渐变）不参与本校验
    const expect = [0, 2, 4].map((o) => Number.parseInt(hm[1].slice(o, o + 2), 16)).join(", ");
    const actual = value
      .split(",")
      .map((s) => s.trim())
      .join(", ");
    if (actual !== expect) mismatched.push(`${name}: ${actual}  ≠  ${base}(${baseVal}) 的三元组 ${expect}`);
  }
  assert.deepEqual(mismatched, [], `rgb 三元组与基色不同源：\n  ${mismatched.join("\n  ")}`);
});

test("被 --x-rgb 取代的调色板字面值不应再出现（阶段1 已收敛的颜色不得回流）", () => {
  const vars = rootVars();
  // 对每个有 -rgb 三元组的 token，检查其字面 rgba(三元组, a) 形式是否又出现在声明里
  const withoutRoot = (() => {
    const m = /:root\s*\{/.exec(stripped);
    if (!m) return stripped;
    let d = 1;
    let i = m.index + m[0].length;
    for (; i < stripped.length && d > 0; i++) {
      if (stripped[i] === "{") d++;
      else if (stripped[i] === "}") d--;
    }
    return stripped.slice(0, m.index) + stripped.slice(i);
  })();

  const offenders = [];
  for (const [name, value] of vars) {
    if (!name.endsWith("-rgb")) continue;
    const trip = value
      .split(",")
      .map((s) => s.trim())
      .join(",\\s*");
    const re = new RegExp(`rgba?\\(\\s*${trip}\\s*[,)]`, "g");
    const hits = [...withoutRoot.matchAll(re)];
    if (hits.length) offenders.push(`${name} 的字面三元组 (${value}) 仍以硬编码出现 ${hits.length} 次 —— 应写成 rgba(var(${name}), a)`);
  }
  assert.deepEqual(offenders, [], `已 token 化的颜色出现回流：\n  ${offenders.join("\n  ")}`);
});
