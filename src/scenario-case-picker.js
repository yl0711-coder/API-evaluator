import { escapeHtml } from "./client-utils.js";

// 场景多选器:复用 .batch-picker 的视觉(勾选列表 + 全选/清空 + chips),与上方
// 「勾选要体检的模型」样式一致。真值仍写回隐藏的 <select multiple>(scenarioCaseSelect),
// 既有读取(.selectedOptions / requireSelectedValues)与模板自动勾选(option.selected)逻辑不变。
export function createScenarioCasePicker(container, hiddenSelect) {
  container.classList.add("batch-picker");
  container.innerHTML = `
    <div class="bp-listhead">
      <span class="bp-list-title">勾选要测试的场景</span>
      <span class="bp-acts"><button type="button" class="bp-all">全选</button><button type="button" class="bp-clear">清空</button></span>
    </div>
    <div class="list bp-list"></div>
    <p class="bp-echo"></p>
    <div class="chips bp-chips"></div>`;

  const list = container.querySelector(".bp-list");
  const echo = container.querySelector(".bp-echo");
  const chips = container.querySelector(".bp-chips");

  // 当前可选项,从隐藏 select 的 option 读出(value + data-name + data-difficulty + selected)。
  function rows() {
    return [...hiddenSelect.options]
      .filter((o) => o.value)
      .map((o) => ({ id: o.value, name: o.dataset.name || o.textContent, difficulty: o.dataset.difficulty || "", selected: o.selected }));
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
    const data = rows();
    list.innerHTML = data.length
      ? data
          .map(
            (r) =>
              `<label class="opt${r.selected ? " checked" : ""}" data-id="${escapeHtml(r.id)}"><input type="checkbox" ${r.selected ? "checked" : ""}><span class="name">${escapeHtml(r.name)}</span>${r.difficulty ? `<span class="pill">${escapeHtml(r.difficulty)}</span>` : ""}</label>`,
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
    const selected = data.filter((r) => r.selected);
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

  container.querySelector(".bp-all").addEventListener("click", () => {
    [...hiddenSelect.options].forEach((o) => {
      if (o.value) o.selected = true;
    });
    emitChange();
    renderList();
    renderChips();
  });
  container.querySelector(".bp-clear").addEventListener("click", () => {
    [...hiddenSelect.options].forEach((o) => {
      o.selected = false;
    });
    emitChange();
    renderList();
    renderChips();
  });

  // 外部改了隐藏 select(重新载入场景 / 套用模板)后调用,重渲染勾选与 chips。
  function refresh() {
    renderList();
    renderChips();
  }

  return { refresh };
}
