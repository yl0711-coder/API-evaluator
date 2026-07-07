// src/model-compare.js
// 「模型比对」（高级测试栏，登录即可用）：选「所用模型」(A) 与「要对比的模型」(B)，
// 依据两者在报告中心各自最近的报告（1 稳定性 + 1 准入 + 每场景最新一份）做统计对比。
// 后端 POST /api/reports/compare 产出并落盘一份「模型对比报告」，前端用浮层查看 + 可下载 md。
import { escapeHtml, toast, downloadText } from "./client-utils.js";
import { api } from "./api-client.js";
import { requireElement } from "./dom-utils.js";
import { createCascadeTargetPicker } from "./target-picker.js";
import { openReportOverlay } from "./report-overlay.js";

export function createModelCompare({ state }) {
  const form = requireElement("#mc-form");
  const aChannel = requireElement("#mc-a-channel");
  const aModel = requireElement("#mc-a-model");
  const bChannel = requireElement("#mc-b-channel");
  const bModel = requireElement("#mc-b-model");
  const aiInput = requireElement("#mc-ai");
  const generateBtn = requireElement("#mc-generate");
  const resultBox = requireElement("#mc-result");

  const cascadeA = createCascadeTargetPicker(aChannel, aModel);
  const cascadeB = createCascadeTargetPicker(bChannel, bModel);

  // 由模型目标 id 反查 { channel(渠道名), model }，供后端按报告文件名匹配。
  function subjectOf(targetId) {
    const t = (state.modelTargets || []).find((x) => x.id === targetId);
    if (!t) return null;
    return { channel: t.channelName || "", model: t.model || "" };
  }

  async function onSubmit(event) {
    event.preventDefault();
    const idA = cascadeA.value;
    const idB = cascadeB.value;
    if (!idA || !idB) {
      toast("请为两个对象都选好渠道与模型。", true);
      return;
    }
    if (idA === idB) {
      toast("两个对象不能是同一个模型，请选不同的。", true);
      return;
    }
    const a = subjectOf(idA);
    const b = subjectOf(idB);
    if (!a || !b) {
      toast("找不到所选模型信息，请刷新后重试。", true);
      return;
    }

    generateBtn.disabled = true;
    const prevLabel = generateBtn.textContent;
    generateBtn.textContent = aiInput.checked ? "生成中…（含 AI 叙述，可能较久）" : "生成中…";
    resultBox.innerHTML = "";
    try {
      const r = await api("/api/reports/compare", {
        method: "POST",
        body: JSON.stringify({ a, b, aiNarrative: aiInput.checked }),
      });
      renderResult(r);
      openReportOverlay(r.reportId, { title: "模型对比报告" });
      toast("对比报告已生成。");
    } catch (error) {
      toast(`生成失败：${error.message}`, true);
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = prevLabel;
    }
  }

  function renderResult({ reportId, markdown, notes }) {
    resultBox.innerHTML = `
      <div class="panel" style="margin-top:14px">
        <div class="action-row" style="justify-content:flex-start">
          <button type="button" class="secondary" data-mc-view>查看报告</button>
          <button type="button" class="secondary" data-mc-download>下载 Markdown</button>
        </div>
        <p class="field-hint" style="margin-top:10px">
          对象 A 采用报告：${escapeHtml(notes?.a || "-")}；对象 B 采用报告：${escapeHtml(notes?.b || "-")}。
          ${notes?.aiApplied ? "已附 AI 叙述。" : notes?.ai ? `AI 叙述：${escapeHtml(notes.ai)}` : ""}
        </p>
      </div>`;
    resultBox.querySelector("[data-mc-view]").addEventListener("click", () => openReportOverlay(reportId, { title: "模型对比报告" }));
    resultBox.querySelector("[data-mc-download]").addEventListener("click", () => downloadText(`${reportId}.md`, markdown));
  }

  form.addEventListener("submit", onSubmit);

  function refreshTargets(data) {
    cascadeA.refresh(data);
    cascadeB.refresh(data);
  }

  // 进入页面：用当前 state 刷新两个级联下拉。
  function load() {
    refreshTargets({ modelTargets: state.modelTargets, channels: state.channels, profiles: state.profiles });
  }

  return { load, refreshTargets };
}
