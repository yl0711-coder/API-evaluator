// tests/no-cycles.test.mjs
// 结构守卫：src/ 与 server/ 内部不得出现 import 环。
//
// 背景：**rollup / vite build 对循环依赖默认静默**——构建会成功、CI 会全绿，
// 然后浏览器里在模块求值阶段命中 TDZ（`ReferenceError: Cannot access 'X' before initialization`），
// 页面白屏。前端这边尤其危险：src/app.js 有 0 个 export、0 条测试，是 index.html 直接加载的
// 入口模块，它的一切今天只由「人打开页面看一眼」验证。
//
// 拆分 app.js（16 号报告 C1）时这个风险最高：把 2193 行按功能块拆成模块，
// 一旦两个模块互相 import（例如「报告块」要用「仪表盘块」的渲染函数、反之亦然），
// 就成环。本项目的既定约定本来就是**星型**——模块间不互相 import，回调向上抛、app.js 做扇出——
// 本测试把这条约定钉成机器可查的。
//
// 与 no-backend-src-import.test.mjs 同一路子：静态扫描、命中即失败、零运行时依赖。
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function collectFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collectFiles(p, out);
    else if (/\.(mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

const norm = (p) => relative(root, p).split("\\").join("/");

// 建 import 图：只跟相对路径（./ ../），跳过裸包名（node_modules 不会跟本地文件成环）。
function buildGraph(dir) {
  const graph = new Map();
  for (const file of collectFiles(join(root, dir))) {
    const src = readFileSync(file, "utf8");
    const deps = new Set();
    // 三种形式都要认，漏一种就是守卫有洞：
    //   1. import x from "./y"      具名/默认导入
    //   2. import "./y"             **副作用导入（没有 from）** —— 第一版正则要求 from，漏了它，
    //                               变异测试当场抓出：注入 `import "./x.js"` 造的环没被检出。
    //   3. await import("./y")      动态导入
    // 只认相对路径字面量；裸包名走 node_modules，不会与本地文件成环。
    const patterns = [
      /^\s*import\s[^;]*?from\s+["'](\.[^"']+)["']/gm,
      /^\s*import\s+["'](\.[^"']+)["']/gm,
      /import\s*\(\s*["'](\.[^"'`]+)["']\s*\)/g,
    ];
    for (const re of patterns) {
      for (const m of src.matchAll(re)) {
        // 去掉 ?query（如 ?raw / ?case=）再解析
        const spec = m[1].split("?")[0];
        const target = resolve(dirname(file), spec);
        if (existsSync(target)) deps.add(norm(target));
      }
    }
    graph.set(norm(file), deps);
  }
  return graph;
}

// DFS 找环，返回所有环的路径（用于报错时直接给出可读的环）
function findCycles(graph) {
  const cycles = [];
  const state = new Map(); // 0=未访问 1=在栈上 2=已完成
  const stack = [];

  function dfs(node) {
    state.set(node, 1);
    stack.push(node);
    for (const dep of graph.get(node) || []) {
      if (!graph.has(dep)) continue;
      if (state.get(dep) === 1) {
        // 找到环：从栈里 dep 的位置切到栈顶
        const i = stack.indexOf(dep);
        cycles.push([...stack.slice(i), dep].join(" → "));
      } else if (!state.has(dep)) {
        dfs(dep);
      }
    }
    stack.pop();
    state.set(node, 2);
  }

  for (const node of graph.keys()) if (!state.has(node)) dfs(node);
  return [...new Set(cycles)];
}

test("src/ 内部无 import 环（rollup 不报，但浏览器里会 TDZ 白屏）", () => {
  const graph = buildGraph("src");
  // 自检：图建空了说明解析逻辑坏了，此时必须失败而不是「没有环所以绿」。
  assert.ok(graph.size > 30, `只扫到 ${graph.size} 个 src/ 模块，import 图构建可能坏了`);
  const edges = [...graph.values()].reduce((n, s) => n + s.size, 0);
  assert.ok(edges > 30, `只解析出 ${edges} 条 import 边，解析逻辑可能坏了`);

  const cycles = findCycles(graph);
  assert.deepEqual(cycles, [], `发现循环依赖：\n  ${cycles.join("\n  ")}`);
});

test("server/ 内部无 import 环", () => {
  const graph = buildGraph("server");
  assert.ok(graph.size > 30, `只扫到 ${graph.size} 个 server/ 模块，import 图构建可能坏了`);
  const cycles = findCycles(graph);
  assert.deepEqual(cycles, [], `发现循环依赖：\n  ${cycles.join("\n  ")}`);
});
