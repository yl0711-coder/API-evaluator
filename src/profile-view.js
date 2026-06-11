import { escapeHtml, protocolLabel } from "./client-utils.js";
import { resolveRunnableTargets } from "./runnable-targets.js";

export function renderProfileList({ profiles, list, verdicts = {}, onFocusForm, onDeleteProfile, onUpdateKey, onEditProfile }) {
  if (profiles.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <strong>还没有可测试的 API</strong>
        <p>先把平台给你的地址、Key 和模型名填进来。不会填协议时，直接选“AI 中转站 / OpenAI 兼容”。</p>
        <button class="primary" type="button" data-focus-profile-form="1">去填写配置</button>
      </div>
    `;
    list.querySelector("[data-focus-profile-form]").addEventListener("click", onFocusForm);
    return;
  }

  list.innerHTML = profiles
    .map((profile) => {
      const verdict = verdicts[profile.id] || null; // { cls: good|warn|bad, label } | null
      const health = verdict ? verdict.cls : "idle";
      const pill = verdict
        ? `<span class="chan-pill ${verdict.cls}">已测 · ${escapeHtml(verdict.label)}</span>`
        : `<span class="chan-pill idle">未测</span>`;
      return `
        <div class="chan-row">
          <span class="chan-health ${health}" title="${verdict ? escapeHtml(verdict.label) : "未测"}"></span>
          <div class="chan-who">
            <b>${escapeHtml(profile.name)} <span class="chan-role ${roleClass(profile.role)}">${roleLabel(profile.role)}</span></b>
            <small>${escapeHtml(profile.defaultModel)} · ${escapeHtml(protocolLabel(profile.protocol))}</small>
          </div>
          <div class="chan-meta">${escapeHtml(formatProfilePrice(profile))}</div>
          ${pill}
          <div class="row-actions">
            <button class="secondary" data-edit-profile="${profile.id}">编辑</button>
            <button class="secondary" data-update-key="${profile.id}">更新 Key</button>
            <button class="secondary" data-delete-profile="${profile.id}">删除</button>
          </div>
        </div>
      `;
    })
    .join("");

  list.querySelectorAll("[data-delete-profile]").forEach((button) => {
    button.addEventListener("click", () => onDeleteProfile(button.dataset.deleteProfile));
  });

  list.querySelectorAll("[data-update-key]").forEach((button) => {
    button.addEventListener("click", () => onUpdateKey(button.dataset.updateKey));
  });

  if (onEditProfile) {
    list.querySelectorAll("[data-edit-profile]").forEach((button) => {
      button.addEventListener("click", () => onEditProfile(button.dataset.editProfile));
    });
  }
}

function formatProfilePrice(profile) {
  const input = Number.isFinite(Number(profile.inputPricePerMTokens)) ? Number(profile.inputPricePerMTokens) : null;
  const output = Number.isFinite(Number(profile.outputPricePerMTokens)) ? Number(profile.outputPricePerMTokens) : null;
  const sellInput = Number.isFinite(Number(profile.inputSellPricePerMTokens)) ? Number(profile.inputSellPricePerMTokens) : null;
  const sellOutput = Number.isFinite(Number(profile.outputSellPricePerMTokens)) ? Number(profile.outputSellPricePerMTokens) : null;
  if (input === null && output === null && sellInput === null && sellOutput === null) return "未填单价";
  return `成本 ${input ?? "-"}/${output ?? "-"} · 售价 ${sellInput ?? "-"}/${sellOutput ?? "-"}`;
}

export function renderMissingKeyPanel({ profiles, container, onFillKey }) {
  const missing = profiles.filter((profile) => profile.hasKey === false || !profile.apiKey);
  if (missing.length === 0) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }

  container.classList.remove("hidden");
  container.innerHTML = `
    <div class="section-header compact">
      <div>
        <p class="eyebrow">需要补 Key</p>
        <h3>导入的配置里有 ${missing.length} 条还不能测试</h3>
      </div>
    </div>
    <p class="section-desc">为了安全，导出的配置不会带真实 Key。请逐条补 Key，补完后点击“保存并测试配置”，通过后再进入标准评测。</p>
    <div class="inline-list">
      ${missing
        .map(
          (profile) => `
            <article class="inline-item">
              <div>
                <strong>${escapeHtml(profile.name)}</strong>
                <small>${escapeHtml(profile.defaultModel || "-")}</small>
              </div>
              <button class="primary" type="button" data-fill-missing-key="${profile.id}">补 Key</button>
            </article>
          `,
        )
        .join("")}
    </div>
  `;

  container.querySelectorAll("[data-fill-missing-key]").forEach((button) => {
    button.addEventListener("click", () => onFillKey(button.dataset.fillMissingKey));
  });
}

// v0.3.0 运行下拉：列“模型目标”（渠道名 / 模型，value=目标 id，运行链路已支持）。
// 过渡期兼容：未被迁移成渠道的旧 profile（没有同 id 渠道）也一并列出，标注“旧配置”。
export function renderRunTargetSelectOptions({ modelTargets = [], channels = [], profiles = [], selects }) {
  const targets = resolveRunnableTargets({ channels, modelTargets, profiles });
  const options = targets.map((target) => {
    if (target.source === "legacy") {
      return `<option value="${target.id}">${escapeHtml(target.name)} / ${escapeHtml(target.model || "")}（旧配置）</option>`;
    }
    const disabled = target.channelStatus === "disabled" ? "（已禁用）" : "";
    return `<option value="${target.id}">${escapeHtml(target.name)}${disabled}</option>`;
  });
  const html = options.length ? options.join("") : `<option value="">请先在“模型管理”添加测试模型</option>`;
  selects.forEach((select) => {
    select.innerHTML = html;
  });
}

export function renderProfileSelectOptions({ profiles, selects }) {
  const targets = profiles.filter((profile) => profile.role === "target" || profile.role === "baseline");
  if (targets.length === 0) {
    selects.forEach((select) => {
      select.innerHTML = `<option value="">请先新增被测 API</option>`;
    });
    return;
  }

  const options = targets
    .map((profile) => `<option value="${profile.id}">${escapeHtml(profile.name)} / ${escapeHtml(profile.defaultModel)}${profile.role === "baseline" ? " / 可信基线" : ""}</option>`)
    .join("");
  selects.forEach((select) => {
    select.innerHTML = options;
  });
}

function roleLabel(role) {
  if (role === "judge") return "主 API";
  if (role === "baseline") return "可信基线";
  return "被测";
}

function roleClass(role) {
  if (role === "judge") return "judge";
  if (role === "baseline") return "baseline";
  return "target";
}

