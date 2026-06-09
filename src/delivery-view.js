import { average, escapeHtml, formatDateTime, formatPercent } from "./client-utils.js";
import { formatCost, formatTaskType, recommendationClass } from "./formatters.js";

// Presentation-only helpers for report insights and handoff text. Keep API
// calls and DOM event binding in app.js so these functions remain easy to test.
export function getLatestRuns(state) {
  const sorted = [...state.testRuns].sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0));
  return {
    latest: sorted[0] || null,
    latestAdmission: sorted.find((run) => run.type === "admission") || null,
    latestStability: sorted.find((run) => run.type !== "scenario" && run.type !== "admission") || null,
    latestScenario: sorted.find((run) => run.type === "scenario") || null,
    latestRequest: state.requests[0] || null,
    failedRequests: state.requests.filter((request) => !request.success).slice(0, 5),
    interruptedTasks: state.taskEvents.filter((task) => task.status === "interrupted").slice(0, 5),
  };
}

export function renderInsightCards(runs, { compact }) {
  if (!runs.latest && !runs.latestRequest) {
    return `<p class="muted">还没有可分析的测试结果。普通操作员建议先完成标准评测。</p>`;
  }

  const cards = [];
  if (runs.latestAdmission) {
    cards.push(renderAdmissionInsight(runs.latestAdmission));
  }
  if (runs.latestStability) {
    cards.push(renderStabilityInsight(runs.latestStability));
  }
  if (runs.latestScenario) {
    cards.push(renderScenarioInsight(runs.latestScenario));
  }
  if (runs.latestRequest) {
    cards.push(renderRequestInsight(runs.latestRequest));
  }
  if (!compact) {
    cards.push(renderOperatorAdvice(runs));
  }
  return cards.join("");
}

export function buildRankingRows(testRuns) {
  const grouped = new Map();

  for (const run of testRuns) {
    if (run.type === "batch-admission") {
      for (const result of run.results || []) {
        if (result.error) continue;
        mergeAdmissionRankingItem(grouped, result);
      }
      continue;
    }

    if (run.type === "admission") {
      mergeAdmissionRankingItem(grouped, run);
      continue;
    }

    if (run.type === "scenario") {
      for (const result of run.results || []) {
        const key = result.profileId || result.profileName || "unknown";
        const item = ensureRankingItem(grouped, key, result.profileName || key, result.model || "-", result.profileRole);
        item.scenarioRuns += 1;
        if (Number.isFinite(Number(result.successRate))) {
          item.scenarioSuccessRates.push(Number(result.successRate));
        }
        if (Number.isFinite(Number(result.avgQualityScore))) {
          item.qualityScores.push(Number(result.avgQualityScore));
        }
        addCostSignals(item, result);
      }
      continue;
    }

    const key = run.profileId || run.profileName || "unknown";
    const item = ensureRankingItem(grouped, key, run.profileName || key, run.model || "-", run.profileRole);
    item.stabilityRuns += 1;
    if (Number.isFinite(Number(run.successRate))) {
      item.successRates.push(Number(run.successRate));
    }
    if (Number.isFinite(Number(run.p95TotalMs))) {
      item.p95Values.push(Number(run.p95TotalMs));
    }
    addCostSignals(item, run);
  }

  const rows = [...grouped.values()]
    .map((item) => {
      const successRate = average([...item.successRates, ...item.scenarioSuccessRates]) || 0;
      const qualityScore = average(item.qualityScores) || 0;
      const admissionScore = average(item.admissionScores) || 0;
      const purityScore = average(item.purityScores) || 0;
      const fingerprintRate = average(item.fingerprintRates) || 0;
      const tokenCoverage = average(item.tokenCoverageRates) || 0;
      const p95 = average(item.p95Values);
      const estimatedCost = sumNumbers(item.estimatedCosts);
      const estimatedRevenue = sumNumbers(item.estimatedRevenues);
      const estimatedGrossProfit = sumNumbers(item.estimatedGrossProfits);
      const inputTokens = sumNumbers(item.inputTokens);
      const outputTokens = sumNumbers(item.outputTokens);
      const estimatedGrossMargin =
        Number.isFinite(Number(estimatedGrossProfit)) && Number.isFinite(Number(estimatedRevenue)) && estimatedRevenue > 0
          ? estimatedGrossProfit / estimatedRevenue
          : null;
      const latencyScore = Math.max(0, 1 - Math.min(p95 || 60000, 60000) / 60000) * 100;
      const score = Math.min(100, Math.round(
        successRate * 35 +
          successRate * 20 +
          latencyScore * 0.2 +
          qualityScore * 0.25 +
          admissionScore * 0.05 +
          purityScore * 0.05 +
          fingerprintRate * 5 +
          tokenCoverage * 2,
      ));
      return {
        ...item,
        successRate,
        qualityScore,
        admissionScore,
        purityScore,
        fingerprintRate,
        tokenCoverage,
        p95,
        inputTokens,
        outputTokens,
        estimatedCost,
        estimatedRevenue,
        estimatedGrossProfit,
        estimatedGrossMargin,
        score,
        level: score >= 85 ? "pass" : score >= 65 ? "watch" : "fail",
      };
    })
    .sort((a, b) => b.score - a.score);
  return attachBaselineComparison(rows);
}

