// Browser-only helpers shared by the single-page UI. Keeping these pure or
// DOM-local makes src/app.js easier to read and reduces accidental coupling.
export function formatNumber(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value)).toLocaleString("zh-CN") : "-";
}

export function formatPercent(value) {
  return Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100)}%` : "-";
}

export function downloadText(filename, text) {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function average(values) {
  const clean = values.filter((value) => Number.isFinite(Number(value))).map(Number);
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

export function renderMarkdown(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const html = [];
  let listOpen = false;
  let table = [];
  let inCode = false;

  const closeList = () => {
    if (listOpen) {
      html.push("</ul>");
      listOpen = false;
    }
  };
  const flushTable = () => {
    if (!table.length) return;
    closeList();
    html.push(renderMarkdownTable(table));
    table = [];
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      flushTable();
      closeList();
      html.push(inCode ? "</code></pre>" : "<pre><code>");
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      html.push(`${escapeHtml(line)}\n`);
      continue;
    }
    if (line.trim().startsWith("|")) {
      table.push(line);
      continue;
    }
    flushTable();
    if (!line.trim()) {
      closeList();
      continue;
    }
    if (line.startsWith("# ")) {
      closeList();
      html.push(`<h1>${escapeHtml(line.slice(2))}</h1>`);
    } else if (line.startsWith("## ")) {
      closeList();
      html.push(`<h2>${escapeHtml(line.slice(3))}</h2>`);
    } else if (line.startsWith("### ")) {
      closeList();
      html.push(`<h3>${escapeHtml(line.slice(4))}</h3>`);
    } else if (line.startsWith("- ")) {
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${formatInlineMarkdown(line.slice(2))}</li>`);
    } else {
      closeList();
      html.push(`<p>${formatInlineMarkdown(line)}</p>`);
    }
  }
  flushTable();
  closeList();
  if (inCode) html.push("</code></pre>");
  return html.join("\n");
}

function renderMarkdownTable(lines) {
  const rows = lines
    .filter((line) => !/^\|\s*-+/.test(line))
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => formatInlineMarkdown(cell.trim())),
    );
  if (!rows.length) return "";
  const [head, ...body] = rows;
  return [
    "<table>",
    `<thead><tr>${head.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead>`,
    `<tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody>`,
    "</table>",
  ].join("");
}

function formatInlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

export function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function toast(message, error = false) {
  const item = document.createElement("div");
  item.className = `toast ${error ? "error" : ""}`;
  item.textContent = message;
  document.body.appendChild(item);
  setTimeout(() => {
    item.classList.add("visible");
  }, 10);
  setTimeout(() => {
    item.classList.remove("visible");
    setTimeout(() => item.remove(), 250);
  }, 2600);
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 协议代码 -> 中文展示名。渠道/模型/profile 各处共用，避免多份分支漂移。
export function protocolLabel(protocol) {
  if (protocol === "claude_messages") return "Claude Messages";
  if (protocol === "openai_chat") return "OpenAI Chat";
  if (protocol === "openai_compatible") return "OpenAI 兼容";
  return protocol || "-";
}
