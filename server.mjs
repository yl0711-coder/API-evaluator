import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { MIME_TYPES, getTestScenarios } from "./server/constants.mjs";
import { ERROR_LOG_FILE, REPORTS_DIR, STATIC_ROOT, TASK_EVENTS_FILE, TEST_RUNS_FILE } from "./server/paths.mjs";
import { ensureDataDir, readRecentErrors, readRecentRequests, readRecentTasks, readRecentTestRuns } from "./server/data-store.mjs";
import {
  analyzeClientLogs,
  buildSupplierEvidence,
  extractClientLogRecords,
  extractReplayCandidates,
} from "./server/client-log-analyzer.mjs";
import { readClientLogDirectory } from "./server/client-log-importer.mjs";
import { runClientReplay } from "./server/client-replay.mjs";
import { buildUserErrorMessage, logTechnicalError } from "./server/error-log.mjs";
import { isAllowedBrowserOrigin, staticSecurityHeaders } from "./server/http-security.mjs";
import { HttpRequestError, readJson } from "./server/http-request.mjs";
import { formatClientReplayReport, formatSupplierEvidenceReport, saveReportFiles } from "./server/reporting.mjs";
import {
  exportProfile,
  findDuplicateProfile,
  hashApiKey,
  loadProfiles,
  maskProfile,
  maskScenario,
  mergeProfiles,
  normalizeImportedProfiles,
  normalizeProfile,
  saveProfiles,
} from "./server/profile-store.mjs";
import { deleteProfileApiKey, readProfileApiKey, saveProfileApiKey } from "./server/secret-store.mjs";
import { createTaskManager } from "./server/task-manager.mjs";
import { buildSupportBundle } from "./server/support-bundle.mjs";
import {
  getDbHealth,
  pruneReports,
  queryProfileRunSummaries,
  queryRecentReports,
  queryRegressionAlerts,
  querySpendSummary,
} from "./server/db.mjs";
import { buildTrendSeries, detectRegression } from "./server/regression.mjs";
import {
  normalizeProfileIds,
  normalizeScenarioIds,
  runAdmissionTest,
  runBatchAdmissionTest,
  runBatchStabilityTest,
  runQuickTest,
  runQuickVerify,
  runScenarioTest,
  runStabilityTest,
} from "./server/test-runner.mjs";
import { openReportInBrowser, sanitizeReportBaseName } from "./server/report-files.mjs";
import { getRawRequestPathname, resolveRequestPathInside } from "./server/static-paths.mjs";
import { appendJsonLine, compactDate, hasProxyEnv, requiredString, safeJson, sendJson } from "./server/utils.mjs";
import { saveRunArtifacts } from "./server/workspace-store.mjs";
import {
  authenticate,
  buildSessionCookie,
  canWriteConfig,
  clearSessionCookie,
  clientIp,
  createSessionToken,
  getSessionFromRequest,
  hasConfiguredLocalUsers,
  isRoleAllowed,
  loginThrottleCheck,
  loginThrottleFail,
  loginThrottleReset,
} from "./server/auth.mjs";
import { evaluateApiAccess } from "./server/api-access.mjs";
import {
  attachChannelKey,
  deleteChannelApiKey,
  findDuplicateChannel,
  loadChannels,
  maskChannel,
  migrateProfilesToChannelsIfEmpty,
  saveChannels,
} from "./server/channel-store.mjs";
import { loadModelTargets, saveModelTargets } from "./server/model-target-store.mjs";
import { modelTargetDedupKey, normalizeChannel, normalizeModelTarget } from "./server/channel-model.mjs";
import { loadRunnableProfiles } from "./server/run-targets.mjs";
import { buildImportPlan } from "./server/newapi-import.mjs";
import { fetchNewapiChannels, importSourceMode } from "./server/newapi-source.mjs";
import { pushModelTagsToNewapi, isNewapiTagWriterConfigured } from "./server/newapi-tag-writer.mjs";
import { pushChannelToNewapi, addModelToNewapiChannel, deleteNewapiChannel, removeModelFromNewapiChannel } from "./server/newapi-channel-sync.mjs";
import { getSettings, loadSettings, saveSettings } from "./server/settings-store.mjs";
import { withRunBy } from "./server/run-context.mjs";
import { APP_VERSION } from "./server/version.mjs";

const PORT = Number(process.env.API_PORT || process.env.PORT || 5180);
// 部署适配：绑定地址可配（容器内需 0.0.0.0；默认仍 127.0.0.1，本地行为不变）
const HOST = process.env.HOST || process.env.API_HOST || "127.0.0.1";
const taskManager = createTaskManager({
  taskEventsFile: TASK_EVENTS_FILE,
  runStabilityTest,
  runBatchAdmissionTest,
  runBatchStabilityTest,
  runScenarioTest,
  normalizeProfileIds,
  normalizeScenarioIds,
  errorLogFile: ERROR_LOG_FILE,
  logTechnicalError,
  buildUserErrorMessage,
});

await ensureDataDir();
await loadSettings(); // 暖运行时设置缓存（AI 总结模型 / LiveBench / 安全题开关）
await pruneReportsOnStartup();

