// 报告文件落盘：把 Markdown + 渲染后的 HTML 写到报告目录，并登记报告中心元数据。
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, stat, utimes, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { createGunzip, gunzip, gzip } from "node:zlib";
import { recordReport } from "./db.mjs";
import { REPORTS_DIR } from "./paths.mjs";
import { renderReportHtml } from "./report-html.mjs";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

// EVALUATOR_OPEN_REPORT=1/true/on/yes 时，报告生成后自动在本机默认浏览器打开。默认关闭。
export function isOpenReportEnabled(value) {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
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
      platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "explorer.exe") : platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(command, [htmlPath], { detached: true, stdio: "ignore" });
    child.on("error", () => {}); // 找不到命令 / 无图形界面 → 静默
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// chartNonce：仅「自动测试巡检」报告出报告时由服务端生成并传入，用于校验平台图表围栏的可信穿透
// （见 report-html.mjs）。其它报告（含 AI 辅助分析）不传，任何 SVG 围栏都会被转义。
export async function saveReportFiles(baseName, markdown, title, { chartNonce = "" } = {}) {
  await mkdir(REPORTS_DIR, { recursive: true });
  const safeBaseName = sanitizeReportBaseName(baseName);
  const markdownPath = join(REPORTS_DIR, `${safeBaseName}.md`);
  const htmlPath = join(REPORTS_DIR, `${safeBaseName}.html`);
  await writeFile(markdownPath, markdown, "utf8");
  await writeFile(htmlPath, renderReportHtml(markdown, title, { chartNonce }), "utf8");
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
  if (probe.includes("digest")) return "auto-digest"; // 自动测试巡检报告（autodigest_…）
  if (probe.includes("compare")) return "compare"; // 模型对比报告
  if (probe.includes("load")) return "load-test"; // 压力测试报告（buildReportId("load", ...)）
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

// 读一份报告正文（.md 或 .html），对老化后被原地 gzip 压缩过的文件透明解压。
// 判断依据是文件头两字节的 gzip magic（0x1f 0x8b），不依赖扩展名——压缩前后文件名不变。
export async function readReportFileText(path) {
  const buf = await readFile(path);
  if (buf.length >= 2 && buf[0] === GZIP_MAGIC[0] && buf[1] === GZIP_MAGIC[1]) {
    return (await gunzipAsync(buf)).toString("utf8");
  }
  return buf.toString("utf8");
}

async function isGzipReportFile(path) {
  const handle = await open(path, "r");
  try {
    const probe = Buffer.alloc(2);
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
    return bytesRead === 2 && probe[0] === GZIP_MAGIC[0] && probe[1] === GZIP_MAGIC[1];
  } finally {
    await handle.close();
  }
}

// Returns the report's original bytes without creating a whole-file Buffer.
// Old reports can be gzip-compressed in place, so detection intentionally uses
// the magic bytes rather than the file extension.
export async function createReportFileReadStream(path) {
  const gzipCompressed = await isGzipReportFile(path);
  const input = createReadStream(path);
  if (!gzipCompressed) return input;
  const output = createGunzip();
  input.on("error", (error) => output.destroy(error));
  return input.pipe(output);
}

// Counts uncompressed report bytes with a hard ceiling. The caller uses this
// preflight pass to reject an oversized archive before HTTP headers are sent.
export async function countReportFileTextBytes(path, { maxBytes = Number.MAX_SAFE_INTEGER } = {}) {
  const stream = await createReportFileReadStream(path);
  let total = 0;
  try {
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > maxBytes) {
        const error = new Error("report_size_limit_exceeded");
        error.code = "report_size_limit_exceeded";
        throw error;
      }
    }
  } catch (error) {
    stream.destroy(error);
    throw error;
  }
  return total;
}

// 老化报告原地压缩：扫描 REPORTS_DIR 下 .md/.html 文件，超过 compressAfterDays 且尚未压缩的，
// gzip 后原地替换（文件名/扩展名不变，靠上面的 magic-byte 判断透明解压读取）。
// 写临时文件再 rename 落地，避免读者读到半写文件；已压缩的文件跳过（幂等，重复调用不会二次压缩坏掉）。
// 压缩后用 utimes 把 mtime 还原成压缩前的值——handleReportFilesList/loadBalancedCompareFiles
// 都拿 mtime 当"报告实际生成时间"用于排序/展示（前端报告列表的日期列、模型对比选最近报告），
// 若放任 rename 把 mtime 刷成"现在"，老报告会看起来比新报告更"新"，报告列表日期显示错误、
// 模型对比可能优先选中刚被压缩的老报告而非真正最近的报告。
// best-effort：单个文件失败不影响其余文件；返回被压缩的文件名列表。
export async function compressAgedReportFiles({ compressAfterDays = 30, now } = {}) {
  const compressed = [];
  // 配置校验：非法值（如误填非数字字符串）算术上会产出 NaN，而 `mtimeMs >= NaN` 恒为 false，
  // 会导致"任何文件都判定为超龄"，把刚生成的报告也压缩掉。宁可整次跳过（fail safe），
  // 不学 Number(bad || 30) 那种一 truthy 就直接把坏值送进算术的写法。
  if (!Number.isFinite(compressAfterDays) || compressAfterDays < 0) return compressed;
  let names;
  try {
    names = (await readdir(REPORTS_DIR)).filter((n) => /\.(md|html)$/i.test(n));
  } catch {
    return compressed; // 目录不存在 → 无事可做
  }
  const cutoffMs = (now ?? Date.now()) - compressAfterDays * 24 * 3600 * 1000;
  for (const name of names) {
    const path = join(REPORTS_DIR, name);
    try {
      const st = await stat(path);
      if (st.mtimeMs >= cutoffMs) continue; // 未到年龄
      const buf = await readFile(path);
      if (buf.length >= 2 && buf[0] === GZIP_MAGIC[0] && buf[1] === GZIP_MAGIC[1]) continue; // 已压缩
      const gz = await gzipAsync(buf);
      const tmpPath = `${path}.tmp${process.pid}`;
      await writeFile(tmpPath, gz);
      await rename(tmpPath, path);
      await utimes(path, st.atime, st.mtime); // 还原原始时间戳，压缩不应改变"报告生成时间"的语义
      compressed.push(name);
    } catch {
      /* 单文件失败不影响其余：跳过 */
    }
  }
  return compressed;
}
