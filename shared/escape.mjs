// shared/escape.mjs
// 纯字符串 HTML 转义，前后端共用。放在 shared/（而非 src/）是刻意的：后端 server/*.mjs 需要它
// （经 shared/trend-chart.mjs 生成 SVG），而后端【不应】import 前端源目录 src/——那样会因生产镜像
// 不打包 src/ 导致启动崩溃（见「14-0.5.7升级失败说明-镜像未打包src」）。前端从 client-utils.js 里
// re-export 本函数，保持既有 import 路径不变。
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
