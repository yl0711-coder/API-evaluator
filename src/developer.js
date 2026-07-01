// src/developer.js
// 「提示词修改」（仅超管）：自定义能力标签编辑 + 场景测试源数据增删改。样式与全站统一（站点 .panel/.secondary 等）。
// 场景编辑默认「结构化表单」，可一键「切到 JSON」编辑完整对象（含复杂答案）；二者编辑同一条。
// 注：表单/JSON 的显隐用内联 style.display 切换（折叠卡用站点 .helper-details 样式）。
// 数据经 /api/dev/scenarios（不脱敏）增删改，后端会改写 server/scenarios/*.mjs 源文件并即时生效。
import { escapeHtml, toast, renderMarkdown } from "./client-utils.js";
import { api } from "./api-client.js";
import { normalizeCustomTags } from "./model-tags.js";
import { requireElement } from "./dom-utils.js";
import scorerDoc from "./docs/scorer-mechanism.md?raw";

// 结构化表单直接编辑的「简单字段」（中文标签）；其余复杂字段（expectedSet/needle/instructions 等）由 JSON 模式编辑、结构化保存时原样保留。
const SIMPLE_FIELDS = [
  { key: "name", label: "名称" },
  { key: "category", label: "类别" },
  { key: "difficulty", label: "难度" },
  { key: "tag", label: "标签" },
  { key: "scorer", label: "评分器" },
];

// 仅供前端展示/分组的元信息，编辑时从场景对象里剥除，避免写回源文件。
function stripMeta(scn) {
  const { bankKey, active, resolvedTag, ...rest } = scn;
  return rest;
}

