// src/alert-rules.js
// 「报警规则」：任意登录管理员可自定义阈值报警规则——测试运行完成后，若某项原始指标触发阈值即发信提醒。
// 不复用高危/回归判定逻辑，直接对运行结果的原始数值/等级字段做比较。表单沿用「自动测试配置」页的
// .panel.form-grid 观感；范围用「全部」单选 + 复用的级联渠道/模型选择器（无「全部」选项时补一个单选切换）。
import { escapeHtml, toast, renderMarkdown } from "./client-utils.js";
import { api } from "./api-client.js";
import { requireElement } from "./dom-utils.js";
import { createCascadeTargetPicker } from "./target-picker.js";
// 汇总的「人话预设 ↔ cron」映射：纯函数，与 tests/alert-digest-cron-presets.test.mjs 共用同一份，
// 不在本文件里复刻（那会让测试拿副本跟自己比）。它内部再复用 cron-ui.js。
import { buildDigestCron as buildDigestCronFrom, digestTimesOfDay, parseDigestCron, WEEKLY_FREQ } from "./alert-digest-schedule.js";
import alertRulesGuideDoc from "./docs/alert-rules-guide.md?raw";
import alertDigestGuideDoc from "./docs/alert-digest-guide.md?raw";

const METRIC_LABEL = {
  successRate: "成功率",
  p95TotalMs: "P95 耗时（毫秒）",
  avgTotalMs: "平均耗时（毫秒）",
  score: "综合分（准入）",
  grade: "准入等级",
  avgQualityScore: "质量分（场景）",
  recommendationLevel: "结论等级",
  verdictLevel: "快速验证结论",
};
const COMPARATOR_LABEL = { lt: "低于", lte: "不高于", gt: "高于", gte: "不低于", eq: "等于" };
const LEVEL_METRICS = ["grade", "recommendationLevel", "verdictLevel"];
const JITTER_KIND = "stability-jitter";
const DECLINE_KIND = "stability-decline";
// 退化规则冷却默认 24 小时（其余形态 1 小时）：持续退化会让之后【每一次】运行都继续命中
// （两个窗口整体下移），1 小时冷却在 2 小时一测的节奏下等于每次都发。24 小时把一次退化事件收敛成一封信。
const DECLINE_DEFAULT_COOLDOWN_HOURS = 24;
const LEVEL_OPTIONS = {
  grade: ["A", "B", "C", "D", "E", "X", "F"],
  recommendationLevel: [
    ["pass", "通过"],
    ["watch", "观察"],
    ["fail", "不通过"],
  ],
  verdictLevel: [
    ["ok", "正常"],
    ["watch", "观察"],
    ["suspect", "疑似异常"],
  ],
};

function levelOptionsHtml(metric) {
  const opts = LEVEL_OPTIONS[metric] || [];
  return opts
    .map((o) =>
      Array.isArray(o)
        ? `<option value="${escapeHtml(o[0])}">${escapeHtml(o[1])}</option>`
        : `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`,
    )
    .join("");
}

