// src/manual.js
// 操作手册页：渲染 Markdown + 构建右侧「本页目录」+ 滚动高亮（scrollspy）。
//
// 从 app.js 整块搬出（16 号报告 C1）。代码**逐字未改**——纯搬运才能用构建产物比对
// 证明等价（产物里标识符与字符串一个不少不多，就是没改过）。
//
// 依赖极窄：renderMarkdown（纯函数）、MANUAL_MARKDOWN（静态文案）、state.manualLoaded（懒加载标志）。
// 不发请求、不与其它模块交互，是全文件里最自足的几块之一。
import { renderMarkdown } from "./client-utils.js";
import { requireElement } from "./dom-utils.js";
import { MANUAL_MARKDOWN } from "./manual-content.js";

export function createManual({ state }) {
  const manualContent = requireElement("#manual-content");

  function load() {
    manualContent.innerHTML = renderMarkdown(MANUAL_MARKDOWN);
    buildManualToc();
    state.manualLoaded = true;
  }

  // 渲染后构建右侧「本页目录」并接上滚动高亮（scrollspy）。
  // 不改共享的 renderMarkdown，全部在 manual 页 DOM 上后处理。
  // 右侧目录「大标题」的矢量图标：按标题关键词匹配，stroke 用 currentColor
  // 以跟随目录文字颜色（平时暖白、高亮时变橙）。未匹配到的大标题用兜底井号图标。
  function tocIconFor(title) {
    const svg = (paths) =>
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
    if (title.includes("快速上手")) {
      return svg(
        '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
      );
    }
    if (title.includes("核心概念")) {
      return svg(
        '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
      );
    }
    if (title.includes("逐页要点")) {
      return svg(
        '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
      );
    }
    return svg('<path d="M4 9h16"/><path d="M4 15h16"/><path d="M10 3 8 21"/><path d="M16 3l-2 18"/>');
  }

  function buildManualToc() {
    const toc = document.getElementById("manual-toc");
    if (!toc) return;
    const scroller = manualContent.closest(".main");
    const TOC_SCROLL_OFFSET = 24; // 标题落点距容器顶端的留白
    // 点击跳转期间锁住 scrollspy，避免平滑滚动过程中中途标题抢走高亮。
    let spyLocked = false;
    let spyTimer = 0;
    // 目录自身是可滚动容器（overflow-y:auto）；高亮项将移出目录视口时把它带回来。
    const tocScroller = toc.closest(".doc-toc");
    function keepActiveVisible(link) {
      if (!tocScroller || !link) return;
      const pad = 8;
      const cr = tocScroller.getBoundingClientRect();
      const lr = link.getBoundingClientRect();
      if (lr.top < cr.top + pad) {
        tocScroller.scrollTop += lr.top - cr.top - pad;
      } else if (lr.bottom > cr.bottom - pad) {
        tocScroller.scrollTop += lr.bottom - cr.bottom + pad;
      }
    }
    const headings = [...manualContent.querySelectorAll("h2, h3")];
    let h2 = 0;
    let h3 = 0;
    const links = headings.map((el) => {
      const level = el.tagName === "H2" ? 2 : 3;
      if (level === 2) {
        h2 += 1;
        h3 = 0;
        el.id = `sec-${h2}`;
      } else {
        h3 += 1;
        el.id = `sec-${h2}-${h3}`;
      }
      const a = document.createElement("a");
      a.href = `#${el.id}`;
      a.className = "toc-link";
      a.dataset.level = String(level);
      a.dataset.target = el.id;
      if (level === 2) {
        const ico = document.createElement("span");
        ico.className = "toc-ico";
        ico.setAttribute("aria-hidden", "true");
        ico.innerHTML = tocIconFor(el.textContent);
        a.append(ico, document.createTextNode(el.textContent));
      } else {
        a.textContent = el.textContent;
      }
      a.addEventListener("click", (event) => {
        event.preventDefault();
        // 直接对真正的滚动容器 .main 做确定性偏移滚动，不依赖 scrollIntoView
        // 的祖先启发式（#app 设了 overflow:hidden 会干扰其落点计算）。
        if (scroller) {
          const top = scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - TOC_SCROLL_OFFSET;
          scroller.scrollTo({ top, behavior: "smooth" });
        } else {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        // 立即把高亮切到被点项，并锁住 scrollspy 直到平滑滚动结束，
        // 否则中部/下方标题会在滚动过程中把高亮抢到目标下面几项。
        for (const other of links) other.classList.toggle("is-active", other === a);
        keepActiveVisible(a);
        spyLocked = true;
        clearTimeout(spyTimer);
        spyTimer = setTimeout(() => {
          spyLocked = false;
        }, 700);
        history.replaceState(null, "", `#${el.id}`);
      });
      return a;
    });
    toc.replaceChildren(...links);

    // scrollspy：判定带贴视口顶部（顶部 0~20% 区间），让"当前章节"= 刚滚到
    // 顶部的那个标题，点击跳转与手动滚动都一致。多个标题同时命中时取最靠上的。
    const byId = new Map(links.map((a) => [a.dataset.target, a]));
    const observer = new IntersectionObserver(
      (entries) => {
        if (spyLocked) return;
        const hit = entries.filter((e) => e.isIntersecting).sort((x, y) => x.boundingClientRect.top - y.boundingClientRect.top)[0];
        if (!hit) return;
        const active = byId.get(hit.target.id);
        if (!active) return;
        for (const a of links) a.classList.toggle("is-active", a === active);
        keepActiveVisible(active);
      },
      { rootMargin: "0px 0px -80% 0px", threshold: 0 },
    );
    for (const el of headings) observer.observe(el);
  }

  return { load };
}
