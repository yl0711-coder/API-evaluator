import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { MIME_TYPES, getTestScenarios } from "./server/constants.mjs";
import { getAllScenariosForAdmin, loadScenarioOverrides, upsertScenario, deleteScenario, renameScenarioGroup, clearScenarioGroup } from "./server/scenarios/index.mjs";
import { DATA_DIR, ERROR_LOG_FILE, REPORTS_DIR, STATIC_ROOT, TASK_EVENTS_FILE, TEST_RUNS_FILE } from "./server/paths.mjs";
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
import { deleteProfileApiKey, saveProfileApiKey } from "./server/secret-store.mjs";
import { createTaskManager } from "./server/task-manager.mjs";
import { buildSupportBundle } from "./server/support-bundle.mjs";
import {
  closeDatabase,
  deleteReport,
  getDbHealth,
  pruneHistory,
  pruneReports,
  queryLastTestedByProfile,
  queryRecentReports,
  queryRegressionAlerts,
  querySpendSummary,
} from "./server/db.mjs";
import { buildProfileTrend } from "./server/trend-service.mjs";
import { formatAutoTestDigestReport } from "./server/auto-test-digest.mjs";
import {
  executeTestRequest,
  normalizeProfileIds,
  normalizeScenarioIds,
  runAdmissionTest,
  runBatchAdmissionTest,
  runBatchStabilityTest,
  runQuickTest,
  runQuickVerify,
  runScenarioTest,
  runStabilityTest,
  reportTargetSlug,
} from "./server/test-runner.mjs";
import { runLoadTest } from "./server/load-test.mjs";
import { buildAiAnalysisResult } from "./server/ai-report-analysis.mjs";
import {
  aggregateSubject,
  balanceCommonReports,
  buildComparison,
  buildCompareAnalysisPrompt,
  commonScenarioNames,
  formatCompareReportMarkdown,
  parseReportBaseName,
  pickRecentReports,
} from "./server/report-compare.mjs";
import { openReportInBrowser, reportIdFromHtmlPath, sanitizeReportBaseName } from "./server/report-files.mjs";
import { loadJobs, updateJobs, normalizeJob, validateJob, computeNextRunAt, JobValidationError } from "./server/auto-test-store.mjs";
import { createAutoTestScheduler } from "./server/auto-test-scheduler.mjs";
import { noteRunIfEnabled, listAlerts, ackAlert, ackAll } from "./server/high-risk-store.mjs";
import { getRawRequestPathname, resolveRequestPathInside } from "./server/static-paths.mjs";
import { appendJsonLine, compactDate, hasProxyEnv, requiredString, safeJson, sendJson } from "./server/utils.mjs";
import { saveRunArtifacts } from "./server/workspace-store.mjs";
import {
  authenticate,
  assertSessionSecretStrength,
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
import { migratePricingToTargetsOnce } from "./server/migrate-pricing.mjs";
import { modelTargetDedupKey, normalizeChannel, normalizeModelTarget } from "./server/channel-model.mjs";
import { loadRunnableProfiles } from "./server/run-targets.mjs";
import { buildImportPlan } from "./server/newapi-import.mjs";
import { fetchNewapiChannels, importSourceMode } from "./server/newapi-source.mjs";
import { readConfig as readNewapiConfig, loadNewapiToken, saveNewapiToken } from "./server/newapi-tag-writer.mjs";
import { getSettings, loadSettings, saveSettings, peekLegacyNewapiToken, stripLegacyNewapiToken } from "./server/settings-store.mjs";
import { withRunBy } from "./server/run-context.mjs";
import { createRouter } from "./server/router.mjs";
import { createRateLimiter } from "./server/rate-limit.mjs";
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
  runLoadTest,
  normalizeProfileIds,
  normalizeScenarioIds,
  errorLogFile: ERROR_LOG_FILE,
  logTechnicalError,
  buildUserErrorMessage,
  onRunComplete: (result) => noteRunIfEnabled(result), // 高危报告提示：手动测试完成时按开关判危记录
});

// 自动测试调度器（平台唯一的周期性定时器）：按各作业的 nextRunAt 到点直接调 runner 跑测试并产出报告。
const autoTestScheduler = createAutoTestScheduler({
  loadJobs,
  updateJobs,
  runners: { runQuickVerify, runAdmissionTest, runStabilityTest, runScenarioTest },
  reportIdFromHtmlPath,
  onRunComplete: (result) => noteRunIfEnabled(result), // 高危报告提示：自动测试完成时按开关判危记录
  logError: (error, job) =>
    logErrorSafely({ source: "auto-test-scheduler", error, context: { jobId: job?.id, kind: job?.kind, targetId: job?.targetId } }),
});

try {
  // 会话密钥强度门（P3-2）：弱密钥可被离线爆破后伪造超管会话。在 listen 前失败快，
  // 让「弱密钥」变成启动即拒，而不是线上默默可被伪造。
  assertSessionSecretStrength();
} catch (error) {
  console.error(`[启动失败] ${error?.message || error}`);
  process.exit(1);
}

try {
  await ensureDataDir();
} catch (error) {
  // 启动第一个碰 /data 卷的调用，且在 listen() 之前：卷只读挂载 / 属主 UID 不符 / 卷写满
  // 都会在此抛错，进程在绑定端口前退出，容器只见一坨堆栈、连 /api/health 都起不来。
  // 兜成可诊断的运维提示再退出，避免重启死循环时无从下手。
  console.error(`[启动失败] 无法初始化数据目录 ${DATA_DIR}：${error?.message || error}`);
  console.error("请检查 /data 卷是否已挂载、是否可写、属主 UID 是否匹配（常见：EACCES 权限不符 / EROFS 只读挂载 / ENOSPC 卷写满）。");
  process.exit(1);
}
await loadSettings(); // 暖运行时设置缓存（AI 总结模型 / LiveBench / 安全题开关）
await loadScenarioOverrides(); // 读回超管的场景编辑覆盖层（/data），合并到内置 bank 之上
// new-api 系统令牌走加密库：启动解密一次缓存进内存（readConfig 同步读）。
// 迁移旧版明文令牌：先写进加密库，再从 settings.json 抹除（顺序保证不丢令牌）。
const legacyNewapiToken = await peekLegacyNewapiToken();
await loadNewapiToken(legacyNewapiToken);
if (legacyNewapiToken) await stripLegacyNewapiToken();
await pruneReportsOnStartup();

