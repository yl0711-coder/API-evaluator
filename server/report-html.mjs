import { escapeHtmlText } from "./utils.mjs";

export function renderReportHtml(markdown, title) {
  const escapedTitle = escapeHtmlText(title || "测试报告");
  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `<title>${escapedTitle}</title>`,
    "<style>",
    "body{margin:0;padding:32px;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;background:#f6f7fb;color:#172033;line-height:1.75}",
    "main{max-width:1180px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:20px;padding:30px;box-shadow:0 18px 60px rgba(15,23,42,.08)}",
    "h1{margin-top:0;font-size:30px}h2{margin-top:32px;border-top:1px solid #e5e7eb;padding-top:18px}h3{margin-top:24px}",
    "table{width:100%;border-collapse:collapse;margin:12px 0;display:block;overflow-x:auto}th,td{border:1px solid #d7dde8;padding:9px 11px;text-align:left;vertical-align:top}th{background:#f1f5f9}",
    "pre{background:#0f172a;color:#e5e7eb;border-radius:14px;padding:14px;overflow:auto}code{font-family:'SFMono-Regular',Consolas,monospace}",
    "p,li{color:#334155}.meta{color:#64748b;font-size:13px;margin-bottom:20px}",
    "</style>",
    "</head>",
    "<body><main>",
    `<div class="meta">本报告由模型评测平台本地生成，不包含 API Key。</div>`,
    renderMarkdownForReport(markdown),
    "</main></body></html>",
  ].join("\n");
}

function renderMarkdownForReport(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const html = [];
  let inCode = false;
  let table = [];
  const flushTable = () => {
    if (!table.length) return;
    html.push(renderReportTable(table));
    table = [];
  };
  for (const line of lines) {
    if (line.startsWith("```")) {
      flushTable();
      html.push(inCode ? "</code></pre>" : "<pre><code>");
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      html.push(`${escapeHtmlText(line)}\n`);
      continue;
    }
    if (line.trim().startsWith("|")) {
      table.push(line);
      continue;
    }
    flushTable();
    if (!line.trim()) continue;
    if (line.startsWith("# ")) html.push(`<h1>${formatReportInline(line.slice(2))}</h1>`);
    else if (line.startsWith("## ")) html.push(`<h2>${formatReportInline(line.slice(3))}</h2>`);
    else if (line.startsWith("### ")) html.push(`<h3>${formatReportInline(line.slice(4))}</h3>`);
    else if (line.startsWith("- ")) html.push(`<li>${formatReportInline(line.slice(2))}</li>`);
    else html.push(`<p>${formatReportInline(line)}</p>`);
  }
  flushTable();
  if (inCode) html.push("</code></pre>");
  return html.join("\n");
}

// GFM 分隔行：去掉首尾管道后，每个单元格只由 - : 和空白组成（如 ---、:---:、 --- ）。
function isTableSeparator(line) {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return body.length > 0 && /^[\s:|-]+$/.test(body) && body.includes("-");
}

// 按「未转义的管道」切分单元格，再把 \| 还原成字面量 |。
// 报告里的说明/摘要/证据列经 escapeMarkdownTable 把内容中的 | 转义成 \|，
// 若直接 split("|") 会把一个单元格拆成多列，导致整张表错位。
function splitTableCells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, "|").trim());
}

function renderReportTable(lines) {
  const rows = lines
    .filter((line) => !isTableSeparator(line))
    .map((line) => splitTableCells(line).map((cell) => formatReportInline(cell)));
  if (!rows.length) return "";
  const [head, ...body] = rows;
  return [
    "<table>",
    `<thead><tr>${head.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead>`,
    `<tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody>`,
    "</table>",
  ].join("");
}

function formatReportInline(text) {
  return escapeHtmlText(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}
