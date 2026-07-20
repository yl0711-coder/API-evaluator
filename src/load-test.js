// src/load-test.js
// 压力测试页：闭环/开环 + 负载扫描，走 task-manager 后台 + 进度轮询 + 可取消（仅超管）。
//
// 从 app.js 整块搬出（16 号报告 C1 第二阶段）。代码**逐字未改**——纯搬运才能用构建产物比对证明等价。
//
// 依赖：api、toast、escapeHtml、confirmAction、createTaskFormController 等
// 全部通过 deps 注入。级联通过 onProfileData 自注册。
export function createLoadTest({ state, els, onProfileData, deps }) {
  const {
    toast,
    escapeHtml,
    confirmAction,
    createTaskFormController,
    estimateLoadTestCost,
    confirmExecution,
    loadResultsBundle,
    createCascadeTargetPicker,
  } = deps;

  // 压力测试专属级联（渠道 → 模型）
  const cascade = createCascadeTargetPicker(els.loadTestChannelSelect, els.loadTestProfileSelect);
  onProfileData((data) => cascade.refresh(data));

  // —— 压力测试：闭环/开环 + 负载扫描，走 task-manager 后台 + 进度轮询 + 可取消（仅超管，入口 data-requires-admin）——
  const LOAD_PROFILE_LABEL = { simple: "简单", think: "轻思考", coding: "编程" };
  const lms = (v) => (Number.isFinite(v) ? `${(v / 1000).toFixed(2)}s` : "—");

  // 负载值文本 → 数字数组（逗号分隔，去空去非法）。多个即为扫描。
  function parseLoads(raw) {
    return String(raw || "")
      .split(/[,，\s]+/)
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  // 模式变化：切换负载值标签（并发/速率）、显隐开环在飞上限与闭环测试间隔。
  function syncLoadTestMode() {
    const open = els.loadTestModeSelect.value === "open";
    els.loadTestLoadLabel.textContent = open ? "负载值（速率 req/s）" : "负载值（并发数，可逗号扫描）";
    els.loadTestMaxInFlightField.classList.toggle("hidden", !open); // 在飞上限仅开环
    els.loadTestBurstField.classList.toggle("hidden", !open); // 发送周期（突发）仅开环
    els.loadTestIntervalField.classList.toggle("hidden", open); // 测试间隔（思考时间）仅闭环
  }
  els.loadTestModeSelect.addEventListener("change", syncLoadTestMode);
  syncLoadTestMode();

  const loadTestErrText = (e) =>
    `429×${e.http_429 || 0}　5xx×${e.http_5xx || 0}　超时×${e.timeout || 0}　网络×${e.network_error || 0}　发生器受限×${e.gen_saturated || 0}`;
  // 单点结果卡片。
  function renderLoadTestSingle(result) {
    const L = result.latency || {};
    const e = result.errors || {};
    const okRate = result.successRate || 0;
    const rateCls = okRate >= 0.99 ? "" : "fail";
    const errBad = (e.http_429 || 0) + (e.http_5xx || 0) + (e.timeout || 0) + (e.gen_saturated || 0) > 0 ? "fail" : "";
    const modeLabel = result.mode === "open" ? `开环 · 速率 ${result.offered} req/s` : `闭环 · 并发 ${result.offered}`;
    const sent = result.sentRequests || 0;
    const notReturned = (e.timeout || 0) + (e.http_5xx || 0) + (e.network_error || 0) + (e.other || 0);
    // <small class="fail"> 是硬编码标签，插值是数字——刻意不转义
    const biasNote =
      notReturned > 0
        ? `<small class="fail">⚠️ 另有 ${notReturned} 条（${Math.round(sent ? (notReturned / sent) * 100 : 0)}%）超时/失败未返回、未计入延迟，真实尾延迟更差</small>`
        : "";
    els.loadTestSummary.innerHTML = `
      <article class="summary-card">
        <span>吞吐 QPS</span>
        <strong>${escapeHtml(String(result.qps ?? "—"))} req/s</strong>
        <small>稳态完成 ${result.sentRequests ?? "—"}（预热 ${result.warmupRequests ?? 0} 不计）</small>
        ${result.outputTokens > 0 ? `<small>输出吞吐 ${escapeHtml(String(result.tokensPerSecond ?? "—"))} tok/s（单请求均速 ${escapeHtml(String(result.perReqTokensPerSec ?? "—"))} tok/s）</small>` : ""}
      </article>
      <article class="summary-card">
        <span>成功率</span>
        <strong class="${rateCls}">${Math.round(okRate * 100)}%</strong>
        <small>成功 ${result.successCount ?? "—"} / ${result.sentRequests ?? "—"}</small>
      </article>
      <article class="summary-card">
        <span>延迟分位（成功）</span>
        <strong>p95 ${lms(L.p95)}</strong>
        <small>p50 ${lms(L.p50)}　p90 ${lms(L.p90)}　p99 ${lms(L.p99)}　max ${lms(L.max)}</small>
        ${biasNote}
      </article>
      <article class="summary-card wide-summary">
        <span>错误构成</span>
        <strong class="${errBad}">${escapeHtml(loadTestErrText(e))}</strong>
        <small>${escapeHtml(modeLabel)} · 负载档 ${escapeHtml(result.promptProfile || "-")} · 稳态 ${result.durationSec}s · ramp-up ${result.warmupSec}s</small>
        <small>HTML 报告：${escapeHtml(result.reportHtmlPath || "-")}</small>
      </article>
    `;
  }
  // 扫描结果：曲线表格 + 拐点(D)。
  function renderLoadTestSweep(result) {
    const unit = result.mode === "open" ? "速率(req/s)" : "并发";
    const rows = (result.sweep || [])
      .map((p, i) => {
        const hit = i === result.knee?.index ? ' class="fail"' : "";
        return `<tr${hit}><td>${p.offered}</td><td>${p.qps}</td><td>${Math.round((p.successRate || 0) * 100)}%</td><td>${lms(p.latency.p95)}</td><td>${lms(p.latency.p99)}</td><td>${p.errors.http_429}</td><td>${(p.errors.timeout || 0) + (p.errors.http_5xx || 0)}</td><td>${p.genSaturated || 0}</td></tr>`;
      })
      .join("");
    const knee = result.knee || {};
    const kneePoint = (result.sweep || [])[knee.index] || {};
    els.loadTestSummary.innerHTML = `
      <article class="summary-card wide-summary">
        <span>饱和拐点（推荐可用容量）</span>
        <strong>${unit} = ${kneePoint.offered ?? "—"}</strong>
        <small>${escapeHtml(knee.reason || "")}</small>
        <small>该点：QPS ${kneePoint.qps ?? "—"}　成功率 ${Math.round((kneePoint.successRate || 0) * 100)}%　p99 ${lms(kneePoint.latency?.p99)}</small>
        <small>HTML 报告：${escapeHtml(result.reportHtmlPath || "-")}</small>
      </article>
      <article class="summary-card wide-summary" style="overflow-x:auto;">
        <span>负载 → 吞吐 / 尾延迟曲线</span>
        <table class="mini-table">
          <thead><tr><th>${unit}</th><th>QPS</th><th>成功率</th><th>p95</th><th>p99</th><th>429</th><th>超时+5xx</th><th>发生器受限</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </article>
    `;
  }
  // 表单参数变化时更新预估框（选完参数即知这一轮大概发多少请求）。
  function updateLoadTestEstimate() {
    const raw = Object.fromEntries(new FormData(els.loadTestForm).entries());
    const loads = parseLoads(raw.loads);
    const est = estimateLoadTestCost({ ...raw, loads });
    const sweepNote = loads.length > 1 ? `扫描 ${loads.length} 个负载点，` : "";
    els.loadTestEstimate.textContent = `${sweepNote}预计约发出 ${est.requests} 个真实请求（${LOAD_PROFILE_LABEL[raw.promptProfile] || "简单"}档）。全部真实计费，请谨慎。`;
  }
  els.loadTestForm.addEventListener("change", updateLoadTestEstimate);
  els.loadTestForm.addEventListener("input", updateLoadTestEstimate);
  updateLoadTestEstimate();

  createTaskFormController({
    form: els.loadTestForm,
    submitButton: els.loadTestSubmit,
    resultElement: els.loadTestSummary,
    progressElement: els.loadTestProgress,
    state,
    slot: "loadTest",
    taskType: "load-test",
    confirmRun: (payload) => confirmAction(confirmExecution("压力测试", estimateLoadTestCost(payload))),
    predict: (payload) => estimateLoadTestCost(payload),
    preparePayload: (raw) => {
      if (!raw.profileId) {
        toast("请先选择被测渠道与模型。", true);
        return null;
      }
      const loads = parseLoads(raw.loads);
      if (!loads.length) {
        toast("请填写负载值（并发数或速率），扫描用逗号分隔多个。", true);
        return null;
      }
      return {
        target: { profileId: raw.profileId },
        mode: raw.mode === "open" ? "open" : "closed",
        loads,
        promptProfile: raw.promptProfile || "simple",
        durationSec: Number(raw.durationSec) || 60,
        warmupSec: Number(raw.warmupSec) || 0,
        timeoutSec: Number(raw.timeoutSec) || 30,
        maxInFlight: Number(raw.maxInFlight) || 300,
        intervalSec: raw.mode === "open" ? 0 : Number(raw.intervalSec) || 0, // 思考时间仅闭环
        burstPeriodSec: raw.mode === "open" ? Number(raw.burstPeriodSec) || 1 : 1, // 发送周期仅开环
        stream: raw.streamRequest === "1", // 流式 SSE；开启后报告额外给出 TTFT
      };
    },
    beforeStart: (payload) => {
      const what =
        payload.loads.length > 1
          ? `扫描 ${payload.loads.length} 个负载点`
          : `${payload.mode === "open" ? "速率" : "并发"} ${payload.loads[0]}`;
      els.loadTestSummary.innerHTML = `<p class="muted">正在压测：${what}，每点稳态 ${payload.durationSec}s。测试期间请不要关闭窗口。</p>`;
    },
    onSuccess: async (result) => {
      if (result.sweep) renderLoadTestSweep(result);
      else renderLoadTestSingle(result);
      await loadResultsBundle();
      toast("压力测试完成。");
    },
    failurePrefix: "压力测试失败",
    idleButtonText: "开始压力测试",
  });
}
