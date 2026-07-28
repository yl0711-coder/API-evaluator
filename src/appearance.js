// src/appearance.js
// 本机显示偏好：侧边栏折叠 + 「更好的光影」。两者都只存 localStorage、即时生效，
// 与服务器设置无关（不走「保存设置」流程），故与设置页解耦、单独成模块。
//
// 从 app.js 整块搬出（16 号报告 C1）。零外部依赖——只用 requireElement 与 localStorage，
// 不碰 state、不发请求、不与其它模块交互，是全文件里最自足的一块，故作为拆分的第一块。
import { requireElement } from "./dom-utils.js";

// 以下为从 app.js 原样搬来的代码，刻意**逐字未改**（连 readSidebarCollapsed / readBetterLighting
// 这对可以合并成通用 readFlag(key) 的重复也保留着）。
// 原因：纯搬运才能用「构建产物比对」证明等价——产物里标识符与字符串一个不少不多，就是没改过。
// 一旦顺手重构，那条证据链就断了，只能靠人眼。合并去重可以做，但要另起一个 commit，
// 那时它自己就是个独立的、可审的改动。

// 侧边栏折叠：切换 #app.sidebar-collapsed，并把状态持久化到本机
const SIDEBAR_COLLAPSED_KEY = "evaluator:sidebar-collapsed";
const readSidebarCollapsed = () => {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
};
const writeSidebarCollapsed = (on) => {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, on ? "1" : "0");
  } catch {
    /* 隐私模式：忽略 */
  }
};

// 外观：更好的光影（背景橙色渐变流光）。纯本机显示偏好，存 localStorage、即时生效，
// 与服务器设置无关（不走「保存设置」流程）。
const BETTER_LIGHTING_KEY = "evaluator:better-lighting";
const readBetterLighting = () => {
  try {
    return localStorage.getItem(BETTER_LIGHTING_KEY) === "1";
  } catch {
    return false;
  }
};
const writeBetterLighting = (on) => {
  try {
    localStorage.setItem(BETTER_LIGHTING_KEY, on ? "1" : "0");
  } catch {
    /* 隐私模式：忽略 */
  }
};

// 装到已有 DOM 上并立即应用偏好。无 load()：这不是「进页面才加载」的页模块，
// 而是启动即生效的全局外观，故 app.js 顶层调用一次即可。
export function installAppearance() {
  const appEl = requireElement("#app");
  const sidebarToggle = requireElement("#sidebar-toggle");
  function applySidebarCollapsed(on) {
    appEl.classList.toggle("sidebar-collapsed", on);
    sidebarToggle.setAttribute("aria-expanded", String(!on));
    const label = on ? "展开侧边栏" : "收起侧边栏";
    sidebarToggle.setAttribute("aria-label", label);
    sidebarToggle.title = label;
  }
  applySidebarCollapsed(readSidebarCollapsed());
  sidebarToggle.addEventListener("click", () => {
    const on = !appEl.classList.contains("sidebar-collapsed");
    applySidebarCollapsed(on);
    writeSidebarCollapsed(on);
  });

  const betterLightingToggle = requireElement("#set-better-lighting");
  function applyBetterLighting(on) {
    document.body.classList.toggle("better-lighting", on);
    betterLightingToggle.checked = on;
  }
  applyBetterLighting(readBetterLighting());
  betterLightingToggle.addEventListener("change", (event) => {
    // 它在 #settings-form 内，但即时生效、不走「保存设置」：阻止冒泡，
    // 免得表单的 change 监听把它误标为「设置未保存」。
    event.stopPropagation();
    applyBetterLighting(betterLightingToggle.checked);
    writeBetterLighting(betterLightingToggle.checked);
  });
}
