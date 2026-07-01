import { api } from "./api-client.js";
import { escapeHtml, protocolLabel, toast } from "./client-utils.js";
import { unionTagVocabulary, distinctTargetTags, hasUntaggedTarget, filterTargetsByTag, NO_TAG_FILTER } from "./model-tags.js";

// v0.3.0 两区管理：渠道（超管，含 key）+ 模型目标（管理员，选渠道+填模型，不见 key）。
export function createChannelAdmin({ state, els, onChange, confirmDeleteSync, confirm }) {
  // 「按标签筛选」当前选中的标签：""=全部、NO_TAG_FILTER=无标签、其它=该标签。
  let tagFilter = "";
  // 删除前若「允许删除同步至new-api」开启，弹框问是否一并删 new-api。
  // 返回 { proceed:bool, sync:bool }：是→同步删、否→仅本地删、Esc/背景→不删。
  async function resolveDeleteSync(what) {
    if (!state.settings?.enableDeleteSync || !confirmDeleteSync) return { proceed: true, sync: false };
    const choice = await confirmDeleteSync({
      title: "删除确认",
      message: `是否将删除同步至new-api？`,
      detail: `“是”会同时在 new-api 删除该${what}；“否”仅删除本地。`,
      confirmLabel: "是",
      cancelLabel: "否",
      confirmDelayMs: 2000,
      tristate: true,
      tone: "danger",
    });
    if (choice === "dismiss") return { proceed: false, sync: false };
    return { proceed: true, sync: choice === "confirm" };
  }
  // 同步删除结果 → toast 文案。三种结果文案显著区分，避免「是/否」看起来一样。
  function syncToast(base, r) {
    if (r.newapiSynced) return `${base}，并已在 new-api 同步删除。`; // 「是」成功
    if (r.newapiError) return `${base}（本地）；new-api 同步失败：${r.newapiError}`; // 「是」失败
    if (r.newapiSkipped) return `${base}（本地）；${r.newapiSkipped}`; // 「是」但跳过
    return `${base}（仅本地，未同步 new-api）。`; // 「否」仅本地删（响应无 newapiSynced 字段）
  }
  async function loadChannels() {
    state.channels = await api("/api/channels");
    renderChannelList();
    renderChannelOptions();
    onChange?.();
  }
  async function loadModelTargets() {
    state.modelTargets = await api("/api/model-targets");
    populateTagFilter();
    renderModelTargetList();
    onChange?.();
  }

  function renderChannelList() {
    const list = state.channels || [];
    els.channelList.innerHTML = list.length
      ? list.map(channelRow).join("")
      : `<div class="empty-state"><strong>还没有渠道</strong><p>在左侧填 Base URL + Key 添加，或从 new-api 一键导入。</p></div>`;
    els.channelList.querySelectorAll("[data-del-channel]").forEach((b) => b.addEventListener("click", () => deleteChannel(b.dataset.delChannel)));
    els.channelList.querySelectorAll("[data-edit-channel]").forEach((b) => b.addEventListener("click", () => editChannel(b.dataset.editChannel)));
    els.channelList.querySelectorAll("[data-sync-channel]").forEach((b) => b.addEventListener("click", () => syncChannelModels(b.dataset.syncChannel)));
    els.channelList.querySelectorAll("[data-push-channel]").forEach((b) => b.addEventListener("click", () => pushChannelToNewapi(b.dataset.pushChannel)));
  }

  // 把本平台渠道（含上游 Key + models）推送到 new-api：新建或更新已关联渠道。
  async function pushChannelToNewapi(id) {
    try {
      const r = await api(`/api/channels/${encodeURIComponent(id)}/push-to-newapi`, { method: "POST", body: "{}" });
      await loadChannels();
      toast(r.action === "updated" ? `已更新 new-api 渠道「${r.name}」。` : `已在 new-api 新建渠道「${r.name}」。`);
    } catch (error) {
      toast(`推送渠道失败：${error.message}`, true);
    }
  }

  async function syncChannelModels(id) {
    try {
      const r = await api(`/api/channels/${encodeURIComponent(id)}/sync-models`, { method: "POST", body: "{}" });
      await Promise.all([loadChannels(), loadModelTargets()]);
      toast(`已同步该渠道模型：新增 ${r.newTargets} 个。`);
    } catch (error) {
      toast(`同步失败：${error.message}`, true);
    }
  }
  function channelRow(channel) {
    // 未配置 Key 的渠道无法调用，状态显示「未配置」；配好 Key 后才按 enabled/disabled 显示启用/已禁用。
    const status = !channel.hasKey
      ? `<span class="chan-pill warn">未配置</span>`
      : channel.status === "disabled"
        ? `<span class="chan-pill bad">已禁用</span>`
        : `<span class="chan-pill good">启用</span>`;
    const source = channel.source === "newapi" ? " · 来自 new-api" : "";
    const models = Array.isArray(channel.models) ? channel.models.length : 0;
    return `
      <div class="chan-row">
        <div class="chan-who">
          <b>${escapeHtml(channel.name)}</b>
          <small>${escapeHtml(protocolLabel(channel.protocol))} · ${models} 个模型 · ${channel.hasKey ? "已存 Key" : "缺 Key"}${source}</small>
        </div>
        ${status}
        <div class="row-actions${channel.source === "newapi" ? " actions-grid" : ""}">
          ${channel.source === "newapi" ? `<button class="secondary" data-sync-channel="${channel.id}">同步模型</button>` : ""}
          <button class="secondary" data-push-channel="${channel.id}">推送</button>
          <button class="secondary" data-edit-channel="${channel.id}">编辑</button>
          <button class="secondary" data-del-channel="${channel.id}">删除</button>
        </div>
      </div>`;
  }
  function renderChannelOptions() {
    const list = (state.channels || []).filter((c) => c.status !== "disabled");
    els.modelTargetChannelSelect.innerHTML = list.length
      ? list.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}（${escapeHtml(protocolLabel(c.protocol))}）</option>`).join("")
      : `<option value="">请先在“渠道管理”添加渠道</option>`;
  }

  // 配置模型表单的「标签」可勾选项：场景库去重能力标签 ∪ 设置页自定义标签。
  function tagVocabulary() {
    return unionTagVocabulary(state.scenarios, state.settings?.customTags);
  }
  function renderTagOptions(selected = []) {
    const box = els.modelTargetForm.querySelector("#model-target-tags");
    if (!box) return;
    const sel = new Set(selected);
    const vocab = tagVocabulary();
    box.innerHTML = vocab.length
      ? vocab
          .map(
            (t) =>
              `<label class="tag-opt"><input type="checkbox" name="modelTag" value="${escapeHtml(t)}"${sel.has(t) ? " checked" : ""}/><span class="tag-opt-face">${escapeHtml(t)}</span></label>`,
          )
          .join("")
      : `<span class="field-hint">暂无可选标签（场景库为空）。</span>`;
  }

  // 用模型目标上实际出现的标签重建「按标签筛选」下拉，保留当前选中（已不存在则回落「全部」）。
  function populateTagFilter() {
    const sel = els.modelTagFilter;
    if (!sel) return;
    const targets = state.modelTargets || [];
    const tags = distinctTargetTags(targets);
    if (tagFilter && tagFilter !== NO_TAG_FILTER && !tags.includes(tagFilter)) tagFilter = "";
    if (tagFilter === NO_TAG_FILTER && !hasUntaggedTarget(targets)) tagFilter = "";
    const opts = [`<option value="">全部</option>`];
    for (const t of tags) opts.push(`<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`);
    if (hasUntaggedTarget(targets)) opts.push(`<option value="${NO_TAG_FILTER}">无标签</option>`);
    sel.innerHTML = opts.join("");
    sel.value = tagFilter;
  }
  // 切换「按标签筛选」选中项 → 重渲染列表。
  function setTagFilter(value) {
    tagFilter = value || "";
    renderModelTargetList();
  }

  function renderModelTargetList() {
    const all = state.modelTargets || [];
    if (!all.length) {
      els.modelTargetList.innerHTML = `<div class="empty-state"><strong>还没有测试模型</strong><p>选一个渠道 + 填模型名添加。</p></div>`;
      return;
    }
    // 先按「按标签筛选」过滤，再按渠道分组。
    const list = filterTargetsByTag(all, tagFilter);
    if (!list.length) {
      els.modelTargetList.innerHTML = `<div class="empty-state"><strong>没有符合该标签的模型</strong><p>换个标签，或选「全部」查看所有模型。</p></div>`;
      return;
    }
    // 按渠道分组：同一渠道的模型聚在一起，加渠道小标题（一个渠道可挂多个模型）。
    const groups = new Map();
    for (const target of list) {
      const key = target.channelName || target.channelId || "未知渠道";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(target);
    }
    els.modelTargetList.innerHTML = [...groups.entries()]
      .map(([channelName, targets]) => `
        <div class="model-group">
          <div class="model-group-head"><b>${escapeHtml(channelName)}</b><span>${targets.length} 个模型</span></div>
          <div class="model-group-grid">${targets.map(modelTargetRow).join("")}</div>
        </div>`)
      .join("");
    els.modelTargetList.querySelectorAll("[data-del-target]").forEach((b) => b.addEventListener("click", () => deleteModelTarget(b.dataset.delTarget)));
    els.modelTargetList.querySelectorAll("[data-del-tag]").forEach((b) => b.addEventListener("click", () => removeModelTargetTag(b.dataset.tagTarget, b.dataset.delTag)));
    els.modelTargetList.querySelectorAll("[data-push-target]").forEach((b) => b.addEventListener("click", () => pushModelTargetToNewapi(b.dataset.pushTarget)));
    els.modelTargetList.querySelectorAll("[data-edit-target]").forEach((b) => b.addEventListener("click", () => editModelTarget(b.dataset.editTarget)));
  }

  // 把该模型并入其渠道在 new-api 的 models 列表（需先把渠道推送到 new-api）。标签为纯本地概念，不再推送。
  async function pushModelTargetToNewapi(id) {
    const target = (state.modelTargets || []).find((t) => t.id === id);
    const modelName = target?.model || "该模型";
    if (!(await confirm({ title: "推送模型", message: `确定把「${modelName}」推送到 new-api 吗？`, confirmLabel: "推送", cancelLabel: "取消" }))) return;
    try {
      const r = await api(`/api/model-targets/${encodeURIComponent(id)}/push-to-newapi`, { method: "POST", body: "{}" });
      await loadModelTargets();
      toast((r.added ? "已把该模型加入 new-api 渠道。" : "该模型在 new-api 渠道里已存在。"));
    } catch (error) {
      toast(`推送模型失败：${error.message}`, true);
    }
  }
  // 重新编辑模型：回填表单（含标签勾选），保存沿用同一 saveModelTarget（按 id 覆盖）。
  function editModelTarget(id) {
    const target = (state.modelTargets || []).find((t) => t.id === id);
    if (!target) return;
    const f = els.modelTargetForm;
    f.elements.id.value = target.id;
    f.elements.channelId.value = target.channelId || "";
    f.elements.model.value = target.model || "";
    f.elements.note.value = target.note || "";
    renderTagOptions(Array.isArray(target.tags) ? target.tags : []);
    f.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function modelTargetRow(target) {
    const badge = target.channelStatus === "disabled"
      ? `<span class="chan-pill bad">已禁用</span>`
      : target.channelStatus === "missing"
        ? `<span class="chan-pill bad">渠道缺失</span>`
        : `<span class="chan-pill good">可测</span>`;
    // 标签为纯本地概念（单一样式），× 本地移除。不再区分明黄/灰、不再与 new-api 联动。
    const tags = Array.isArray(target.tags) ? target.tags : [];
    const allChips = tags.map(
      (t) =>
        `<span class="model-tag">${escapeHtml(t)}<button type="button" class="model-tag-x" data-tag-target="${target.id}" data-del-tag="${escapeHtml(t)}" title="移除标签">×</button></span>`,
    );
    const tagChips = allChips.length ? `<div class="model-tags">${allChips.join("")}</div>` : "";
    // 「推送模型到 new-api」会写外部、仅超管可用 → 非超管不渲染该按钮（后端 api-access 也强制 403）。
    const actions = [];
    if (state.canConfig) actions.push(`<button class="secondary" data-push-target="${target.id}">推送</button>`);
    actions.push(`<button class="secondary" data-edit-target="${target.id}">编辑</button>`);
    actions.push(`<button class="secondary" data-del-target="${target.id}">删除</button>`);
    // 渠道名已在分组标题里，卡片小字只显示协议 + 备注。按钮一排（列数随按钮数自适应，避免空格）。
    // 列数整体注入为一个变量，避免 IDE 把内联样式里的 repeat(${...}) 当 CSS 语法误报。
    const gridCols = `repeat(${actions.length}, 1fr)`;
    return `
      <div class="chan-row">
        <div class="chan-who">
          <b>${escapeHtml(target.model)}</b>
          <small>${escapeHtml(protocolLabel(target.protocol))}${target.note ? " · " + escapeHtml(target.note) : ""}</small>
          ${tagChips}
        </div>
        ${badge}
        <div class="row-actions actions-grid" style="grid-template-columns: ${gridCols}">
          ${actions.join("")}
        </div>
      </div>`;
  }

  async function saveChannel(event) {
    event.preventDefault();
    try {
      const payload = Object.fromEntries(new FormData(els.channelForm).entries());
      await api("/api/channels", { method: "POST", body: JSON.stringify(payload) });
      els.channelForm.reset();
      if (els.channelForm.elements.id) els.channelForm.elements.id.value = "";
      await loadChannels();
      toast("渠道已保存。");
    } catch (error) {
      toast(error.message, true);
    }
  }
  function editChannel(id) {
    const channel = (state.channels || []).find((c) => c.id === id);
    if (!channel) return;
    const f = els.channelForm;
    f.elements.id.value = channel.id;
    f.elements.name.value = channel.name || "";
    f.elements.baseUrl.value = channel.baseUrl || "";
    f.elements.protocol.value = channel.protocol || "openai_compatible";
    f.elements.provider.value = channel.provider || "";
    f.elements.models.value = (channel.models || []).join(", ");
    f.elements.apiKey.value = "";
    f.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  async function deleteChannel(id) {
    const { proceed, sync } = await resolveDeleteSync("渠道");
    if (!proceed) return;
    try {
      const r = await api(`/api/channels/${encodeURIComponent(id)}${sync ? "?syncNewapi=1" : ""}`, { method: "DELETE" });
      await Promise.all([loadChannels(), loadModelTargets()]);
      toast(syncToast("渠道已删除（其下模型目标一并清除）", r));
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function saveModelTarget(event) {
    event.preventDefault();
    try {
      const payload = Object.fromEntries(new FormData(els.modelTargetForm).entries());
      // 标签来自勾选框（FormData 会把多选折成单值），显式收集为数组；删掉冗余的 modelTag 键。
      const box = els.modelTargetForm.querySelector("#model-target-tags");
      payload.tags = box ? [...box.querySelectorAll("input[name=modelTag]:checked")].map((i) => i.value) : [];
      delete payload.modelTag;
      await api("/api/model-targets", { method: "POST", body: JSON.stringify(payload) });
      els.modelTargetForm.reset();
      renderTagOptions([]); // reset() 仅清表单控件，这里重建标签勾选区为未选中。
      await loadModelTargets();
      toast("测试模型已添加。");
    } catch (error) {
      toast(error.message, true);
    }
  }
  async function deleteModelTarget(id) {
    const { proceed, sync } = await resolveDeleteSync("模型");
    if (!proceed) return;
    try {
      const r = await api(`/api/model-targets/${encodeURIComponent(id)}${sync ? "?syncNewapi=1" : ""}`, { method: "DELETE" });
      await loadModelTargets();
      toast(syncToast("已删除", r));
    } catch (error) {
      toast(error.message, true);
    }
  }
  async function removeModelTargetTag(id, tag) {
    try {
      await api(`/api/model-targets/${encodeURIComponent(id)}/remove-tag`, { method: "POST", body: JSON.stringify({ tag }) });
      await loadModelTargets();
      toast(`已移除标签：${tag}`);
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function importFromNewapi() {
    try {
      const r = await api("/api/channels/import", { method: "POST", body: "{}" });
      await Promise.all([loadChannels(), loadModelTargets()]);
      const keyNote = r.mode === "api" ? "（api 模式不含 Key，请逐个补 Key）" : "";
      toast(`从 new-api 导入完成：新增 ${r.imported} / 更新 ${r.updated} 个渠道，${r.newTargets} 个模型，禁用 ${r.disabled} 个${keyNote}。`);
    } catch (error) {
      toast(`导入失败：${error.message}`, true);
    }
  }

  return { loadChannels, loadModelTargets, saveChannel, saveModelTarget, importFromNewapi, renderTagOptions, setTagFilter };
}

