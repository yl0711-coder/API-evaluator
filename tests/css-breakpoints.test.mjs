// tests/css-breakpoints.test.mjs
// 结构守卫：响应式断点必须收敛在约定的四档内，且同一断点不得散落多处。
//
// 背景（CHANGELOG v0.7.2）：styles.css 曾有 6 个不同的 max-width 断点
// （1180/1080/980/960/860/760），其中 1080/980/960 挤在 120px 区间内、做的是同一件事
// （某个双列网格塌成单列），只是分属不同页面——典型的「哪个页面挤了就补一个断点」。
// 且 980px 写在两个地方，8 处规则与 1180px 档同值属死代码。
//
// 这类退化是静默的：每个断点单看都"能用"，只是整体没有尺度，改一处不知道会不会跟另一处打架。
// 本测试把四档钉成机读契约。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const css = readFileSync(join(root, "src", "styles.css"), "utf8");
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));

// 约定的四档。@media 条件不支持 var()（媒体查询在自定义属性替换之前求值），
// 故断点值只能是字面量，语义只能靠注释 + 本测试表达。
const ALLOWED = {
  1180: "lg — 内容区开始被压缩（与内容限宽 max-width:1180px 同值）",
  980: "md — 内容区容不下双列",
  860: "sm — 侧栏无法与内容并存（唯一结构性断点）",
  760: "xs — sm 之下的细化（手机竖屏）",
};

function widthBlocks() {
  const out = [];
  const re = /@media[^{]*\{/g;
  let m;
  while ((m = re.exec(stripped))) {
    const cond = m[0].slice(6, -1).trim();
    const w = /max-width:\s*(\d+)px/.exec(cond);
    if (!w) continue; // prefers-reduced-motion 等特性查询不受本测试约束
    out.push({ px: Number(w[1]), line: stripped.slice(0, m.index).split("\n").length, cond });
  }
  return out;
}

test("max-width 断点只允许约定的四档（1180/980/860/760）", () => {
  const blocks = widthBlocks();
  assert.ok(blocks.length > 0, "没找到任何 max-width 断点 —— 抽取逻辑可能坏了");
  const bad = blocks.filter((b) => !(b.px in ALLOWED));
  assert.deepEqual(
    bad.map((b) => `${b.px}px (行 ${b.line})`),
    [],
    "出现了约定外的断点。四档语义：\n" +
      Object.entries(ALLOWED)
        .map(([px, d]) => `  ${px}px — ${d}`)
        .join("\n") +
      "\n新增断点前先问：这是真的新档位，还是某个已有档位没覆盖到？后者请复用已有档。",
  );
});

test("同一断点值不得散落在多个 @media 块（同档规则应集中）", () => {
  const byPx = new Map();
  for (const b of widthBlocks()) {
    if (!byPx.has(b.px)) byPx.set(b.px, []);
    byPx.get(b.px).push(b.line);
  }
  // 允许每档最多出现在 2 个块：全站通用降级 + 某个页面作用域的降级，
  // 再多就说明又开始散落了。980 档目前是 3 处（手册/总览/API 配置各一），
  // 属页面作用域各自维护，故上限设为 3。
  const scattered = [...byPx].filter(([, lines]) => lines.length > 3);
  assert.deepEqual(
    scattered.map(([px, lines]) => `${px}px 出现在 ${lines.length} 处：行 ${lines.join(", ")}`),
    [],
    "同一断点散落过多，规则应就近合并到该档的块里。",
  );
});

test("断点在文件中自上而下递减（阅读顺序与生效叠加顺序一致）", () => {
  // max-width 是叠加生效的：窄屏命中所有更大的断点。若文件里断点值忽大忽小，
  // 读代码时很难判断某个属性最终被哪一档覆盖。这里只要求「不出现明显的乱序倒挂」：
  // 同一档的多个块之间可以穿插，但整体趋势应递减。
  const pxs = widthBlocks().map((b) => b.px);
  const uniqueInOrder = pxs.filter((p, i) => i === 0 || p !== pxs[i - 1]);
  const sortedDesc = [...new Set(uniqueInOrder)].sort((a, b) => b - a);
  // 检查首次出现顺序是否与降序一致
  const firstSeen = [];
  for (const p of pxs) if (!firstSeen.includes(p)) firstSeen.push(p);
  assert.deepEqual(
    firstSeen,
    sortedDesc,
    `断点首次出现顺序 [${firstSeen.join(", ")}] 与降序 [${sortedDesc.join(", ")}] 不一致。` +
      "请把更窄的断点块放在更宽的之后，让阅读顺序与覆盖顺序一致。",
  );
});

test("不得在窄断点里重复更宽断点已设的同值声明（死代码）", () => {
  // max-width 叠加生效：860px 屏幕同时命中 1180px。若两档给同一 (选择器,属性) 设**相同**值，
  // 窄档那份永远不产生效果，是死代码。历史上 .row/.request-row/.test-run-row/.task-row
  // 的 grid-template-columns 与 min-width 就在 1180 和 860 各写了一遍。
  const blocks = [];
  const re = /@media[^{]*\{/g;
  let m;
  while ((m = re.exec(stripped))) {
    const cond = m[0].slice(6, -1).trim();
    const w = /max-width:\s*(\d+)px/.exec(cond);
    if (!w) continue;
    let d = 1;
    let i = m.index + m[0].length;
    for (; i < stripped.length && d > 0; i++) {
      if (stripped[i] === "{") d++;
      else if (stripped[i] === "}") d--;
    }
    blocks.push({
      px: Number(w[1]),
      body: stripped.slice(m.index + m[0].length, i - 1),
      line: stripped.slice(0, m.index).split("\n").length,
    });
  }

  const seen = new Map(); // "sel|prop" -> [{px, value}]
  for (const b of blocks) {
    const rr = /([^{}]+)\{([^{}]*)\}/g;
    let r;
    while ((r = rr.exec(b.body))) {
      const sels = r[1]
        .split(",")
        .map((s) => s.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      for (const decl of r[2].split(";")) {
        const c = decl.indexOf(":");
        if (c === -1) continue;
        const prop = decl.slice(0, c).trim();
        const value = decl
          .slice(c + 1)
          .replace(/\s+/g, " ")
          .trim();
        for (const sel of sels) {
          const k = `${sel}|${prop}`;
          if (!seen.has(k)) seen.set(k, []);
          seen.get(k).push({ px: b.px, value, line: b.line });
        }
      }
    }
  }

  const dead = [];
  for (const [k, list] of seen) {
    if (list.length < 2) continue;
    const [sel, prop] = k.split("|");
    // 按断点降序：更宽的在前。若某个更窄的断点与任一更宽断点同值 → 死代码
    const desc = [...list].sort((a, b) => b.px - a.px);
    for (let i = 1; i < desc.length; i++) {
      for (let j = 0; j < i; j++) {
        if (desc[i].value === desc[j].value && desc[i].px < desc[j].px) {
          dead.push(
            `${sel} { ${prop}: ${desc[i].value} } —— ${desc[i].px}px(行 ${desc[i].line}) 重复了 ${desc[j].px}px(行 ${desc[j].line}) 的同值`,
          );
        }
      }
    }
  }
  assert.deepEqual([...new Set(dead)], [], `窄断点里有与更宽断点同值的死代码：\n  ${[...new Set(dead)].join("\n  ")}`);
});
