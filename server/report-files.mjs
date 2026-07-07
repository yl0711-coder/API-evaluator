// 报告文件落盘：把 Markdown + 渲染后的 HTML 写到报告目录，并登记报告中心元数据。
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { recordReport } from "./db.mjs";
import { REPORTS_DIR } from "./paths.mjs";
import { renderReportHtml } from "./report-html.mjs";

// EVALUATOR_OPEN_REPORT=1/true/on/yes 时，报告生成后自动在本机默认浏览器打开。默认关闭。
export function isOpenReportEnabled(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

// 在本机默认浏览器打开一份报告 HTML。
// best-effort：无桌面环境 / 命令缺失 / 任何异常一律静默忽略，绝不阻塞或影响任务完成。
export function openReportInBrowser(htmlPath, { enabled = isOpenReportEnabled(process.env.EVALUATOR_OPEN_REPORT) } = {}) {
  if (!enabled || !htmlPath) return false;
  try {
    const platform = process.platform;
    // Windows：用 explorer.exe 的完整路径，避免 spawn 按裸名字解析 PATH 报 ENOENT。
    // explorer.exe 收到一个文件参数时，会用其默认关联程序（.html → 默认浏览器）打开。
    const command =
      platform === "win32"
        ? join(process.env.SystemRoot || "C:\\Windows", "explorer.exe")
        : platform === "darwin"
          ? "open"
          : "xdg-open";
    const child = spawn(command, [htmlPath], { detached: true, stdio: "ignore" });
    child.on("error", () => {}); // 找不到命令 / 无图形界面 → 静默
    child.unref();
    return true;
  } catch {
    return false;
  }
}

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

// AI 辅助分析单独落盘：只写一份独立 HTML（不产出 .md），并登记到报告中心。
// markdown 为空（未启用 / 无内容）时直接跳过并返回 null。best-effort，绝不影响主报告。
export async function saveAiAnalysisReport(baseName, markdown, title) {
  if (!markdown) return null;
  await mkdir(REPORTS_DIR, { recursive: true });
  const safeBaseName = `${sanitizeReportBaseName(baseName)}-ai-analysis`;
  const htmlPath = join(REPORTS_DIR, `${safeBaseName}.html`);
  await writeFile(htmlPath, renderReportHtml(markdown, title), "utf8");
  // 登记元数据：pathMd 留空（本报告只有 HTML），共享报告中心 + 留存清理同样适用。
  await recordReport({
    reportId: safeBaseName,
    runId: String(baseName || ""),
    type: "ai-analysis",
    title: title || "",
    pathMd: null,
    pathHtml: htmlPath,
    createdAt: new Date().toISOString(),
  }).catch(() => {});
  return { htmlPath };
}

export function inferReportType(baseName) {
  const name = String(baseName || "");
  // 新格式 渠道_模型_<type>_<YYYYMMDD>_<HHMMSS>_<hash>：type 在 8 位日期 token 前一个。
  // 旧格式 <type>-YYYYMMDD-...：无下划线分段 → probe 回退为整名（行为不变）。
  const parts = name.split("_");
  const dateIdx = parts.findIndex((p) => /^\d{8}$/.test(p));
  const probe = dateIdx > 0 ? parts[dateIdx - 1] : name;
  if (probe.includes("scenario")) return "scenario";
  if (probe.includes("stability") || probe === "run") return "stability";
  if (probe.includes("admission")) return "admission"; // 先于 batch：admission-batch 归 admission（同旧行为）
  if (probe.includes("batch")) return "batch";
  if (probe.includes("replay")) return "replay";
  if (probe.includes("supplier")) return "supplier-evidence";
  return "report";
}

// 从落盘的报告 HTML 路径反推报告 id（= 落盘时的 safeBaseName，去掉目录与 .html 后缀）。
// 供前端拼出 HTTP 查看 URL（/api/reports/<id>/view）。路径由本进程 join 生成，故 basename 跨平台正确。
export function reportIdFromHtmlPath(htmlPath) {
  if (!htmlPath) return "";
  return basename(String(htmlPath)).replace(/\.html$/i, "");
}

export function sanitizeReportBaseName(baseName) {
  // 允许中文等 unicode（报告名含渠道名「小侠」），但仍防目录穿越/非法文件名字符：
  const safeName = String(baseName || "")
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_") // 路径分隔 / Windows 非法字符 / 控制字符 → _
    .replace(/\.\.+/g, "_") // 禁 .. 父目录穿越
    .replace(/\s+/g, "_") // 空白 → _
    .replace(/^[._]+/, "") // 去前导点 / 下划线
    .slice(0, 200);
  return safeName || "report";
}