// 「模型比对」共用：按文件名前缀收集两方在报告中心的报告，取最近若干份，再平衡为「双方共有」的报告集。
// 返回 { balA, balB }（已平衡的报告文件），或 { error, userMessage }（无报告 / 无共有报告）。
// 供 /api/reports/compare（生成对比）与 /api/reports/compare/scenarios（列出可选场景）共用。
async function loadBalancedCompareFiles(A, B) {
  let names = [];
  try {
    names = (await readdir(REPORTS_DIR)).filter((n) => n.toLowerCase().endsWith(".md"));
  } catch {
    /* 报告目录不存在 → 空 */
  }
  const collect = async (subject) => {
    // 候选前缀：当前名 + 曾用名(aliases)的笛卡尔组合，让改名前的历史报告也能被本模型认领。
    const channels = [subject.channel, ...(Array.isArray(subject.channelAliases) ? subject.channelAliases : [])].filter(Boolean);
    const models = [subject.model, ...(Array.isArray(subject.modelAliases) ? subject.modelAliases : [])].filter(Boolean);
    const prefixes = [...new Set(channels.flatMap((c) => models.map((m) => `${sanitizeReportBaseName(`${c}_${m}`)}_`)))];
    const metas = [];
    for (const name of names) {
      if (!prefixes.some((p) => name.startsWith(p))) continue;
      const base = name.replace(/\.md$/i, "");
      const type = parseReportBaseName(base).type;
      if (type !== "run" && type !== "admission" && type !== "scenario") continue;
      try {
        const st = await stat(join(REPORTS_DIR, name));
        metas.push({ base, type, mtimeMs: st.mtimeMs });
      } catch {
        /* 读不到 → 跳过 */
      }
    }
    metas.sort((x, y) => y.mtimeMs - x.mtimeMs);
    // 限流：稳定性/准入各取最近几份，场景最多取最近 60 份读盘（pickRecentReports 再按场景名去重取最新）。
    const chosen = [...metas.filter((m) => m.type !== "scenario").slice(0, 6), ...metas.filter((m) => m.type === "scenario").slice(0, 60)];
    const files = [];
    for (const m of chosen) {
      try {
        files.push({ name: m.base, md: await readFile(join(REPORTS_DIR, `${m.base}.md`), "utf8"), mtimeMs: m.mtimeMs });
      } catch {
        /* 读失败 → 跳过 */
      }
    }
    return files;
  };
  const [filesA, filesB] = await Promise.all([collect(A), collect(B)]);
  if (!filesA.length || !filesB.length) {
    const missing = [!filesA.length ? `${A.channel} / ${A.model}` : null, !filesB.length ? `${B.channel} / ${B.model}` : null].filter(Boolean);
    return { error: "no_reports", userMessage: `以下模型暂无可用于对比的报告：${missing.join("、")}。请先为其跑一次准入 / 稳定性 / 场景测试。` };
  }
  const [balA, balB] = balanceCommonReports(pickRecentReports(filesA), pickRecentReports(filesB));
  if (!balA.length || !balB.length) {
    return { error: "no_common_reports", userMessage: "两个对象没有可对比的共同报告：没有同名场景，稳定性 / 准入也未双方都有。请让两者至少跑一个相同的场景，或同一类测试。" };
  }
  return { balA, balB };
}

const httpServer = createServer(async (req, res) => {
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
  autoTestScheduler.start(); // 启动自动测试调度器（首个 tick 追补停机期间到期的作业）
  console.log("[auto-test] 自动测试调度器已启动");
  // 一次性迁移：老 profile → 渠道 + 模型目标（仅当渠道为空且有老配置时；best-effort，不阻塞启动）。
  migrateProfilesToChannelsIfEmpty()
    .then((r) => {
      if (r?.migrated) console.log(`已迁移 ${r.migrated} 个渠道 / ${r.targets} 个模型目标。`);
    })
    // 接着把「最大输出/超时/单价」从渠道下沉到模型目标（幂等；须在 profile→渠道迁移之后，以覆盖其新建的目标）。
    .then(() => migratePricingToTargetsOnce())
    .then((r) => {
      if (r?.migrated) console.log(`已把单价/参数下沉到 ${r.migrated} 个模型目标。`);
    })
    .catch(() => {});
  const backend = (process.env.EVALUATOR_AUTH_BACKEND || "local").toLowerCase();
  if (backend !== "newapi" && backend !== "new-api" && !hasConfiguredLocalUsers()) {
    console.warn(
      "[auth] 登录后端=local 但未配置任何账号：请设置 EVALUATOR_ADMIN_PASSWORD（或 EVALUATOR_LOCAL_USERS），否则无法登录。",
    );
  }
});

