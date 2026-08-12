// tests/selector-contract.test.mjs
// 结构守卫：src/ 里每个 requireElement("#x") 的选择器，都必须能在 index.html 里找到。
//
// 背景：requireElement / requireElements（src/dom-utils.js）在元素缺失时直接 throw
// （「页面缺少必要元素：#x」）。而 src/app.js 是 index.html 直接加载的入口模块、
// 有 0 个 export、**0 条测试**——它的 170 多个元素查找今天只由「人打开页面看一眼」验证。
// 于是 index.html 里改错/删掉一个 id，或代码里选择器写错一个字母，都要等到浏览器里才炸。
//
// 这两组字面量（代码里的选择器 × index.html 里的 id）本质是一份**机读契约**，
// 可以纯静态比对，不需要 DOM。本测试把它钉住。
//
// 为什么还要快照选择器集合：拆分 app.js（16 号报告 C1）时，元素声明要从顶层的集中声明区
// 搬进各功能模块——那是 170 多个 id 字符串的搬迁，「漏掉一个 / 搬进了从不执行的模块」
// 是主要失败模式，而 vite build 抓不到（它只管 import 能否解析）。集合快照能抓住数量与内容的变化：
// 有意增删元素时，同步改快照即可（diff 里也就看得见）。
//
// 与 no-backend-src-import.test.mjs 同一路子：静态扫描、命中即失败、零运行时依赖。
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function collectJs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collectJs(p, out);
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}

// 抽取 requireElement("...") / requireElements("...") 的字面量参数。
// 只认字面量：动态拼接的选择器（如 requireElement(`#x-${id}`)）无法静态校验，本测试不覆盖，
// 这是已知的能力边界。
function collectSelectors() {
  const found = new Map(); // selector -> Set(相对路径)
  for (const file of collectJs(join(root, "src"))) {
    const src = readFileSync(file, "utf8");
    const rel = file
      .slice(root.length + 1)
      .split("\\")
      .join("/");
    for (const m of src.matchAll(/requireElements?\(\s*"([^"]+)"/g)) {
      if (!found.has(m[1])) found.set(m[1], new Set());
      found.get(m[1]).add(rel);
    }
  }
  return found;
}

const selectors = collectSelectors();
// 全部 HTML 入口拼在一起校验：v0.7.10 起「模型档案」是独立页面（model-profile/index.html），
// 它的元素不在 index.html 里。这里只需回答「这个选择器在**某个**页面里存在吗」——
// 哪个模块用在哪个页面由 import 关系决定，不是本测试的职责。
// 新增独立页面时把入口加进这个数组。
const HTML_ENTRIES = ["index.html", join("model-profile", "index.html")];
const html = HTML_ENTRIES.map((rel) => readFileSync(join(root, rel), "utf8")).join("\n");

test("src/ 里每个 requireElement 的 #id 选择器都能在 HTML 入口里找到", () => {
  const missing = [];
  for (const [sel, files] of selectors) {
    const id = sel.match(/^#([\w-]+)$/)?.[1];
    if (!id) continue; // 非单纯 #id 的复合选择器（如 "[data-x] .y"）交给下一条测试的集合快照兜
    if (!html.includes(`id="${id}"`)) missing.push(`${sel}  ←  ${[...files].join(", ")}`);
  }
  assert.deepEqual(
    missing,
    [],
    `以下选择器在任何 HTML 入口（${HTML_ENTRIES.join(" / ")}）里都找不到对应 id —— 页面加载到这里会抛「页面缺少必要元素」：\n  ${missing.join("\n  ")}`,
  );
});

// 选择器集合快照（tests/fixtures/selector-snapshot.json，随仓库入库）。
// 必须是**独立的文件**而非现场算出来的常量——否则就是拿抽取结果跟自己比，永远绿，等于装饰品。
//
// - 拆分 app.js 时，选择器只该在文件之间搬家，总集合必须逐个不变
// - 有意增删页面元素时，重新生成快照即可；diff 里看得见改了哪些，是刻意的就没问题
const SNAPSHOT = JSON.parse(readFileSync(join(root, "tests", "fixtures", "selector-snapshot.json"), "utf8"));

test("选择器集合快照：拆分/重构不得改变 src/ 用到的选择器总集", () => {
  // 自检：抽取逻辑坏掉时（如正则失效）会得到空集，此时必须失败而不是「没差异所以绿」。
  assert.ok(SNAPSHOT.length > 200, `快照里只有 ${SNAPSHOT.length} 个选择器，快照文件可能坏了`);
  const actual = [...collectSelectors().keys()].sort();
  assert.ok(actual.length > 200, `本次只抽取到 ${actual.length} 个选择器，抽取逻辑可能坏了`);

  const added = actual.filter((s) => !SNAPSHOT.includes(s));
  const removed = SNAPSHOT.filter((s) => !actual.includes(s));
  assert.deepEqual(
    { added, removed },
    { added: [], removed: [] },
    "src/ 用到的选择器集合变了。若是有意增删页面元素，请重新生成 tests/fixtures/selector-snapshot.json；" +
      "若是在拆分 app.js，这说明搬迁过程中丢了或写错了选择器。",
  );
});

test("复合选择器（非 #id）也应能在 index.html 里找到痕迹", () => {
  const suspicious = [];
  for (const [sel, files] of selectors) {
    if (/^#[\w-]+$/.test(sel)) continue; // 纯 #id 已由第一条测试覆盖
    // 复合选择器无法静态求值，退而求其次：把里面的 #id / [data-x] / .class 片段逐个找一遍。
    const parts = [...sel.matchAll(/#([\w-]+)|\[([\w-]+)[\]=]|\.([\w-]+)/g)];
    if (!parts.length) continue;
    for (const p of parts) {
      const [, id, dataAttr, cls] = p;
      const needle = id ? `id="${id}"` : dataAttr ? dataAttr : cls;
      if (!html.includes(needle)) suspicious.push(`${sel}（片段 "${needle}" 未出现）  ←  ${[...files].join(", ")}`);
    }
  }
  assert.deepEqual(suspicious, [], `以下复合选择器的片段在任何 HTML 入口里都找不到：\n  ${suspicious.join("\n  ")}`);
});
