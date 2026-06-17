import { escapeHtml, renderMarkdown } from "./client-utils.js";
import { recommendationClass } from "./formatters.js";

const GRADE_TEXT = {
  A: "优秀，可进入后续测试",
  B: "可用，可进入后续测试",
  C: "可观察，需要复测",
  D: "不建议直接开放",
  E: "协议或结构风险较高",
  F: "不可用或配置错误",
  X: "上游稳定性风险",
};

export function renderAdmissionResult(result) {
  if (!result || typeof result !== "object") {
    return `<p class="muted">暂无准入结果。</p>`;
  }

  const level = result.recommendation?.level || "watch";
  const grade = result.grade || "-";
  const cases = Array.isArray(result.cases) ? result.cases : [];
  const errorEntries = Object.entries(result.errorCounts || {});

  return `
    <div class="admission-result">
      <article class="admission-hero ${recommendationClass(level)}-card">
        <div>
          <span>准入等级</span>
          <strong>${escapeHtml(grade)}</strong>
          <small>${escapeHtml(GRADE_TEXT[grade] || "需要查看明细")}</small>
        </div>
        <div>
          <span>综合分</span>
          <strong>${result.score ?? "-"}</strong>
          <small>满分 100</small>
        </div>
        <div>
          <span>成功率</span>
          <strong>${escapeHtml(result.successRateText || "-")}</strong>
          <small>${result.successCount ?? 0}/${result.requestCount ?? 0} 次请求成功</small>
        </div>
      </article>

      <section class="admission-decision">
        <span>业务结论</span>
        <strong>${escapeHtml(result.recommendation?.title || "-")}</strong>
        <p>${escapeHtml(result.recommendation?.detail || "-")}</p>
        <p><b>下一步：</b>${escapeHtml(result.nextAction || "-")}</p>
      </section>

      <div class="summary-grid admission-metrics">
        <article class="summary-card">
          <span>工具调用</span>
          <strong class="${result.toolCallPassed ? "ok" : "warn"}">${result.toolCallPassed ? "通过" : "未通过"}</strong>
          <small>用于判断 Claude Code / Codex 等工具类客户端兼容性。</small>
        </article>
        <article class="summary-card">
          <span>JSON 结构</span>
          <strong class="${result.jsonPassed ? "ok" : "warn"}">${result.jsonPassed ? "通过" : "未通过"}</strong>
          <small>用于判断结构化输出和协议转换是否稳定。</small>
        </article>
        <article class="summary-card">
          <span>标称一致性</span>
          <strong class="${identityClass(result.identityCheck)}">${identityText(result.identityCheck)}</strong>
          <small>${escapeHtml(identityDetail(result.identityCheck))}</small>
        </article>
        <article class="summary-card">
          <span>模型纯度初判</span>
          <strong class="${purityClass(result.purityAssessment)}">${escapeHtml(result.purityAssessment?.title || "未评估")}</strong>
          <small>${escapeHtml(purityDetail(result.purityAssessment))}</small>
        </article>
        <article class="summary-card">
          <span>指纹探针</span>
          <strong class="${fingerprintClass(result.fingerprintSummary)}">${escapeHtml(fingerprintText(result.fingerprintSummary))}</strong>
          <small>固定指令、逻辑、代码和上下文锚点的行为一致性初筛。</small>
        </article>
        <article class="summary-card">
          <span>Token 审计</span>
          <strong>${escapeHtml(result.tokenAudit?.usageCoverageText || "-")}</strong>
          <small>usage 覆盖率，可靠性 ${escapeHtml(result.tokenAudit?.tokenReliability || "unknown")}</small>
        </article>
        <article class="summary-card">
          <span>流式结构</span>
          <strong class="${result.streamPassed ? "ok" : "warn"}">${result.streamPassed ? "通过" : "未通过"}</strong>
          <small>用于识别 SSE 事件顺序、缺块和流式结束异常。</small>
        </article>
        <article class="summary-card">
          <span>慢请求参考</span>
          <strong>${result.p95TotalMs ?? "-"} ms</strong>
          <small>平均耗时 ${result.avgTotalMs ?? "-"} ms。</small>
        </article>
        <article class="summary-card">
          <span>分词器指纹</span>
          <strong class="${tokenizerFpClass(result.tokenizerFingerprint)}">${escapeHtml(tokenizerFpText(result.tokenizerFingerprint))}</strong>
          <small>${escapeHtml(tokenizerFpDetail(result.tokenizerFingerprint))}</small>
        </article>
      </div>

      <section class="admission-cases">
        <h4>分项结果</h4>
        <div class="table compact-table">
          ${cases.map(renderAdmissionCase).join("") || `<p class="muted">暂无分项结果。</p>`}
        </div>
      </section>

      <section class="admission-files">
        <h4>报告文件</h4>
        <p>Markdown：${escapeHtml(result.reportPath || "-")}</p>
        <p>HTML：${escapeHtml(result.reportHtmlPath || "-")}</p>
        <p>JSON 原始结果：${escapeHtml(result.rawJsonPath || "-")}</p>
      </section>

      <details class="technical-details">
        <summary>查看完整技术报告</summary>
        <div class="markdown-report">${renderMarkdown(result.reportMarkdown || buildTechnicalFallback(result, errorEntries))}</div>
      </details>
    </div>
  `;
}