// —— 优雅停机 —— //
// 容器里 node 以 PID 1 运行、CMD 是 exec 形式，无 init/tini 回收信号：内核对 PID 1 上「无处理器」的
// 信号不执行默认终止动作，故 docker stop 的 SIGTERM 会被无视 → 白等满 10s 宽限期后被 SIGKILL 硬杀。
// 注册处理器把它变成「收到即主动收尾并退出」：停调度器（不再起新 tick）、停止接受新连接、关库刷 WAL。
// best-effort 且带兜底超时，绝不因某一步卡住而永远不退出。
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] 收到 ${signal}，开始优雅停机…`);
  // 兜底：无论下面哪步卡住，最多等这么久就强制退出，避免吊死在宽限期。
  const forceExit = setTimeout(() => {
    console.warn("[shutdown] 收尾超时，强制退出。");
    process.exit(0);
  }, 8000);
  forceExit.unref?.();
  try {
    autoTestScheduler.stop(); // 不再触发新 tick；在途作业不强杀，靠启动对账归位
  } catch {
    /* 停调度器失败不应阻断后续收尾 */
  }
  httpServer.close(() => {
    // 所有在途连接结束后：关库让 SQLite 干净检查点（WAL 即便不关也能在下次打开时恢复，关一下更稳）。
    try {
      closeDatabase();
    } catch {
      /* 关库失败可接受：WAL 会在下次打开时恢复 */
    }
    clearTimeout(forceExit);
    console.log("[shutdown] 收尾完成，退出。");
    process.exit(0);
  });
  // close() 只等【在途请求】结束，但反向代理（Caddy）会握着【空闲 keep-alive】长连接不放——不主动断开
  // 它们，close() 的回调永不触发，只能等下面 forceExit 硬退（实测：空闲 keepalive 会把优雅退出拖到超时）。
  // 故立刻断开当前空闲连接；再给在途请求一段宽限，到点强断剩余连接让 close() 回调尽快触发。
  httpServer.closeIdleConnections?.();
  setTimeout(() => httpServer.closeAllConnections?.(), 5000).unref?.();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// 最后一道兜底：任何逃逸的 Promise 拒绝 / 未捕获异常，在 Node 默认「直接杀进程」之前先落一条日志，
// 把「静默猝死」变成「可诊断」。不吞异常、不假装恢复——记录后仍按默认语义处理（rejection 仅告警，
// 保持进程存活；uncaughtException 记录后退出，避免进程停留在未知状态）。
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection] 未处理的 Promise 拒绝：", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[uncaughtException] 未捕获异常，进程即将退出：", error);
  process.exit(1);
});

// —— API 路由表 —— //
// 「本服务有哪些接口」的唯一清单：全部 65 条都在这里，读它即可，不必再翻 handleApi。
// 新增接口写这里 + 写一个 handler，不要再往 handleApi 里塞 if。
//
// handler 签名统一为 (req, res, { url, params })，不依赖 handleApi 闭包，可脱离 HTTP 单测。
// 匹配语义见 server/router.mjs（分段严格比对，":id" 匹配单个非空段并自动解码）。
//
// 顺序即优先级，靠前的规则会遮住靠后的（如 /api/tasks/recent 必须排在 /api/tasks/:id 之前）。
// createRouter 建表时做顺序体检：排错了直接启动失败，不会像原来的 if 链那样静默走错分支。
//
// 鉴权不在这张表里：所有规则都在 evaluateApiAccess（api-access.mjs）之后才被匹配，
// 门禁按路径前缀判定（/api/dev/ 一律超管、/api/channels 非 GET 超管等），与本表无耦合。
const API_ROUTES = [
  // 会话（登录端点在 handleApi 里单独前置，因为它必须免鉴权）
  ["POST", "/api/auth/logout", handleAuthLogout],
  ["GET", "/api/auth/me", handleAuthMe],

  // 平台自检（免登录白名单，见 api-access.PUBLIC_API_PATHS）
  ["GET", "/api/health", handleHealth],

  // 配置档案：读
  ["GET", "/api/profiles/export", handleProfilesExport], // 必须在 /api/profiles/:id 之前
  ["GET", "/api/profiles", handleProfilesList],

  // 场景：面向普通管理员的脱敏清单（不含 prompt / 答案）
  ["GET", "/api/scenarios", handleScenariosList],

  // 开发者接口：场景增删改查（含 prompt / 答案，仅超管）
  ["GET", "/api/dev/scenarios", handleDevScenariosList],
  ["POST", "/api/dev/scenarios", handleDevScenarioCreate],
  ["PUT", "/api/dev/scenarios/:id", handleDevScenarioUpdate],
  ["DELETE", "/api/dev/scenarios/:id", handleDevScenarioDelete],

  // 前端错误上报（免登录白名单）
  ["POST", "/api/client-errors", handleClientErrorReport],

  // 真实客户端日志：分析 / 导入 / 回放（replay* 会真实消耗上游额度）
  ["POST", "/api/client-logs/analyze", handleClientLogsAnalyze],
  ["POST", "/api/client-logs/import-directory", handleClientLogsImportDirectory],
  ["POST", "/api/client-logs/replay-candidates", handleClientLogsReplayCandidates],
  ["POST", "/api/client-logs/replay-batch", handleClientLogsReplayBatch],
  ["POST", "/api/client-logs/supplier-evidence", handleClientLogsSupplierEvidence],
  ["POST", "/api/client-logs/replay", handleClientLogsReplay],

  // 开发者接口：场景分组（重命名 / 删除会级联改题并改写源文件，仅超管）
  ["POST", "/api/dev/scenario-groups", handleScenarioGroupCreate],
  ["PUT", "/api/dev/scenario-groups", handleScenarioGroupRename],
  ["DELETE", "/api/dev/scenario-groups", handleScenarioGroupDelete],

  // 自动测试作业：登录即可用（普通管理员也能维护自己的定时作业），故不走 /api/dev/ 前缀
  ["GET", "/api/auto-test-jobs", handleAutoTestJobsList],
  ["POST", "/api/auto-test-jobs", handleAutoTestJobUpsert],
  ["POST", "/api/auto-test-jobs/:id/run", handleAutoTestJobRunNow],
  ["DELETE", "/api/auto-test-jobs/:id", handleAutoTestJobDelete],

  // 配置档案：写（非 GET 一律要超管，见 api-access.requiresAdmin）
  ["POST", "/api/profiles", handleProfileUpsert],
  ["POST", "/api/profiles/import", handleProfilesImport],
  ["DELETE", "/api/profiles/:id", handleProfileDelete],
  ["POST", "/api/profiles/:id/key", handleProfileKeyUpdate],

  // 渠道：持 API key，非 GET 一律要超管
  ["GET", "/api/channels", handleChannelsList],
  ["POST", "/api/channels", handleChannelUpsert],
  ["POST", "/api/channels/import", handleChannelsImport],
  ["POST", "/api/channels/:id/sync-models", handleChannelSyncModels],
  ["DELETE", "/api/channels/:id", handleChannelDelete],

  // 设置（写不一刀切要超管：影响 new-api 的字段在 handleSettingsUpdate 里做字段级门禁）
  ["GET", "/api/settings", handleSettingsGet],
  ["PUT", "/api/settings", handleSettingsUpdate],

  // 模型目标：不持 key，普通管理员即可维护
  ["GET", "/api/model-targets", handleModelTargetsList],
  ["POST", "/api/model-targets/:id/remove-tag", handleModelTargetRemoveTag],
  ["POST", "/api/model-targets", handleModelTargetUpsert],
  ["DELETE", "/api/model-targets/:id", handleModelTargetDelete],

  // 同步测试：直接在请求里跑完并返回结果（耗时长的走下面的 /api/tasks 异步任务）
  ["POST", "/api/tests/quick", handleTestQuick],
  ["POST", "/api/tests/quick-verify", handleTestQuickVerify],
  ["POST", "/api/tests/admission", handleTestAdmission],
  ["POST", "/api/tests/batch-admission", handleTestBatchAdmission],
  ["POST", "/api/tests/stability", handleTestStability],
  ["POST", "/api/tests/batch-stability", handleTestBatchStability],
  ["POST", "/api/tests/scenario", handleTestScenario],

  // 异步任务：重测试排队执行，前端轮询进度（并发上限见 task-manager.mjs）
  ["POST", "/api/tasks", handleTaskCreate],
  ["GET", "/api/tasks/recent", handleTasksRecent], // 必须在 /api/tasks/:id 之前
  ["GET", "/api/tasks/:id", handleTaskGet],
  ["POST", "/api/tasks/:id/cancel", handleTaskCancel],

  // 运行历史
  ["GET", "/api/requests/recent", handleRequestsRecent],
  ["GET", "/api/test-runs/recent", handleTestRunsRecent],

  // 高危报告提示
  ["GET", "/api/high-risk-alerts", handleHighRiskAlertsList],
  ["POST", "/api/high-risk-alerts/ack", handleHighRiskAlertsAck],

  // 报告中心（DELETE 一律要超管；GET 列表 / 查看不受限）
  ["GET", "/api/reports", handleReportsList],
  ["GET", "/api/reports/files", handleReportFilesList],
  ["DELETE", "/api/reports/files/:id", handleReportFileDelete],
  ["POST", "/api/reports/compare/scenarios", handleReportsCompareScenarios],
  ["POST", "/api/reports/compare", handleReportsCompare],
  ["POST", "/api/reports/auto-test-digest", handleReportsAutoTestDigest],
  ["GET", "/api/reports/:id/view", handleReportView],

  // 趋势 / 回归告警 / 花费
  ["GET", "/api/trend", handleTrend],
  ["GET", "/api/alerts", handleAlerts],
  ["GET", "/api/spend", handleSpend],

  // 排障包（仅超管）
  ["GET", "/api/support-bundle", handleSupportBundle],
];

const apiRouter = createRouter(API_ROUTES);

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

  // —— 路由表分发（清单见文件上方 API_ROUTES）——
  const matched = apiRouter.match(req.method, url.pathname);
  if (matched) {
    await matched.handler(req, res, { url, params: matched.params });
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
    // 同步清理请求/运行/告警/指纹历史表，防 evaluator.db 只增不减吃满卷。
    const history = await pruneHistory({
      retentionDays: Number(process.env.EVALUATOR_HISTORY_RETENTION_DAYS || 90),
    });
    const historyTotal = Object.values(history).reduce((sum, n) => sum + (n || 0), 0);
    if (historyTotal) {
      console.log(`[history] 已清理 ${historyTotal} 条过期/超量历史记录（${JSON.stringify(history)}）`);
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
// —— 路由表 handler —— //
// 签名统一为 (req, res, { url, params })：不依赖 handleApi 的闭包，可脱离 HTTP 单独调用与测试。
// 抛错交由 createServer 顶层统一兜底（HttpRequestError → 对应状态码，其余 → 500 + errorId），
// 与原 if 链一致，故这里不做 try/catch。

function handleAuthLogout(req, res) {
  res.setHeader("Set-Cookie", clearSessionCookie());
  sendJson(res, 200, { ok: true });
}

function handleAuthMe(req, res) {
  sendJson(res, 200, {
    user: {
      username: req.session.username,
      role: req.session.role,
      canConfig: canWriteConfig(req.session.role),
    },
  });
}

function handleHealth(req, res) {
  // autoTest.stale=true 表示调度器心跳超时（进程活着但定时器僵死）——容器健康检查据此判 unhealthy，
  // autoheal 看门狗再重启，补上「进程活着但自动测试停摆」这类静默故障的自动恢复（见 deploy compose）。
  sendJson(res, 200, {
    ok: true,
    service: "evaluator-api",
    pid: process.pid,
    proxyEnvDetected: hasProxyEnv(),
    safetyScenariosEnabled: getTestScenarios().some((scenario) => scenario.category === "safety"),
    version: APP_VERSION,
    autoTest: autoTestScheduler.getStatus(),
  });
}

async function handleProfilesList(req, res) {
  const profiles = await loadProfiles();
  sendJson(res, 200, profiles.map(maskProfile));
}

async function handleProfilesExport(req, res) {
  const profiles = await loadProfiles();
  sendJson(res, 200, {
    exportedAt: new Date().toISOString(),
    version: 1,
    profiles: profiles.map(exportProfile),
  });
}

function handleScenariosList(req, res) {
  sendJson(res, 200, getTestScenarios().map(maskScenario));
}

function handleDevScenariosList(req, res) {
  sendJson(res, 200, getAllScenariosForAdmin());
}

async function handleDevScenarioCreate(req, res) {
  const result = await upsertScenario(await readJson(req));
  if (!result.ok) {
    sendJson(res, 400, { error: "invalid_scenario", userMessage: result.userMessage });
    return;
  }
  sendJson(res, 200, result);
}

async function handleDevScenarioUpdate(req, res, { params }) {
  const body = await readJson(req);
  const result = await upsertScenario({ ...body, id: params.id });
  if (!result.ok) {
    sendJson(res, 400, { error: "invalid_scenario", userMessage: result.userMessage });
    return;
  }
  sendJson(res, 200, result);
}

async function handleDevScenarioDelete(req, res, { params }) {
  const result = await deleteScenario(params.id);
  if (!result.ok) {
    sendJson(res, 404, { error: "not_found", userMessage: result.userMessage });
    return;
  }
  sendJson(res, 200, result);
}

// /api/client-errors 在免登录白名单里（前端崩溃需能在登录前上报），故匿名可达、可被灌日志（P3-8）。
// 按客户端 IP 轻量限流：正常前端每分钟寥寥几条，60/分钟绰绰有余；灌日志会被挡在 429。
const clientErrorLimiter = createRateLimiter({
  windowMs: 60_000,
  max: Number(process.env.EVALUATOR_CLIENT_ERROR_RATE_MAX) > 0 ? Number(process.env.EVALUATOR_CLIENT_ERROR_RATE_MAX) : 60,
});

async function handleClientErrorReport(req, res) {
  const gate = clientErrorLimiter.check(clientIp(req));
  if (!gate.allowed) {
    sendJson(res, 429, { error: "rate_limited", userMessage: "错误上报过于频繁，请稍后再试。", retryAfterMs: gate.retryAfterMs });
    return;
  }
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

async function handleClientLogsAnalyze(req, res) {
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

async function handleClientLogsImportDirectory(req, res) {
  const body = await readJson(req);
  const imported = await readClientLogDirectory(body.directoryPath, {
    maxFiles: body.maxFiles,
    recursive: body.recursive,
  });
  sendJson(res, 200, imported);
  return;
}

async function handleClientLogsReplayCandidates(req, res) {
  const body = await readJson(req);
  const candidates = extractReplayCandidates(body);
  sendJson(res, 200, {
    count: candidates.length,
    candidates,
  });
  return;
}

async function handleClientLogsReplayBatch(req, res) {
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

async function handleClientLogsSupplierEvidence(req, res) {
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

async function handleClientLogsReplay(req, res) {
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

  // —— 开发者接口：场景分组清单（新建 / 重命名 / 删除；仅超管）——
async function handleScenarioGroupCreate(req, res) {
  const name = String((await readJson(req)).name ?? "").trim();
  if (!name) {
    sendJson(res, 400, { error: "invalid_group", userMessage: "分组名不能为空。" });
    return;
  }
  const next = await saveSettings({ scenarioGroups: [...(getSettings().scenarioGroups || []), name] }); // normalize 去重保序
  sendJson(res, 200, { ok: true, scenarioGroups: next.scenarioGroups });
  return;
}

async function handleScenarioGroupRename(req, res) {
  const body = await readJson(req);
  const from = String(body.name ?? "").trim();
  const to = String(body.newName ?? "").trim();
  if (!from || !to) {
    sendJson(res, 400, { error: "invalid_group", userMessage: "分组名不能为空。" });
    return;
  }
  const groups = (getSettings().scenarioGroups || []).map((x) => (x === from ? to : x));
  const next = await saveSettings({ scenarioGroups: groups });
  const cascade = await renameScenarioGroup(from, to); // 级联改题 + 改写源文件
  sendJson(res, 200, { ok: true, scenarioGroups: next.scenarioGroups, changed: cascade.changed, persistError: cascade.persistError });
  return;
}

async function handleScenarioGroupDelete(req, res) {
  const name = String((await readJson(req)).name ?? "").trim();
  if (!name) {
    sendJson(res, 400, { error: "invalid_group", userMessage: "分组名不能为空。" });
    return;
  }
  const groups = (getSettings().scenarioGroups || []).filter((x) => x !== name);
  const next = await saveSettings({ scenarioGroups: groups });
  const cascade = await clearScenarioGroup(name); // 成员落回 bank 默认组 + 改写源文件
  sendJson(res, 200, { ok: true, scenarioGroups: next.scenarioGroups, changed: cascade.changed, persistError: cascade.persistError });
  return;
}

  // —— 自动测试作业（列表 / 新建改 / 删除 / 立即运行）——
  // 非 /api/dev 前缀：登录即可用（普通管理员 role 10 也可维护自己的定时作业），未登录仍 401。
  // 作业管理不暴露场景 prompt/答案，故不需超管；与 /api/dev/scenarios 的严格门禁区分开。
async function handleAutoTestJobsList(req, res) {
  const [jobs, runnable] = await Promise.all([loadJobs(), loadRunnableProfiles()]);
  const byId = new Map(runnable.map((p) => [p.id, p]));
  const enriched = jobs.map((job) => {
    const target = byId.get(job.targetId);
    return { ...job, targetName: target?.name || "", targetRunnable: Boolean(target) };
  });
  sendJson(res, 200, { ok: true, jobs: enriched });
  return;
}

async function handleAutoTestJobUpsert(req, res) {
  const body = await readJson(req);
  // 目标可运行性校验（异步、只读）先在锁外做，缩短持锁时间。
  const runnable = await loadRunnableProfiles();
  const runnableIds = new Set(runnable.map((p) => p.id));
  try {
    // 整个「找 existing → 规范化 → 校验 → 算 nextRunAt → upsert」在串行化的 updateJobs 里做，
    // 与调度器回写、其它并发请求互不覆盖。校验失败抛 JobValidationError → 不落盘 → 下面兜 400。
    const job = await updateJobs((jobs) => {
      const existing = body.id ? jobs.find((j) => j.id === body.id) || null : null;
      const next = normalizeJob(body, existing);
      const err = validateJob(next);
      if (err) throw new JobValidationError(err);
      if (!runnableIds.has(next.targetId)) throw new JobValidationError("被测目标不存在或不可运行（渠道可能已删除/停用）。");
      // 新建、或改动周期/由停用转启用后：重算 nextRunAt；已有且未改则沿用旧值。停用则清空。
      const cadenceChanged = !existing || existing.periodHours !== next.periodHours || (!existing.enabled && next.enabled);
      if (next.enabled && (cadenceChanged || !next.nextRunAt)) next.nextRunAt = computeNextRunAt(next.periodHours);
      if (!next.enabled) next.nextRunAt = null;
      // 由停用转启用（含熔断自动停用后的人工复活）：清零连续失败熔断状态，让作业重新开始计数。
      if (existing && !existing.enabled && next.enabled) {
        next.consecutiveFailures = 0;
        next.autoDisabledAt = null;
      }
      const idx = jobs.findIndex((j) => j.id === next.id);
      if (idx >= 0) jobs[idx] = next;
      else jobs.push(next);
      return next;
    });
    sendJson(res, 200, { ok: true, job });
  } catch (error) {
    if (error instanceof JobValidationError) {
      sendJson(res, 400, { error: "invalid_job", userMessage: error.message });
      return;
    }
    throw error;
  }
  return;
}

async function handleAutoTestJobRunNow(req, res, { params }) {
  const id = params.id;
  const result = await autoTestScheduler.runJobNow(id);
  sendJson(res, result.ok ? 200 : 409, result);
  return;
}

async function handleAutoTestJobDelete(req, res, { params }) {
  const id = params.id;
  await updateJobs((jobs) => {
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx >= 0) jobs.splice(idx, 1);
  });
  sendJson(res, 200, { ok: true });
  return;
}

async function handleProfileUpsert(req, res) {
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

async function handleProfilesImport(req, res) {
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

async function handleProfileDelete(req, res, { params }) {
  const id = params.id;
  const profiles = await loadProfiles();
  const profile = profiles.find((item) => item.id === id);
  if (profile) {
    await deleteProfileApiKey(profile);
  }
  await saveProfiles(profiles.filter((profile) => profile.id !== id));
  sendJson(res, 200, { ok: true });
  return;
}

async function handleProfileKeyUpdate(req, res, { params }) {
  const id = params.id;
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
async function handleChannelsList(req, res) {
  const channels = await loadChannels();
  sendJson(res, 200, channels.map(maskChannel));
  return;
}

async function handleChannelUpsert(req, res) {
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

async function handleChannelsImport(req, res) {
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

async function handleChannelSyncModels(req, res, { params }) {
  const id = params.id;
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

async function handleChannelDelete(req, res, { params }) {
  const id = params.id;
  if (!id) {
    sendJson(res, 400, { error: "missing_id", userMessage: "缺少渠道 id。" });
    return;
  }
  const channels = await loadChannels();
  const channel = channels.find((item) => item.id === id);
  if (channel) await deleteChannelApiKey(channel);
  await saveChannels(channels.filter((item) => item.id !== id));
  // 级联删除该渠道下的模型目标，避免孤儿。
  const targets = await loadModelTargets();
  await saveModelTargets(targets.filter((target) => target.channelId !== id));
  sendJson(res, 200, { ok: true });
  return;
}

  // —— 运行时设置（AI 总结模型 / 场景测试题库开关；脱离环境变量）——
function handleSettingsGet(req, res) {
  // 令牌存于加密库、不在 settings.json：只回「已配置/未配置」（含环境变量兜底）。
  sendJson(res, 200, { ...getSettings(), newapiImportTokenSet: Boolean(readNewapiConfig().token) });
  return;
}

async function handleSettingsUpdate(req, res) {
  const patch = await readJson(req);
  // 影响 new-api 的设置仅超管可改：网关配置(网址/用户ID/令牌)。
  // 普通管理员(role 10)的 patch 剔除这些字段，既防越权、也防其表单里的空值误清空网关配置。
  if (!canWriteConfig(req.session.role)) {
    for (const k of ["newapiBaseUrl", "newapiUserId", "newapiImportToken"]) delete patch[k];
  }
  // 令牌走加密库、绝不入 settings.json：从 patch 摘出，非空才更新（留空＝保留原令牌）。
  const tokenInput = typeof patch.newapiImportToken === "string" ? patch.newapiImportToken : "";
  delete patch.newapiImportToken;
  if (tokenInput.trim()) await saveNewapiToken(tokenInput);
  const rest = await saveSettings(patch);
  sendJson(res, 200, { ...rest, newapiImportTokenSet: Boolean(readNewapiConfig().token) });
  return;
}

  // —— v0.3.0 模型目标管理（选渠道 + 填模型，管理员维护、看不到 key）——
async function handleModelTargetsList(req, res) {
  const [targets, channels, lastByProfile] = await Promise.all([loadModelTargets(), loadChannels(), queryLastTestedByProfile()]);
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
        lastTestedAt: lastByProfile[target.id] || null, // 上次测试时间（覆盖所有测试种类）；从未测→null
      };
    }),
  );
  return;
}

async function handleModelTargetRemoveTag(req, res, { params }) {
  // 纯本地移除：从该模型目标的 tags 里删掉指定标签（标签已降级为纯本地概念，不再联动 new-api）。
  const id = params.id;
  const { tag } = await readJson(req);
  const targets = await loadModelTargets();
  const target = targets.find((item) => item.id === id);
  if (!target) {
    sendJson(res, 404, { error: "not_found", userMessage: "模型目标不存在。" });
    return;
  }
  const before = Array.isArray(target.tags) ? target.tags : [];
  const next = before.filter((t) => t !== tag);
  if (next.length !== before.length) {
    target.tags = next;
    target.updatedAt = new Date().toISOString();
    await saveModelTargets(targets);
  }
  sendJson(res, 200, { ok: true, tags: target.tags });
  return;
}

async function handleModelTargetUpsert(req, res) {
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

async function handleModelTargetDelete(req, res, { params }) {
  const id = params.id;
  const targets = await loadModelTargets();
  await saveModelTargets(targets.filter((item) => item.id !== id));
  sendJson(res, 200, { ok: true });
  return;
}

async function handleTestQuick(req, res) {
  const body = await readJson(req);
  const result = await runQuickTest(body.profileId, body.prompt || "");
  sendJson(res, 200, result);
  return;
}

  // 轻量快检：真伪 + token 虚报 + 真实消耗，少量探针、输出封顶、成本可控
async function handleTestQuickVerify(req, res) {
  const body = await readJson(req);
  const result = await runQuickVerify(body);
  openReportInBrowser(result.reportHtmlPath);
  sendJson(res, 200, result);
  return;
}

async function handleTestAdmission(req, res) {
  const body = await readJson(req);
  const result = await runAdmissionTest(body);
  openReportInBrowser(result.reportHtmlPath);
  openReportInBrowser(result.aiAnalysisHtmlPath); // AI 辅助分析独立成文，存在时一并打开
  sendJson(res, 200, result);
  return;
}

async function handleTestBatchAdmission(req, res) {
  const body = await readJson(req);
  const result = await runBatchAdmissionTest(body);
  sendJson(res, 200, result);
  return;
}

async function handleTestStability(req, res) {
  const body = await readJson(req);
  const result = await runStabilityTest(body);
  sendJson(res, 200, result);
  return;
}

async function handleTestBatchStability(req, res) {
  const body = await readJson(req);
  const result = await runBatchStabilityTest(body);
  sendJson(res, 200, result);
  return;
}

async function handleTestScenario(req, res) {
  const body = await readJson(req);
  const result = await runScenarioTest(body);
  sendJson(res, 200, result);
  return;
}

async function handleTaskCreate(req, res) {
  const body = await readJson(req);
  // 压力测试：真实计费且重负载，仅超级管理员可发起（普通管理员连入口都看不到，见前端 data-requires-admin）。
  if (body.type === "load-test" && !canWriteConfig(req.session.role)) {
    sendJson(res, 403, { error: "forbidden_admin", userMessage: "仅超级管理员可发起压力测试。" });
    return;
  }
  const task = await taskManager.createTask(body.type, body.payload || {});
  sendJson(res, 202, taskManager.publicTask(task));
  return;
}

async function handleTasksRecent(req, res) {
  sendJson(res, 200, await readRecentTasks(taskManager.tasks, taskManager.publicTask));
  return;
}

function handleTaskGet(req, res, { params }) {
  const taskId = params.id;
  const task = taskManager.getTask(taskId);
  if (!task) {
    sendJson(res, 404, { error: "task_not_found", message: "没有找到测试任务。" });
    return;
  }
  sendJson(res, 200, taskManager.publicTask(task));
  return;
}

async function handleTaskCancel(req, res, { params }) {
  const taskId = params.id;
  const task = taskManager.getTask(taskId);
  if (!task) {
    sendJson(res, 404, { error: "task_not_found", message: "没有找到测试任务。" });
    return;
  }
  await taskManager.cancelTask(task);
  sendJson(res, 200, taskManager.publicTask(task));
  return;
}

async function handleRequestsRecent(req, res) {
  sendJson(res, 200, await readRecentRequests());
  return;
}

async function handleTestRunsRecent(req, res) {
  sendJson(res, 200, await readRecentTestRuns());
  return;
}

  // 报告中心元数据列表（全平台共享，登录可读）
async function handleReportsList(req, res) {
  sendJson(res, 200, await queryRecentReports(200));
  return;
}

  // 高危报告提示：未读高危报告清单（登录可读）。开关关时不记录，故一般为空。
async function handleHighRiskAlertsList(req, res) {
  sendJson(res, 200, { alerts: await listAlerts() });
  return;
}

  // 点掉某条（{ reportId }）或全部忽略（{ all: true }）；返回剩余清单。
async function handleHighRiskAlertsAck(req, res) {
  const body = await readJson(req);
  if (body?.all === true) await ackAll();
  else if (body?.reportId) await ackAlert(String(body.reportId));
  sendJson(res, 200, { ok: true, alerts: await listAlerts() });
  return;
}

  // 列出报告目录（评测数据/报告）里的全部 .html 报告文件，供「查看报告」浏览。
  // best-effort：目录不存在/读失败 → 返回 []。每项 id 与 /view 路由一致（基名去 .html）。
async function handleReportFilesList(req, res) {
  let files = [];
  try {
    const names = (await readdir(REPORTS_DIR)).filter((n) => n.toLowerCase().endsWith(".html"));
    const stats = await Promise.all(
      names.map(async (name) => {
        try {
          const st = await stat(join(REPORTS_DIR, name));
          return { id: name.replace(/\.html$/i, ""), mtimeMs: st.mtimeMs, sizeBytes: st.size };
        } catch {
          return null;
        }
      }),
    );
    files = stats.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 500);
  } catch {
    /* 目录不存在/读失败 → 空列表 */
  }
  sendJson(res, 200, files);
  return;
}

  // 删除一份报告文件（仅超级管理员，鉴权在 api-access 的 requiresAdmin 已强制）。
  // 只删该 id 自身的 .md + .html 与其元数据行，不牵连 -ai-analysis 兄弟（各行独立）。
async function handleReportFileDelete(req, res, { params }) {
  const id = sanitizeReportBaseName(params.id);
  for (const ext of [".md", ".html"]) {
    await rm(join(REPORTS_DIR, `${id}${ext}`), { force: true }).catch(() => {});
  }
  await deleteReport(id).catch(() => {}); // db 行清理，best-effort
  sendJson(res, 200, { ok: true, id });
  return;
}

  // 「模型比对」：依据两个模型各自在报告中心里「最近」的报告（1 份稳定性 run、1 份准入 admission、
  // 每个场景最新一份 scenario）做统计对比，产出一份「模型对比报告」并落盘（登录即可用，只读既有报告、不发起测试）。
  // 「模型比对 · 可选场景」：给定两个模型，返回两方【共有】的场景列表（名 + 档位），供前端勾选要纳入对比的场景。
async function handleReportsCompareScenarios(req, res) {
  const body = await readJson(req);
  const A = body?.a || {};
  const B = body?.b || {};
  if (!A.channel || !A.model || !B.channel || !B.model) {
    sendJson(res, 400, { error: "invalid_target", userMessage: "请选择两个模型（渠道 + 模型）。" });
    return;
  }
  const prep = await loadBalancedCompareFiles(A, B);
  if (prep.error) {
    sendJson(res, 400, { error: prep.error, userMessage: prep.userMessage });
    return;
  }
  sendJson(res, 200, { scenarios: commonScenarioNames(prep.balA, prep.balB) });
  return;
}

async function handleReportsCompare(req, res) {
  const body = await readJson(req);
  const A = body?.a || {};
  const B = body?.b || {};
  if (!A.channel || !A.model || !B.channel || !B.model) {
    sendJson(res, 400, { error: "invalid_target", userMessage: "请选择两个模型（渠道 + 模型）。" });
    return;
  }
  const prep = await loadBalancedCompareFiles(A, B);
  if (prep.error) {
    sendJson(res, 400, { error: prep.error, userMessage: prep.userMessage });
    return;
  }
  const { balA, balB } = prep;
  // 用户自选场景：body.scenarios 为场景名数组时，只保留勾选的场景（行级过滤，稳定性/准入不受影响）。
  // 不传该字段 → 沿用全部共有场景（向后兼容）。
  const scenarioFilter = Array.isArray(body?.scenarios) ? new Set(body.scenarios.map((s) => String(s))) : undefined;
  // 可选：用户为本次报告给两个对象取的显示名；留空则回退「渠道 / 模型」。
  const labelOf = (name, subj) => (typeof name === "string" && name.trim() ? name.trim().slice(0, 40) : `${subj.channel} / ${subj.model}`);
  const aggA = aggregateSubject({ files: balA, label: labelOf(body?.aName, A), scenarioFilter });
  const aggB = aggregateSubject({ files: balB, label: labelOf(body?.bName, B), scenarioFilter });
  const cmp = buildComparison(aggA, aggB);

  // 可选 AI 叙述：复用「设置」里指定的 AI 总结模型；未配置/失败则优雅跳过（记 note）。
  let aiNarrative = null;
  let aiNote = null;
  if (body?.aiNarrative) {
    try {
      const settings = getSettings();
      let profile = null;
      if (settings.aiAnalysisModelTargetId) {
        const profiles = await loadRunnableProfiles();
        profile = profiles.find((p) => p.id === settings.aiAnalysisModelTargetId) || null;
      }
      if (!profile) {
        aiNote = "未在「设置」里指定 AI 总结模型，已跳过 AI 叙述。";
      } else {
        const record = await executeTestRequest(
          { ...profile, maxTokens: Math.max(Number(profile.maxTokens || 0), 1200), timeoutMs: Math.max(Number(profile.timeoutMs || 0), 90000) },
          buildCompareAnalysisPrompt(cmp),
          { runId: "model-compare", caseId: "compare-analysis", writeLog: true },
        );
        const r = buildAiAnalysisResult(record);
        if (r?.success && r.text) aiNarrative = r.text;
        else aiNote = `AI 叙述生成失败：${r?.error || "未知错误"}`;
      }
    } catch (error) {
      aiNote = `AI 叙述生成异常：${error.message}`;
    }
  }

  const markdown = formatCompareReportMarkdown(cmp, { aiNarrative, balancedToCommon: true });
  const stamp = compactDate(new Date()).replace("-", "_");
  const slug = (s) => sanitizeReportBaseName(`${s.channel}_${s.model}`);
  const baseName = `${slug(A)}_vs_${slug(B)}_compare_${stamp}_${randomUUID().slice(0, 4)}`;
  await saveReportFiles(baseName, markdown, "模型对比报告");
  const reportId = sanitizeReportBaseName(baseName);
  const usedNote = (agg) => `${agg.reportCounts.scenario} 场景 / ${agg.reportCounts.run} 稳定性 / ${agg.reportCounts.admission} 准入`;
  sendJson(res, 200, {
    reportId,
    markdown,
    notes: { a: usedNote(aggA), b: usedNote(aggB), ai: aiNote, aiApplied: Boolean(aiNarrative) },
  });
  return;
}

  // 「自动测试巡检报告」：跨作业的周期性汇总——按时间窗口聚合各自动测试作业的目标模型，
  // 出调度健康 + 逐模型小结 + 每模型一张稳定性趋势图，落报告中心（登录即用，只读既有数据、不发起测试）。
  // 传 { profileId } 则只出该单个模型的巡检报告（作业/告警/图均限定到它，报告名带渠道_模型前缀，报告中心可按渠道/模型筛）。
async function handleReportsAutoTestDigest(req, res) {
  const body = await readJson(req);
  // 时间窗口：24h / 7天(168) / 30天(720)，默认 7 天。
  const allowedWindows = new Set([24, 168, 720]);
  const windowHours = allowedWindows.has(Number(body?.windowHours)) ? Number(body.windowHours) : 168;
  const soloProfileId = typeof body?.profileId === "string" && body.profileId.trim() ? body.profileId.trim() : null;
  const now = new Date();
  const windowStart = now.getTime() - windowHours * 3600 * 1000;
  const withinWindow = (iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= windowStart;
  };
  const OVERDUE_GRACE_MS = 3600 * 1000; // 逾期宽限 1h，避开正常抖动

  const allJobs = await loadJobs();
  const profiles = await loadRunnableProfiles();
  const infoOf = (targetId) => {
    const p = profiles.find((x) => x.id === targetId);
    return { label: p?.name || targetId || "-", model: p?.defaultModel || "" };
  };
  // 单模型模式：作业与范围都限定到该目标；否则跨全部作业。
  const jobs = soloProfileId ? allJobs.filter((j) => j.targetId === soloProfileId) : allJobs;

  // 巡检范围：单模型 → 仅该目标；否则＝作业目标集，无作业时回退为「近期测过的模型」。
  let targetIds;
  if (soloProfileId) targetIds = [soloProfileId];
  else {
    targetIds = [...new Set(allJobs.map((j) => j.targetId).filter(Boolean))];
    if (!targetIds.length) targetIds = [...new Set(profiles.map((p) => p.id))];
  }

  const targets = [];
  for (const pid of targetIds) {
    const { series, rounds, regression } = await buildProfileTrend(pid, { limit: 200 });
    const seriesWindow = series.filter((p) => withinWindow(p.at));
    const roundsWindow = rounds.filter((r) => withinWindow(r.at));
    const latest = seriesWindow[seriesWindow.length - 1] || null;
    const prev = seriesWindow.length >= 2 ? seriesWindow[seriesWindow.length - 2] : null;
    const { label, model } = infoOf(pid);
    // 回退（无作业）聚合模式下跳过窗口内无运行的模型；单模型模式始终收录（即便为空，给出「无运行」）。
    if (!soloProfileId && !allJobs.length && !seriesWindow.length) continue;
    targets.push({
      profileId: pid,
      label,
      model,
      runsInWindow: seriesWindow.length,
      latest: latest ? { at: latest.at, grade: latest.grade, successRate: latest.successRate, p95Ms: latest.p95Ms } : null,
      prev: prev ? { successRate: prev.successRate } : null,
      regression,
      rounds: roundsWindow,
    });
  }
  // 每目标窗口内运行数，供作业行展示（运行未按 jobId 归属，按目标近似）。
  const runsByTarget = new Map(targets.map((t) => [t.profileId, t.runsInWindow]));
  const jobRows = jobs.map((j) => {
    const { label, model } = infoOf(j.targetId);
    const overdue = Boolean(j.enabled) && !j.autoDisabledAt && j.nextRunAt && Date.parse(j.nextRunAt) < now.getTime() - OVERDUE_GRACE_MS;
    return {
      name: j.name || label,
      kind: j.kind,
      targetLabel: label,
      targetId: j.targetId,
      model,
      enabled: Boolean(j.enabled),
      periodHours: j.periodHours,
      lastRunAt: j.lastRunAt,
      lastStatus: j.lastStatus,
      lastError: j.lastError,
      nextRunAt: j.nextRunAt,
      consecutiveFailures: j.consecutiveFailures || 0,
      autoDisabled: Boolean(j.autoDisabledAt),
      overdue,
      runsInWindow: runsByTarget.get(j.targetId) ?? 0,
    };
  });
  // 告警：单模型模式按渠道名过滤回归告警（告警按 profile_name 记录）。
  const soloInfo = soloProfileId ? infoOf(soloProfileId) : null;
  const regressionAlerts = (await queryRegressionAlerts(soloProfileId ? { profileId: soloProfileId, limit: 200 } : { limit: 200 })).filter((a) =>
    withinWindow(a.created_at),
  );
  const highRiskAlerts = soloProfileId ? [] : await listAlerts();

  const scopeLabel = soloProfileId ? `单个模型 · ${soloInfo.label}${soloInfo.model ? " · " + soloInfo.model : ""}` : null;
  const data = { windowHours, generatedAt: now.toISOString(), jobs: jobRows, targets, regressionAlerts, highRiskAlerts, scopeLabel };
  // 一次性图表穿透 nonce：仅本次巡检的可信趋势图 SVG 可原样内联；其它报告与不可信正文无法伪造。
  const chartNonce = randomUUID();
  const markdown = formatAutoTestDigestReport(data, { now, chartNonce });
  const stamp = compactDate(now).replace("-", "_"); // YYYYMMDD_HHMMSS
  // 单模型报告名带 渠道_模型 前缀（供报告中心按渠道/模型筛选）；聚合报告无前缀。
  const soloProfile = soloProfileId ? profiles.find((p) => p.id === soloProfileId) : null;
  const soloSlug = soloProfile ? sanitizeReportBaseName(reportTargetSlug(soloProfile)) : "";
  const baseName = soloSlug ? `${soloSlug}_autodigest_${stamp}_${randomUUID().slice(0, 4)}` : `autodigest_${stamp}_${randomUUID().slice(0, 4)}`;
  await saveReportFiles(baseName, markdown, scopeLabel ? `自动测试巡检报告 · ${soloInfo.label}` : "自动测试巡检报告", { chartNonce });
  sendJson(res, 200, {
    reportId: sanitizeReportBaseName(baseName),
    markdown,
    windowHours,
    profileId: soloProfileId,
    summary: { jobs: jobs.length, targets: targets.length, regressions: regressionAlerts.length, highRisk: highRiskAlerts.length },
  });
  return;
}

  // 在浏览器里查看一份报告 HTML（Docker/远程部署看报告的正路：应用内浮层 iframe 或新标签页打开）。
  // 鉴权同其它 /api/*（已登录即可读）。文件名经 sanitizeReportBaseName 防目录穿越；报告为纯静态
  // HTML+CSS、无脚本，再叠加 nosniff + 禁脚本 CSP，直开标签页也无 XSS 面。
async function handleReportView(req, res, { params }) {
  const id = sanitizeReportBaseName(params.id);
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
async function handleTrend(req, res, { url }) {
  const profileId = url.searchParams.get("profileId") || "";
  if (!profileId) {
    sendJson(res, 400, { error: "missing_profile", userMessage: "请提供 profileId。" });
    return;
  }
  // series（含「基础」场景成功率回填）+ 基线回归 + 逐轮 rounds（稳定性+基础场景，融合）
  const { series, regression, rounds } = await buildProfileTrend(profileId, { limit: 200 });
  const alerts = await queryRegressionAlerts({ profileId, limit: 50 });
  sendJson(res, 200, { profileId, series, regression, alerts, rounds });
  return;
}

  // 最近回归告警（全渠道；?limit=N）
async function handleAlerts(req, res, { url }) {
  const limit = Number(url.searchParams.get("limit")) || 50;
  sendJson(res, 200, await queryRegressionAlerts({ limit }));
  return;
}

  // 累计测试真实消耗（成本可观测；?days=N 限定窗口，?mine=1 仅本人）
async function handleSpend(req, res, { url }) {
  const days = Number(url.searchParams.get("days"));
  const sinceMs = Number.isFinite(days) && days > 0 ? Date.now() - days * 24 * 3600 * 1000 : undefined;
  const runBy = url.searchParams.get("mine") === "1" ? req.session?.username : undefined;
  sendJson(res, 200, (await querySpendSummary({ runBy, sinceMs })) || { runs: 0, totalActualCost: 0, totalEstimatedCost: 0, currency: "USD" });
  return;
}

async function handleSupportBundle(req, res) {
  const profiles = await loadProfiles();
  const requests = await readRecentRequests();
  const testRuns = await readRecentTestRuns();
  const tasks = await readRecentTasks(taskManager.tasks, taskManager.publicTask);
  const errors = await readRecentErrors();
  const storage = getDbHealth();
  sendJson(res, 200, buildSupportBundle({ profiles, requests, testRuns, tasks, errors, storage }));
  return;
}

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
