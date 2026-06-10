import { api } from "./api-client.js";
import { escapeHtml, toast } from "./client-utils.js";

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
          <small>${escapeHtml(protoLabel(channel.protocol))} · ${models} 个模型 · ${channel.hasKey ? "已存 Key" : "缺 Key"}${source}</small>
        </div>
        ${status}
        <div class="row-actions">
          ${channel.source === "newapi" ? `<button class="secondary" data-sync-channel="${channel.id}">同步模型</button>` : ""}
          <button class="secondary" data-edit-channel="${channel.id}">编辑</button>
          <button class="secondary" data-del-channel="${channel.id}">删除</button>
        </div>
      </div>`;
  }
  function renderChannelOptions() {
    const list = (state.channels || []).filter((c) => c.status !== "disabled");
    els.modelTargetChannelSelect.innerHTML = list.length
      ? list.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}（${escapeHtml(protoLabel(c.protocol))}）</option>`).join("")
      : `<option value="">请先在“渠道管理”添加渠道</option>`;
  }

  function renderModelTargetList() {
    const list = state.modelTargets || [];
    els.modelTargetList.innerHTML = list.length
      ? list.map(modelTargetRow).join("")
      : `<div class="empty-state"><strong>还没有测试模型</strong><p>选一个渠道 + 填模型名添加。</p></div>`;
    els.modelTargetList.querySelectorAll("[data-del-target]").forEach((b) => b.addEventListener("click", () => deleteModelTarget(b.dataset.delTarget)));
  }
  function modelTargetRow(target) {
    const badge = target.channelStatus === "disabled"
      ? `<span class="chan-pill bad">渠道已禁用</span>`
      : target.channelStatus === "missing"
        ? `<span class="chan-pill bad">渠道缺失</span>`
        : `<span class="chan-pill good">可测</span>`;
    return `
      <div class="chan-row">
        <div class="chan-who">
          <b>${escapeHtml(target.model)}</b>
          <small>${escapeHtml(target.channelName || "-")} · ${escapeHtml(protoLabel(target.protocol))}${target.note ? " · " + escapeHtml(target.note) : ""}</small>
        </div>
        ${badge}
        <div class="row-actions"><button class="secondary" data-del-target="${target.id}">删除</button></div>
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

  return { loadChannels, loadModelTargets, saveChannel, saveModelTarget, importFromNewapi };
}

function protoLabel(protocol) {
  if (protocol === "claude_messages") return "Claude Messages";
  if (protocol === "openai_chat") return "OpenAI Chat";
  if (protocol === "openai_compatible") return "OpenAI 兼容";
  return protocol || "-";
}