function mergeAdmissionRankingItem(grouped, run) {
  const key = run.profileId || run.profileName || "unknown";
  const item = ensureRankingItem(grouped, key, run.profileName || key, run.model || "-", run.profileRole);
  item.admissionRuns += 1;
  if (Number.isFinite(Number(run.successRate))) {
    item.successRates.push(Number(run.successRate));
  }
  if (Number.isFinite(Number(run.score))) {
    item.admissionScores.push(Number(run.score));
  }
  if (Number.isFinite(Number(run.purityAssessment?.score))) {
    item.purityScores.push(Number(run.purityAssessment.score));
  }
  if (Number.isFinite(Number(run.fingerprintSummary?.passRate))) {
    item.fingerprintRates.push(Number(run.fingerprintSummary.passRate));
  }
  if (Number.isFinite(Number(run.tokenAudit?.usageCoverage))) {
    item.tokenCoverageRates.push(Number(run.tokenAudit.usageCoverage));
  }
  if (Number.isFinite(Number(run.p95TotalMs))) {
    item.p95Values.push(Number(run.p95TotalMs));
  }
  addCostSignals(item, run);
}

export function renderRankingList(rows) {
  if (!rows.length) {
    return `<p class="muted">完成标准评测或高级复测后会生成排行榜。</p>`;
  }

  return rows
    .map(
      (row, index) => `
        <article class="ranking-card ${recommendationClass(row.level)}-card">
          <span class="ranking-index">#${index + 1}</span>
          <div>
            <strong>${escapeHtml(row.profileName)}</strong>
            <small>${escapeHtml(row.model)}${row.profileRole === "baseline" ? " / 可信基线" : ""}</small>
          </div>
          <div>
            <span>综合分</span>
            <strong>${row.score}</strong>
          </div>
          <div>
            <span>成功率</span>
            <strong>${formatPercent(row.successRate)}</strong>
          </div>
          <div>
            <span>慢请求</span>
            <strong>${row.p95 ? `${Math.round(row.p95)} ms` : "-"}</strong>
          </div>
          <div>
            <span>质量分</span>
            <strong>${row.qualityScore ? Math.round(row.qualityScore) : "-"}</strong>
          </div>
          <div>
            <span>纯度</span>
            <strong>${row.purityScore ? Math.round(row.purityScore) : "-"}</strong>
          </div>
          <div>
            <span>指纹</span>
            <strong>${row.fingerprintRate ? formatPercent(row.fingerprintRate) : "-"}</strong>
          </div>
          <div>
            <span>估算成本</span>
            <strong>${formatCost(row.estimatedCost)}</strong>
          </div>
          <div>
            <span>估算毛利</span>
            <strong>${formatCost(row.estimatedGrossProfit)}</strong>
          </div>
          <small>准入 ${row.admissionRuns} 次 / 稳定性 ${row.stabilityRuns} 次 / 场景 ${row.scenarioRuns} 次 / Token 覆盖 ${row.tokenCoverage ? formatPercent(row.tokenCoverage) : "-"}</small>
          <small>${escapeHtml(formatBaselineDelta(row))}</small>
        </article>
      `,
    )
    .join("");
}

