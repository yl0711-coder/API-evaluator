import { escapeHtml } from "./client-utils.js";

// 从 state 建两维度索引。
//   A 渠道体检:有模型目标的渠道 → 该渠道的模型目标。
//   B 渠道选优:去重模型名(大小写不敏感)→ 提供该模型的各渠道目标。
function buildIndex({ channels = [], modelTargets = [] } = {}) {
  const byName = (a, b) => String(a).localeCompare(String(b));
  const chMap = new Map(channels.map((c) => [c.id, c]));
  const aChannels = channels
    .filter((c) => modelTargets.some((t) => t.channelId === c.id))
    .sort((a, b) => byName(a.name, b.name));
  const targetsByChannel = (channelId) =>
    modelTargets.filter((t) => t.channelId === channelId).map((t) => ({ id: t.id, model: t.model })).sort((a, b) => byName(a.model, b.model));
  // 去重模型名,保留首个原始大小写作展示
  const display = new Map();
  for (const t of modelTargets) {
    const k = String(t.model).toLowerCase();
    if (!display.has(k)) display.set(k, t.model);
  }
  const bModels = [...display.values()].sort(byName);
  const targetsForModel = (modelDisplay) => {
    const k = String(modelDisplay).toLowerCase();
    return modelTargets
      .filter((t) => String(t.model).toLowerCase() === k)
      .map((t) => ({ id: t.id, channel: chMap.get(t.channelId) }))
      .filter((x) => x.channel)
      .sort((a, b) => byName(a.channel.name, b.channel.name));
  };
  return { aChannels, targetsByChannel, bModels, targetsForModel };
}

// 批量两维度选择器:渲染进 container,产出一组模型目标 id(getSelectedIds)。
export function createBatchTargetPicker(container, { hiddenSelect } = {}) {
  container.classList.add("batch-picker");
  container.innerHTML = `
    <div class="seg" role="tablist">
      <button type="button" data-dim="A" class="on">渠道体检 · 一渠道·多模型</button>
      <button type="button" data-dim="B">渠道选优 · 一模型·多渠道</button>
    </div>
    <label class="bp-anchor-label"></label>
    <select class="bp-anchor"></select>
    <div class="bp-listhead">
      <span class="bp-list-title"></span>
      <span class="bp-acts"><button type="button" class="bp-all">全选</button><button type="button" class="bp-clear">清空</button></span>
    </div>
    <div class="list bp-list"></div>
    <p class="bp-echo"></p>
    <div class="chips bp-chips"></div>`;

  const segBtns = [...container.querySelectorAll(".seg button")];
  const anchorLabel = container.querySelector(".bp-anchor-label");
  const anchor = container.querySelector(".bp-anchor");
  const listTitle = container.querySelector(".bp-list-title");
  const list = container.querySelector(".bp-list");
  const echo = container.querySelector(".bp-echo");
  const chips = container.querySelector(".bp-chips");

  let dim = "A";
  let idx = { aChannels: [], targetsByChannel: () => [], bModels: [], targetsForModel: () => [] };
  const selected = new Set();

  // 同步到隐藏的 <select multiple>(全部置为 selected),让 updateEstimates / 提交 / 监听器 读法不变。
  function syncHidden() {
    if (!hiddenSelect) return;
    hiddenSelect.innerHTML = [...selected].map((id) => `<option value="${escapeHtml(id)}" selected></option>`).join("");
    hiddenSelect.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function buildAnchor() {
    if (dim === "A") {
      anchorLabel.textContent = "被测渠道";
      listTitle.textContent = "勾选要体检的模型";
      anchor.innerHTML = idx.aChannels.length
        ? idx.aChannels.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}${c.status === "disabled" ? "（已禁用）" : ""}</option>`).join("")
        : `<option value="">还没有可测渠道</option>`;
    } else {
      anchorLabel.textContent = "对比模型";
      listTitle.textContent = "勾选参与对比的渠道（都提供此模型）";
      anchor.innerHTML = idx.bModels.length
        ? idx.bModels.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("")
        : `<option value="">还没有可测模型</option>`;
    }
  }

  function currentRows() {
    if (dim === "A") return idx.targetsByChannel(anchor.value).map((t) => ({ id: t.id, label: t.model, pill: "" }));
    return idx.targetsForModel(anchor.value).map((t) => ({
      id: t.id,
      label: t.channel.name,
      pill: t.channel.status === "disabled" ? '<span class="pill bad">已禁用</span>' : '<span class="pill good">启用</span>',
    }));
  }

  function renderList() {
    const rows = currentRows();
    list.innerHTML = rows.length
      ? rows.map((r) => `<label class="opt${selected.has(r.id) ? " checked" : ""}" data-id="${escapeHtml(r.id)}"><input type="checkbox" ${selected.has(r.id) ? "checked" : ""}><span class="name">${escapeHtml(r.label)}</span>${r.pill}</label>`).join("")
      : `<div class="opt"><span class="name" style="color:var(--muted)">没有可选项</span></div>`;
    list.querySelectorAll(".opt[data-id]").forEach((row) => {
      row.querySelector("input").addEventListener("change", (e) => {
        const id = row.dataset.id;
        if (e.target.checked) selected.add(id); else selected.delete(id);
        row.classList.toggle("checked", e.target.checked);
        renderChips();
      });
    });
  }

  function renderChips() {
    const rows = currentRows();
    const labelOf = (id) => rows.find((r) => r.id === id)?.label || id;
    const ids = [...selected];
    chips.innerHTML = ids.length
      ? ids.map((id) => `<span class="chip" data-id="${escapeHtml(id)}">${escapeHtml(labelOf(id))} <span class="x">✕</span></span>`).join("")
      : `<span class="empty-chips">未选择</span>`;
    chips.querySelectorAll(".chip .x").forEach((x) => x.addEventListener("click", () => {
      selected.delete(x.parentElement.dataset.id);
      renderList(); renderChips();
    }));
    const n = selected.size;
    echo.innerHTML = dim === "A"
      ? `正在体检渠道 <b>${escapeHtml(anchorText())}</b> 的 <b>${n}</b> 个模型`
      : `正在为模型 <b>${escapeHtml(anchor.value || "—")}</b> 对比 <b>${n}</b> 个渠道`;
    syncHidden();
  }
  function anchorText() { return anchor.options[anchor.selectedIndex]?.textContent || "—"; }

  segBtns.forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.dim === dim) return;
    dim = b.dataset.dim;
    segBtns.forEach((x) => x.classList.toggle("on", x.dataset.dim === dim));
    selected.clear();
    buildAnchor(); renderList(); renderChips();
  }));
  anchor.addEventListener("change", () => { selected.clear(); renderList(); renderChips(); });
  container.querySelector(".bp-all").addEventListener("click", () => { currentRows().forEach((r) => selected.add(r.id)); renderList(); renderChips(); });
  container.querySelector(".bp-clear").addEventListener("click", () => { selected.clear(); renderList(); renderChips(); });

  function refresh(stateData) {
    idx = buildIndex(stateData);
    // 尽量保留锚点
    const prevAnchor = anchor.value;
    buildAnchor();
    if (prevAnchor && [...anchor.options].some((o) => o.value === prevAnchor)) anchor.value = prevAnchor;
    // 选中项里仍存在的保留
    const valid = new Set(currentRows().map((r) => r.id));
    [...selected].forEach((id) => { if (!valid.has(id)) selected.delete(id); });
    renderList(); renderChips();
  }

  return { refresh, getSelectedIds: () => [...selected] };
}