// 「删除同步至 new-api」公共逻辑：best-effort 调 action(newapiChannelId)，结果并入 DELETE 响应。
// 任何失败都不影响已完成的本地删除，只在响应里说明同步结果，供前端 toast。
async function syncNewapiDelete(wantSync, newapiChannelId, action) {
  if (!wantSync) return {};
  if (!isNewapiTagWriterConfigured()) {
    return { newapiSynced: false, newapiSkipped: "未配置 new-api，已仅删除本地。" };
  }
  if (!newapiChannelId) {
    return { newapiSynced: false, newapiSkipped: "该渠道未推送到 new-api，已仅删除本地。" };
  }
  try {
    await action(newapiChannelId);
    return { newapiSynced: true };
  } catch (error) {
    return { newapiSynced: false, newapiError: error.message };
  }
}

createServer(async (req, res) => {
  try {
    if (req.url?.startsWith("/api/")) {
      if (!isAllowedBrowserOrigin(req.headers.origin)) {
        sendJson(res, 403, {
          error: "forbidden_origin",
          userMessage: "请求来源不被允许。请从本工具窗口内操作。",
        });
        return;
      }
      // 把当前登录者带入记账上下文，底层 recordRequest/recordTestRun 据此写 run_by
      const runBy = getSessionFromRequest(req)?.username || null;
      await withRunBy(runBy, () => handleApi(req, res));
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    if (error instanceof HttpRequestError) {
      sendJson(res, error.status, {
        error: error.code,
        userMessage: error.userMessage,
      });
      return;
    }

    const errorId = await logErrorSafely({
      source: "server",
      error,
      context: {
        method: req.method,
        url: req.url,
      },
    });
    sendJson(res, 500, {
      error: "internal_error",
      userMessage: buildUserErrorMessage(errorId),
      errorId,
    });
  }
}).listen(PORT, HOST, () => {
  console.log(`模型评测平台: http://${HOST}:${PORT}`);
  // 一次性迁移：老 profile → 渠道 + 模型目标（仅当渠道为空且有老配置时；best-effort，不阻塞启动）。
  migrateProfilesToChannelsIfEmpty()
    .then((r) => {
      if (r?.migrated) console.log(`已迁移 ${r.migrated} 个渠道 / ${r.targets} 个模型目标。`);
    })
    .catch(() => {});
  const backend = (process.env.EVALUATOR_AUTH_BACKEND || "local").toLowerCase();
  if (backend !== "newapi" && backend !== "new-api" && !hasConfiguredLocalUsers()) {
    console.warn(
      "[auth] 登录后端=local 但未配置任何账号：请设置 EVALUATOR_ADMIN_PASSWORD（或 EVALUATOR_LOCAL_USERS），否则无法登录。",
    );
  }
});

async function handleApi(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === "OPTIONS") {
    sendJson(res, 204, { ok: true });
    return;
  }

  // —— 登录端点（公开，免会话）——
  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    await handleLogin(req, res);
    return;
  }

  // —— 鉴权中间件：白名单外一律需有效会话；配置/平台级额外要求超管（判定见 api-access.mjs）——
  const access = evaluateApiAccess({
    method: req.method,
    pathname: url.pathname,
    session: getSessionFromRequest(req),
  });
  if (!access.allow) {
    sendJson(res, access.status, { error: access.error, userMessage: access.userMessage });
    return;
  }
  if (access.session) req.session = access.session;

  // —— 登出 / 当前用户 ——
  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    res.setHeader("Set-Cookie", clearSessionCookie());
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    sendJson(res, 200, {
      user: {
        username: req.session.username,
        role: req.session.role,
        canConfig: canWriteConfig(req.session.role),
      },
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      service: "evaluator-api",
      pid: process.pid,
      proxyEnvDetected: hasProxyEnv(),
      safetyScenariosEnabled: getTestScenarios().some((scenario) => scenario.category === "safety"),
      version: APP_VERSION,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/client-errors") {
    const body = await readJson(req);
    const errorId = await logTechnicalError(ERROR_LOG_FILE, {
      source: "client",
      error: body.message || body.error || "client_error",
      context: {
        page: body.page || "",
        kind: body.kind || "",
        stack: body.stack || "",
        details: body.details || {},
      },
    });
    sendJson(res, 200, { ok: true, errorId });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/client-logs/analyze") {
    const body = await readJson(req);
    const records = extractClientLogRecords(body);
    if (!records.length) {
      sendJson(res, 400, {
        error: "empty_client_logs",
        message: "没有解析到可分析的客户端日志。请传入 records 数组或 JSONL/文本日志。",
      });
      return;
    }
    const runId = `client-replay-${compactDate(new Date())}`;
    const summary = analyzeClientLogs(records, {
      runId,
      sourceName: body.sourceName || body.fileName || "客户端代理日志",
    });
    const artifactFiles = await saveRunArtifacts(runId, {
      summary: {
        ...summary,
        records: undefined,
      },
      records: summary.records,
    });
    summary.workspaceDir = artifactFiles.workspaceDir;
    summary.rawJsonPath = artifactFiles.rawJsonPath;
    const reportMarkdown = formatClientReplayReport(summary);
    const reportFiles = await saveReportFiles(runId, reportMarkdown, "真实客户端日志分析报告");
    const { records: normalizedRecords, ...safeSummary } = summary;
    await appendJsonLine(TEST_RUNS_FILE, {
      ...safeSummary,
      reportPath: reportFiles.markdownPath,
      reportHtmlPath: reportFiles.htmlPath,
    });
    sendJson(res, 200, {
      ...safeSummary,
      recordCount: normalizedRecords.length,
      reportPath: reportFiles.markdownPath,
      reportHtmlPath: reportFiles.htmlPath,
      reportMarkdown,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/client-logs/import-directory") {
    const body = await readJson(req);
    const imported = await readClientLogDirectory(body.directoryPath, {
      maxFiles: body.maxFiles,
      recursive: body.recursive,
    });
    sendJson(res, 200, imported);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/client-logs/replay-candidates") {
    const body = await readJson(req);
    const candidates = extractReplayCandidates(body);
    sendJson(res, 200, {
      count: candidates.length,
      candidates,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/client-logs/replay-batch") {
    const body = await readJson(req);
    const profileId = requiredString(body.profileId, "被测 API");
    const profiles = await loadRunnableProfiles();
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) {
      sendJson(res, 404, { error: "profile_not_found", message: "没有找到被测 API 配置。" });
      return;
    }
    const candidates = extractReplayCandidates(body);
    if (!candidates.length) {
      sendJson(res, 400, {
        error: "empty_replay_candidates",
        message: "没有找到可批量回放的请求。请确认日志里包含 request.body 或 body 字段。",
      });
      return;
    }
    const replayLimit = normalizeReplayLimit(body.maxReplayCount);
    const runId = `client-replay-batch-${compactDate(new Date())}`;
    const selectedCandidates = candidates.slice(0, replayLimit);
    const replayRecords = [];
    for (const [index, candidate] of selectedCandidates.entries()) {
      const replayRecord = await runClientReplay(profile, {
        ...body,
        request: candidate.request,
        requestId: `${runId}-${index + 1}`,
      });
      replayRecords.push(replayRecord);
    }
    const summary = analyzeClientLogs(replayRecords, {
      runId,
      sourceName: body.sourceName || `批量真实客户端请求回放 / ${profile.name}`,
    });
    summary.replayCandidateCount = candidates.length;
    summary.replayedCount = replayRecords.length;
    summary.replayLimit = replayLimit;
    // 审计：批量回放真实消耗上游额度，明确记录触发人 / 消费标记。
    summary.triggeredBy = req.session?.username || null;
    summary.spendIncurred = true;
    const artifactFiles = await saveRunArtifacts(runId, {
      summary: {
        ...summary,
        records: undefined,
      },
      candidates: selectedCandidates,
      records: summary.records,
    });
    summary.workspaceDir = artifactFiles.workspaceDir;
    summary.rawJsonPath = artifactFiles.rawJsonPath;
    const reportMarkdown = formatClientReplayReport(summary);
    const reportFiles = await saveReportFiles(runId, reportMarkdown, "批量真实客户端请求回放报告");
    const { records: normalizedRecords, ...safeSummary } = summary;
    await appendJsonLine(TEST_RUNS_FILE, {
      ...safeSummary,
      reportPath: reportFiles.markdownPath,
      reportHtmlPath: reportFiles.htmlPath,
    });
    sendJson(res, 200, {
      ...safeSummary,
      recordCount: normalizedRecords.length,
      reportPath: reportFiles.markdownPath,
      reportHtmlPath: reportFiles.htmlPath,
      reportMarkdown,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/client-logs/supplier-evidence") {
    const body = await readJson(req);
    const records = extractClientLogRecords(body);
    if (!records.length) {
      sendJson(res, 400, {
        error: "empty_client_logs",
        message: "没有解析到可生成证据包的客户端日志。请传入 records 数组或 JSONL/文本日志。",
      });
      return;
    }
    const runId = `supplier-evidence-${compactDate(new Date())}`;
    const evidence = buildSupplierEvidence(records, {
      runId,
      sourceName: body.sourceName || body.fileName || "客户端代理日志",
      providerName: body.providerName || "上游服务商",
    });
    const artifactFiles = await saveRunArtifacts(runId, {
      evidence,
    });
    evidence.workspaceDir = artifactFiles.workspaceDir;
    evidence.rawJsonPath = artifactFiles.rawJsonPath;
    const reportMarkdown = formatSupplierEvidenceReport(evidence);
    const reportFiles = await saveReportFiles(runId, reportMarkdown, `${evidence.providerName} 异常排查证据包`);
    await appendJsonLine(TEST_RUNS_FILE, {
      ...evidence,
      reportPath: reportFiles.markdownPath,
      reportHtmlPath: reportFiles.htmlPath,
    });
    sendJson(res, 200, {
      ...evidence,
      reportPath: reportFiles.markdownPath,
      reportHtmlPath: reportFiles.htmlPath,
      reportMarkdown,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/client-logs/replay") {
    const body = await readJson(req);
    const profileId = requiredString(body.profileId, "被测 API");
    const profiles = await loadRunnableProfiles();
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) {
      sendJson(res, 404, { error: "profile_not_found", message: "没有找到被测 API 配置。" });
      return;
    }
    const runId = `client-replay-${compactDate(new Date())}`;
    const record = await runClientReplay(profile, {
      ...body,
      requestId: runId,
    });
    const summary = analyzeClientLogs([record], {
      runId,
      sourceName: body.sourceName || `真实客户端请求回放 / ${profile.name}`,
    });
    const artifactFiles = await saveRunArtifacts(runId, {
      summary: {
        ...summary,
        records: undefined,
      },
      records: summary.records,
    });
    summary.workspaceDir = artifactFiles.workspaceDir;
    summary.rawJsonPath = artifactFiles.rawJsonPath;
    // 审计：回放会真实消耗上游额度，明确记录触发人 / 消费标记 / 回放次数。
    summary.triggeredBy = req.session?.username || null;
    summary.spendIncurred = true;
    summary.replayedCount = summary.records?.length || 1;
    const reportMarkdown = formatClientReplayReport(summary);
    const reportFiles = await saveReportFiles(runId, reportMarkdown, "真实客户端请求回放报告");
    const { records: normalizedRecords, ...safeSummary } = summary;
    await appendJsonLine(TEST_RUNS_FILE, {
      ...safeSummary,
      reportPath: reportFiles.markdownPath,
      reportHtmlPath: reportFiles.htmlPath,
    });
    sendJson(res, 200, {
      ...safeSummary,
      recordCount: normalizedRecords.length,
      reportPath: reportFiles.markdownPath,
      reportHtmlPath: reportFiles.htmlPath,
      reportMarkdown,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/profiles") {
    const profiles = await loadProfiles();
    sendJson(res, 200, profiles.map(maskProfile));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/profiles/export") {
    const profiles = await loadProfiles();
    sendJson(res, 200, {
      exportedAt: new Date().toISOString(),
      version: 1,
      profiles: profiles.map(exportProfile),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/scenarios") {
    sendJson(res, 200, getTestScenarios().map(maskScenario));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/profiles") {
    const body = await readJson(req);
    const profiles = await loadProfiles();
    const existing = profiles.find((item) => item.id === body.id);
    // 查重：URL + 模型名 + Key 三者全一致视为同一渠道，拒绝重复添加（在写入前判，避免产生孤儿 vault 记录）。
    const candidateKeyHash = body.apiKey ? hashApiKey(body.apiKey) : existing?.keyHash || null;
    const duplicate = await findDuplicateProfile(profiles, {
      id: body.id || "",
      baseUrl: body.baseUrl,
      defaultModel: body.defaultModel,
      keyHash: candidateKeyHash,
    });
    if (duplicate) {
      sendJson(res, 409, {
        error: "duplicate_profile",
        userMessage: `已存在相同渠道（Base URL + Key + 模型名 完全一致）：「${duplicate.name}」，未重复添加。`,
      });
      return;
    }
    const profile = await normalizeProfile(body, existing);
    const index = profiles.findIndex((item) => item.id === profile.id);
    if (index >= 0) {
      profiles[index] = profile;
    } else {
      profiles.push(profile);
    }
    await saveProfiles(profiles);
    sendJson(res, 200, maskProfile(profile));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/profiles/import") {
    const body = await readJson(req);
    const profiles = await loadProfiles();
    const importedProfiles = await normalizeImportedProfiles(body, profiles);
    // 判重：URL+Key+模型名全一致的（与既有渠道或同批已接受项）跳过，不重复添加。
    // 仅当导入项带 Key（有 keyHash）才能确认重复；无 Key 的导入按 id 合并（mergeProfiles 处理）。
    const accepted = [];
    let skippedDuplicates = 0;
    for (const candidate of importedProfiles) {
      const dup = await findDuplicateProfile([...profiles, ...accepted], candidate);
      if (dup) {
        skippedDuplicates += 1;
        continue;
      }
      accepted.push(candidate);
    }
    const merged = mergeProfiles(profiles, accepted);
    await saveProfiles(merged);
    sendJson(res, 200, { ok: true, imported: accepted.length, skippedDuplicates, total: merged.length });
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/profiles/")) {
    const id = decodeURIComponent(url.pathname.replace("/api/profiles/", ""));
    const profiles = await loadProfiles();
    const profile = profiles.find((item) => item.id === id);
    if (profile) {
      await deleteProfileApiKey(profile);
    }
    await saveProfiles(profiles.filter((profile) => profile.id !== id));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/profiles/") && url.pathname.endsWith("/key")) {
    const id = decodeURIComponent(url.pathname.replace("/api/profiles/", "").replace("/key", ""));
    const body = await readJson(req);
    const apiKey = requiredString(body.apiKey, "API Key");
    const profiles = await loadProfiles();
    const index = profiles.findIndex((profile) => profile.id === id);
    if (index < 0) {
      sendJson(res, 404, { error: "profile_not_found", message: "没有找到 API 配置。" });
      return;
    }
    const keyInfo = await saveProfileApiKey(id, apiKey);
    profiles[index] = {
      ...profiles[index],
      apiKeyRef: keyInfo.ref,
      keyStorage: keyInfo.storage,
      hasKey: true,
      updatedAt: new Date().toISOString(),
    };
    await saveProfiles(profiles);
    sendJson(res, 200, maskProfile(profiles[index]));
    return;
  }

  // —— v0.3.0 渠道管理（连接 url + key + 协议，超管维护、持 key）——
  if (req.method === "GET" && url.pathname === "/api/channels") {
    const channels = await loadChannels();
    sendJson(res, 200, channels.map(maskChannel));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/channels") {
    const body = await readJson(req);
    const channels = await loadChannels();
    const existing = channels.find((item) => item.id === body.id);
    let channel = normalizeChannel(body, existing);
    if (body.apiKey) {
      channel = await attachChannelKey(channel, body.apiKey);
    } else if (existing) {
      channel = { ...channel, apiKeyRef: existing.apiKeyRef, keyStorage: existing.keyStorage, hasKey: existing.hasKey, keyHash: existing.keyHash };
    }
    const duplicate = await findDuplicateChannel(channels, channel);
    if (duplicate && duplicate.id !== channel.id) {
      sendJson(res, 409, { error: "duplicate_channel", userMessage: `已存在相同渠道（Base URL + Key 一致）：「${duplicate.name}」。` });
      return;
    }
    const index = channels.findIndex((item) => item.id === channel.id);
    if (index >= 0) channels[index] = channel;
    else channels.push(channel);
    await saveChannels(channels);
    sendJson(res, 200, maskChannel(channel));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/channels/import") {
    let rows;
    try {
      rows = await fetchNewapiChannels();
    } catch (error) {
      sendJson(res, 400, { error: "import_source_error", userMessage: error.message });
      return;
    }
    const [existingChannels, existingTargets] = await Promise.all([loadChannels(), loadModelTargets()]);
    const plan = buildImportPlan({ rows, existingChannels, existingTargets });
    // 明文 key（仅 A2/DB 模式带）立刻存进加密库、从渠道对象剥离；A1/API 无 key，导入后需手动补。
    const indexById = new Map(plan.channels.map((item, i) => [item.id, i]));
    for (const [channelId, key] of Object.entries(plan.keys)) {
      const i = indexById.get(channelId);
      if (i !== undefined) plan.channels[i] = await attachChannelKey(plan.channels[i], key);
    }
    await saveChannels(plan.channels);
    await saveModelTargets(plan.targets);
    sendJson(res, 200, { ok: true, mode: importSourceMode(), ...plan.summary });
    return;
  }
  if (req.method === "POST" && /^\/api\/channels\/.+\/sync-models$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.replace("/api/channels/", "").replace("/sync-models", ""));
    const channels = await loadChannels();
    const channel = channels.find((item) => item.id === id);
    if (!channel) {
      sendJson(res, 404, { error: "channel_not_found", userMessage: "没有找到该渠道。" });
      return;
    }
    if (!channel.newapiChannelId) {
      sendJson(res, 400, { error: "not_newapi_channel", userMessage: "该渠道不是从 new-api 导入的，无法同步模型。手动渠道请在“模型管理”里直接加模型。" });
      return;
    }
    let rows;
    try {
      rows = await fetchNewapiChannels();
    } catch (error) {
      sendJson(res, 400, { error: "import_source_error", userMessage: error.message });
      return;
    }
    const row = rows.find((r) => Number(r.id) === Number(channel.newapiChannelId));
    if (!row) {
      sendJson(res, 404, { error: "newapi_channel_gone", userMessage: "new-api 里已找不到该渠道（可能已删除）。" });
      return;
    }
    // 只同步这一个渠道：buildImportPlan 只喂这一行，upsert 它的渠道 + 模型目标，其余不动。
    const existingTargets = await loadModelTargets();
    const plan = buildImportPlan({ rows: [row], existingChannels: channels, existingTargets });
    const indexById = new Map(plan.channels.map((item, i) => [item.id, i]));
    for (const [channelId, key] of Object.entries(plan.keys)) {
      const i = indexById.get(channelId);
      if (i !== undefined) plan.channels[i] = await attachChannelKey(plan.channels[i], key);
    }
    await saveChannels(plan.channels);
    await saveModelTargets(plan.targets);
    sendJson(res, 200, { ok: true, newTargets: plan.summary.newTargets });
    return;
  }
  if (req.method === "POST" && /^\/api\/channels\/.+\/push-to-newapi$/.test(url.pathname)) {
    // 把本平台渠道（含上游 Key + models 列表）推送到 new-api：新建或更新已关联渠道。
    const id = decodeURIComponent(url.pathname.replace("/api/channels/", "").replace("/push-to-newapi", ""));
    const channels = await loadChannels();
    const channel = channels.find((item) => item.id === id);
    if (!channel) {
      sendJson(res, 404, { error: "channel_not_found", userMessage: "没有找到该渠道。" });
      return;
    }
    if (!isNewapiTagWriterConfigured()) {
      sendJson(res, 400, { error: "newapi_not_configured", userMessage: "未配置 new-api（在 .env.evaluator 填 EVALUATOR_NEWAPI_BASE_URL + 系统访问令牌）。" });
      return;
    }
    const key = await readProfileApiKey(channel);
    if (!key) {
      sendJson(res, 400, { error: "missing_key", userMessage: "该渠道未保存上游 Key，无法在 new-api 建渠道。请先在渠道里更新 Key。" });
      return;
    }
    try {
      const result = await pushChannelToNewapi(channel, key);
      // 回存 new-api 渠道 id，便于后续“模型推送/渠道更新”定位。
      if (result.newapiChannelId && channel.newapiChannelId !== result.newapiChannelId) {
        const idx = channels.findIndex((item) => item.id === channel.id);
        if (idx >= 0) {
          channels[idx] = { ...channel, newapiChannelId: result.newapiChannelId };
          await saveChannels(channels);
        }
      }
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 502, { error: "newapi_push_failed", userMessage: error.message });
    }
    return;
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/channels/")) {
    const id = decodeURIComponent(url.pathname.replace("/api/channels/", ""));
    if (!id) {
      sendJson(res, 400, { error: "missing_id", userMessage: "缺少渠道 id。" });
      return;
    }
    const channels = await loadChannels();
    const channel = channels.find((item) => item.id === id);
    // 删本地前捕获 newapiChannelId（本地删后就拿不到了），供「删除同步至 new-api」用。
    const wantSync = url.searchParams.get("syncNewapi") === "1";
    const newapiChannelId = channel?.newapiChannelId || null;
    if (channel) await deleteChannelApiKey(channel);
    await saveChannels(channels.filter((item) => item.id !== id));
    // 级联删除该渠道下的模型目标，避免孤儿。
    const targets = await loadModelTargets();
    await saveModelTargets(targets.filter((target) => target.channelId !== id));
    // best-effort 同步删除 new-api 渠道：失败不影响本地删，结果并入响应。
    const sync = await syncNewapiDelete(wantSync, newapiChannelId, (cid) => deleteNewapiChannel(cid));
    sendJson(res, 200, { ok: true, ...sync });
    return;
  }

  // —— 运行时设置（AI 总结模型 / 场景测试题库开关；脱离环境变量）——
  if (req.method === "GET" && url.pathname === "/api/settings") {
    sendJson(res, 200, getSettings());
    return;
  }
  if (req.method === "PUT" && url.pathname === "/api/settings") {
    const next = await saveSettings(await readJson(req));
    sendJson(res, 200, next);
    return;
  }

  // —— v0.3.0 模型目标管理（选渠道 + 填模型，管理员维护、看不到 key）——
  if (req.method === "GET" && url.pathname === "/api/model-targets") {
    const [targets, channels] = await Promise.all([loadModelTargets(), loadChannels()]);
    const byChannel = new Map(channels.map((item) => [item.id, item]));
    sendJson(
      res,
      200,
      targets.map((target) => {
        const channel = byChannel.get(target.channelId);
        return {
          ...target,
          channelName: channel?.name || "(渠道已删除)",
          channelStatus: channel?.status || "missing",
          protocol: channel?.protocol || null,
        };
      }),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/model-targets/push-tags") {
    // 把本平台已授予的模型标签推送到 new-api 模型广场。按模型名聚合（同名多渠道目标取并集）。
    const targets = await loadModelTargets();
    const tagSets = {};
    for (const t of targets) {
      const tags = Array.isArray(t.tags) ? t.tags : [];
      if (!t.model || !tags.length) continue;
      (tagSets[t.model] ||= new Set());
      tags.forEach((x) => tagSets[t.model].add(x));
    }
    const tagMap = Object.fromEntries(Object.entries(tagSets).map(([k, v]) => [k, [...v]]));
    if (!Object.keys(tagMap).length) {
      sendJson(res, 200, { configured: true, totalModels: 0, matched: 0, updated: 0, unchanged: 0, errors: [], note: "没有已授予标签的模型可推送（先跑场景测试得到标签）。" });
      return;
    }
    try {
      const summary = await pushModelTagsToNewapi(tagMap);
      if (summary.configured === false) {
        sendJson(res, 400, { error: "newapi_not_configured", userMessage: summary.error });
        return;
      }
      sendJson(res, 200, summary);
    } catch (error) {
      sendJson(res, 502, { error: "newapi_push_failed", userMessage: error.message });
    }
    return;
  }
  if (req.method === "POST" && /^\/api\/model-targets\/[^/]+\/push-to-newapi$/.test(url.pathname)) {
    // 把该模型名并入其渠道在 new-api 的 models 列表（让模型可被调用）。需渠道已推送到 new-api。
    const id = decodeURIComponent(url.pathname.split("/")[3]);
    const targets = await loadModelTargets();
    const target = targets.find((item) => item.id === id);
    if (!target) {
      sendJson(res, 404, { error: "target_not_found", userMessage: "没有找到该模型目标。" });
      return;
    }
    if (!isNewapiTagWriterConfigured()) {
      sendJson(res, 400, { error: "newapi_not_configured", userMessage: "未配置 new-api（在 .env.evaluator 填 EVALUATOR_NEWAPI_BASE_URL + 系统访问令牌）。" });
      return;
    }
    const channels = await loadChannels();
    const channel = channels.find((item) => item.id === target.channelId);
    if (!channel) {
      sendJson(res, 404, { error: "channel_not_found", userMessage: "该模型所属渠道不存在。" });
      return;
    }
    if (!channel.newapiChannelId) {
      sendJson(res, 400, { error: "channel_not_pushed", userMessage: "请先在“渠道管理”把该模型所属渠道「推送到 new-api」。" });
      return;
    }
    try {
      const result = await addModelToNewapiChannel(channel.newapiChannelId, target.model);
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 502, { error: "newapi_push_failed", userMessage: error.message });
    }
    return;
  }
  if (req.method === "POST" && /^\/api\/model-targets\/[^/]+\/remove-tag$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.split("/")[3]);
    const { tag } = await readJson(req);
    const targets = await loadModelTargets();
    const target = targets.find((item) => item.id === id);
    if (!target) {
      sendJson(res, 404, { error: "not_found", userMessage: "模型目标不存在。" });
      return;
    }
    target.tags = (Array.isArray(target.tags) ? target.tags : []).filter((t) => t !== tag);
    target.updatedAt = new Date().toISOString();
    await saveModelTargets(targets);
    sendJson(res, 200, { ok: true, tags: target.tags });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/model-targets") {
    const body = await readJson(req);
    const targets = await loadModelTargets();
    const existing = targets.find((item) => item.id === body.id);
    const target = normalizeModelTarget(body, existing);
    const channels = await loadChannels();
    if (!channels.some((item) => item.id === target.channelId)) {
      sendJson(res, 400, { error: "channel_not_found", userMessage: "所选渠道不存在，请先在渠道管理里配置。" });
      return;
    }
    const dupKey = modelTargetDedupKey(target);
    const duplicate = targets.find((item) => item.id !== target.id && modelTargetDedupKey(item) === dupKey);
    if (duplicate) {
      sendJson(res, 409, { error: "duplicate_model_target", userMessage: "该渠道下已存在同名模型测试目标。" });
      return;
    }
    const index = targets.findIndex((item) => item.id === target.id);
    if (index >= 0) targets[index] = target;
    else targets.push(target);
    await saveModelTargets(targets);
    sendJson(res, 200, target);
    return;
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/model-targets/")) {
    const id = decodeURIComponent(url.pathname.replace("/api/model-targets/", ""));
    const targets = await loadModelTargets();
    const target = targets.find((item) => item.id === id);
    // 删本地前定位所属渠道的 newapiChannelId 与模型名，供「删除同步」从 new-api 渠道 models 移除。
    const wantSync = url.searchParams.get("syncNewapi") === "1";
    let newapiChannelId = null;
    const modelName = target?.model || "";
    if (wantSync && target) {
      const channel = (await loadChannels()).find((c) => c.id === target.channelId);
      newapiChannelId = channel?.newapiChannelId || null;
    }
    await saveModelTargets(targets.filter((item) => item.id !== id));
    const sync = await syncNewapiDelete(wantSync, newapiChannelId, (cid) => removeModelFromNewapiChannel(cid, modelName));
    sendJson(res, 200, { ok: true, ...sync });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tests/quick") {
    const body = await readJson(req);
    const result = await runQuickTest(body.profileId, body.prompt || "");
    sendJson(res, 200, result);
    return;
  }

  // 轻量快检：真伪 + token 虚报 + 真实消耗，少量探针、输出封顶、成本可控
  if (req.method === "POST" && url.pathname === "/api/tests/quick-verify") {
    const body = await readJson(req);
    const result = await runQuickVerify(body);
    openReportInBrowser(result.reportHtmlPath);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tests/admission") {
    const body = await readJson(req);
    const result = await runAdmissionTest(body);
    openReportInBrowser(result.reportHtmlPath);
    openReportInBrowser(result.aiAnalysisHtmlPath); // AI 辅助分析独立成文，存在时一并打开
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tests/batch-admission") {
    const body = await readJson(req);
    const result = await runBatchAdmissionTest(body);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tests/stability") {
    const body = await readJson(req);
    const result = await runStabilityTest(body);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tests/batch-stability") {
    const body = await readJson(req);
    const result = await runBatchStabilityTest(body);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tests/scenario") {
    const body = await readJson(req);
    const result = await runScenarioTest(body);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tasks") {
    const body = await readJson(req);
    const task = await taskManager.createTask(body.type, body.payload || {});
    sendJson(res, 202, taskManager.publicTask(task));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/tasks/recent") {
    sendJson(res, 200, await readRecentTasks(taskManager.tasks, taskManager.publicTask));
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/tasks/")) {
    const taskId = decodeURIComponent(url.pathname.replace("/api/tasks/", "").replace("/cancel", ""));
    const task = taskManager.getTask(taskId);
    if (!task) {
      sendJson(res, 404, { error: "task_not_found", message: "没有找到测试任务。" });
      return;
    }
    sendJson(res, 200, taskManager.publicTask(task));
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/tasks/") && url.pathname.endsWith("/cancel")) {
    const taskId = decodeURIComponent(url.pathname.replace("/api/tasks/", "").replace("/cancel", ""));
    const task = taskManager.getTask(taskId);
    if (!task) {
      sendJson(res, 404, { error: "task_not_found", message: "没有找到测试任务。" });
      return;
    }
    await taskManager.cancelTask(task);
    sendJson(res, 200, taskManager.publicTask(task));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/requests/recent") {
    sendJson(res, 200, await readRecentRequests());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/test-runs/recent") {
    sendJson(res, 200, await readRecentTestRuns());
    return;
  }

  // 报告中心元数据列表（全平台共享，登录可读）
  if (req.method === "GET" && url.pathname === "/api/reports") {
    sendJson(res, 200, await queryRecentReports(200));
    return;
  }

  // 在浏览器里查看一份报告 HTML（Docker/远程部署看报告的正路：应用内浮层 iframe 或新标签页打开）。
  // 鉴权同其它 /api/*（已登录即可读）。文件名经 sanitizeReportBaseName 防目录穿越；报告为纯静态
  // HTML+CSS、无脚本，再叠加 nosniff + 禁脚本 CSP，直开标签页也无 XSS 面。
  if (req.method === "GET" && /^\/api\/reports\/[^/]+\/view$/.test(url.pathname)) {
    const id = sanitizeReportBaseName(decodeURIComponent(url.pathname.split("/")[3]));
    try {
      const html = await readFile(join(REPORTS_DIR, `${id}.html`), "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'",
        "Cache-Control": "no-store",
      });
      res.end(html);
    } catch {
      sendJson(res, 404, { error: "report_not_found", userMessage: "报告不存在或已被清理。" });
    }
    return;
  }

  // 单渠道趋势 + 基线回归 + 告警（?profileId=...）
  if (req.method === "GET" && url.pathname === "/api/trend") {
    const profileId = url.searchParams.get("profileId") || "";
    if (!profileId) {
      sendJson(res, 400, { error: "missing_profile", userMessage: "请提供 profileId。" });
      return;
    }
    const history = await queryProfileRunSummaries(profileId, { limit: 200 });
    const series = buildTrendSeries(history);
    const latest = series[series.length - 1] || null;
    const regression = latest ? detectRegression({ current: latest, history: series }) : null;
    const alerts = await queryRegressionAlerts({ profileId, limit: 50 });
    sendJson(res, 200, { profileId, series, regression, alerts });
    return;
  }

  // 最近回归告警（全渠道；?limit=N）
  if (req.method === "GET" && url.pathname === "/api/alerts") {
    const limit = Number(url.searchParams.get("limit")) || 50;
    sendJson(res, 200, await queryRegressionAlerts({ limit }));
    return;
  }

  // 累计测试真实消耗（成本可观测；?days=N 限定窗口，?mine=1 仅本人）
  if (req.method === "GET" && url.pathname === "/api/spend") {
    const days = Number(url.searchParams.get("days"));
    const sinceMs = Number.isFinite(days) && days > 0 ? Date.now() - days * 24 * 3600 * 1000 : undefined;
    const runBy = url.searchParams.get("mine") === "1" ? req.session?.username : undefined;
    sendJson(res, 200, (await querySpendSummary({ runBy, sinceMs })) || { runs: 0, totalActualCost: 0, totalEstimatedCost: 0, currency: "USD" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/support-bundle") {
    const profiles = await loadProfiles();
    const requests = await readRecentRequests();
    const testRuns = await readRecentTestRuns();
    const tasks = await readRecentTasks(taskManager.tasks, taskManager.publicTask);
    const errors = await readRecentErrors();
    const storage = getDbHealth();
    sendJson(res, 200, buildSupportBundle({ profiles, requests, testRuns, tasks, errors, storage }));
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

async function pruneReportsOnStartup() {
  try {
    const removed = await pruneReports({
      retentionDays: Number(process.env.EVALUATOR_REPORT_RETENTION_DAYS || 30),
      maxTotal: Number(process.env.EVALUATOR_REPORT_MAX_TOTAL || 2000),
    });
    for (const report of removed) {
      for (const filePath of [report.pathMd, report.pathHtml]) {
        if (filePath) await rm(filePath, { force: true }).catch(() => {});
      }
    }
    if (removed.length) {
      console.log(`[reports] 已清理 ${removed.length} 份过期/超量报告`);
    }
  } catch {
    // 清理失败不应阻断启动
  }
}

async function logErrorSafely(entry) {
  try {
    return await logTechnicalError(ERROR_LOG_FILE, entry);
  } catch (error) {
    console.error("failed to write technical error log", error);
    return "err-log-write-failed";
  }
}

function normalizeReplayLimit(value) {
  const number = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(number)) return 3;
  return Math.min(10, Math.max(1, number));
}

// 配置类 / 平台级端点需 role=100：写 profiles（POST/DELETE/key）与 support-bundle（含全局数据）
// 登录：账密仅内存转发给鉴权后端校验，绝不落盘、绝不入日志
async function handleLogin(req, res) {
  const body = await readJson(req);
  const username = requiredString(body.username, "用户名");
  const password = requiredString(body.password, "密码");
  const throttleKey = `${clientIp(req)}|${username}`;
  const throttle = loginThrottleCheck(throttleKey);
  if (throttle.blocked) {
    sendJson(res, 429, {
      error: "too_many_attempts",
      userMessage: `登录尝试过多，请约 ${Math.ceil(throttle.retryAfterMs / 1000)} 秒后再试。`,
    });
    return;
  }
  let result;
  try {
    result = await authenticate(username, password);
  } catch {
    sendJson(res, 502, { error: "auth_upstream_error", userMessage: "登录服务暂时不可用，请稍后再试。" });
    return;
  }
  if (!result.ok) {
    loginThrottleFail(throttleKey);
    sendJson(res, 401, { error: "bad_credentials", userMessage: "用户名或密码错误。" });
    return;
  }
  if (!isRoleAllowed(result.user.role)) {
    loginThrottleFail(throttleKey);
    sendJson(res, 403, { error: "role_not_allowed", userMessage: "该账号无权使用评测平台（需管理员及以上）。" });
    return;
  }
  loginThrottleReset(throttleKey);
  const token = createSessionToken(result.user);
  res.setHeader("Set-Cookie", buildSessionCookie(token));
  sendJson(res, 200, {
    ok: true,
    user: { username: result.user.username, role: result.user.role, canConfig: canWriteConfig(result.user.role) },
  });
}

async function serveStatic(req, res) {
  const rawPathname = getRawRequestPathname(req.url);
  const requestedPath = rawPathname === "/" ? "/index.html" : rawPathname;
  const staticPath = resolveRequestPathInside(STATIC_ROOT, requestedPath);
  if (!staticPath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const content = await readFile(staticPath);
    res.writeHead(200, {
      "content-type": MIME_TYPES[extname(staticPath)] || "application/octet-stream",
      ...staticSecurityHeaders(staticPath),
    });
    res.end(content);
    return;
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}