export function buildModelComparisonGroups(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = modelCompareKey(row.model);
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, {
        model: row.model || "-",
        candidates: [],
        baselines: [],
      });
    }
    const group = groups.get(key);
    if (row.profileRole === "baseline") {
      group.baselines.push(row);
    } else {
      group.candidates.push(row);
    }
  }

  return [...groups.values()]
    .filter((group) => group.candidates.length + group.baselines.length > 1)
    .map((group) => {
      const sortedCandidates = [...group.candidates].sort((a, b) => b.score - a.score);
      const sortedBaselines = [...group.baselines].sort((a, b) => b.score - a.score);
      const bestCandidate = sortedCandidates[0] || null;
      const bestBaseline = sortedBaselines[0] || null;
      return {
        ...group,
        candidates: sortedCandidates,
        baselines: sortedBaselines,
        bestCandidate,
        bestBaseline,
        candidateCount: sortedCandidates.length,
        baselineCount: sortedBaselines.length,
        baselineDelta: bestCandidate && bestBaseline ? bestCandidate.score - bestBaseline.score : null,
      };
    })
    .sort((a, b) => (b.bestCandidate?.score || 0) - (a.bestCandidate?.score || 0));
}

export function renderModelComparisonList(groups) {
  if (!groups.length) {
    return `<p class="muted">同一模型至少需要 2 个候选渠道，或 1 个候选渠道加 1 个可信基线，才会生成对比矩阵。</p>`;
  }

  return groups
    .map((group) => {
      const rows = [...group.candidates, ...group.baselines]
        .map(
          (row) => `
            <tr>
              <td>${escapeHtml(row.profileName || "-")}</td>
              <td>${row.profileRole === "baseline" ? "可信基线" : "候选渠道"}</td>
              <td>${row.score ?? "-"}</td>
              <td>${formatPercent(row.successRate || 0)}</td>
              <td>${row.p95 ? `${Math.round(row.p95)} ms` : "-"}</td>
              <td>${row.qualityScore ? Math.round(row.qualityScore) : "-"}</td>
              <td>${row.purityScore ? Math.round(row.purityScore) : "-"}</td>
              <td>${row.fingerprintRate ? formatPercent(row.fingerprintRate) : "-"}</td>
              <td>${row.tokenCoverage ? formatPercent(row.tokenCoverage) : "-"}</td>
              <td>${formatCost(row.estimatedCost)}</td>
              <td>${formatCost(row.estimatedGrossProfit)}</td>
              <td>${formatMargin(row.estimatedGrossMargin)}</td>
              <td>${escapeHtml(formatBaselineDelta(row))}</td>
            </tr>
          `,
        )
        .join("");
      const deltaText = Number.isFinite(group.baselineDelta)
        ? `${group.baselineDelta > 0 ? "+" : ""}${group.baselineDelta} 分`
        : "暂无可信基线";
      return `
        <article class="comparison-card">
          <div class="section-header compact">
            <div>
              <p class="eyebrow">${escapeHtml(group.model)}</p>
              <h4>${escapeHtml(group.bestCandidate?.profileName || "暂无候选渠道")}</h4>
            </div>
            <div class="comparison-summary">
              <span>候选 ${group.candidateCount} 个</span>
              <span>基线 ${group.baselineCount} 个</span>
              <strong>相对基线 ${escapeHtml(deltaText)}</strong>
            </div>
          </div>
          <div class="table-scroll">
            <table class="comparison-table">
              <thead>
                <tr>
                  <th>API</th>
                  <th>角色</th>
                  <th>综合分</th>
                  <th>成功率</th>
                  <th>P95</th>
                  <th>质量</th>
                  <th>纯度</th>
                  <th>指纹</th>
                  <th>Token</th>
                  <th>估算成本</th>
                  <th>估算毛利</th>
                  <th>毛利率</th>
                  <th>基线对比</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </article>
      `;
    })
    .join("");
}

