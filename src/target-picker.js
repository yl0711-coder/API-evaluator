import { escapeHtml } from "./client-utils.js";

// 把 state 的 渠道 + 模型目标 + 旧 profile 分组成「渠道 -> 该渠道的模型目标」结构,供级联下拉用。
// 只列“有模型目标”的渠道(避免选了空渠道、第二下拉没东西);未迁移的孤儿老 profile 归入“旧配置”分组。
export function groupRunnableTargets({ channels = [], modelTargets = [], profiles = [] } = {}) {
  const channelIds = new Set(channels.map((c) => c.id));
  const groups = channels
    .slice()
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
    .map((c) => ({
      channelId: c.id,
      label: String(c.name || c.id) + (c.status === "disabled" ? "（已禁用）" : ""),
      targets: modelTargets
        .filter((t) => t.channelId === c.id)
        .map((t) => ({ id: t.id, model: t.model }))
        .sort((a, b) => String(a.model).localeCompare(String(b.model))),
    }))
    .filter((g) => g.targets.length > 0);
  const legacy = profiles
    .filter((p) => (p.role === "target" || p.role === "baseline") && !channelIds.has(p.id))
    .map((p) => ({ id: p.id, model: `${p.name} / ${p.defaultModel || ""}`.replace(/ \/ $/, "") }))
    .sort((a, b) => String(a.model).localeCompare(String(b.model)));
  return { groups, legacy };
}

const LEGACY = "__legacy__";

// 级联选择器:渠道下拉 + 模型下拉。模型下拉带 name="profileId"(value=模型目标 id),
// 所以表单 FormData 读法不变、后端零改。channelSelect 仅作 UI 联动,不提交。
export function createCascadeTargetPicker(channelSelect, modelSelect) {
  let data = { groups: [], legacy: [] };

  function buildChannels() {
    const opts = ['<option value="">选择渠道</option>'];
    for (const g of data.groups) opts.push(`<option value="${escapeHtml(g.channelId)}">${escapeHtml(g.label)}</option>`);
    if (data.legacy.length) opts.push(`<option value="${LEGACY}">旧配置（直接选）</option>`);
    channelSelect.innerHTML = opts.join("");
  }

  function targetsOf(channelVal) {
    if (channelVal === LEGACY) return data.legacy;
    return (data.groups.find((g) => g.channelId === channelVal) || { targets: [] }).targets;
  }

  function buildModels(channelVal) {
    if (!channelVal) {
      modelSelect.disabled = true;
      modelSelect.innerHTML = '<option value="">先选渠道 ——</option>';
      return;
    }
    const targets = targetsOf(channelVal);
    if (!targets.length) {
      modelSelect.disabled = true;
      modelSelect.innerHTML = '<option value="">该渠道还没有模型</option>';
      return;
    }
    modelSelect.disabled = false;
    modelSelect.innerHTML = targets.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.model)}</option>`).join("");
  }

  channelSelect.addEventListener("change", () => {
    buildModels(channelSelect.value);
    modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });

  // 反查某目标属于哪个渠道,回填两级下拉(供程序化跳转用);找不到则清空。
  function setValue(targetId, { silent = false } = {}) {
    let ch = "";
    if (targetId) {
      const owner = data.groups.find((g) => g.targets.some((t) => t.id === targetId));
      if (owner) ch = owner.channelId;
      else if (data.legacy.some((t) => t.id === targetId)) ch = LEGACY;
    }
    channelSelect.value = ch;
    buildModels(ch);
    if (ch) modelSelect.value = targetId;
    if (!silent) modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // 数据刷新:重建渠道下拉,尽量保留当前选中(按目标 id 命中则保留,否则回落空)。
  function refresh(stateData) {
    const prev = modelSelect.value;
    data = groupRunnableTargets(stateData);
    buildChannels();
    setValue(prev, { silent: true });
  }

  return { refresh, setValue, get value() { return modelSelect.value; } };
}