export function createAlertRules({ state, confirm }) {
  const form = requireElement("#ar-form");
  const formTitle = requireElement("#ar-form-title");
  const ruleIdInput = requireElement("#ar-rule-id");
  const nameInput = requireElement("#ar-name");
  const kindSelect = requireElement("#ar-kind");
  const scopeTypeSelect = requireElement("#ar-scope-type");
  const targetPickerBox = requireElement("#ar-target-picker");
  const channelSelect = requireElement("#ar-channel-select");
  const modelSelect = requireElement("#ar-model-select");
  const metricLabel = requireElement("#ar-metric-label");
  const metricSelect = requireElement("#ar-metric");
  const comparatorLabel = requireElement("#ar-comparator-label");
  const comparatorSelect = requireElement("#ar-comparator");
  const thresholdNumberLabel = requireElement("#ar-threshold-number-label");
  const thresholdNumberInput = requireElement("#ar-threshold-number");
  const thresholdLevelLabel = requireElement("#ar-threshold-level-label");
  const thresholdLevelSelect = requireElement("#ar-threshold-level");
  const jitterBox = requireElement("#ar-jitter-params");
  const jitterRatioInput = requireElement("#ar-jitter-ratio");
  const jitterFirstSrInput = requireElement("#ar-jitter-first-sr");
  const jitterRetryOverheadInput = requireElement("#ar-jitter-retry-overhead");
  const declineBox = requireElement("#ar-decline-params");
  const declineRecentInput = requireElement("#ar-decline-recent");
  const declineBaselineInput = requireElement("#ar-decline-baseline");
  const declineSrDropInput = requireElement("#ar-decline-sr-drop");
  const declineP95WorsenInput = requireElement("#ar-decline-p95-worsen");
  const cooldownInput = requireElement("#ar-cooldown");
  const enabledInput = requireElement("#ar-enabled");
  const resetBtn = requireElement("#ar-reset");
  const reloadBtn = requireElement("#ar-reload");
  const metricDocBtn = requireElement("#ar-metric-doc");
  const listBox = requireElement("#ar-rule-list");
  const digestDocBtn = requireElement("#ar-digest-doc");
  const digestEnabled = requireElement("#ar-digest-enabled");
  const digestFreq = requireElement("#ar-digest-freq");
  const digestTime = requireElement("#ar-digest-time");
  const digestWeekdayLabel = requireElement("#ar-digest-weekday-label");
  const digestWeekday = requireElement("#ar-digest-weekday");
  const digestPreview = requireElement("#ar-digest-preview");
  const digestJobScope = requireElement("#ar-digest-job-scope");
  const digestJobPicker = requireElement("#ar-digest-job-picker");
  const digestJobList = requireElement("#ar-digest-job-list");
  const digestJobAllBtn = requireElement("#ar-digest-job-all");
  const digestJobNoneBtn = requireElement("#ar-digest-job-none");
  const digestSaveBtn = requireElement("#ar-digest-save");
  const digestTestBtn = requireElement("#ar-digest-test");
  // 认不出的手写 cron（手改过配置文件 / 从别处拷来）。非空时预览行会提示，
  // 且不去猜着回填控件——打开页面看一眼不该变成一次静默的配置变更。
  let unknownCron = "";

  // 新标签页渲染 md 文档，与「测试场景维护」页的评分器/类别说明同款惯用法。
  function openDocInNewTab(title, md) {
    const w = window.open("", "_blank");
    if (!w) {
      toast("浏览器拦截了弹窗，请允许后重试。", true);
      return;
    }
    const style =
      "body{font-family:system-ui,'Segoe UI',sans-serif;max-width:880px;margin:24px auto;padding:0 20px;line-height:1.7;color:#1b2330}" +
      "h1{font-size:24px}h2{font-size:19px;margin-top:1.6em}h3{font-size:16px}" +
      "code{background:#f2f4f7;padding:1px 5px;border-radius:4px;font-size:.92em}" +
      "pre{background:#f2f4f7;padding:12px;border-radius:8px;overflow:auto}" +
      "table{border-collapse:collapse;width:100%;margin:12px 0}" +
      "th,td{border:1px solid #d4d9e0;padding:6px 10px;text-align:left;font-size:14px}th{background:#f2f4f7}";
    w.document.write(
      `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${style}</style></head><body>${renderMarkdown(md)}</body></html>`,
    );
    w.document.close();
  }
  metricDocBtn.addEventListener("click", () => openDocInNewTab("报警规则说明", alertRulesGuideDoc));
  digestDocBtn.addEventListener("click", () => openDocInNewTab("报警汇总说明", alertDigestGuideDoc));

  // —— 报警汇总 ——
  //
  // 【为什么界面上没有 crontab 输入框】crontab 是给程序员看的。这一页的使用者是任意管理员，
  // 让他们理解「7 3-23/6 * * *」不合理，写错了还会造成实质后果（分钟字段写成 `*` 就是每分钟一封）。
  // 改为五个人话选项 + 一个时刻，由 cron-ui.js 的 buildCron 拼出表达式，用户全程看不到 cron。
  //
  // 【为什么用 fixed 形态而不是步长形态】步长形态（`分 起点-23/步长`）无法保住用户选的分钟：
  // cron-ui 的小时级频率会把分钟字段固定成 0，「每 6 小时，从 09:07 起」就变成 09:00 那一档。
  // fixed 形态把每个时刻单独列出（`7 3 * * *;7 9 * * *;…`，分号分隔，后端 cron 引擎支持），
  // 分钟原样保留，反解析也能精确还原。五种预设已全部用真实 cron 引擎验证过触发时刻。
  // 从控件读出预设参数，喂给 alert-digest-schedule 的纯函数。
  function digestFormValues() {
    const [h, m] = String(digestTime.value || "09:07").split(":");
    return {
      freq: digestFreq.value,
      hour: Math.min(23, Math.max(0, Number(h) || 0)),
      minute: Math.min(59, Math.max(0, Number(m) || 0)),
      weekday: Number(digestWeekday.value) || 1,
    };
  }

  function buildDigestCron() {
    return buildDigestCronFrom(digestFormValues());
  }

  // cron → 回填五个人话选项。走 alert-digest-schedule 的 parseDigestCron（内部用 cron-ui 反解析）。
  //
  // 认不出的表达式（手改过配置文件、或从别处拷来的）：保持当前控件不动，只在预览行提示，
  // 绝不猜着改写用户的配置——那会让「打开页面看一眼」变成一次静默的配置变更。
  function fillDigestCron(cron) {
    const raw = String(cron || "").trim();
    unknownCron = "";
    const parsed = parseDigestCron(raw);
    if (!parsed) {
      unknownCron = raw;
      syncDigestFreq();
      return;
    }
    digestFreq.value = parsed.freq;
    if (parsed.freq === WEEKLY_FREQ) digestWeekday.value = String(parsed.weekday);
    // 回填的是当天【最早】那个时刻，可能不等于用户当初填的那个：
    // 选 09:07 + 每天四次会生成 03:07/09:07/15:07/21:07，回填显示 03:07。
    // 两者是同一个触发集合，且原样再保存会生成完全相同的 cron（幂等性有测试钉住），故不算失真。
    digestTime.value = `${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`;
    syncDigestFreq();
  }

  // 预览行用大白话说清「什么时候发」，把实际会触发的每个时刻都列出来 ——
  // 不复用 cron-ui 的 describeSchedule：那句话是给「跑测试」写的（「每天，固定在 09:07 运行」），
  // 这里要说的是发信，且要说清顺延规则。
  const DOW_TEXT = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  function describeDigest() {
    if (!digestEnabled.checked) return "当前关闭：报警仍按每条规则各自立即发信。";
    if (unknownCron) {
      return `当前配置是手写的定时表达式「${unknownCron}」，本页的选项认不出它。改动上面任一项并保存即会替换成新设置。`;
    }
    const v = digestFormValues();
    const times = digestTimesOfDay(v.hour, v.minute, v.freq)
      .slice()
      .sort((a, b) => a.hour - b.hour || a.minute - b.minute)
      .map((t) => `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`);
    const when =
      digestFreq.value === WEEKLY_FREQ
        ? `每${DOW_TEXT[Number(digestWeekday.value) || 1]}`
        : digestFreq.value === "weekday"
          ? "每个工作日"
          : "每天";
    const scopeText = digestJobScope.value === "selected" ? `已勾选的 ${countSelectedJobs()} 个作业` : "全部自动测试";
    return `${when} ${times.join("、")} 各发一封汇总（${scopeText}）。若届时自动测试还在跑，会等它跑完再发，最多等 6 小时。`;
  }

  function syncDigestFreq() {
    digestWeekdayLabel.classList.toggle("hidden", digestFreq.value !== WEEKLY_FREQ);
    digestJobPicker.classList.toggle("hidden", digestJobScope.value !== "selected");
    digestPreview.textContent = describeDigest();
  }

  for (const el of [digestFreq, digestTime, digestWeekday, digestEnabled, digestJobScope]) {
    el.addEventListener("change", syncDigestFreq);
    el.addEventListener("input", syncDigestFreq);
  }

  // —— 作业勾选 ——
  const JOB_KIND_TEXT = { quick: "快速验证", admission: "准入评测", stability: "稳定性", scenario: "场景测试" };

  function countSelectedJobs() {
    return digestJobList.querySelectorAll("input[data-digest-job]:checked").length;
  }

  function selectedJobIds() {
    return [...digestJobList.querySelectorAll("input[data-digest-job]:checked")].map((el) => el.dataset.digestJob);
  }

  // 渲染作业勾选清单。已停用的作业也列出来但标注——它现在不跑，日后重新启用就会跑，
  // 此时若不在清单里，用户会以为「启用后自动进汇总」，而实际不会（jobScope=selected 只认勾选的 id）。
  function renderJobList(jobs, checkedIds, staleIds) {
    const checked = new Set(checkedIds || []);
    if (!jobs.length) {
      digestJobList.innerHTML = `<div class="muted">还没有配置任何自动测试作业。请先到「自动测试配置」页新建。</div>`;
      return;
    }
    const rows = jobs
      .map((job) => {
        const kind = JOB_KIND_TEXT[job.kind] || job.kind || "";
        const who = job.targetName || job.targetId || "目标未知";
        const off = job.enabled === false ? `<span class="pill">已停用</span>` : "";
        const name = job.name || `${kind}作业`;
        return `<label class="ar-digest-job"><input type="checkbox" data-digest-job="${escapeHtml(job.id)}"${
          checked.has(job.id) ? " checked" : ""
        } /> <strong>${escapeHtml(name)}</strong>　${escapeHtml(kind)}　${escapeHtml(who)} ${off}</label>`;
      })
      .join("");
    // 已勾选但作业已被删除的 id：明确告知，否则配置里躺着一个界面上看不见的东西。
    const stale = staleIds?.length
      ? `<div class="field-hint">另有 ${staleIds.length} 个已勾选的作业已被删除，保存后会自动清掉。</div>`
      : "";
    digestJobList.innerHTML = rows + stale;
  }

  digestJobList.addEventListener("change", syncDigestFreq);
  digestJobAllBtn.addEventListener("click", () => {
    for (const el of digestJobList.querySelectorAll("input[data-digest-job]")) el.checked = true;
    syncDigestFreq();
  });
  digestJobNoneBtn.addEventListener("click", () => {
    for (const el of digestJobList.querySelectorAll("input[data-digest-job]")) el.checked = false;
    syncDigestFreq();
  });

  async function loadDigest() {
    try {
      const r = await api("/api/alert-rules/digest");
      const cfg = r.config || {};
      digestEnabled.checked = cfg.enabled === true;
      digestJobScope.value = cfg.jobScope === "selected" ? "selected" : "all";
      renderJobList(Array.isArray(r.jobs) ? r.jobs : [], cfg.jobIds || [], r.staleJobIds);
      fillDigestCron(cfg.cron); // 内部会调 syncDigestFreq，故放在勾选渲染之后
      const pending = r.pending || {};
      const queued = Number(pending.alerts) || 0;
      // 让管理员看得见汇总确实在攒东西——否则开了之后一整天收不到信，无从判断是在攒还是坏了。
      const extra = cfg.enabled && queued ? `　当前已攒下 ${queued} 条待发报警。` : "";
      digestPreview.textContent = describeDigest() + extra;
    } catch (error) {
      digestPreview.textContent = `加载汇总设置失败：${error.message}`;
    }
  }

  digestSaveBtn.addEventListener("click", async () => {
    const cron = buildDigestCron();
    // 认不出的手写表达式：改动任一项后 buildDigestCron 会产出新的，这里不该被旧值挡住。
    if (digestEnabled.checked && !cron) {
      toast("定时设置不完整，请检查频率与时刻。", true);
      return;
    }
    const jobScope = digestJobScope.value === "selected" ? "selected" : "all";
    const jobIds = jobScope === "selected" ? selectedJobIds() : [];
    // 前端先挡一次，给出比后端 400 更贴近操作的提示（后端仍有同样的校验兜底）。
    if (digestEnabled.checked && jobScope === "selected" && !jobIds.length) {
      toast("选了「只汇总下面勾选的作业」但一个都没勾。请至少勾一个，或改选「全部自动测试」。", true);
      return;
    }
    digestSaveBtn.disabled = true;
    try {
      const r = await api("/api/alert-rules/digest", {
        method: "PUT",
        body: JSON.stringify({ enabled: digestEnabled.checked, cron, jobScope, jobIds }),
      });
      // 关闭时若队列里还有没发出去的报警，后端会清掉它们并解除对应规则的冷却。
      // 必须说给管理员听：静默丢弃报警正是这个功能要避免的事。
      if (r.flushed?.alerts) {
        toast(`已关闭报警汇总。队列中 ${r.flushed.alerts} 条未发出的报警已清除，相关规则的冷却已解除，下次命中会立即发信。`);
      } else {
        toast(digestEnabled.checked ? "汇总设置已保存。" : "已关闭报警汇总。");
      }
      await loadDigest();
    } catch (error) {
      toast(`保存失败：${error.message}`, true);
    } finally {
      digestSaveBtn.disabled = false;
    }
  });

  digestTestBtn.addEventListener("click", async () => {
    digestTestBtn.disabled = true;
    const original = digestTestBtn.textContent;
    digestTestBtn.textContent = "发送中…";
    try {
      const r = await api("/api/alert-rules/digest/test", { method: "POST" });
      toast(`已发送：${r.alerts || 0} 条报警、${r.runs || 0} 条运行记录。队列未清空。`);
    } catch (error) {
      toast(`发送失败：${error.message}`, true);
    } finally {
      digestTestBtn.disabled = false;
      digestTestBtn.textContent = original;
    }
  });

  const cascade = createCascadeTargetPicker(channelSelect, modelSelect);

  // 范围单选：「全部」隐藏级联选择器；「指定」显示。同 auto-test-config 惯用的 .hidden class 切换。
  function syncScopeType() {
    targetPickerBox.classList.toggle("hidden", scopeTypeSelect.value !== "target");
  }
  scopeTypeSelect.addEventListener("change", syncScopeType);
  syncScopeType();

  // 指标切换：等级型指标（grade/recommendationLevel/verdictLevel）用等级下拉选阈值，其余用数值输入。
  // 复合形态（jitter/decline）下这三个控件整体隐藏，故先看 kind 再决定阈值控件的显隐。
  function syncMetric() {
    if (kindSelect.value !== "threshold") {
      thresholdNumberLabel.classList.add("hidden");
      thresholdLevelLabel.classList.add("hidden");
      return;
    }
    const isLevel = LEVEL_METRICS.includes(metricSelect.value);
    thresholdNumberLabel.classList.toggle("hidden", isLevel);
    thresholdLevelLabel.classList.toggle("hidden", !isLevel);
    if (isLevel) thresholdLevelSelect.innerHTML = levelOptionsHtml(metricSelect.value);
  }
  metricSelect.addEventListener("change", syncMetric);

  // 规则类型切换：三组控件互斥显隐——阈值形态（指标+比较符+阈值）/ 稳定性抖动（三个子阈值）/
  // 稳定性退化（两个窗口 + 两个判定阈值）。
  // 同上用 .hidden class 而非 hidden 属性——本页 .form-grid 的 display:grid 压不住 UA 的 display:none。
  function syncKind() {
    const kind = kindSelect.value;
    const isThreshold = kind === "threshold";
    metricLabel.classList.toggle("hidden", !isThreshold);
    comparatorLabel.classList.toggle("hidden", !isThreshold);
    jitterBox.classList.toggle("hidden", kind !== JITTER_KIND);
    declineBox.classList.toggle("hidden", kind !== DECLINE_KIND);
    syncMetric();
  }
  // 切到退化形态时把冷却默认值抬到 24 小时（仅在用户还没手改过、且是新建时）——
  // 避免持续退化下每 2 小时就来一封。用户随后手改的值不会被这里覆盖。
  kindSelect.addEventListener("change", () => {
    syncKind();
    if (!ruleIdInput.value) {
      cooldownInput.value = kindSelect.value === DECLINE_KIND ? String(DECLINE_DEFAULT_COOLDOWN_HOURS) : "1";
    }
  });
  syncKind();

  function resetForm() {
    ruleIdInput.value = "";
    nameInput.value = "";
    kindSelect.value = "threshold";
    scopeTypeSelect.value = "all";
    cascade.setValue("", { silent: true });
    syncScopeType();
    metricSelect.value = "successRate";
    comparatorSelect.value = "lt";
    thresholdNumberInput.value = "";
    // 抖动子阈值的默认值：倍数 6 与首次成功率 0.9 有实测依据（正常区间 2.3～3.6×），
    // 重试额外等待留空（历史数据常无 endToEndMs，默认给个数会让人以为在检查其实一直跳过）。
    jitterRatioInput.value = "6";
    jitterFirstSrInput.value = "0.9";
    jitterRetryOverheadInput.value = "";
    // 退化默认：最近 3 次 vs 之前 20 次（约 6 小时 vs 1.7 天，按 2 小时一测的节奏），
    // 跌幅 10pp / P95 恶化 1.5× 沿用趋势页既有回归判定的克制口径。
    declineRecentInput.value = "3";
    declineBaselineInput.value = "20";
    declineSrDropInput.value = "0.1";
    declineP95WorsenInput.value = "1.5";
    syncKind();
    cooldownInput.value = "1";
    enabledInput.checked = true;
    formTitle.textContent = "新建报警规则";
  }
  resetBtn.addEventListener("click", resetForm);
  reloadBtn.addEventListener("click", loadRules);

  // 空输入框送 null 而非 0：后端把 null 当「不检查该项」，0 会被当成真阈值（且非正数会被兜成 null，
  // 但语义上还是送 null 更直白）。
  const optionalNum = (input) => (input.value.trim() === "" ? null : Number(input.value));

  function collect() {
    const scopeType = scopeTypeSelect.value;
    const base = {
      id: ruleIdInput.value || undefined,
      name: nameInput.value.trim(),
      kind: kindSelect.value,
      scope: scopeType === "target" ? { type: "target", targetId: cascade.value } : { type: "all" },
      cooldownHours: Math.max(0.1, Number(cooldownInput.value) || 0.1),
      enabled: enabledInput.checked,
    };
    if (kindSelect.value === JITTER_KIND) {
      return {
        ...base,
        params: {
          jitterRatioMax: optionalNum(jitterRatioInput),
          firstAttemptSuccessRateMin: optionalNum(jitterFirstSrInput),
          retryOverheadP95MsMax: optionalNum(jitterRetryOverheadInput),
        },
      };
    }
    if (kindSelect.value === DECLINE_KIND) {
      return {
        ...base,
        params: {
          // 窗口尺寸留空也送 null，后端 normalizeWindowSize 会兜默认 3 / 20。
          recentRuns: optionalNum(declineRecentInput),
          baselineRuns: optionalNum(declineBaselineInput),
          successRateDropPp: optionalNum(declineSrDropInput),
          p95WorsenRatio: optionalNum(declineP95WorsenInput),
        },
      };
    }
    const isLevel = LEVEL_METRICS.includes(metricSelect.value);
    return {
      ...base,
      metric: metricSelect.value,
      comparator: comparatorSelect.value,
      threshold: isLevel ? thresholdLevelSelect.value : Number(thresholdNumberInput.value),
    };
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = collect();
    if (!body.name) {
      toast("请填写规则名称。", true);
      return;
    }
    if (body.scope.type === "target" && !body.scope.targetId) {
      toast("请选择渠道与模型，或改为「全部渠道 + 模型」。", true);
      return;
    }
    // 后端也会拦（返回 400），这里先拦一道给即时反馈，省一次往返。
    if (body.kind === JITTER_KIND && !Object.values(body.params).some((v) => Number.isFinite(v) && v > 0)) {
      toast("稳定性抖动规则至少要配一项子阈值。", true);
      return;
    }
    // 退化规则只看两个【判定阈值】——窗口尺寸留空后端会兜默认值，不算「配了一项」。
    if (body.kind === DECLINE_KIND) {
      const thresholds = [body.params.successRateDropPp, body.params.p95WorsenRatio];
      if (!thresholds.some((v) => Number.isFinite(v) && v > 0)) {
        toast("稳定性退化规则至少要配一项判定阈值（成功率跌幅 / P95 恶化倍数）。", true);
        return;
      }
    }
    try {
      await api("/api/alert-rules", { method: "POST", body: JSON.stringify(body) });
      toast(body.id ? "规则已更新。" : "规则已创建。");
      resetForm();
      await loadRules();
    } catch (error) {
      toast(`保存失败：${error.message}`, true);
    }
  });

  // 回填数值输入：null/undefined（= 该项不检查）要留空，不能写成 "null" 或 0。
  const fillOptional = (input, value) => {
    input.value = Number.isFinite(value) ? String(value) : "";
  };

  function editRule(rule) {
    ruleIdInput.value = rule.id;
    nameInput.value = rule.name || "";
    kindSelect.value = rule.kind === JITTER_KIND || rule.kind === DECLINE_KIND ? rule.kind : "threshold";
    scopeTypeSelect.value = rule.scope?.type === "target" ? "target" : "all";
    syncScopeType();
    if (rule.scope?.type === "target") cascade.setValue(rule.scope.targetId, { silent: true });
    if (rule.kind === JITTER_KIND) {
      const p = rule.params || {};
      fillOptional(jitterRatioInput, p.jitterRatioMax);
      fillOptional(jitterFirstSrInput, p.firstAttemptSuccessRateMin);
      fillOptional(jitterRetryOverheadInput, p.retryOverheadP95MsMax);
    } else if (rule.kind === DECLINE_KIND) {
      const p = rule.params || {};
      fillOptional(declineRecentInput, p.recentRuns);
      fillOptional(declineBaselineInput, p.baselineRuns);
      fillOptional(declineSrDropInput, p.successRateDropPp);
      fillOptional(declineP95WorsenInput, p.p95WorsenRatio);
    } else {
      metricSelect.value = rule.metric;
      comparatorSelect.value = rule.comparator;
      if (LEVEL_METRICS.includes(rule.metric)) {
        // 等级下拉的 options 由 syncMetric 按指标现填，故必须先 sync 再赋 value，否则赋不上。
        syncMetric();
        thresholdLevelSelect.value = String(rule.threshold ?? "");
      } else {
        thresholdNumberInput.value = String(rule.threshold ?? "");
      }
    }
    syncKind();
    cooldownInput.value = String(rule.cooldownHours ?? 1);
    enabledInput.checked = rule.enabled !== false;
    formTitle.textContent = `编辑规则：${rule.name || rule.id}`;
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function toggleEnabled(rule) {
    try {
      await api("/api/alert-rules", { method: "POST", body: JSON.stringify({ ...rule, enabled: !rule.enabled }) });
      await loadRules();
    } catch (error) {
      toast(`操作失败：${error.message}`, true);
    }
  }

  async function deleteRule(rule) {
    const ok = await confirm?.({
      title: "删除报警规则",
      message: `确定删除规则「${rule.name || rule.id}」吗？`,
      detail: "删除后不再对该规则做判断。",
      confirmLabel: "删除",
      cancelLabel: "取消",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api(`/api/alert-rules/${encodeURIComponent(rule.id)}`, { method: "DELETE" });
      toast("规则已删除。");
      await loadRules();
    } catch (error) {
      toast(`删除失败：${error.message}`, true);
    }
  }

  function scopeText(rule) {
    if (rule.scope?.type !== "target") return "全部渠道 + 模型";
    if (rule.targetRunnable === false) return `指定目标（已不可用）`;
    return `指定：${escapeHtml(rule.targetName || rule.scope.targetId)}`;
  }

  function thresholdText(rule) {
    if (LEVEL_METRICS.includes(rule.metric)) {
      const opts = LEVEL_OPTIONS[rule.metric] || [];
      const hit = opts.find((o) => (Array.isArray(o) ? o[0] === rule.threshold : o === rule.threshold));
      return hit ? (Array.isArray(hit) ? hit[1] : hit) : String(rule.threshold);
    }
    return String(rule.threshold);
  }

  // 卡片「条件：」行。复合规则列出已配置的子阈值（未配置的不列，与「不检查」的语义一致）。
  // 返回值会插进 innerHTML，故这里出现的动态量都得转义；数值走 Number() 后拼接，本身不含标记。
  function conditionHtml(rule) {
    const p = rule.params || {};
    if (rule.kind === JITTER_KIND) {
      const lines = [];
      if (Number.isFinite(p.jitterRatioMax)) lines.push(`耗时抖动倍数（P95÷P50）高于 ${Number(p.jitterRatioMax)}×`);
      if (Number.isFinite(p.firstAttemptSuccessRateMin)) lines.push(`首次成功率低于 ${Math.round(p.firstAttemptSuccessRateMin * 100)}%`);
      if (Number.isFinite(p.retryOverheadP95MsMax)) lines.push(`重试额外等待 P95 高于 ${Number(p.retryOverheadP95MsMax)}ms`);
      if (!lines.length) return "（未配置任何子阈值，不会触发）";
      return `任一越界即不合格<br>${lines.map((l) => `　· ${escapeHtml(l)}`).join("<br>")}`;
    }
    if (rule.kind === DECLINE_KIND) {
      const lines = [];
      if (Number.isFinite(p.successRateDropPp)) lines.push(`成功率中位数跌幅达 ${Math.round(p.successRateDropPp * 100)}pp`);
      if (Number.isFinite(p.p95WorsenRatio)) lines.push(`P95 中位数恶化达 ${Number(p.p95WorsenRatio)}×`);
      if (!lines.length) return "（未配置任何判定阈值，不会触发）";
      const window = `最近 ${Number(p.recentRuns) || 3} 次 vs 之前 ${Number(p.baselineRuns) || 20} 次`;
      return `${escapeHtml(window)}，任一越界即不合格<br>${lines.map((l) => `　· ${escapeHtml(l)}`).join("<br>")}`;
    }
    return `${escapeHtml(METRIC_LABEL[rule.metric] || rule.metric)} ${escapeHtml(COMPARATOR_LABEL[rule.comparator] || rule.comparator)} ${escapeHtml(thresholdText(rule))}`;
  }

  function ruleCard(rule) {
    const card = document.createElement("div");
    card.className = "atc-job-card";
    const targetWarn = rule.scope?.type === "target" && rule.targetRunnable === false ? ` <span class="pill danger">目标不可用</span>` : "";
    // kindPill 是硬编码 HTML，不是用户数据——刻意不转义（同 auto-test-config 的 targetWarn 惯例）。
    const kindPill =
      rule.kind === JITTER_KIND
        ? ` <span class="pill">稳定性抖动</span>`
        : rule.kind === DECLINE_KIND
          ? ` <span class="pill">稳定性退化</span>`
          : "";
    card.innerHTML = `
      <div class="atc-job-head">
        <b>${escapeHtml(rule.name || rule.id)}</b>
        <span class="pill ${rule.enabled ? "" : "muted"}">${rule.enabled ? "已启用" : "已停用"}</span>${kindPill}${targetWarn}
      </div>
      <div class="atc-job-meta">
        范围：${scopeText(rule)}<br>
        条件：${conditionHtml(rule)}<br>
        冷却：${Number(rule.cooldownHours)} 小时
      </div>
      <div class="action-row atc-job-actions"></div>`;
    const actions = card.querySelector(".atc-job-actions");
    const mkBtn = (label, cls, handler) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = cls;
      b.textContent = label;
      b.addEventListener("click", handler);
      return b;
    };
    actions.append(
      mkBtn(rule.enabled ? "停用" : "启用", "secondary", () => toggleEnabled(rule)),
      mkBtn("编辑", "secondary", () => editRule(rule)),
      mkBtn("删除", "danger", () => deleteRule(rule)),
    );
    return card;
  }

  async function loadRules() {
    listBox.textContent = "正在加载…";
    try {
      const r = await api("/api/alert-rules");
      const rules = Array.isArray(r.rules) ? r.rules : [];
      listBox.innerHTML = "";
      if (!rules.length) {
        listBox.innerHTML = `<div class="muted">还没有配置任何报警规则。</div>`;
        return;
      }
      for (const rule of rules) listBox.append(ruleCard(rule));
    } catch (error) {
      listBox.textContent = `加载规则失败：${error.message}`;
    }
  }

  async function load() {
    cascade.refresh({ modelTargets: state.modelTargets, channels: state.channels, profiles: state.profiles });
    await Promise.all([loadRules(), loadDigest()]);
  }

  function refreshTargets(data) {
    cascade.refresh(data);
  }

  return { load, refreshTargets };
}