export function renderPlainConclusion(runs) {
  if (!runs.latest && !runs.latestStability && !runs.latestScenario && !runs.latestRequest) {
    return `<p class="muted">还没有测试结果。普通操作员先完成标准评测。</p>`;
  }

  if (runs.interruptedTasks.length > 0) {
    return renderPlainConclusionCard({
      level: "fail",
      title: "不推荐交付",
      reason: "有测试任务中断，当前结果不完整。",
      next: "重新执行中断的测试，再复制交付模板。",
      evidence: `中断任务 ${runs.interruptedTasks.length} 个`,
    });
  }

  if (runs.failedRequests.length > 0 && !runs.latestStability && !runs.latestScenario) {
    return renderPlainConclusionCard({
      level: "fail",
      title: "不推荐",
      reason: "最近请求失败，配置或渠道还没有跑通。",
      next: "回 API 配置检查 URL、协议、模型名和 Key，然后重新快速测试。",
      evidence: runs.failedRequests[0]?.normalizedError || runs.failedRequests[0]?.rawError || "请求失败",
    });
  }

  if (runs.latestStability) {
    const level = runs.latestStability.recommendation?.level || "watch";
    return renderPlainConclusionCard({
      level,
      title: level === "pass" ? "推荐进入下一轮" : level === "fail" ? "不推荐" : "观察",
      reason: runs.latestStability.recommendation?.title || "需要查看报告。",
      next:
        level === "pass"
          ? "继续跑复杂场景测试，或复制交付模板给负责人。"
          : level === "fail"
          ? "查看错误类型，修配置或换渠道后再复测。"
          : "建议再跑 10 轮稳定性或人工查看报告明细。",
      evidence: `成功率 ${runs.latestStability.successRateText || "-"} / 慢请求参考 ${runs.latestStability.p95TotalMs ?? "-"} ms`,
    });
  }

  if (runs.latestAdmission) {
    const level = runs.latestAdmission.recommendation?.level || "watch";
    return renderPlainConclusionCard({
      level,
      title: level === "pass" ? "可进入标准评测" : level === "fail" ? "暂不推荐接入" : "需要观察",
      reason: runs.latestAdmission.recommendation?.title || "需要查看准入报告。",
      next:
        level === "pass"
          ? "继续跑标准评测，确认稳定性和复杂场景表现。"
          : "先复核协议、模型名、工具调用和上游配置，再重新做准入评测。",
      evidence: `准入等级 ${runs.latestAdmission.grade || "-"} / 成功率 ${runs.latestAdmission.successRateText || "-"}`,
    });
  }

  if (runs.latestRequest) {
    return renderPlainConclusionCard({
      level: runs.latestRequest.success ? "watch" : "fail",
      title: runs.latestRequest.success ? "只证明能连通" : "不推荐",
      reason: runs.latestRequest.success ? "最近一次快速测试成功，但还没有稳定性结论。" : "最近一次快速测试失败。",
      next: runs.latestRequest.success ? "继续跑标准评测，生成可交付结论。" : "先修配置，再重新快速测试。",
      evidence: `最近请求：${runs.latestRequest.success ? "成功" : "失败"}`,
    });
  }

  return `<p class="muted">暂无可用结论。</p>`;
}