function renderAdmissionCase(item, index) {
  return `
    <div class="row admission-case-row">
      <div>
        <strong>${index + 1}. ${escapeHtml(item.name || item.id || "-")}</strong><br />
        <small>${escapeHtml(item.issue || item.summary || "-")}</small>
      </div>
      <span class="${item.passed ? "ok" : "fail"}">${item.passed ? "通过" : "未通过"}</span>
      <span>${item.statusCode ?? "-"}</span>
      <span>${item.totalMs ?? "-"} ms</span>
      <small>输入 ${item.inputTokens ?? "-"} / 输出 ${item.outputTokens ?? "-"}</small>
    </div>
  `;
}

function identityText(identityCheck) {
  if (!identityCheck) return "未测试";
  if (identityCheck.status === "aligned") return "一致";
  if (identityCheck.status === "conflict") return "冲突";
  if (identityCheck.status === "observed") return "已记录";
  return "无法确认";
}

function identityClass(identityCheck) {
  if (!identityCheck) return "warn";
  if (identityCheck.status === "aligned" || identityCheck.status === "observed") return "ok";
  if (identityCheck.status === "conflict") return "fail";
  return "warn";
}

function identityDetail(identityCheck) {
  if (!identityCheck) return "未执行模型标称一致性探针。";
  return `标称 ${identityCheck.expectedFamily || "unknown"}，自述 ${identityCheck.reportedFamily || "unknown"}。`;
}

function purityClass(purityAssessment) {
  if (!purityAssessment) return "warn";
  if (purityAssessment.score >= 85) return "ok";
  if (purityAssessment.score >= 65) return "warn";
  return "fail";
}

function purityDetail(purityAssessment) {
  if (!purityAssessment) return "未生成模型纯度初判。";
  return `纯度分 ${purityAssessment.score}/100，置信度 ${purityAssessment.confidence}。`;
}

function fingerprintClass(fingerprintSummary) {
  if (!fingerprintSummary?.totalCount) return "warn";
  if (fingerprintSummary.passRate >= 0.8) return "ok";
  if (fingerprintSummary.passRate >= 0.5) return "warn";
  return "fail";
}

function fingerprintText(fingerprintSummary) {
  if (!fingerprintSummary?.totalCount) return "未测试";
  return `${fingerprintSummary.passedCount}/${fingerprintSummary.totalCount} 通过`;
}

function tokenizerFpClass(fp) {
  if (!fp || !fp.applicable) return "warn";
  if (fp.status === "consistent") return "ok";
  if (fp.status === "mismatch") return "fail";
  return "warn";
}

function tokenizerFpText(fp) {
  if (!fp) return "不适用";
  if (!fp.applicable) return "不适用";
  if (fp.status === "consistent") return "一致";
  if (fp.status === "mismatch") return "疑似冒牌";
  return "需复核";
}

function tokenizerFpDetail(fp) {
  if (!fp) return "仅对声称 Claude 的模型做分词核验。";
  if (!fp.applicable) return fp.reason || "未核验。";
  return `按 ${fp.baselineModel} 基线，slope=${fp.slope ?? "-"} / R²=${fp.r2 ?? "-"}（n=${fp.n ?? 0}）。`;
}

function buildTechnicalFallback(result, errorEntries) {
  return [
    `# ${result.profileName || "准入评测"} 技术摘要`,
    "",
    `- 模型：${result.model || "-"}`,
    `- 协议：${result.protocol || "-"}`,
    `- 错误分布：${errorEntries.length ? errorEntries.map(([key, value]) => `${key} ${value}`).join("；") : "无"}`,
  ].join("\n");
}
