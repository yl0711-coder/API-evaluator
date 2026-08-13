// tests/css-audit.test.mjs
// 给 scripts/css-audit.mjs（CSS 等价性审计工具）本身做测试。
//
// 为什么工具需要测试：它的输出被当作「重构前后渲染等价」的证据。
// 一个错的审计工具比没有工具更危险——它会给出虚假的绿灯（equivalence-change 技能第 5 条：
// 报警时先怀疑自己的工具；反过来说，「没报警」也可能是工具瞎了）。
// 这里用**手工可验算**的小样本钉住解析器行为，尤其是那些容易写错的边界：
// 注释里的花括号、字符串里的分号、@media 嵌套、逗号选择器展开、var() fallback。
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const TOOL = join(root, "scripts", "css-audit.mjs");

function run(cmd, css, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), "cssaudit-"));
  const f = join(dir, "t.css");
  writeFileSync(f, css, "utf8");
  try {
    return execFileSync(process.execPath, [TOOL, cmd, f, ...extra], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("逗号选择器展开成多条，声明顺序与层叠序号保留", () => {
  const out = run("dump", `.a, .b { color: red; margin: 0 }\n.c { color: blue }`);
  const lines = out.trim().split("\n");
  // .a{color} .a{margin} .b{color} .b{margin} .c{color} = 5 条
  assert.equal(lines.length, 5);
  assert.match(lines[0], /\.a\s+{color: red}/);
  assert.match(lines[2], /\.b\s+{color: red}/);
  // .c 的 order 必须大于 .a/.b（层叠位置靠后）
  const orderOf = (l) => Number(l.slice(0, 5));
  assert.ok(orderOf(lines[4]) > orderOf(lines[0]));
});

test("注释里的花括号与分号不破坏切块", () => {
  const out = run("dump", `/* } ; { */ .a { color: red }\n.b { color: blue }`);
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\.a\s+{color: red}/);
  assert.match(lines[1], /\.b\s+{color: blue}/);
});

test("字符串里的分号/花括号不被当作分隔符", () => {
  const out = run("dump", `.a { content: "a;b{c}"; color: red }`);
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /content: "a;b\{c\}"/);
  assert.match(lines[1], /color: red/);
});

test("font-family 里的引号内容不被注释剥离逻辑吃掉", () => {
  const out = run("dump", `.a { font-family: "SF Mono", monospace }`);
  assert.match(out, /font-family: "SF Mono", monospace/);
});

test("@media 条件并入作用域，且内部规则参与全局层叠序", () => {
  const out = run("dump", `.a { color: red }\n@media (max-width: 700px) { .a { color: blue } }`);
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.ok(!lines[0].includes("@media"));
  assert.match(lines[1], /@media \(max-width: 700px\) \| \.a\s+{color: blue}/);
});

test("--resolve 展开 var()，并把 :root 变量定义本身从输出里剔除", () => {
  const css = `:root { --c: #abc }\n.a { color: var(--c) }`;
  const plain = run("dump", css);
  const resolved = run("dump", css, ["--resolve"]);
  assert.match(plain, /--c: #aabbcc/); // 未 resolve 时变量定义在输出里
  assert.match(plain, /color: var\(--c\)/);
  assert.ok(!resolved.includes("--c:"), "resolve 模式不应输出变量定义自身");
  assert.match(resolved, /color: #aabbcc/, "消费点应展开为字面值");
});

test("var() fallback 语义：变量未定义时取 fallback", () => {
  const out = run("dump", `.a { color: var(--nope, #123456) }`, ["--resolve"]);
  assert.match(out, /color: #123456/);
});

test("var() 嵌套展开（变量引用变量）", () => {
  const out = run("dump", `:root { --a: #111111; --b: var(--a) }\n.x { color: var(--b) }`, ["--resolve"]);
  assert.match(out, /color: #111111/);
});

test("后定义的 :root 变量遮蔽先定义的（对应本项目两套 :root）", () => {
  const css = `:root { --c: #111111 }\n.mid { color: var(--c) }\n:root { --c: #222222 }`;
  const vars = run("vars", css);
  assert.match(vars, /:root 块数量：2/);
  assert.match(vars, /#222222\s+<= 生效/);
  assert.match(vars, /#111111\s+（被遮蔽）/);
  // 关键语义：CSS 变量是「最终值」生效，中间位置的消费点也拿到后定义的值
  const resolved = run("dump", css, ["--resolve"]);
  assert.match(resolved, /\.mid\s+{color: #222222}/);
});

test("3位/4位/8位 hex 规范化为等价 6 位形式", () => {
  const out = run("dump", `.a { color: #ABC; border-color: #AABBCCFF }`);
  assert.match(out, /color: #aabbcc/);
  assert.match(out, /border-color: #aabbcc/);
});

test("!important 被识别并在输出中标注", () => {
  const out = run("dump", `.a { color: red !important }`);
  assert.match(out, /color: red !important/);
});

test("winners：同选择器同属性，后写的值胜出（忽略书写位置的等价检查）", () => {
  const out = run("winners", `.a { color: red }\n.b { color: green }\n.a { color: blue }`);
  const lines = out.trim().split("\n");
  assert.deepEqual(lines, [".a | color = blue", ".b | color = green"]);
});

test("winners：!important 胜过后写的普通声明", () => {
  const out = run("winners", `.a { color: red !important }\n.a { color: blue }`);
  assert.match(out, /\.a \| color = red !important/);
});

test("选择器空白规范化：.a>.b 与 .a > .b 视为同一选择器", () => {
  const out = run("winners", `.a>.b { color: red }\n.a  >  .b { color: blue }`);
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 1, "两种写法应归并为一条，后者胜出");
  assert.match(lines[0], /color = blue/);
});

test("colors：字面值等于某 token 时给出替换建议，不把 token 定义自身算作硬编码", () => {
  const out = run("colors", `:root { --accent: #f6b56b }\n.a { color: #F6B56B }\n.b { border-color: #010203 }`);
  assert.match(out, /#f6b56b\s+×1\s+-> var\(--accent\)/);
  assert.match(out, /#010203/);
  // token 定义自身（:root 里的 --accent）不应被计入出现次数
  assert.match(out, /#f6b56b\s+×1\b/);
});

test("@keyframes 内部的百分比块不被当作选择器规则", () => {
  const out = run("winners", `@keyframes spin { 0% { transform: rotate(0) } 100% { transform: rotate(1turn) } }\n.a { color: red }`);
  const lines = out.trim().split("\n");
  assert.deepEqual(lines, [".a | color = red"], "keyframes 不应污染选择器胜出表");
});

test("自检：解析器坏掉时（空输入）不会假装成功", () => {
  const out = run("dump", `/* 只有注释 */`);
  assert.equal(out.trim(), "", "无规则时应输出空，而不是报错或造假");
});
