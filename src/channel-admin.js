import { api } from "./api-client.js";
import { escapeHtml, protocolLabel, toast } from "./client-utils.js";

// v0.3.0 两区管理：渠道（超管，含 key）+ 模型目标（管理员，选渠道+填模型，不见 key）。
export function createChannelAdmin({ state, els, onChange }) {
  async function loadChannels() {
    state.channels = await api("/api/channels");
    renderChannelList();
    renderChannelOptions();
    onChange?.();
  }
  async function loadModelTargets() {
    state.modelTargets = await api("/api/model-targets");
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
    const status = channel.status === "disabled" ? `<span class="chan-pill bad">已禁用</span>` : `<span class="chan-pill good">启用</span>`;
    const source = channel.source === "newapi" ? " · 来自 new-api" : "";
    const models = Array.isArray(channel.models) ? channel.models.length : 0;
    return `
      <div class="chan-row">
        <div class="chan-who">
          <b>${escapeHtml(channel.name)}</b>
          <small>${escapeHtml(protocolLabel(channel.protocol))} · ${models} 个模型 · ${channel.hasKey ? "已存 Key" : "缺 Key"}${source}</small>
        </div>
        ${status}
        <div class="row-actions">
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

  function renderModelTargetList() {
    const list = state.modelTargets || [];
    if (!list.length) {
      els.modelTargetList.innerHTML = `<div class="empty-state"><strong>还没有测试模型</strong><p>选一个渠道 + 填模型名添加。</p></div>`;
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
  }

  // 把该模型并入其渠道在 new-api 的 models 列表（需先把渠道推送到 new-api）。
  async function pushModelTargetToNewapi(id) {
    try {
      const r = await api(`/api/model-targets/${encodeURIComponent(id)}/push-to-newapi`, { method: "POST", body: "{}" });
      toast(r.added ? "已把该模型加入 new-api 渠道。" : "该模型在 new-api 渠道里已存在，无需重复添加。");
    } catch (error) {
      toast(`推送模型失败：${error.message}`, true);
    }
  }
  function modelTargetRow(target) {
    const badge = target.channelStatus === "disabled"
      ? `<span class="chan-pill bad">渠道已禁用</span>`
      : target.channelStatus === "missing"
        ? `<span class="chan-pill bad">渠道缺失</span>`
        : `<span class="chan-pill good">可测</span>`;
    // 场景测验夺标得到的能力标签，可点 × 手动移除。
    const tags = Array.isArray(target.tags) ? target.tags : [];
    const tagChips = tags.length
      ? `<div class="model-tags">${tags
          .map(
            (t) =>
              `<span class="model-tag">${escapeHtml(t)}<button type="button" class="model-tag-x" data-tag-target="${target.id}" data-del-tag="${escapeHtml(t)}" title="移除标签">×</button></span>`,
          )
          .join("")}</div>`
      : "";
    // 渠道名已在分组标题里，卡片小字只显示协议 + 备注。
    return `
      <div class="chan-row">
        <div class="chan-who">
          <b>${escapeHtml(target.model)}</b>
          <small>${escapeHtml(protocolLabel(target.protocol))}${target.note ? " · " + escapeHtml(target.note) : ""}</small>
          ${tagChips}
        </div>
        ${badge}
        <div class="row-actions">
          <button class="secondary" data-push-target="${target.id}">推送到 new-api</button>
          <button class="secondary" data-del-target="${target.id}">删除</button>
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
    try {
      await api(`/api/channels/${encodeURIComponent(id)}`, { method: "DELETE" });
      await Promise.all([loadChannels(), loadModelTargets()]);
      toast("渠道已删除（其下模型目标一并清除）。");
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function saveModelTarget(event) {
    event.preventDefault();
    try {
      const payload = Object.fromEntries(new FormData(els.modelTargetForm).entries());
      await api("/api/model-targets", { method: "POST", body: JSON.stringify(payload) });
      els.modelTargetForm.reset();
      await loadModelTargets();
      toast("测试模型已添加。");
    } catch (error) {
      toast(error.message, true);
    }
  }
  async function deleteModelTarget(id) {
    try {
      await api(`/api/model-targets/${encodeURIComponent(id)}`, { method: "DELETE" });
      await loadModelTargets();
      toast("已删除。");
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

  // 把本平台已授予的模型标签推送到 new-api 模型广场（后端聚合模型目标 tags 并写回）。
  async function pushModelTags() {
    try {
      const r = await api("/api/model-targets/push-tags", { method: "POST", body: "{}" });
      if (r.note) {
        toast(r.note, true);
        return;
      }
      const failNote = r.errors?.length ? `，失败 ${r.errors.length}` : "";
      toast(`推送完成：更新 ${r.updated}、未变 ${r.unchanged}、匹配 ${r.matched}/${r.totalModels} 个模型${failNote}。`);
    } catch (error) {
      toast(`推送标签失败：${error.message}`, true);
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

  return { loadChannels, loadModelTargets, saveChannel, saveModelTarget, importFromNewapi, pushModelTags };
}

