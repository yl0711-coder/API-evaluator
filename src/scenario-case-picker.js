import { escapeHtml } from "./client-utils.js";
import { distinctGroups, filterRowsByGroup, resolveGroupFilterValue, visibleSelectableIds, selectedRows } from "./scenario-grouping.js";

// 场景多选器:复用 .batch-picker 的视觉(勾选列表 + 全选/清空 + chips),与上方
// 「勾选要体检的模型」样式一致。真值仍写回隐藏的 <select multiple>(scenarioCaseSelect),
// 既有读取(.selectedOptions / requireSelectedValues)与模板自动勾选(option.selected)逻辑不变。
export function createScenarioCasePicker(container, hiddenSelect) {
  container.classList.add("batch-picker");
  container.innerHTML = `
    <div class="bp-listhead">
      <span class="bp-list-title">勾选要测试的场景</span>
      <span class="bp-acts"><select class="bp-group-filter"><option value="">全部分组</option></select><button type="button" class="bp-all">全选</button><button type="button" class="bp-clear">清空</button></span>
    </div>
    <div class="list bp-list"></div>
    <p class="bp-echo"></p>
    <div class="chips bp-chips"></div>`;

  const list = container.querySelector(".bp-list");
  const echo = container.querySelector(".bp-echo");
  const chips = container.querySelector(".bp-chips");
  const groupFilter = container.querySelector(".bp-group-filter");

  // 当前可选项,从隐藏 select 的 option 读出(value + data-name + data-tag + data-difficulty + data-group + selected)。
  function rows() {
    return [...hiddenSelect.options]
      .filter((o) => o.value)
      .map((o) => ({ id: o.value, name: o.dataset.name || o.textContent, tag: o.dataset.tag || "", difficulty: o.dataset.difficulty || "", group: o.dataset.group || "", selected: o.selected }));
  }
  // 当前分组筛选下的可见项（空＝全部）。
  function visibleRows() {
    return filterRowsByGroup(rows(), groupFilter.value);
  }
  // 用当前 rows 的去重分组重建下拉选项（保留当前选中值）。
  function syncGroupOptions() {
    const groups = distinctGroups(rows());
    const cur = groupFilter.value;
    groupFilter.innerHTML = `<option value="">全部分组</option>` + groups.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join("");
    groupFilter.value = resolveGroupFilterValue(groups, cur);
  }

  function setSelected(id, on) {
    const opt = [...hiddenSelect.options].find((o) => o.value === id);
    if (opt) opt.selected = on;
  }

  // 写回隐藏 select 后派发 change,沿用既有 updateEstimates 监听。
  function emitChange() {
    hiddenSelect.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function renderList() {
    const data = visibleRows();
    list.innerHTML = data.length
      ? data
          .map(
            (r) =>
              `<label class="opt${r.selected ? " checked" : ""}" data-id="${escapeHtml(r.id)}"><input type="checkbox" ${r.selected ? "checked" : ""}><span class="name">${escapeHtml(r.name)}</span>${r.tag ? `<span class="pill tag">${escapeHtml(r.tag)}</span>` : ""}${r.difficulty ? `<span class="pill">${escapeHtml(r.difficulty)}</span>` : ""}</label>`,
          )
          .join("")
      : `<div class="opt"><span class="name" style="color:var(--muted)">暂无测试场景</span></div>`;
    list.querySelectorAll(".opt[data-id]").forEach((row) => {
      row.querySelector("input").addEventListener("change", (e) => {
        setSelected(row.dataset.id, e.target.checked);
        row.classList.toggle("checked", e.target.checked);
        emitChange();
        renderChips();
      });
    });
  }

  function renderChips() {
    const data = rows();
    const selected = selectedRows(data);
    chips.innerHTML = selected.length
      ? selected.map((r) => `<span class="chip" data-id="${escapeHtml(r.id)}">${escapeHtml(r.name)} <span class="x">✕</span></span>`).join("")
      : `<span class="empty-chips">未选择</span>`;
    chips.querySelectorAll(".chip .x").forEach((x) =>
      x.addEventListener("click", () => {
        setSelected(x.parentElement.dataset.id, false);
        emitChange();
        renderList();
        renderChips();
      }),
    );
    echo.innerHTML = `已选 <b>${selected.length}</b> / ${data.length} 个场景`;
  }

  // 全选/清空只作用于「当前分组筛选下可见」的场景，符合筛选后的直觉。
  function setVisibleSelected(on) {
    const visible = visibleSelectableIds(rows(), groupFilter.value);
    [...hiddenSelect.options].forEach((o) => {
      if (o.value && visible.has(o.value)) o.selected = on;
    });
    emitChange();
    renderList();
    renderChips();
  }
  container.querySelector(".bp-all").addEventListener("click", () => setVisibleSelected(true));
  container.querySelector(".bp-clear").addEventListener("click", () => setVisibleSelected(false));
  groupFilter.addEventListener("change", () => {
    renderList();
    renderChips();
  });

  // 外部改了隐藏 select(重新载入场景 / 套用模板)后调用,重建分组选项并重渲染勾选与 chips。
  function refresh() {
    syncGroupOptions();
    renderList();
    renderChips();
  }

  return { refresh };
}