export function createDeveloper({ state, onTagsSaved }) {
  // —— 自定义能力标签 ——
  const tagInput = requireElement("#set-custom-tag-input");
  const tagAdd = requireElement("#set-custom-tag-add");
  const tagsBox = requireElement("#set-custom-tags");
  const saveTagsBtn = requireElement("#dev-save-tags");
  let customTags = [];

  function renderChips() {
    tagsBox.innerHTML = customTags.length
      ? customTags
          .map((t) => `<span class="model-tag">${escapeHtml(t)}<button type="button" class="model-tag-x" data-del-tag="${escapeHtml(t)}" title="删除标签">×</button></span>`)
          .join("")
      : "（还没有自定义标签）";
    tagsBox.querySelectorAll("[data-del-tag]").forEach((b) =>
      b.addEventListener("click", () => {
        customTags = customTags.filter((t) => t !== b.dataset.delTag);
        renderChips();
      }),
    );
  }
  function addTag() {
    customTags = normalizeCustomTags([...customTags, tagInput.value]);
    renderChips();
    tagInput.value = "";
    tagInput.focus();
  }
  async function saveTags() {
    try {
      const saved = await api("/api/settings", { method: "PUT", body: JSON.stringify({ customTags: [...customTags] }) });
      state.settings = saved;
      customTags = Array.isArray(saved.customTags) ? [...saved.customTags] : [];
      renderChips();
      onTagsSaved?.(); // 模型表单标签勾选项即时并入
      toast("自定义标签已保存。");
    } catch (error) {
      toast(`保存标签失败：${error.message}`, true);
    }
  }
  tagAdd.addEventListener("click", addTag);
  saveTagsBtn.addEventListener("click", saveTags);
  tagInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addTag();
    }
  });

  // —— 场景测试（结构化表单 ⇄ JSON）——
  const listBox = requireElement("#dev-scenario-list");
  const addBtn = requireElement("#dev-add-scenario");
  const reloadBtn = requireElement("#dev-reload-scenarios");
  const scorerDocBtn = requireElement("#dev-scorer-doc");

  // 「评分器机制说明」：新标签页渲染该 md 文档（含表格），便于阅读。
  scorerDocBtn.addEventListener("click", () => {
    const w = window.open("", "_blank");
    if (!w) {
      toast("浏览器拦截了弹窗，请允许后重试。", true);
      return;
    }
    const style =
      "body{font-family:system-ui,'Segoe UI',sans-serif;max-width:880px;margin:24px auto;padding:0 20px;line-height:1.7;color:#1b2330}" +
      "h1{font-size:24px}h2{font-size:19px;margin-top:1.6em}h3{font-size:16px}" +
      "code{background:#f2f4f7;padding:1px 5px;border-radius:4px;font-size:.92em}" +
      "pre{background:#f2f4f7;padding:12px;border-radius:8px;overflow:auto}" +
      "table{border-collapse:collapse;width:100%;margin:12px 0}" +
      "th,td{border:1px solid #d4d9e0;padding:6px 10px;text-align:left;font-size:14px}th{background:#f2f4f7}";
    w.document.write(
      `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>评分器机制说明</title><style>${style}</style></head><body>${renderMarkdown(scorerDoc)}</body></html>`,
    );
    w.document.close();
  });

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const c of [].concat(children)) node.append(c);
    return node;
  }
  function field(label, input) {
    return el("div", {}, [el("label", {}, [`${label}：`, input])]);
  }
  const promptText = (p) => (typeof p === "string" ? p : (p || []).join("\n"));

  // 一条场景的编辑器：默认结构化表单，可切 JSON。originalId=null 表示新增（POST），否则编辑（PUT 用原 id）。
  function scenarioEditor(scn, originalId) {
    const isNew = originalId === null;
    const working = stripMeta(scn);

    // 结构化表单
    const form = el("div", { className: "dev-scenario-form" });
    const inputs = {};
    const idInput = el("input", { value: working.id ?? "", disabled: !isNew, size: 36 });
    form.append(field("ID", idInput));
    for (const f of SIMPLE_FIELDS) {
      const inp = el("input", { value: working[f.key] ?? "", size: 44 });
      inputs[f.key] = inp;
      form.append(field(f.label, inp));
    }
    const minCharsInput = el("input", { value: working.minChars ?? "", type: "number" });
    form.append(field("最少字数", minCharsInput));

    const expectedIsObject = working.expected !== null && typeof working.expected === "object";
    const expectedInput = el("input", {
      value: expectedIsObject ? "（对象答案，请用 JSON 模式编辑）" : working.expected ?? "",
      disabled: expectedIsObject,
      size: 70,
    });
    form.append(field("期望答案", expectedInput));

    const requiredAnyInput = el("input", { value: Array.isArray(working.requiredAny) ? working.requiredAny.join(", ") : "", size: 70 });
    form.append(field("关键词（任一命中，逗号分隔）", requiredAnyInput));

    const promptArea = el("textarea", { value: promptText(working.prompt), rows: 8, cols: 90 });
    form.append(el("div", {}, ["提示词：", el("br"), promptArea]));

    // JSON 视图（默认隐藏；用 style.display 而非 hidden，避免被 all:revert 还原）
    const jsonArea = el("textarea", { value: JSON.stringify(working, null, 2), rows: 16, cols: 90, spellcheck: false });
    const jsonView = el("div", {}, ["完整 JSON：", el("br"), jsonArea]);
    jsonView.style.display = "none";

    // 结构化表单 → 对象（合并到 working 之上，保留未在表单里的复杂字段）
    function collect() {
      const next = { ...working };
      next.id = idInput.value.trim();
      for (const f of SIMPLE_FIELDS) {
        const v = inputs[f.key].value.trim();
        if (v) next[f.key] = v;
        else delete next[f.key];
      }
      const mc = minCharsInput.value.trim();
      if (mc !== "") next.minChars = Number(mc);
      else delete next.minChars;
      if (!expectedIsObject) {
        const ev = expectedInput.value;
        if (ev !== "") next.expected = ev;
        else delete next.expected;
      }
      const ra = requiredAnyInput.value.trim();
      if (ra) next.requiredAny = ra.split(",").map((s) => s.trim()).filter(Boolean);
      else delete next.requiredAny;
      next.prompt = promptArea.value;
      return next;
    }
    // 对象 → 回填结构化表单
    function fillForm(obj) {
      idInput.value = obj.id ?? "";
      for (const f of SIMPLE_FIELDS) inputs[f.key].value = obj[f.key] ?? "";
      minCharsInput.value = obj.minChars ?? "";
      if (!expectedIsObject) expectedInput.value = obj.expected ?? "";
      requiredAnyInput.value = Array.isArray(obj.requiredAny) ? obj.requiredAny.join(", ") : "";
      promptArea.value = promptText(obj.prompt);
    }

    let mode = "form";
    const toggleBtn = el("button", { type: "button", className: "secondary", textContent: "切到 JSON" });
    toggleBtn.addEventListener("click", () => {
      if (mode === "form") {
        jsonArea.value = JSON.stringify(collect(), null, 2);
        form.style.display = "none";
        jsonView.style.display = "";
        toggleBtn.textContent = "切回表单";
        mode = "json";
      } else {
        let parsed;
        try {
          parsed = JSON.parse(jsonArea.value);
        } catch (e) {
          toast(`JSON 解析失败：${e.message}`, true);
          return;
        }
        Object.assign(working, parsed);
        fillForm(working);
        form.style.display = "";
        jsonView.style.display = "none";
        toggleBtn.textContent = "切到 JSON";
        mode = "form";
      }
    });

    const saveBtn = el("button", { type: "button", className: "primary", textContent: "保存" });
    saveBtn.addEventListener("click", async () => {
      let body;
      if (mode === "json") {
        try {
          body = JSON.parse(jsonArea.value);
        } catch (e) {
          toast(`JSON 解析失败：${e.message}`, true);
          return;
        }
      } else {
        body = collect();
      }
      try {
        const path = isNew ? "/api/dev/scenarios" : `/api/dev/scenarios/${encodeURIComponent(originalId)}`;
        const r = await api(path, { method: isNew ? "POST" : "PUT", body: JSON.stringify(body) });
        toast(`已保存：${r.scenario?.id || body.id}` + (r.persistError ? `（写回源文件失败：${r.persistError}，重启后会丢失）` : ""));
        await load();
      } catch (error) {
        toast(`保存失败：${error.message}`, true);
      }
    });

    const delBtn = el("button", { type: "button", className: "danger", textContent: "删除" });
    delBtn.addEventListener("click", async () => {
      if (isNew) {
        wrapper.remove();
        return;
      }
      // eslint-disable-next-line no-alert
      if (!window.confirm(`确定删除场景「${originalId}」？会改写源文件。`)) return;
      try {
        const r = await api(`/api/dev/scenarios/${encodeURIComponent(originalId)}`, { method: "DELETE" });
        toast(`已删除：${originalId}` + (r.persistError ? `（写回源文件失败：${r.persistError}）` : ""));
        await load();
      } catch (error) {
        toast(`删除失败：${error.message}`, true);
      }
    });

    const summaryText = isNew
      ? "★ 新增场景（填 ID 与提示词后保存）"
      : `${scn.id} — ${scn.name || ""}  [${scn.resolvedTag || scn.tag || "无标签"}]  (${scn.bankKey}${scn.active ? "" : "·未启用"})`;
    const actions = el("div", { className: "action-row" }, [toggleBtn, saveBtn, delBtn]);
    const body = el("div", { className: "dev-scenario-body" }, [form, jsonView, actions]);
    const wrapper = el("details", { className: "helper-details", open: isNew });
    wrapper.append(el("summary", { textContent: summaryText }), body);
    return wrapper;
  }

  async function load() {
    // 标签：取最新设置（GET 不回显令牌但含 customTags）
    try {
      const s = state.settings && Array.isArray(state.settings.customTags) ? state.settings : await api("/api/settings");
      state.settings = s;
      customTags = Array.isArray(s.customTags) ? [...s.customTags] : [];
    } catch {
      customTags = [];
    }
    renderChips();

    listBox.textContent = "正在加载…";
    try {
      const scenarios = await api("/api/dev/scenarios");
      listBox.innerHTML = "";
      listBox.append(el("div", { textContent: `共 ${scenarios.length} 条场景。` }));
      for (const scn of scenarios) listBox.append(scenarioEditor(scn, scn.id));
    } catch (error) {
      listBox.textContent = `加载场景失败：${error.message}`;
    }
  }

  addBtn.addEventListener("click", () => {
    const tpl = { id: "", name: "", category: "basic", difficulty: "small", prompt: "", minChars: 5 };
    listBox.prepend(scenarioEditor(tpl, null));
  });
  reloadBtn.addEventListener("click", load);

  return { load };
}
