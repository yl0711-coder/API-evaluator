// src/model-compare.js
// 「模型比对」（高级测试栏，登录即可用）：选「所用模型」(A) 与「要对比的模型」(B)，
// 依据两者在报告中心各自最近的报告（1 稳定性 + 1 准入 + 每场景最新一份）做统计对比。
// 后端 POST /api/reports/compare 产出并落盘一份「模型对比报告」，前端用浮层查看 + 可下载 md。
import { escapeHtml, toast, downloadText } from "./client-utils.js";
import { api, runRemoteTask } from "./api-client.js";
import { requireElement } from "./dom-utils.js";
import { createCascadeTargetPicker } from "./target-picker.js";
import { openReportOverlay } from "./report-overlay.js";

export function createModelCompare({ state, confirm }) {
  const form = requireElement("#mc-form");
  const aChannel = requireElement("#mc-a-channel");
  const aModel = requireElement("#mc-a-model");
  const aName = requireElement("#mc-a-name");
  const bChannel = requireElement("#mc-b-channel");
  const bModel = requireElement("#mc-b-model");
  const bName = requireElement("#mc-b-name");
  const aiInput = requireElement("#mc-ai");
  const generateBtn = requireElement("#mc-generate");
  const resultBox = requireElement("#mc-result");
  const loadScenariosBtn = requireElement("#mc-load-scenarios");
  const scenariosBox = requireElement("#mc-scenarios");
  const scenarioHint = requireElement("#mc-scenario-hint");
  const gapFillBox = requireElement("#mc-gap-fill");
  const fillGapsBtn = requireElement("#mc-fill-gaps");
  const gapHint = requireElement("#mc-gap-hint");
  const gapProgress = requireElement("#mc-gap-progress");

  const cascadeA = createCascadeTargetPicker(aChannel, aModel);
  const cascadeB = createCascadeTargetPicker(bChannel, bModel);

  // null = 未加载可选场景（生成时不带 scenarios 字段，后端用全部共有场景）；
  // 数组 = 已加载的两方共有场景 [{name, tier}]，勾选状态在 DOM 上。
  let loadedScenarios = null;
  // 「补齐单方场景」：{ onlyA: [{name,tier}], onlyB: [...] } | null（未算出 / 已重置）。
  // onlyA = A 测过但 B 没测过（需要补给 B）；onlyB 反之（需要补给 A）。
  let gaps = null;

  // 由模型目标 id 反查 { channel(渠道名), model, 曾用名 }，供后端按报告文件名匹配。
  // 带上渠道与模型的曾用名(aliases)，让改名前的历史报告也能被本模型认领。
  function subjectOf(targetId) {
    const t = (state.modelTargets || []).find((x) => x.id === targetId);
    if (!t) return null;
    const ch = (state.channels || []).find((c) => c.id === t.channelId);
    return {
      channel: t.channelName || "",
      model: t.model || "",
      channelAliases: Array.isArray(ch?.aliases) ? ch.aliases : [],
      modelAliases: Array.isArray(t.aliases) ? t.aliases : [],
    };
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

    // 已加载且有共有场景时，只用勾选的（未勾选任何 → 拦下）；未加载或无共有场景时不带 scenarios（后端用全部共有）。
    let scenarios;
    if (loadedScenarios && loadedScenarios.length) {
      scenarios = checkedScenarioNames();
      if (!scenarios.length) {
        toast("请至少勾选一个场景，或点「重置」用全部共有场景。", true);
        return;
      }
    }

    // 可选：为两个对象取一个「只用于本次报告」的显示名（留空则后端回退 渠道 / 模型）。
    const aNameVal = aName.value.trim();
    const bNameVal = bName.value.trim();

    generateBtn.disabled = true;
    const prevLabel = generateBtn.textContent;
    generateBtn.textContent = aiInput.checked ? "生成中…（含 AI 叙述，可能较久）" : "生成中…";
    resultBox.innerHTML = "";
    try {
      const r = await api("/api/reports/compare", {
        method: "POST",
        body: JSON.stringify({
          a,
          b,
          aiNarrative: aiInput.checked,
          ...(aNameVal ? { aName: aNameVal } : {}),
          ...(bNameVal ? { bName: bNameVal } : {}),
          ...(scenarios ? { scenarios } : {}),
        }),
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

  // 勾选的场景名。
  function checkedScenarioNames() {
    return [...scenariosBox.querySelectorAll('input[type="checkbox"]:checked')].map((el) => el.value);
  }

  // 渲染两方共有场景为复选框（默认全选）+ 全选/全不选/重置控件。
  function renderScenarioChecklist(scenarios) {
    if (!scenarios.length) {
      scenariosBox.innerHTML = `<p class="field-hint">两方没有共有的同名场景（可能只共有稳定性/准入）。将按全部共有报告生成。</p>`;
      scenariosBox.classList.remove("hidden");
      return;
    }
    const items = scenarios
      .map(
        (s) =>
          `<label class="mc-scenario-item"><input type="checkbox" value="${escapeHtml(s.name)}" checked /><span>${escapeHtml(s.name)}${s.tier ? ` <em>${escapeHtml(s.tier)}</em>` : ""}</span></label>`,
      )
      .join("");
    scenariosBox.innerHTML = `
      <div class="mc-scenario-tools">
        <span class="field-hint" id="mc-scenario-count"></span>
        <span class="mc-scenario-actions">
          <button type="button" class="link-button" data-mc-all>全选</button>
          <button type="button" class="link-button" data-mc-none>全不选</button>
          <button type="button" class="link-button" data-mc-reset>重置(用全部共有)</button>
        </span>
      </div>
      <div class="mc-scenario-list">${items}</div>`;
    scenariosBox.classList.remove("hidden");
    // 以下按钮是本次 innerHTML 新建的子节点，随重渲染一起丢弃，故可在渲染函数里挂监听。
    scenariosBox.querySelector("[data-mc-all]").addEventListener("click", () => {
      scenariosBox.querySelectorAll('input[type="checkbox"]').forEach((el) => (el.checked = true));
      updateScenarioCount();
    });
    scenariosBox.querySelector("[data-mc-none]").addEventListener("click", () => {
      scenariosBox.querySelectorAll('input[type="checkbox"]').forEach((el) => (el.checked = false));
      updateScenarioCount();
    });
    scenariosBox.querySelector("[data-mc-reset]").addEventListener("click", resetScenarios);
    updateScenarioCount();
  }

  // 计数文案：读模块级 loadedScenarios（渲染时传的就是它），不闭包 scenarios 参数——
  // 这样 change 监听可在 init 处只挂一次。scenariosBox 是 requireElement 拿到的持久元素，
  // innerHTML 只换子节点、不换它自己；若在渲染函数里给它挂监听，每点一次「加载共有场景」就叠加一个。
  // 重置后 #mc-scenario-count 随子节点消失，故需空值保护。
  function updateScenarioCount() {
    const el = scenariosBox.querySelector("#mc-scenario-count");
    if (!el) return;
    el.textContent = `已选 ${checkedScenarioNames().length} / ${loadedScenarios?.length ?? 0} 个共有场景`;
  }

  // 清空场景选择：回到「未加载」态（生成时不带 scenarios → 用全部共有）。
  function resetScenarios() {
    loadedScenarios = null;
    scenariosBox.innerHTML = "";
    scenariosBox.classList.add("hidden");
    scenarioHint.classList.remove("hidden");
    resetGaps();
  }

  // 清空「补齐单方场景」状态：换模型/渠道，或补齐流程结束后回到未算出的初始态。
  function resetGaps() {
    gaps = null;
    gapFillBox.classList.add("hidden");
    gapHint.textContent = "";
    gapProgress.classList.add("hidden");
  }

  async function onLoadScenarios() {
    const idA = cascadeA.value;
    const idB = cascadeB.value;
    if (!idA || !idB || idA === idB) {
      toast("请先选好两个不同的模型。", true);
      return;
    }
    const a = subjectOf(idA);
    const b = subjectOf(idB);
    if (!a || !b) {
      toast("找不到所选模型信息，请刷新后重试。", true);
      return;
    }
    loadScenariosBtn.disabled = true;
    const prev = loadScenariosBtn.textContent;
    loadScenariosBtn.textContent = "加载中…";
    try {
      const [scenarioRes, gapRes] = await Promise.all([
        api("/api/reports/compare/scenarios", { method: "POST", body: JSON.stringify({ a, b }) }),
        api("/api/reports/compare/gaps", { method: "POST", body: JSON.stringify({ a, b }) }).catch(() => null),
      ]);
      loadedScenarios = Array.isArray(scenarioRes.scenarios) ? scenarioRes.scenarios : [];
      renderScenarioChecklist(loadedScenarios);
      renderGaps(gapRes);
    } catch (error) {
      toast(`加载场景失败：${error.message}`, true);
    } finally {
      loadScenariosBtn.disabled = false;
      loadScenariosBtn.textContent = prev;
    }
  }

  // 渲染「补齐单方场景」入口：两方都无独有场景（或差集接口失败）则隐藏按钮。
  function renderGaps(gapRes) {
    const onlyA = Array.isArray(gapRes?.onlyA) ? gapRes.onlyA : [];
    const onlyB = Array.isArray(gapRes?.onlyB) ? gapRes.onlyB : [];
    if (!onlyA.length && !onlyB.length) {
      resetGaps();
      return;
    }
    gaps = { onlyA, onlyB };
    gapFillBox.classList.remove("hidden");
    gapHint.textContent = `发现 A 有 ${onlyA.length} 个场景 B 未测，B 有 ${onlyB.length} 个场景 A 未测。点击可自动为对方补测（真实消耗额度）。`;
    gapProgress.classList.add("hidden");
  }

  // 把场景名映射为场景 id：state.scenarios 是当前生效的题库（可能已改名/下架场景不在其中）。
  function scenarioIdByName(name) {
    const s = (state.scenarios || []).find((x) => x.name === name);
    return s ? s.id : null;
  }

  async function onFillGaps() {
    if (!gaps || (!gaps.onlyA.length && !gaps.onlyB.length)) return;
    const idA = cascadeA.value;
    const idB = cascadeB.value;
    if (!idA || !idB) {
      toast("请先选好两个不同的模型。", true);
      return;
    }
    // jobs：[{ targetId, scenarioId, scenarioName, forLabel }]；名字在当前题库里找不到 id 的场景（已改名/下架）跳过。
    const jobs = [];
    const skipped = [];
    for (const s of gaps.onlyA) {
      const scenarioId = scenarioIdByName(s.name);
      if (scenarioId) jobs.push({ targetId: idB, scenarioId, scenarioName: s.name, forLabel: "B" });
      else skipped.push(s.name);
    }
    for (const s of gaps.onlyB) {
      const scenarioId = scenarioIdByName(s.name);
      if (scenarioId) jobs.push({ targetId: idA, scenarioId, scenarioName: s.name, forLabel: "A" });
      else skipped.push(s.name);
    }
    if (!jobs.length) {
      toast("待补场景均已从当前题库下架/改名，无法自动补齐。", true);
      return;
    }

    const detail = [
      `将发起 ${jobs.length} 次场景测试（每次测 1 个场景），逐个进行、每次都真实调用被测 API、消耗额度。`,
      skipped.length ? `另有 ${skipped.length} 个场景已从当前题库下架/改名，无法补齐，将跳过：${skipped.join("、")}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const confirmed = confirm
      ? await confirm({
          title: "补齐单方场景",
          message: detail,
          detail: "确认后会逐个开始测试，可能耗时较久，请不要关闭窗口。",
          confirmLabel: "确认开始补齐",
          cancelLabel: "先不运行",
          tone: jobs.length >= 10 ? "danger" : "normal",
        })
      : window.confirm(detail);
    if (!confirmed) return;

    fillGapsBtn.disabled = true;
    const prevLabel = fillGapsBtn.textContent;
    const failures = [];
    for (let i = 0; i < jobs.length; i += 1) {
      const job = jobs[i];
      fillGapsBtn.textContent = `补齐中…（${i + 1}/${jobs.length}）`;
      gapProgress.classList.remove("hidden");
      const p = gapProgress.querySelector("p");
      if (p) p.textContent = `补齐中 ${i + 1}/${jobs.length}：《${job.scenarioName}》→ 补给对象 ${job.forLabel} (0%)`;
      try {
        await runRemoteTask(
          state,
          "mc-gap-fill",
          "scenario",
          { profileIds: [job.targetId], scenarioIds: [job.scenarioId], repeats: 1 },
          gapProgress,
        );
      } catch (error) {
        failures.push(`${job.scenarioName}（补给 ${job.forLabel}）：${error.message}`);
      }
    }
    fillGapsBtn.disabled = false;
    fillGapsBtn.textContent = prevLabel;
    gapProgress.classList.add("hidden");

    if (failures.length) {
      toast(`补齐完成：${jobs.length - failures.length}/${jobs.length} 成功，${failures.length} 个失败。`, true);
    } else {
      toast(`补齐完成：${jobs.length} 个场景测试已全部完成。`);
    }
    // 补齐后重新拉一次共有场景 + 差集，让用户能立刻看到最新可对比场景。
    await onLoadScenarios();
  }

  loadScenariosBtn.addEventListener("click", onLoadScenarios);
  fillGapsBtn.addEventListener("click", onFillGaps);
  // 勾选变化 → 更新计数。挂在持久容器上，故只在此挂一次（放渲染函数里会每次渲染叠加）。
  scenariosBox.addEventListener("change", updateScenarioCount);
  // 换模型/渠道后，已加载的场景列表可能不再适用 → 重置，避免用旧场景生成。
  for (const el of [aChannel, aModel, bChannel, bModel]) el.addEventListener("change", resetScenarios);

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
