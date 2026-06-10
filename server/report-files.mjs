// 报告文件落盘：把 Markdown + 渲染后的 HTML 写到报告目录，并登记报告中心元数据。
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { recordReport } from "./db.mjs";
import { REPORTS_DIR } from "./paths.mjs";
import { renderReportHtml } from "./report-html.mjs";

export async function saveReportFiles(baseName, markdown, title) {
  await mkdir(REPORTS_DIR, { recursive: true });
  const safeBaseName = sanitizeReportBaseName(baseName);
  const markdownPath = join(REPORTS_DIR, `${safeBaseName}.md`);
  const htmlPath = join(REPORTS_DIR, `${safeBaseName}.html`);
  await writeFile(markdownPath, markdown, "utf8");
  await writeFile(htmlPath, renderReportHtml(markdown, title), "utf8");
  // 登记报告元数据（共享报告中心 + 留存清理）。best-effort，不影响出报告。
  await recordReport({
    reportId: safeBaseName,
    runId: String(baseName || ""),
    type: inferReportType(baseName),
    title: title || "",
    pathMd: markdownPath,
    pathHtml: htmlPath,
    createdAt: new Date().toISOString(),
  }).catch(() => {});
  return { markdownPath, htmlPath };
}

function inferReportType(baseName) {
  const name = String(baseName || "");
  if (name.startsWith("scenario")) return "scenario";
  if (name.startsWith("stability")) return "stability";
  if (name.startsWith("batch")) return "batch";
  if (name.includes("admission")) return "admission";
  if (name.includes("replay")) return "replay";
  if (name.includes("supplier")) return "supplier-evidence";
  return "report";
}

export function sanitizeReportBaseName(baseName) {
  const safeName = String(baseName || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return safeName || "report";
}