export function buildHandoffTemplate(runs, projectInfo = {}, rankingRows = []) {
  const latest = runs.latest;
  const latestRequest = runs.latestRequest;
  const projectName = projectInfo.projectName?.trim() || "未填写";
  const batchName = projectInfo.batchName?.trim() || "未填写";
  const testerName = projectInfo.testerName?.trim() || "未填写";
  const testPurpose = projectInfo.testPurpose?.trim() || "未填写";
  const failedLines = runs.failedRequests.length
    ? runs.failedRequests
        .map(
          (request, index) =>
            `${index + 1}. ${request.profileName || "-"} / ${request.normalizedError || "unknown_error"} / 请求状态 ${
              request.statusCode ?? "-"
            } / ${request.totalMs ?? "-"} ms`,
        )
        .join("\n")
    : "无明显失败请求。";
  const interruptedLines = runs.interruptedTasks.length
    ? runs.interruptedTasks
        .map((task, index) => `${index + 1}. ${formatTaskType(task.type)} / ${formatDateTime(task.startedAt)} / ${task.message}`)
        .join("\n")
    : "无中断任务。";
  const rankingLines = formatRankingForHandoff(rankingRows);

  // This template is meant for non-technical operators to paste into a handoff
  // message. Keep it concise and never include secrets or raw 评测数据 content.
  if (!latest && !latestRequest) {
    return [
      "# 测试交付",
      "",
      "当前还没有测试结果。",
      "",
      "建议先执行：API 配置 -> 标准评测 -> 报告中心 -> 测试交付。",
    ].join("\n");
  }

  const latestSummary = latest ? summarizeRunForHandoff(latest) : "只有快速测试记录，还没有可交付的完整报告。建议继续跑标准评测。";
  return [
    "# 测试交付",
    "",
    `交付时间：${new Date().toLocaleString("zh-CN")}`,
    `项目 / 客户：${projectName}`,
    `测试批次：${batchName}`,
    `测试人员：${testerName}`,
    `测试目的：${testPurpose}`,
    "",
    "## 一、总体结论",
    "",
    latestSummary,
    "",
    "## 二、最近请求状态",
    "",
    latestRequest
      ? [
          `- API：${latestRequest.profileName || "-"}`,
          `- 模型：${latestRequest.model || "-"}`,
          `- 结果：${latestRequest.success ? "成功" : "失败"}`,
          `- 请求状态：${latestRequest.statusCode ?? "-"}`,
          `- 总耗时：${latestRequest.totalMs ?? "-"} ms`,
          `- 错误/摘要：${latestRequest.normalizedError || latestRequest.responseSummary || latestRequest.rawError || "-"}`,
        ].join("\n")
      : "- 暂无请求记录。",
    "",
    "## 三、异常记录",
    "",
    "### 失败请求",
    "",
    failedLines,
    "",
    "### 中断任务",
    "",
    interruptedLines,
    "",
    "## 四、候选渠道与可信基线对比",
    "",
    rankingLines,
    "",
    "## 五、报告附件",
    "",
    latest
      ? [
          `- Markdown：${latest.reportPath || "-"}`,
          `- HTML：${latest.reportHtmlPath || "-"}`,
          `- JSON 原始结果：${latest.rawJsonPath || "-"}`,
        ].join("\n")
      : "- 暂无报告文件。",
    "",
    "## 六、需要负责人确认",
    "",
    "- 是否继续扩大轮数或增加复杂场景？",
    "- 是否需要对失败渠道按 Request ID 去平台后台排查？",
    "- 是否保留当前候选渠道进入下一轮人工质量评审？",
    "",
    "## 七、备注",
    "",
    "- 本交付内容不包含 API Key。",
    "- 如需复现问题，请同时提供平台后台 Request ID 和本工具报告文件。",
  ].join("\n");
}

function formatRankingForHandoff(rows = []) {
  if (!rows.length) {
    return "暂无排行榜数据。建议至少完成准入评测或标准评测后再交付。";
  }

  const visibleRows = rows
    .filter((row) => row.profileRole !== "baseline")
    .slice(0, 5);
  const baselineRows = rows.filter((row) => row.profileRole === "baseline");
  const candidateLines = visibleRows.length
    ? visibleRows
        .map((row, index) => {
          const baselineText = Number.isFinite(row.baselineDelta)
            ? `，相对可信基线 ${row.baselineProfileName}：${row.baselineDelta > 0 ? "+" : ""}${row.baselineDelta} 分`
            : "，暂无同模型可信基线";
          return `${index + 1}. ${row.profileName || "-"} / ${row.model || "-"}：综合分 ${row.score}，成功率 ${formatPercent(row.successRate)}，纯度 ${
            row.purityScore ? Math.round(row.purityScore) : "-"
          }，指纹 ${row.fingerprintRate ? formatPercent(row.fingerprintRate) : "-"}${baselineText}`;
        })
        .join("\n")
    : "暂无候选渠道排行。";
  const baselineLines = baselineRows.length
    ? baselineRows
        .slice(0, 5)
        .map((row, index) => `${index + 1}. ${row.profileName || "-"} / ${row.model || "-"}：综合分 ${row.score}，作为可信基线参考。`)
        .join("\n")
    : "暂无可信基线配置。建议为关键模型配置官方 API 或长期稳定渠道作为对照。";

  return [
    "### 候选渠道排行",
    "",
    candidateLines,
    "",
    "### 可信基线",
    "",
    baselineLines,
  ].join("\n");
}

function renderStabilityInsight(run) {
  const level = run.recommendation?.level || "watch";
  return `
    <article class="insight-card ${recommendationClass(level)}-card">
      <span>稳定性结论</span>
      <strong>${escapeHtml(run.recommendation?.title || "需要查看报告")}</strong>
      <p>${escapeHtml(run.recommendation?.detail || "请查看 Markdown 或 HTML 报告。")}</p>
      <small>成功率 ${escapeHtml(run.successRateText || "-")} / 慢请求参考 ${run.p95TotalMs ?? "-"} ms / ${run.rounds ?? "-"} 轮</small>
      <small>报告：${escapeHtml(run.reportHtmlPath || run.reportPath || "-")}</small>
    </article>
  `;
}

