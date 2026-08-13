// tests/dashboard-empty-exits.test.mjs
// 结构守卫：总览页「空状态」（还没有可运行模型目标时显示的那块）必须留有【任何角色都能用】的出路。
//
// 背景：这块原先只有两个按钮——「配置第一个渠道」带 data-requires-admin（非超管会被
// applyRoleVisibility 设成 display:none），以及「打开操作手册」。于是普通管理员在还没有模型目标时
// 只能去手册，出不到别的功能页；用户实际卡住过。
//
// 这条测试钉住三件事：
//   1. 空状态里至少有 N 个【不带 data-requires-admin】的 data-go-page 出口
//   2. 这些出口指向的页面（section.page#id）真实存在 —— 否则点了没反应（showPage 找不到就静默什么都不做）
//   3. 出口指向的页面本身不是「仅超管可见」的（section 上没有 data-requires-admin）
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, "index.html"), "utf8");

// 取出 id="dashboard-empty" 那个 div 的内容。用「从它开始到下一个同级注释」的粗切法：
// 精确解析 HTML 需要引依赖，而本项目刻意零依赖；这里只要能稳定圈出那一段就够。
function extractEmptyState() {
  const start = html.indexOf('id="dashboard-empty"');
  assert.ok(start > 0, 'index.html 里找不到 id="dashboard-empty" —— 空状态块被改名或删除了？');
  // 空状态块结束于「常态」那个注释
  const end = html.indexOf("<!-- 常态：有配置时显示 -->", start);
  assert.ok(end > start, "找不到空状态块的结尾标记（<!-- 常态：有配置时显示 -->）");
  return html.slice(start, end);
}

// 页面 section 是否存在，以及它是否要求超管。
function pageInfo(pageId) {
  const re = new RegExp(`<section[^>]*class="page[^"]*"[^>]*id="${pageId}"[^>]*>`);
  const m = html.match(re);
  if (!m) {
    // id 可能写在 class 之前
    const re2 = new RegExp(`<section[^>]*id="${pageId}"[^>]*>`);
    const m2 = html.match(re2);
    if (!m2) return { exists: false, requiresAdmin: false };
    return { exists: true, requiresAdmin: m2[0].includes("data-requires-admin") };
  }
  return { exists: true, requiresAdmin: m[0].includes("data-requires-admin") };
}

test("总览空状态：存在多个任何角色都能用的出口（不带 data-requires-admin）", () => {
  const block = extractEmptyState();
  // 出口有两种形态：SPA 内跳页的 data-go-page 按钮，以及跳独立页面的 <a href>
  // （「模型档案」自 v0.7.10 起是独立页面 /model-profile/，不再是 SPA 内的一页）。
  const exits = [];
  for (const m of block.matchAll(/<button[^>]*data-go-page="([^"]+)"[^>]*>/g)) {
    exits.push({ page: m[1], requiresAdmin: m[0].includes("data-requires-admin"), external: false });
  }
  for (const m of block.matchAll(/<a[^>]*href="(\/[^"]*)"[^>]*>/g)) {
    exits.push({ page: m[1], requiresAdmin: m[0].includes("data-requires-admin"), external: true });
  }
  assert.ok(exits.length > 0, "空状态里没有任何出口（既无 data-go-page，也无 href）");

  const open = exits.filter((e) => !e.requiresAdmin).map((e) => e.page);
  // 至少 3 个：手册 + 两个功能页。只留手册就等于死胡同（用户真的卡住过）。
  assert.ok(
    open.length >= 3,
    `空状态里「任何角色可用」的出口只有 ${open.length} 个（${open.join(", ") || "无"}）。` +
      "非超管在还没有模型目标时会走不出这一页——请保留至少 3 个不带 data-requires-admin 的出口。",
  );
});

test("总览空状态：每个出口指向的页面都真实存在，且不是仅超管可见", () => {
  const block = extractEmptyState();
  const problems = [];
  for (const m of block.matchAll(/<button[^>]*data-go-page="([^"]+)"[^>]*>/g)) {
    const page = m[1];
    const requiresAdmin = m[0].includes("data-requires-admin");
    const info = pageInfo(page);
    if (!info.exists) {
      problems.push(`${page}：index.html 里没有对应的 <section class="page" id="${page}">，点了不会有反应`);
      continue;
    }
    // 出口自己不要求超管，但目标页只有超管能看 → 非超管点进去会是一片空白
    if (!requiresAdmin && info.requiresAdmin) {
      problems.push(`${page}：出口未标 data-requires-admin，但目标页是仅超管可见的，非超管点进去会看到空白`);
    }
  }
  assert.deepEqual(problems, [], `空状态出口有问题：\n  ${problems.join("\n  ")}`);
});

// 「模型档案」是独立页面（model-profile/index.html，线上 /model-profile/），
// 不是 SPA 里的一个 section。这条钉住三处入口都在、且都不限制为仅超管。
test("模型档案独立页面存在，且三处入口都不限制为仅超管", () => {
  const standalone = readFileSync(join(root, "model-profile", "index.html"), "utf8");
  assert.match(standalone, /id="model-profile"/, "独立页面缺少 #model-profile 容器（样式与 requireElement 都依赖它）");
  assert.match(standalone, /src="\/src\/model-profile-page\.js"/, "独立页面没有引入自己的入口脚本");
  // 独立页面必须有回主站的路：它没有主站侧栏，否则用户只能靠浏览器后退
  assert.match(standalone, /href="\/"/, "独立页面缺少返回主站的链接");

  // 主站三处入口：侧栏、总览空状态、总览「最近报告」头部
  const links = [...html.matchAll(/<a[^>]*href="\/model-profile\/"[^>]*>/g)];
  assert.ok(links.length >= 3, `主站里指向 /model-profile/ 的链接只有 ${links.length} 处，应至少 3 处（侧栏 + 空状态 + 最近报告）`);
  for (const m of links) {
    assert.equal(m[0].includes("data-requires-admin"), false, `该入口限制了仅超管，但档案页只读既有报告：${m[0]}`);
  }
  // 不该再残留 SPA 式的 data-page/data-go-page 引用（会点了没反应）
  assert.doesNotMatch(html, /data-(?:go-)?page="model-profile"/, "主站仍有 SPA 式的 model-profile 跳转，但该页已独立，点了不会有反应");
});
