// src/client-replay.js
// 客户端回放页：日志分析 / 导入 / 回放（单条 + 批量）四大块。
//
// 从 app.js 整块搬出（16 号报告 C1 第二阶段）。代码**逐字未改**——纯搬运才能用构建产物比对证明等价。
//
// 依赖：api、toast、confirmAction、formatClientLogAnalysisResult、formatSupplierEvidenceResult 等
// 全部通过 deps 注入。replayProfileSelect 选项刷新通过 onProfileData 自注册。
export function createClientReplay({ state, els, onProfileData, deps }) {
  const {
    api,
    toast,
    confirmAction,
    loadTestRuns,
    renderDeliveryViews,
    formatClientLogAnalysisResult,
    formatSupplierEvidenceResult,
    renderRunTargetSelectOptions,
  } = deps;

  // 客户端回放页的 profile 选项：在渠道/模型数据变化时跟随刷新。
  onProfileData((data) => renderRunTargetSelectOptions({ ...data, selects: [els.clientReplayProfileSelect] }));

  async function analyzeClientLogs(event) {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(els.clientLogForm).entries());
    if (!String(payload.logText || "").trim()) {
      toast("请先粘贴需要分析的客户端日志。", true);
      return;
    }
    els.clientLogSubmit.disabled = true;
    els.clientLogSubmit.textContent = "正在生成报告...";
    els.clientLogResult.textContent = "正在解析日志并生成报告。";
    try {
      const result = await api("/api/client-logs/analyze", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      els.clientLogResult.textContent = formatClientLogAnalysisResult(result);
      await loadTestRuns();
      renderDeliveryViews();
      toast("客户端日志分析报告已生成。");
    } catch (error) {
      els.clientLogResult.textContent = `客户端日志分析失败：${error.message}`;
      toast(error.message, true);
    } finally {
      els.clientLogSubmit.disabled = false;
      els.clientLogSubmit.textContent = "生成客户端日志分析报告";
    }
  }

  async function generateSupplierEvidence() {
    const payload = Object.fromEntries(new FormData(els.clientLogForm).entries());
    if (!String(payload.logText || "").trim()) {
      toast("请先粘贴需要整理的客户端日志。", true);
      return;
    }
    els.clientEvidenceSubmit.disabled = true;
    els.clientEvidenceSubmit.textContent = "正在生成证据包...";
    els.clientLogResult.textContent = "正在整理给上游排查使用的脱敏证据包。";
    try {
      const result = await api("/api/client-logs/supplier-evidence", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      els.clientLogResult.textContent = formatSupplierEvidenceResult(result);
      await loadTestRuns();
      renderDeliveryViews();
      toast("上游排查证据包已生成。");
    } catch (error) {
      els.clientLogResult.textContent = `生成上游排查证据包失败：${error.message}`;
      toast(error.message, true);
    } finally {
      els.clientEvidenceSubmit.disabled = false;
      els.clientEvidenceSubmit.textContent = "生成上游排查证据包";
    }
  }

  async function importClientLogFile() {
    const file = els.clientLogFile.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      els.clientLogForm.elements.sourceName.value ||= file.name;
      els.clientLogForm.elements.logText.value = text;
      els.clientLogResult.textContent = `已导入 ${file.name}，大小 ${Math.round(file.size / 1024)} KB。确认内容后点击"生成客户端日志分析报告"。`;
    } catch (error) {
      els.clientLogResult.textContent = `读取日志文件失败：${error.message}`;
      toast("读取日志文件失败。", true);
    } finally {
      els.clientLogFile.value = ""; // 清空，使同一文件改动后可再次选择、重新触发 change 导入
    }
  }

  async function importClientLogDirectory() {
    const directoryPath = String(els.clientLogForm.elements.directoryPath.value || "").trim();
    if (!directoryPath) {
      toast("请先填写本机日志目录路径。", true);
      return;
    }
    els.clientLogDirectoryImport.disabled = true;
    els.clientLogDirectoryImport.textContent = "正在读取目录...";
    els.clientLogResult.textContent = "正在读取本机日志目录。";
    try {
      const result = await api("/api/client-logs/import-directory", {
        method: "POST",
        body: JSON.stringify({
          directoryPath,
          maxFiles: 30,
        }),
      });
      els.clientLogForm.elements.sourceName.value ||= result.sourceName || "客户端日志目录";
      els.clientLogForm.elements.logText.value = result.logText || "";
      els.clientLogResult.textContent = [
        `已读取目录：${result.directoryPath || directoryPath}`,
        `文件数量：${result.fileCount}`,
        `读取大小：${Math.round((result.totalBytes || 0) / 1024)} KB`,
        result.truncated ? "提示：部分文件或内容已按安全上限截断。" : "提示：目录内容已读取完成。",
        "确认日志内容后，可以生成分析报告或上游排查证据包。",
      ].join("\n");
      toast("日志目录读取完成。");
    } catch (error) {
      els.clientLogResult.textContent = `读取日志目录失败：${error.message}`;
      toast(error.message, true);
    } finally {
      els.clientLogDirectoryImport.disabled = false;
      els.clientLogDirectoryImport.textContent = "从本机目录读取日志";
    }
  }

  async function extractReplayRequestFromLogs() {
    const logText = String(els.clientLogForm.elements.logText.value || "").trim();
    if (!logText) {
      toast("请先粘贴或导入客户端日志。", true);
      return;
    }
    els.clientReplayExtract.disabled = true;
    els.clientReplayExtract.textContent = "正在提取...";
    try {
      const result = await api("/api/client-logs/replay-candidates", {
        method: "POST",
        body: JSON.stringify({
          sourceName: els.clientLogForm.elements.sourceName.value,
          logText,
        }),
      });
      const candidate = result.candidates?.[0];
      if (!candidate) {
        els.clientReplayResult.textContent = "没有找到可回放请求。请确认日志里包含 request.body 或 body 字段。";
        toast("没有找到可回放请求。", true);
        return;
      }
      els.clientReplayForm.elements.requestJson.value = candidate.requestJson;
      els.clientReplayForm.elements.sourceName.value ||= `${candidate.client || "客户端"} ${candidate.model || ""} 请求回放`.trim();
      els.clientReplayResult.textContent = [
        "已提取第一条可回放请求。",
        `Request ID：${candidate.requestId || "-"}`,
        `客户端：${candidate.client || "-"}`,
        `模型：${candidate.model || "-"}`,
        `路径：${candidate.path || "-"}`,
        `候选数量：${result.count}`,
        "请确认请求内容和成本后，再点击“回放这条请求”。",
      ].join("\n");
      toast("已提取可回放请求。");
    } catch (error) {
      els.clientReplayResult.textContent = `提取可回放请求失败：${error.message}`;
      toast(error.message, true);
    } finally {
      els.clientReplayExtract.disabled = false;
      els.clientReplayExtract.textContent = "从上方日志提取第一条可回放请求";
    }
  }

  async function replayClientRequest(event) {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(els.clientReplayForm).entries());
    if (!payload.profileId) {
      toast("请先选择回放使用的 API。", true);
      return;
    }
    if (!String(payload.requestJson || "").trim()) {
      toast("请先粘贴单条请求 JSON。", true);
      return;
    }
    const confirmed = await confirmAction({
      title: "确认回放真实客户端请求",
      message: "这会真实调用所选 API，并消耗对应额度。请确认请求内容已经脱敏，且成本可接受。",
      confirmLabel: "确认回放",
      cancelLabel: "取消",
    });
    if (!confirmed) return;

    els.clientReplaySubmit.disabled = true;
    els.clientReplaySubmit.textContent = "正在回放...";
    els.clientReplayResult.textContent = "正在请求 API 并生成回放报告。";
    try {
      const result = await api("/api/client-logs/replay", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      els.clientReplayResult.textContent = formatClientLogAnalysisResult(result);
      await loadTestRuns();
      renderDeliveryViews();
      toast("真实客户端请求回放完成。");
    } catch (error) {
      els.clientReplayResult.textContent = `请求回放失败：${error.message}`;
      toast(error.message, true);
    } finally {
      els.clientReplaySubmit.disabled = false;
      els.clientReplaySubmit.textContent = "回放这条请求";
    }
  }

  async function replayClientRequestsFromLogs() {
    const payload = Object.fromEntries(new FormData(els.clientReplayForm).entries());
    const logText = String(els.clientLogForm.elements.logText.value || "").trim();
    if (!payload.profileId) {
      toast("请先选择回放使用的 API。", true);
      return;
    }
    if (!logText) {
      toast("请先在上方粘贴、导入或读取客户端日志。", true);
      return;
    }
    const maxReplayCount = Math.min(10, Math.max(1, Number.parseInt(String(payload.maxReplayCount || "3"), 10) || 3));
    const confirmed = await confirmAction({
      title: "确认批量回放真实客户端请求",
      message: `这会从上方日志中提取候选请求，并最多真实回放 ${maxReplayCount} 条，会消耗对应额度。建议只用于复现 524、504、Content block not found 等关键问题。`,
      confirmLabel: "确认批量回放",
      cancelLabel: "取消",
    });
    if (!confirmed) return;

    els.clientReplayBatch.disabled = true;
    els.clientReplayBatch.textContent = "正在批量回放...";
    els.clientReplayResult.textContent = "正在提取候选请求并按上限批量回放。";
    try {
      const result = await api("/api/client-logs/replay-batch", {
        method: "POST",
        body: JSON.stringify({
          ...payload,
          sourceName: payload.sourceName || els.clientLogForm.elements.sourceName.value || "批量真实客户端请求回放",
          logText,
          maxReplayCount,
        }),
      });
      els.clientReplayResult.textContent = [
        formatClientLogAnalysisResult(result),
        "",
        `候选请求数：${result.replayCandidateCount ?? "-"}`,
        `实际回放数：${result.replayedCount ?? "-"}`,
        `回放上限：${result.replayLimit ?? maxReplayCount}`,
      ].join("\n");
      await loadTestRuns();
      renderDeliveryViews();
      toast("批量真实客户端请求回放完成。");
    } catch (error) {
      els.clientReplayResult.textContent = `批量请求回放失败：${error.message}`;
      toast(error.message, true);
    } finally {
      els.clientReplayBatch.disabled = false;
      els.clientReplayBatch.textContent = "批量回放上方日志候选请求";
    }
  }

  // 事件监听器在工厂内接线（DOM 元素通过 els 传入，已在 app.js 初始化时完成查找）。
  els.clientLogForm.addEventListener("submit", analyzeClientLogs);
  els.clientEvidenceSubmit.addEventListener("click", generateSupplierEvidence);
  els.clientLogFile.addEventListener("change", importClientLogFile);
  els.clientLogDirectoryImport.addEventListener("click", importClientLogDirectory);
  els.clientReplayExtract.addEventListener("click", extractReplayRequestFromLogs);
  els.clientReplayForm.addEventListener("submit", replayClientRequest);
  els.clientReplayBatch.addEventListener("click", replayClientRequestsFromLogs);
}