function ensureRankingItem(grouped, key, profileName, model, profileRole = "target") {
  if (!grouped.has(key)) {
    grouped.set(key, {
      key,
      profileName,
      profileRole: profileRole || "target",
      model,
      stabilityRuns: 0,
      scenarioRuns: 0,
      admissionRuns: 0,
      successRates: [],
      scenarioSuccessRates: [],
      p95Values: [],
      qualityScores: [],
      admissionScores: [],
      purityScores: [],
      fingerprintRates: [],
      tokenCoverageRates: [],
      estimatedCosts: [],
      estimatedRevenues: [],
      estimatedGrossProfits: [],
      inputTokens: [],
      outputTokens: [],
    });
  }
  const item = grouped.get(key);
  if (profileRole === "baseline") {
    item.profileRole = "baseline";
  }
  return item;
}

function addCostSignals(item, run) {
  if (Number.isFinite(Number(run.estimatedCost))) {
    item.estimatedCosts.push(Number(run.estimatedCost));
  }
  if (Number.isFinite(Number(run.estimatedRevenue))) {
    item.estimatedRevenues.push(Number(run.estimatedRevenue));
  }
  if (Number.isFinite(Number(run.estimatedGrossProfit))) {
    item.estimatedGrossProfits.push(Number(run.estimatedGrossProfit));
  }
  if (Number.isFinite(Number(run.inputTokens))) {
    item.inputTokens.push(Number(run.inputTokens));
  }
  if (Number.isFinite(Number(run.outputTokens))) {
    item.outputTokens.push(Number(run.outputTokens));
  }
}

function sumNumbers(values) {
  const finiteValues = values.map((value) => Number(value)).filter(Number.isFinite);
  if (!finiteValues.length) return null;
  return finiteValues.reduce((total, value) => total + value, 0);
}

function attachBaselineComparison(rows) {
  const baselineByModel = new Map();
  for (const row of rows) {
    if (row.profileRole !== "baseline") continue;
    const key = modelCompareKey(row.model);
    const current = baselineByModel.get(key);
    if (!current || row.score > current.score) {
      baselineByModel.set(key, row);
    }
  }

  return rows.map((row) => {
    if (row.profileRole === "baseline") {
      return { ...row, baselineDelta: null, baselineProfileName: "" };
    }
    const baseline = baselineByModel.get(modelCompareKey(row.model));
    if (!baseline) {
      return { ...row, baselineDelta: null, baselineProfileName: "" };
    }
    return {
      ...row,
      baselineDelta: row.score - baseline.score,
      baselineProfileName: baseline.profileName,
    };
  });
}

function modelCompareKey(model) {
  return String(model || "").trim().toLowerCase();
}

function formatBaselineDelta(row) {
  if (row.profileRole === "baseline") return "该配置被标记为可信基线。";
  if (!Number.isFinite(row.baselineDelta)) return "暂无同模型可信基线。";
  const prefix = row.baselineDelta > 0 ? "+" : "";
  return `相对可信基线 ${row.baselineProfileName}：${prefix}${row.baselineDelta} 分`;
}


function formatMargin(value) {
  if (!Number.isFinite(Number(value))) return "-";
  return formatPercent(Number(value));
}

function renderAdmissionInsight(run) {
  const level = run.recommendation?.level || "watch";
  return `
    <article class="insight-card ${recommendationClass(level)}-card">
      <span>准入结论</span>
      <strong>${escapeHtml(run.recommendation?.title || "需要查看准入报告")}</strong>
      <p>准入等级 ${escapeHtml(run.grade || "-")}，综合分 ${run.score ?? "-"}，成功率 ${escapeHtml(run.successRateText || "-")}。</p>
      <small>工具调用 ${run.toolCallPassed ? "通过" : "未通过或未测试"} / JSON 结构 ${run.jsonPassed ? "通过" : "未通过或未测试"}</small>
      <small>报告：${escapeHtml(run.reportHtmlPath || run.reportPath || "-")}</small>
    </article>
  `;
}

function renderScenarioInsight(run) {
  const scores = run.results?.map((item) => item.avgQualityScore).filter((value) => Number.isFinite(value)) || [];
  const avgScore = Math.round(average(scores) || 0);
  const successRates = run.results?.map((item) => item.successRate).filter((value) => Number.isFinite(value)) || [];
  const avgSuccessRate = average(successRates) || 0;
  const level = avgSuccessRate >= 0.95 && avgScore >= 80 ? "pass" : avgSuccessRate >= 0.8 && avgScore >= 65 ? "watch" : "fail";
  const title = level === "pass" ? "复杂场景表现可继续复核" : level === "watch" ? "复杂场景需要观察" : "复杂场景风险较高";
  return `
    <article class="insight-card ${recommendationClass(level)}-card">
      <span>场景测试结论</span>
      <strong>${title}</strong>
      <p>平均质量分 ${avgScore}，平均成功率 ${formatPercent(avgSuccessRate)}。重要模型需要人工抽查输出内容。</p>
      <small>${run.profileCount ?? "-"} 个 API / ${run.scenarioCount ?? "-"} 个场景 / 重复 ${run.repeats ?? "-"} 次</small>
      <small>报告：${escapeHtml(run.reportHtmlPath || run.reportPath || "-")}</small>
    </article>
  `;
}

function renderRequestInsight(request) {
  const level = request.success ? "pass" : "fail";
  return `
    <article class="insight-card ${recommendationClass(level)}-card">
      <span>最近请求</span>
      <strong>${request.success ? "最近一次请求成功" : "最近一次请求失败"}</strong>
      <p>${escapeHtml(request.normalizedError || request.responseSummary || request.rawError || "-")}</p>
      <small>${escapeHtml(request.profileName || "-")} / 请求状态 ${request.statusCode ?? "-"} / 总耗时 ${request.totalMs ?? "-"} ms</small>
    </article>
  `;
}

function renderOperatorAdvice(runs) {
  const failed = runs.failedRequests.length;
  const interrupted = runs.interruptedTasks.length;
  const title = failed > 0 || interrupted > 0 ? "交付时必须说明异常" : "交付材料基本完整";
  const detail =
    interrupted > 0
      ? `发现 ${interrupted} 个中断任务。交付时请说明这些任务没有完整结论，需要重新执行。`
      : failed > 0
      ? `最近有 ${failed} 条失败请求。交付时请附上错误类型、平台 Request ID 和复测建议。`
      : "请复制下方模板，并附上 Markdown 或 HTML 报告文件路径。";
  return `
    <article class="insight-card">
      <span>交付提醒</span>
      <strong>${title}</strong>
      <p>${detail}</p>
      <small>不要发送 API Key，不要发送整个 评测数据 目录。</small>
    </article>
  `;
}

function renderPlainConclusionCard({ level, title, reason, next, evidence }) {
  return `
    <article class="plain-card ${recommendationClass(level)}-card">
      <div>
        <span>结论</span>
        <strong>${escapeHtml(title)}</strong>
      </div>
      <div>
        <span>原因</span>
        <p>${escapeHtml(reason)}</p>
      </div>
      <div>
        <span>下一步</span>
        <p>${escapeHtml(next)}</p>
      </div>
      <small>${escapeHtml(evidence || "")}</small>
    </article>
  `;
}

function summarizeRunForHandoff(run) {
  if (run.type === "scenario") {
    const scores = run.results?.map((item) => item.avgQualityScore).filter((value) => Number.isFinite(value)) || [];
    const successRates = run.results?.map((item) => item.successRate).filter((value) => Number.isFinite(value)) || [];
    return [
      `- 最新报告类型：复杂场景测试`,
      `- 被测 API：${run.profileCount ?? "-"} 个`,
      `- 场景数量：${run.scenarioCount ?? "-"} 个`,
      `- 平均成功率：${formatPercent(average(successRates) || 0)}`,
      `- 平均质量分：${Math.round(average(scores) || 0)}`,
      `- 结论：请结合场景明细和人工抽查判断是否进入下一轮复测。`,
    ].join("\n");
  }

  return [
    `- 最新报告类型：稳定性测试`,
    `- API：${run.profileName || "-"}`,
    `- 模型：${run.model || "-"}`,
    `- 成功率：${run.successRateText || "-"}`,
    `- 慢请求参考：${run.p95TotalMs ?? "-"} ms`,
    `- 结论：${run.recommendation?.title || "-"}`,
    `- 建议：${run.recommendation?.detail || "-"}`,
  ].join("\n");
}
