import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, stat, statfs } from "node:fs/promises";
import { extname, join } from "node:path";
import { MIME_TYPES, getTestScenarios } from "./server/constants.mjs";
import {
  getAllScenariosForAdmin,
  loadScenarioOverrides,
  upsertScenario,
  deleteScenario,
  renameScenarioGroup,
  clearScenarioGroup,
} from "./server/scenarios/index.mjs";
import { DATA_DIR, ERROR_LOG_FILE, REPORTS_DIR, STATIC_ROOT, TASK_EVENTS_FILE, TEST_RUNS_FILE } from "./server/paths.mjs";
import {
  ensureDataDir,
  readRecentErrors,
  readRecentRequests,
  readRecentTasks,
  readRecentTestRuns,
  readTaskDetail,
} from "./server/data-store.mjs";
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
import {
  compressAgedReportFiles,
  formatClientReplayReport,
  formatSupplierEvidenceReport,
  readReportFileText,
  saveReportFiles,
} from "./server/reporting.mjs";
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
import { deleteProfileApiKey, saveProfileApiKey, saveSecret, readSecret } from "./server/secret-store.mjs";
import { createTaskManager } from "./server/task-manager.mjs";
import { buildSupportBundle } from "./server/support-bundle.mjs";
import {
  closeDatabase,
  deleteReport,
  getDbHealth,
  PersistentStorageWriteError,
  pruneHistory,
  pruneReports,
  queryLastTestedByProfile,
  queryRecentReports,
  queryReportSummariesByBase,
  queryRegressionAlerts,
  querySpendSummary,
} from "./server/db.mjs";
import { buildProfileTrend } from "./server/trend-service.mjs";
import { buildModelProfileView } from "./server/model-profile.mjs";
import { formatAutoTestDigestReport } from "./server/auto-test-digest.mjs";
import {
  executeTestRequest,
  normalizeProfileIds,
  normalizeScenarioIds,
  runAdmissionTest,
  runBatchAdmissionTest,
  runBatchStabilityTest,
  runQuickVerify,
  runScenarioTest,
  runStabilityTest,
  reportTargetSlug,
} from "./server/test-runner.mjs";
import { runLoadTest } from "./server/load-test.mjs";
import { createAdmissionSuiteRunner } from "./server/admission-suite.mjs";
import { buildAiAnalysisResult } from "./server/ai-report-analysis.mjs";
import {
  aggregateSubject,
  balanceCommonReports,
  buildComparison,
  buildComparisonView,
  buildCompareAnalysisPrompt,
  buildMultiComparisonView,
  buildSubjectSlugIndex,
  commonScenarioNames,
  exclusiveScenarioNames,
  formatCompareReportMarkdown,
  parseCompareReportBaseName,
  parseReportBaseName,
  pickRecentReports,
} from "./server/report-compare.mjs";
import {
  countReportFileTextBytes,
  createReportFileReadStream,
  openReportInBrowser,
  reportIdFromHtmlPath,
  sanitizeReportBaseName,
} from "./server/report-files.mjs";
import { streamZipArchive } from "./server/report-archive.mjs";
import { loadJobs, updateJobs, normalizeJob, validateJob, computeNextRunAt, JobValidationError } from "./server/auto-test-store.mjs";
import { loadRules, updateRules, normalizeRule, validateRule, RuleValidationError } from "./server/alert-rules-store.mjs";
import { createAutoTestScheduler } from "./server/auto-test-scheduler.mjs";
import { noteRunIfEnabled, listAlerts, ackAlert, ackAll } from "./server/high-risk-store.mjs";
import { evaluateAlertRules } from "./server/alert-rules-evaluator.mjs";
import { getRawRequestPathname, resolveRequestPathInside } from "./server/static-paths.mjs";
import { appendJsonLine, compactDate, hasProxyEnv, requiredString, sendJson } from "./server/utils.mjs";
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
import { fetchNewapiChannels, fetchNewapiSmtp, importSourceMode } from "./server/newapi-source.mjs";
import { readConfig as readNewapiConfig, loadNewapiToken, saveNewapiToken } from "./server/newapi-tag-writer.mjs";
import { getSettings, loadSettings, saveSettings, peekLegacyNewapiToken, stripLegacyNewapiToken } from "./server/settings-store.mjs";
import { getNotifyConfig, loadNotifyConfig, saveNotifyConfig } from "./server/notify-config.mjs";
import { sendMail, buildTestMailBody } from "./server/mailer.mjs";
import { withRunBy } from "./server/run-context.mjs";
import { createRouter } from "./server/router.mjs";
import { createRateLimiter } from "./server/rate-limit.mjs";
import { APP_VERSION } from "./server/version.mjs";
import { sendCompressedStatic, sendCompressedJson } from "./server/compression.mjs";
import { envInt, invalidEnvVars } from "./server/env-config.mjs";
import { createExecutionLimiter } from "./server/execution-limiter.mjs";
import { createProcessPerformanceSnapshot } from "./server/performance.mjs";

const PORT = Number(process.env.API_PORT || process.env.PORT || 5180);
// 部署适配：绑定地址可配（容器内需 0.0.0.0；默认仍 127.0.0.1，本地行为不变）
const HOST = process.env.HOST || process.env.API_HOST || "127.0.0.1";
// 唯一的平台级执行闸：异步任务、自动作业和旧同步测试接口均从这里取槽。
// 自动测试仍可设置更小的子额度 EVALUATOR_AUTO_TEST_CONCURRENCY，但永远不能突破这个总上限。
const executionLimiter = createExecutionLimiter({
  getLimit: () => envInt("EVALUATOR_MAX_CONCURRENT_TASKS", 2, { min: 1, max: 64 }),
});

async function runWithExecutionSlot(run) {
  await executionLimiter.acquire();
  try {
    return await run();
  } finally {
    executionLimiter.release();
  }
}

// 一键准入复合任务：编排器只负责按顺序调下面三个 runner，判定全部交给 admission-policy.mjs。
// runner 在这里注入，编排逻辑因此可以用假 runner 单测（tests/admission-suite.test.mjs）。
const runAdmissionSuite = createAdmissionSuiteRunner({ runQuickVerify, runStabilityTest, runAdmissionTest });
const taskManager = createTaskManager({
  taskEventsFile: TASK_EVENTS_FILE,
  runStabilityTest,
  runBatchAdmissionTest,
  runBatchStabilityTest,
  runScenarioTest,
  runLoadTest,
  runAdmissionTest,
  runAdmissionSuite,
  normalizeProfileIds,
  normalizeScenarioIds,
  errorLogFile: ERROR_LOG_FILE,
  logTechnicalError,
  buildUserErrorMessage,
  executionLimiter,
  onRunComplete: (result) => {
    noteRunIfEnabled(result); // 高危报告提示：手动测试完成时按开关判危记录
    evaluateAlertRules(result); // 自定义阈值报警规则：手动测试完成时按规则判断是否报警
  },
});

// 自动测试调度器（平台唯一的周期性定时器）：按各作业的 nextRunAt 到点直接调 runner 跑测试并产出报告。
const autoTestScheduler = createAutoTestScheduler({
  loadJobs,
  updateJobs,
  runners: { runQuickVerify, runAdmissionTest, runStabilityTest, runScenarioTest },
  reportIdFromHtmlPath,
  onRunComplete: (result) => {
    noteRunIfEnabled(result); // 高危报告提示：自动测试完成时按开关判危记录
    evaluateAlertRules(result); // 自定义阈值报警规则：自动测试完成时按规则判断是否报警
  },
  logError: (error, job) =>
    logErrorSafely({ source: "auto-test-scheduler", error, context: { jobId: job?.id, kind: job?.kind, targetId: job?.targetId } }),
  executionLimiter,
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
await loadNotifyConfig(); // 暖邮件报警发信配置缓存
await loadScenarioOverrides(); // 读回超管的场景编辑覆盖层（/data），合并到内置 bank 之上
// new-api 系统令牌走加密库：启动解密一次缓存进内存（readConfig 同步读）。
// 迁移旧版明文令牌：先写进加密库，再从 settings.json 抹除（顺序保证不丢令牌）。
const legacyNewapiToken = await peekLegacyNewapiToken();
await loadNewapiToken(legacyNewapiToken);
if (legacyNewapiToken) await stripLegacyNewapiToken();
await runReportMaintenance();
scheduleReportMaintenance();

// 列出报告目录里的 .md 文件名（一次 readdir）。报告目录可达数千文件，多模型比对要为每个对象
// 各收一遍报告——目录列表读一次传下去，别每个对象重扫一遍。
async function listReportMdNames() {
  try {
    return (await readdir(REPORTS_DIR)).filter((n) => n.toLowerCase().endsWith(".md"));
  } catch {
    return []; // 报告目录不存在 → 空
  }
}

// 收集某个对象（渠道 + 模型，含曾用名）在报告中心的报告正文，按类型分别限流取最近若干份。
// names 由调用方传入（listReportMdNames 的结果），避免每个对象各自 readdir 一遍报告目录。
// 返回 [{ name(不含扩展名), md, mtimeMs }]。
async function collectSubjectReportFiles(names, subject, { splitAdmissionBudget = false } = {}) {
  // 候选前缀：当前名 + 曾用名(aliases)的笛卡尔组合，让改名前的历史报告也能被本模型认领。
  const channels = [subject.channel, ...(Array.isArray(subject.channelAliases) ? subject.channelAliases : [])].filter(Boolean);
  const models = [subject.model, ...(Array.isArray(subject.modelAliases) ? subject.modelAliases : [])].filter(Boolean);
  const prefixes = [...new Set(channels.flatMap((c) => models.map((m) => `${sanitizeReportBaseName(`${c}_${m}`)}_`)))];
  const metas = [];
  for (const name of names) {
    if (!prefixes.some((p) => name.startsWith(p))) continue;
    const base = name.replace(/\.md$/i, "");
    const type = parseReportBaseName(base).type;
    if (type !== "run" && type !== "admission" && type !== "scenario" && type !== "load") continue;
    try {
      const st = await stat(join(REPORTS_DIR, name));
      metas.push({ base, type, mtimeMs: st.mtimeMs });
    } catch {
      /* 读不到 → 跳过 */
    }
  }
  metas.sort((x, y) => y.mtimeMs - x.mtimeMs);
  // 限流：run/admission 共享最近 6 份（沿用 load 类型加入前的原始预算）；load 独立取最近 6 份——
  // 三者混在一个预算里时，密集调参跑压测（6 份以上近期 load 文件）会把 run/admission 全部挤出候选，
  // 对比里稳定性/准入静默消失（磁盘上明明有）。场景需要按名去重，最多取最近 60 份读盘。
  // 已知问题（暂不修）：场景是按【文件数】限流（取最近 60 份场景报告），而 pickRecentReports 是
  // 按【场景名】去重（一份文件可含多条场景行，理论上也可能撞名）。内置场景库已有约 89 个场景，
  // 若用户实际跑过的场景种类数超过 60，排序在候选池之外的稀有场景会连去重环节都进不去，被静默漏掉
  // （不报错，只是「共有场景数」会比实际偏小）。多数部署场景种类不会跑到这么全，暂按可接受风险处理。
  // splitAdmissionBudget：给 admission 单独的 6 份预算，而不是与 run 共享。
  // 起因与上面 load 独立预算完全同类：run 与 admission 共享 6 份时，密集跑稳定性（本地实测某模型
  // 有 15 份较新的 run）会把 admission 全部挤出候选，页面显示「还没有准入评测报告」而磁盘上明明有。
  // 【只有模型档案页传 true】—— 对比链路(/api/reports/compare)刻意保持原预算不动：
  // 它的统计口径被既有用例与报告文案钉住（「用于对比的报告数量」两方需相等，见 balanceCommonReports），
  // 悄悄多喂一份准入报告会改变已产出报告的可复现性。档案页是纯展示、无配对统计，扩预算无副作用。
  const runAdmissionSlice = splitAdmissionBudget
    ? [...metas.filter((m) => m.type === "run").slice(0, 6), ...metas.filter((m) => m.type === "admission").slice(0, 6)]
    : metas.filter((m) => m.type === "run" || m.type === "admission").slice(0, 6);
  const chosen = [
    ...runAdmissionSlice,
    ...metas.filter((m) => m.type === "load").slice(0, 6),
    ...metas.filter((m) => m.type === "scenario").slice(0, 60),
  ];
  const files = [];
  for (const m of chosen) {
    try {
      files.push({ name: m.base, md: await readReportFileText(join(REPORTS_DIR, `${m.base}.md`)), mtimeMs: m.mtimeMs });
    } catch {
      /* 读失败 → 跳过 */
    }
  }
  return files;
}

// 「模型比对」共用：按文件名前缀收集两方在报告中心的报告，取最近若干份，再平衡为「双方共有」的报告集。
// 返回 { balA, balB, pickedA, pickedB }（已平衡的报告文件），或 { error, userMessage }（无报告 / 无共有报告）。
// 供 /api/reports/compare（生成对比）与 /api/reports/compare/scenarios（列出可选场景）共用。
async function loadBalancedCompareFiles(A, B) {
  const names = await listReportMdNames();
  const [filesA, filesB] = await Promise.all([collectSubjectReportFiles(names, A), collectSubjectReportFiles(names, B)]);
  if (!filesA.length || !filesB.length) {
    const missing = [!filesA.length ? `${A.channel} / ${A.model}` : null, !filesB.length ? `${B.channel} / ${B.model}` : null].filter(
      Boolean,
    );
    return {
      error: "no_reports",
      userMessage: `以下模型暂无可用于对比的报告：${missing.join("、")}。请先为其跑一次准入 / 稳定性 / 场景测试。`,
    };
  }
  const pickedA = pickRecentReports(filesA);
  const pickedB = pickRecentReports(filesB);
  const [balA, balB] = balanceCommonReports(pickedA, pickedB);
  if (!balA.length || !balB.length) {
    return {
      error: "no_common_reports",
      userMessage: "两个对象没有可对比的共同报告：没有同名场景，稳定性 / 准入也未双方都有。请让两者至少跑一个相同的场景，或同一类测试。",
    };
  }
  // 给每份报告挂上当初生成它的结构化 summary（test_runs.raw_json），让场景报告不必再从
  // 渲染后的 markdown 表格里反解析数字（B2）。取不到的照旧解析 md —— 老报告/孤儿报告/库不可用都得能对比。
  // 放在平衡之后：此时只剩真正参与对比的报告，查库量最小。
  await attachSummaries([...balA, ...balB]);
  // pickedA/pickedB：平衡前的「各自已测场景全集」，供「补齐单方场景」算差集用（不受交集裁剪）。
  return { balA, balB, pickedA, pickedB };
}

// 按报告文件名批量取结构化 summary 并挂到 file.summary 上（原地改）。
// 整体 try 兜底：对比功能不该因为库读不到而挂掉——最坏就是全部回退解析 md，即改动前的行为。
async function attachSummaries(files) {
  try {
    const byBase = await queryReportSummariesByBase(files.map((f) => f.name));
    for (const f of files) {
      const s = byBase.get(f.name);
      if (s) f.summary = s;
    }
  } catch (error) {
    console.warn(`[compare] 读结构化报告数据失败，回退解析 markdown：${error?.message || error}`);
  }
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

    if (error instanceof PersistentStorageWriteError) {
      const errorId = await logErrorSafely({
        source: "persistent-storage",
        error,
        context: { method: req.method, url: req.url, scope: error.scope },
      });
      sendJson(res, 503, {
        error: "persistent_storage_unavailable",
        userMessage: "配置未保存：持久化存储暂时不可写，请检查 SQLite 数据卷、磁盘空间和权限后重试。",
        errorId,
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
    .catch((error) => {
      // 迁移失败不能冒充“已完成”；服务仍可启动供排障，但日志必须留下可操作证据。
      console.error(`[migration] 配置迁移失败，请检查 SQLite 数据卷后重试：${error?.message || error}`);
    });
  const backend = (process.env.EVALUATOR_AUTH_BACKEND || "local").toLowerCase();
  if (backend !== "newapi" && backend !== "new-api" && !hasConfiguredLocalUsers()) {
    console.warn("[auth] 登录后端=local 但未配置任何账号：请设置 EVALUATOR_ADMIN_PASSWORD（或 EVALUATOR_LOCAL_USERS），否则无法登录。");
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

  // 报警规则：登录即可用（任意管理员可自定义阈值报警规则），同样不走 /api/dev/ 前缀
  ["GET", "/api/alert-rules", handleAlertRulesList],
  ["POST", "/api/alert-rules", handleAlertRuleUpsert],
  ["DELETE", "/api/alert-rules/:id", handleAlertRuleDelete],

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

  // 邮件报警发信配置：持有 SMTP 凭证，整组仅超管（含 GET，见 api-access.mjs）
  ["GET", "/api/notify/config", handleNotifyConfigGet],
  ["PUT", "/api/notify/config", handleNotifyConfigSave],
  ["POST", "/api/notify/test", handleNotifyTestSend],
  ["POST", "/api/notify/smtp/sync", handleNotifySmtpSync],

  // 模型目标：不持 key，普通管理员即可维护
  ["GET", "/api/model-targets", handleModelTargetsList],
  ["POST", "/api/model-targets/:id/remove-tag", handleModelTargetRemoveTag],
  ["POST", "/api/model-targets", handleModelTargetUpsert],
  ["DELETE", "/api/model-targets/:id", handleModelTargetDelete],

  // 同步测试：直接在请求里跑完并返回结果（耗时长的走下面的 /api/tasks 异步任务）
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
  ["GET", "/api/reports/disk", handleReportsDiskUsage],
  ["POST", "/api/reports/files/download", handleReportFilesDownload],
  ["DELETE", "/api/reports/files", handleReportFilesBulkDelete],
  ["DELETE", "/api/reports/files/:id", handleReportFileDelete],
  ["POST", "/api/reports/compare/scenarios", handleReportsCompareScenarios],
  ["POST", "/api/reports/compare/peers", handleReportsComparePeers],
  ["POST", "/api/reports/compare/multi", handleReportsCompareMulti],
  ["POST", "/api/reports/compare", handleReportsCompare],
  ["POST", "/api/reports/compare/gaps", handleReportsCompareGaps],
  ["POST", "/api/reports/auto-test-digest", handleReportsAutoTestDigest],
  ["GET", "/api/reports/:id/view", handleReportView],

  // 单模型档案（指标 + 趋势 + 报告，只读既有报告与历史，不发起测试）
  ["GET", "/api/model-profile", handleModelProfile],

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

// 报告 + 历史维护：删过期/超量报告 → 删过期/超量历史表行 → 把剩下超龄未压缩的报告原地 gzip。
// 顺序如此：先删掉不再需要保留的，再压缩还要留着的，避免白白压缩马上又要删的文件。
// 默认时间线：创建 30 天后压缩，累计 180 天后删除（EVALUATOR_REPORT_RETENTION_DAYS 含义不变，
// 仍是「距创建超过 N 天即删」，默认值改大以配合新增的压缩层，不新增单独的「压缩后再留几天」变量）。
async function runReportMaintenance() {
  try {
    // 全部走 envInt：这里的 NaN 不只是"用错额度"——retentionDays 为 NaN 会让 pruneReports 里的
    // new Date(NaN).toISOString() 抛 RangeError，被本函数最外层的空 catch 吞掉，整段维护
    // （报告清理 + 历史清理 + 老化压缩）静默一次都不执行，磁盘继续只增不减（P1-04）。
    const removed = await pruneReports({
      retentionDays: envInt("EVALUATOR_REPORT_RETENTION_DAYS", 180, { min: 1, max: 36500 }),
      maxTotal: envInt("EVALUATOR_REPORT_MAX_TOTAL", 2000, { min: 1, max: 1_000_000 }),
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
      retentionDays: envInt("EVALUATOR_HISTORY_RETENTION_DAYS", 90, { min: 1, max: 36500 }),
    });
    const historyTotal = Object.values(history).reduce((sum, n) => sum + (n || 0), 0);
    if (historyTotal) {
      console.log(`[history] 已清理 ${historyTotal} 条过期/超量历史记录（${JSON.stringify(history)}）`);
    }
    // 剩下的（未到删除线）报告里，超过压缩阈值且尚未压缩的原地 gzip，缓解长期磁盘增长。
    const compressed = await compressAgedReportFiles({
      compressAfterDays: envInt("EVALUATOR_REPORT_COMPRESS_AFTER_DAYS", 30, { min: 1, max: 36500 }),
    });
    if (compressed.length) {
      console.log(`[reports] 已压缩 ${compressed.length} 份老化报告`);
    }
  } catch {
    // 维护失败不应阻断启动 / 定时触发
  }
}

// 长期不重启的进程不能只在启动时清理一次，否则报告/历史只会一直增长。
// 启动跑一次（调用处不变）之外，另加定时重跑；unref 避免这个计时器阻止进程正常退出。
function scheduleReportMaintenance() {
  // 这一处原本就挡住了 NaN/Infinity（下方 isFinite 校验），但"非法即静默不再定时维护"同样不好；
  // 改走 envInt 后回落到 24 小时并在 /api/health 显形，行为更接近运维的预期。
  const intervalHours = envInt("EVALUATOR_MAINTENANCE_INTERVAL_HOURS", 24, { min: 1, max: 8760 });
  setInterval(runReportMaintenance, intervalHours * 3600 * 1000).unref();
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
    // 生效额度 + 被拒的非法环境变量（P1-04）。invalidEnvVars 非空即说明有人配错了值、系统正跑在
    // 默认值上；只报变量名与原始值，不含任何凭据类配置。
    limits: {
      ...taskManager.getLimits(),
      execution: executionLimiter.getStatus(),
      autoTestConcurrency: autoTestScheduler.getStatus().maxConcurrent,
    },
    invalidEnvVars: invalidEnvVars(),
    performance: createProcessPerformanceSnapshot({ limiter: executionLimiter, scheduler: autoTestScheduler }),
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
  // 原写法用 `> 0 ?:` 挡住了 NaN，但 "Infinity" 是合法 Number 且 > 0，会让这道限流阀彻底失效。
  max: envInt("EVALUATOR_CLIENT_ERROR_RATE_MAX", 60, { min: 1, max: 1_000_000 }),
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
      // 新建、或改动节奏（周期/cron）/由停用转启用后：重算 nextRunAt；已有且未改则沿用旧值。停用则清空。
      const cadenceChanged =
        !existing || existing.periodHours !== next.periodHours || existing.cron !== next.cron || (!existing.enabled && next.enabled);
      if (next.enabled && (cadenceChanged || !next.nextRunAt)) {
        const nextRunAt = computeNextRunAt(next);
        if (!nextRunAt) throw new JobValidationError("定时表达式没有可执行时刻，请修改后再保存。");
        next.nextRunAt = nextRunAt;
      }
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

async function handleAlertRulesList(req, res) {
  const [rules, runnable] = await Promise.all([loadRules(), loadRunnableProfiles()]);
  const byId = new Map(runnable.map((p) => [p.id, p]));
  const enriched = rules.map((rule) => {
    if (rule.scope?.type !== "target") return rule;
    const target = byId.get(rule.scope.targetId);
    return { ...rule, targetName: target?.name || "", targetRunnable: Boolean(target) };
  });
  sendJson(res, 200, { ok: true, rules: enriched });
  return;
}

async function handleAlertRuleUpsert(req, res) {
  const body = await readJson(req);
  try {
    // 整个「找 existing → 规范化 → 校验 → upsert」在串行化的 updateRules 里做，与其它并发请求互不覆盖。
    // 校验失败抛 RuleValidationError → 不落盘 → 下面兜 400。
    const rule = await updateRules((rules) => {
      const existing = body.id ? rules.find((r) => r.id === body.id) || null : null;
      const next = normalizeRule(body, existing);
      const err = validateRule(next);
      if (err) throw new RuleValidationError(err);
      const idx = rules.findIndex((r) => r.id === next.id);
      if (idx >= 0) rules[idx] = next;
      else rules.push(next);
      return next;
    });
    sendJson(res, 200, { ok: true, rule });
  } catch (error) {
    if (error instanceof RuleValidationError) {
      sendJson(res, 400, { error: "invalid_rule", userMessage: error.message });
      return;
    }
    throw error;
  }
  return;
}

async function handleAlertRuleDelete(req, res, { params }) {
  const id = params.id;
  await updateRules((rules) => {
    const idx = rules.findIndex((r) => r.id === id);
    if (idx >= 0) rules.splice(idx, 1);
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
    channel = {
      ...channel,
      apiKeyRef: existing.apiKeyRef,
      keyStorage: existing.keyStorage,
      hasKey: existing.hasKey,
      keyHash: existing.keyHash,
    };
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
    sendJson(res, 400, {
      error: "not_newapi_channel",
      userMessage: "该渠道不是从 new-api 导入的，无法同步模型。手动渠道请在“模型管理”里直接加模型。",
    });
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

// —— 邮件报警发信配置（本轮只做发信，报警规则留到后续）——
// 全站只有一份 SMTP 配置，非 per-profile，用固定 ref（对齐 secret-store 的通用 ref 读写）。
const SMTP_PASSWORD_REF = "notify:smtp-password";

async function handleNotifyConfigGet(req, res) {
  // 对齐 monitor 的 ensureSMTPDefault()：本页从未配置过 SMTP 时，首次 GET 尽力自动从线上
  // new-api 同步一次（失败不阻塞、不报错，只是留空让用户手填）；已配置过（无论是同步来的
  // 还是手填的）绝不覆盖。
  await ensureSmtpDefault();
  // 密码存于加密库、不在 notify-config.json：GET 只回 smtpPasswordSet 布尔，绝不回明文。
  sendJson(res, 200, getNotifyConfig());
  return;
}

async function handleNotifyConfigSave(req, res) {
  const patch = await readJson(req);
  const passwordInput = typeof patch.smtpPassword === "string" ? patch.smtpPassword : "";
  delete patch.smtpPassword;
  // 密码留空＝保留原值；非空才写入加密库并把 smtpPasswordSet 置真。
  if (passwordInput) {
    await saveSecret(SMTP_PASSWORD_REF, passwordInput);
    patch.smtpPasswordSet = true;
  }
  const next = await saveNotifyConfig(patch);
  sendJson(res, 200, next);
  return;
}

async function handleNotifyTestSend(req, res) {
  const cfg = getNotifyConfig();
  if (!cfg.smtpHost || !cfg.recipients) {
    sendJson(res, 400, { error: "missing_config", userMessage: "请先保存 SMTP 服务器和收件人。" });
    return;
  }
  const smtpPassword = await readSecret(SMTP_PASSWORD_REF);
  try {
    await sendMail({ ...cfg, smtpPassword }, "API-evaluator 配置测试邮件", buildTestMailBody());
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 500, { error: "send_failed", userMessage: `发送失败：${error?.message || error}` });
  }
  return;
}

// 从线上 new-api 的 options 表读它自己的发信配置，覆盖本页 host/port/ssl/账号/发件人；
// 密码源端非空才覆盖（源端未配密码不清空本地已设的）。收件人是本站自己的订阅名单，不受同步影响。
async function syncSmtpFromNewapi() {
  const smtp = await fetchNewapiSmtp();
  const patch = {
    smtpHost: smtp.host,
    smtpPort: smtp.port,
    smtpSsl: smtp.ssl,
    smtpUser: smtp.user,
    smtpFrom: smtp.from,
  };
  if (smtp.password) {
    await saveSecret(SMTP_PASSWORD_REF, smtp.password);
    patch.smtpPasswordSet = true;
  }
  return saveNotifyConfig(patch);
}

// 对齐 monitor 的 ensureSMTPDefault()：本页未配置过时尽力同步一次，失败静默吞掉（不阻塞 GET）。
async function ensureSmtpDefault() {
  if (getNotifyConfig().smtpHost) return; // 已配置过，不覆盖
  try {
    await syncSmtpFromNewapi();
  } catch {
    // 尽力而为：没配 DSN / 线上没配 SMTP 都是常见情况，留空让用户手填即可。
  }
}

// 一键同步按钮：与 ensureSmtpDefault 共用同步逻辑，但失败要回显给用户（不是静默吞掉）。
async function handleNotifySmtpSync(req, res) {
  try {
    const next = await syncSmtpFromNewapi();
    sendJson(res, 200, next);
  } catch (error) {
    sendJson(res, 502, { error: "sync_failed", userMessage: error?.message || String(error) });
  }
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

// 轻量快检：真伪 + token 虚报 + 真实消耗，少量探针、输出封顶、成本可控
async function handleTestQuickVerify(req, res) {
  const body = await readJson(req);
  const result = await runWithExecutionSlot(() => runQuickVerify(body));
  openReportInBrowser(result.reportHtmlPath);
  sendJson(res, 200, result);
  return;
}

async function handleTestAdmission(req, res) {
  const body = await readJson(req);
  const result = await runWithExecutionSlot(() => runAdmissionTest(body));
  openReportInBrowser(result.reportHtmlPath);
  openReportInBrowser(result.aiAnalysisHtmlPath); // AI 辅助分析独立成文，存在时一并打开
  sendJson(res, 200, result);
  return;
}

async function handleTestBatchAdmission(req, res) {
  const body = await readJson(req);
  const result = await runWithExecutionSlot(() => runBatchAdmissionTest(body));
  sendJson(res, 200, result);
  return;
}

async function handleTestStability(req, res) {
  const body = await readJson(req);
  const result = await runWithExecutionSlot(() => runStabilityTest(body));
  sendJson(res, 200, result);
  return;
}

async function handleTestBatchStability(req, res) {
  const body = await readJson(req);
  const result = await runWithExecutionSlot(() => runBatchStabilityTest(body));
  sendJson(res, 200, result);
  return;
}

async function handleTestScenario(req, res) {
  const body = await readJson(req);
  const result = await runWithExecutionSlot(() => runScenarioTest(body));
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
  // 记下发起人（五人共用一台工具时「这轮谁跑的、这笔钱谁花的」是最常问的）。
  // 只记录与展示，不做权限边界——取消仍对所有登录者放行，见 task-manager 的 createTask 注释。
  const task = await taskManager.createTask(body.type, body.payload || {}, { actor: req.session?.username || null });
  sendJson(res, 202, taskManager.publicTask(task));
  return;
}

async function handleTasksRecent(req, res) {
  sendJson(res, 200, await readRecentTasks(taskManager.tasks, taskManager.publicTask));
  return;
}

// 内存里没有【不等于】任务不存在：task-manager 在任务落定 1 小时后就把它从 Map 里删掉，
// 进程重启更是全丢。此时事件日志里仍有终态事件（含 steps 快照），任务中心据此还能还原详情。
// 所以查不到时回落到事件日志，而不是直接 404——否则「任务中心」点开一条历史任务就是空白页。
async function handleTaskGet(req, res, { params }) {
  const taskId = params.id;
  const task = taskManager.getTask(taskId);
  if (task) {
    sendJson(res, 200, taskManager.publicTask(task));
    return;
  }
  // 必须把内存 Map 与 publicTask 一起传进去：readTaskDetail 要靠它们区分「任务真的还在跑」
  // 与「事件流停在 running 的僵尸任务」（后者改判 interrupted）。少传就会 TypeError → 500。
  const fromLog = await readTaskDetail(taskId, taskManager.tasks, taskManager.publicTask);
  if (!fromLog) {
    sendJson(res, 404, { error: "task_not_found", message: "没有找到测试任务。" });
    return;
  }
  sendJson(res, 200, fromLog);
  return;
}

async function handleTaskCancel(req, res, { params }) {
  const taskId = params.id;
  const task = taskManager.getTask(taskId);
  if (!task) {
    sendJson(res, 404, { error: "task_not_found", message: "没有找到测试任务。" });
    return;
  }
  // 刻意不校验 req.session.username === task.createdBy：取消是止损操作，五人协作里
  // 「A 下班后他卡住的任务能被 B 掐掉」是好事，限权反而放大损失。只如实记下是谁停的。
  const cancelled = await taskManager.cancelTask(task, { actor: req.session?.username || null });
  if (!cancelled) {
    sendJson(res, 409, { error: "task_not_active", message: "任务已结束，不能取消。" });
    return;
  }
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
    files = stats
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 500);
  } catch {
    /* 目录不存在/读失败 → 空列表 */
  }
  sendJson(res, 200, files);
  return;
}

const MAX_BULK_REPORTS = 32;
const MAX_BULK_DOWNLOAD_BYTES = 24 * 1024 * 1024;
const BULK_DOWNLOAD_MAX_CONCURRENT = 1;
const BULK_DOWNLOAD_MAX_QUEUE = 1;
const BULK_DOWNLOAD_RATE_WINDOW_MS = 5 * 60_000;
const BULK_DOWNLOAD_RATE_MAX =
  Number(process.env.EVALUATOR_BULK_DOWNLOAD_RATE_MAX) > 0 ? Number(process.env.EVALUATOR_BULK_DOWNLOAD_RATE_MAX) : 4;
const bulkReportDownloadLimiter = createRateLimiter({ windowMs: BULK_DOWNLOAD_RATE_WINDOW_MS, max: BULK_DOWNLOAD_RATE_MAX });
let activeBulkReportDownloads = 0;
const pendingBulkReportDownloads = [];

function runBulkReportDownload(job) {
  activeBulkReportDownloads += 1;
  return Promise.resolve()
    .then(job)
    .finally(() => {
      activeBulkReportDownloads -= 1;
      const next = pendingBulkReportDownloads.shift();
      if (!next) return;
      runBulkReportDownload(next.job).then(next.resolve, next.reject);
    });
}

function enqueueBulkReportDownload(job) {
  if (activeBulkReportDownloads < BULK_DOWNLOAD_MAX_CONCURRENT) return runBulkReportDownload(job);
  if (pendingBulkReportDownloads.length >= BULK_DOWNLOAD_MAX_QUEUE) {
    throw new HttpRequestError(429, "bulk_download_queue_full", "已有批量导出正在处理，请稍后重试。");
  }
  return new Promise((resolve, reject) => pendingBulkReportDownloads.push({ job, resolve, reject }));
}

function endBulkDownloadResponse(res) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off("finish", onFinish);
      res.off("error", onError);
      res.off("close", onClose);
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("archive_response_closed"));
    };
    res.once("finish", onFinish);
    res.once("error", onError);
    res.once("close", onClose);
    res.end();
  });
}

function selectedReportIds(body) {
  if (!Array.isArray(body?.ids) || body.ids.length === 0) {
    throw new HttpRequestError(400, "invalid_report_selection", "请至少选择一份报告。");
  }
  const ids = [];
  const seen = new Set();
  for (const value of body.ids) {
    if (typeof value !== "string" || !value || sanitizeReportBaseName(value) !== value) {
      throw new HttpRequestError(400, "invalid_report_id", "报告标识无效，请刷新列表后重试。");
    }
    if (!seen.has(value)) {
      seen.add(value);
      ids.push(value);
    }
  }
  if (ids.length > MAX_BULK_REPORTS) {
    throw new HttpRequestError(413, "too_many_reports", `单次最多处理 ${MAX_BULK_REPORTS} 份报告。`);
  }
  return ids;
}

function downloadFileName() {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `api-evaluator-reports-${stamp}.zip`;
}

async function handleReportFilesDownload(req, res) {
  const ids = selectedReportIds(await readJson(req));
  const rate = bulkReportDownloadLimiter.check(req.session?.username || "unknown");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000))));
    sendJson(res, 429, { error: "bulk_download_rate_limited", userMessage: "批量导出过于频繁，请稍后重试。" });
    return;
  }

  await enqueueBulkReportDownload(async () => {
    if (res.destroyed) return;
    const entries = [];
    let totalBytes = 0;
    for (const id of ids) {
      const path = join(REPORTS_DIR, `${id}.html`);
      try {
        const file = await stat(path);
        if (!file.isFile()) throw Object.assign(new Error("report_not_found"), { code: "ENOENT" });
        const size = await countReportFileTextBytes(path, { maxBytes: MAX_BULK_DOWNLOAD_BYTES - totalBytes });
        totalBytes += size;
      } catch (error) {
        if (error?.code === "ENOENT") {
          throw new HttpRequestError(404, "report_not_found", `报告「${id}」不存在或已删除。`);
        }
        if (error?.code === "report_size_limit_exceeded") {
          throw new HttpRequestError(413, "reports_too_large", "所选报告解压后的总大小超过 24 MiB，请减少选择后重试。");
        }
        throw error;
      }
      entries.push({ name: `${id}.html`, path });
    }

    const filename = downloadFileName();
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename=\"${filename}\"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    try {
      await streamZipArchive(
        entries.map((entry) => ({ name: entry.name, stream: createReportFileReadStream(entry.path) })),
        res,
        {
          maxSourceBytes: MAX_BULK_DOWNLOAD_BYTES,
        },
      );
      await endBulkDownloadResponse(res);
    } catch (error) {
      // Headers may already be sent; terminating this response is safer than
      // emitting a corrupt archive or attempting a second JSON response.
      res.destroy(error);
    }
  });
}

async function handleReportFilesBulkDelete(req, res) {
  const ids = selectedReportIds(await readJson(req));
  const deleted = [];
  const failed = [];
  for (const id of ids) {
    const htmlPath = join(REPORTS_DIR, `${id}.html`);
    try {
      await stat(htmlPath);
    } catch (error) {
      failed.push({ id, code: error?.code === "ENOENT" ? "not_found" : "stat_failed" });
      continue;
    }
    try {
      await rm(htmlPath);
      await rm(join(REPORTS_DIR, `${id}.md`), { force: true });
      await deleteReport(id);
      deleted.push(id);
    } catch {
      failed.push({ id, code: "delete_failed" });
    }
  }
  sendJson(res, 200, { requested: ids.length, deleted, failed });
}

// 磁盘剩余空间（评测数据所在分区，非目录用量——够判断"要不要清理"这一件事，不需要递归扫目录）。
async function handleReportsDiskUsage(req, res) {
  const stats = await statfs(DATA_DIR);
  const totalBytes = stats.blocks * stats.bsize;
  const freeBytes = stats.bavail * stats.bsize;
  sendJson(res, 200, {
    totalBytes,
    freeBytes,
    usedPercent: totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 1000) / 10 : 0,
  });
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

// 「模型比对 · 差集场景」：给定两个模型，返回各自【单方独有】的场景（供「补齐单方场景」按钮列出待补清单）。
// 用 pickedA/pickedB（平衡前的各自已测场景全集），不受 balanceCommonReports 的交集裁剪影响。
async function handleReportsCompareGaps(req, res) {
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
  const { onlyA, onlyB } = exclusiveScenarioNames(prep.pickedA, prep.pickedB);
  sendJson(res, 200, { onlyA, onlyB });
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
          {
            ...profile,
            maxTokens: Math.max(Number(profile.maxTokens || 0), 1200),
            timeoutMs: Math.max(Number(profile.timeoutMs || 0), 90000),
          },
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
  const usedNote = (agg) =>
    `${agg.reportCounts.scenario} 场景 / ${agg.reportCounts.run} 稳定性 / ${agg.reportCounts.admission} 准入${agg.reportCounts.load ? ` / ${agg.reportCounts.load} 压测` : ""}`;
  sendCompressedJson(
    res,
    200,
    {
      reportId,
      markdown,
      comparison: buildComparisonView(cmp),
      notes: { a: usedNote(aggA), b: usedNote(aggB), ai: aiNote, aiApplied: Boolean(aiNarrative) },
    },
    req.headers["accept-encoding"],
  );
  return;
}

// 「多模型比对」上限：一次最多并列 6 个对比模型。既防表格列数失控，也防一次请求聚合过多报告
// （每个 peer 都要各自收一遍报告 + 走一次 buildComparison）。
const MULTI_COMPARE_MAX_PEERS = 6;

// 把「模型目标 + 渠道」拼成 buildSubjectSlugIndex 需要的对象列表（含渠道/模型的曾用名），
// 用于把对比报告文件名里切出来的 slug 精确映射回当前的模型目标。
// 顺带带上 protocol / channelStatus：模型档案页要显示它们，而这里已经把渠道和模型目标都取到了，
// 不值得让它另外再查一遍。模型比对那几个消费者只读 targetId/channel/model/aliases，多几个字段无影响。
async function loadCompareSubjects() {
  const [targets, channels] = await Promise.all([loadModelTargets(), loadChannels()]);
  const byId = new Map(channels.map((c) => [c.id, c]));
  return targets
    .map((t) => {
      const ch = byId.get(t.channelId);
      return {
        targetId: t.id,
        channel: ch?.name || "",
        model: t.model || "",
        channelAliases: Array.isArray(ch?.aliases) ? ch.aliases : [],
        modelAliases: Array.isArray(t.aliases) ? t.aliases : [],
        protocol: ch?.protocol || null,
        channelStatus: ch?.status || null,
      };
    })
    .filter((s) => s.channel && s.model);
}

// 「模型比对 · 可比对模型」：反查「曾经和基准模型比对过」的模型列表。
// 比对历史没有专门的库表，只隐式存在于对比报告文件名里（`${slugA}_vs_${slugB}_compare_...`），
// 所以这里扫报告目录、按文件名反查。用 slug 索引精确匹配而非字符串切分——渠道名本身可能含
// 下划线甚至含 `_vs_` 子串，只有「两侧都能命中已知模型」的那个切分点才是真的分隔符。
async function handleReportsComparePeers(req, res) {
  const body = await readJson(req);
  const base = body?.base || {};
  if (!base.channel || !base.model) {
    sendJson(res, 400, { error: "invalid_target", userMessage: "请选择基准模型（渠道 + 模型）。" });
    return;
  }
  const subjects = await loadCompareSubjects();
  const index = buildSubjectSlugIndex(subjects, sanitizeReportBaseName);
  // 基准模型自身的 slug 集合（现用名 + 曾用名组合）：文件任一侧命中其一即算「与基准比对过」。
  const baseSlugs = new Set(buildSubjectSlugIndex([base], sanitizeReportBaseName).keys());
  const idOf = (s) => s.targetId || `${s.channel}\u0000${s.model}`;
  const baseId = idOf(base);

  const names = await listReportMdNames();

  const peers = new Map();
  let unresolved = 0;
  for (const name of names) {
    const parsed = parseCompareReportBaseName(name);
    if (!parsed) continue; // 不是对比报告（单对象报告 / 其它命名）
    // 逐个候选切分点：取第一个「两侧都能解析」的切分。
    let hit = null;
    // 是否存在「有一侧是基准」的切分：决定解析失败时该不该计入 unresolved。
    let baseInvolved = false;
    for (const [slugA, slugB] of parsed.splits) {
      const isBaseA = baseSlugs.has(slugA);
      const isBaseB = baseSlugs.has(slugB);
      if (isBaseA || isBaseB) baseInvolved = true;
      const subjA = index.get(slugA) || (isBaseA ? base : null);
      const subjB = index.get(slugB) || (isBaseB ? base : null);
      if (!subjA || !subjB) continue;
      hit = { slugA, slugB, subjA, subjB, isBaseA, isBaseB };
      break;
    }
    if (!hit) {
      // 只统计「基准在其中一侧、另一侧对应不上」的报告——那才是本页要提醒用户的漏项。
      // 两侧都跟基准无关的历史报告（比如另外两个模型互比、其中一方已删除）不计入：
      // 否则用户选个基准就被告知「另有 N 份无法对应」，而那 N 份跟他选的基准毫无关系。
      if (baseInvolved) unresolved += 1;
      continue;
    }
    // 只保留「一侧是基准」的报告；另一侧即候选 peer。两侧都是基准（自己跟自己比）→ 跳过。
    const baseOnA = hit.isBaseA || idOf(hit.subjA) === baseId;
    const baseOnB = hit.isBaseB || idOf(hit.subjB) === baseId;
    if (baseOnA === baseOnB) continue;
    const peer = baseOnA ? hit.subjB : hit.subjA;
    if (idOf(peer) === baseId) continue;

    const key = idOf(peer);
    const stamp = `${parsed.date}${parsed.time}`;
    const existing = peers.get(key);
    if (existing) {
      existing.compareCount += 1;
      if (stamp > existing.stamp) {
        existing.stamp = stamp;
        existing.lastReportId = name.replace(/\.md$/i, "");
      }
    } else {
      peers.set(key, {
        targetId: peer.targetId || null,
        channel: peer.channel,
        model: peer.model,
        compareCount: 1,
        stamp,
        lastReportId: name.replace(/\.md$/i, ""),
      });
    }
  }

  // lastComparedAt：文件名里的时间戳就是出报告时的本机本地时间（compactDate），
  // 这里只做显示用的格式化，不假装它是 UTC/带时区的时刻。
  const fmtStamp = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
  const list = [...peers.values()]
    .sort((x, y) => (x.stamp === y.stamp ? x.model.localeCompare(y.model, "zh") : y.stamp.localeCompare(x.stamp)))
    .map(({ stamp, ...rest }) => ({ ...rest, lastComparedAt: fmtStamp(stamp) }));
  sendJson(res, 200, { peers: list, unresolved });
  return;
}

// 「模型比对 · 多模型并列」：一个基准模型 + 1~6 个对比模型，产出列数可变的对比表（只在前端展示，
// 不落报告文件）。两遍计算：
//   Pass 1 —— 逐个 peer 算出它与基准的共有场景，再对所有 peer 取交集，得到「N 方共享场景集」；
//   Pass 2 —— 用这个共享场景集把基准【只聚合一次】，各 peer 各聚合一次，逐个走 buildComparison。
// 为什么基准只聚合一次：N 列必须共享同一份基准画像，否则「基准列」的数字会随勾选了哪些 peer 而变。
// buildComparison 会就地改写 a.scenarioPass（入参），这里安全的原因是每个 peer 的 matched 场景集
// 恒等于共享场景集 → 每次写入的值相同（幂等）。若将来放宽共享场景口径，这个前提会失效。
async function handleReportsCompareMulti(req, res) {
  const body = await readJson(req);
  const base = body?.base || {};
  const rawPeers = Array.isArray(body?.peers) ? body.peers : [];
  if (!base.channel || !base.model) {
    sendJson(res, 400, { error: "invalid_target", userMessage: "请选择基准模型（渠道 + 模型）。" });
    return;
  }
  const idOf = (s) => s.targetId || `${s.channel}\u0000${s.model}`;
  const baseId = idOf(base);
  // 去重 + 剔除与基准同一个模型（自己跟自己并列没有意义）。
  const seen = new Set();
  const peerList = [];
  for (const p of rawPeers) {
    if (!p?.channel || !p?.model) continue;
    const key = idOf(p);
    if (key === baseId || seen.has(key)) continue;
    seen.add(key);
    peerList.push(p);
  }
  if (!peerList.length) {
    sendJson(res, 400, { error: "invalid_target", userMessage: "请至少勾选一个与基准不同的对比模型。" });
    return;
  }
  if (peerList.length > MULTI_COMPARE_MAX_PEERS) {
    sendJson(res, 400, {
      error: "too_many_peers",
      userMessage: `一次最多并列 ${MULTI_COMPARE_MAX_PEERS} 个对比模型，请减少勾选。`,
    });
    return;
  }

  const names = await listReportMdNames();
  const baseFiles = await collectSubjectReportFiles(names, base);
  if (!baseFiles.length) {
    sendJson(res, 400, {
      error: "no_reports",
      userMessage: `基准模型暂无可用于对比的报告：${base.channel} / ${base.model}。请先为它跑一次准入 / 稳定性 / 场景测试。`,
    });
    return;
  }
  const pickedBase = pickRecentReports(baseFiles);
  await attachSummaries(pickedBase);

  // —— Pass 1：逐个 peer 求「与基准的共有场景」，无任何可比数据的 peer 记入 skipped ——
  const labelOf = (s) => `${s.channel} / ${s.model}`;
  const skipped = [];
  const prepared = [];
  for (const peer of peerList) {
    const peerFiles = await collectSubjectReportFiles(names, peer);
    if (!peerFiles.length) {
      skipped.push({ label: labelOf(peer), reason: "暂无可用于对比的报告" });
      continue;
    }
    const pickedPeer = pickRecentReports(peerFiles);
    await attachSummaries(pickedPeer);
    // balanceCommonReports 只用来判「有没有可比的东西」与算共有场景；Pass 2 用未平衡的 picked，
    // 因为「双方共有才纳入」是两方概念，套到 N 列上会让基准的数字随勾选组合变化。
    const [balBase, balPeer] = balanceCommonReports(pickedBase, pickedPeer);
    if (!balBase.length || !balPeer.length) {
      skipped.push({ label: labelOf(peer), reason: "与基准没有共同的场景 / 测试种类" });
      continue;
    }
    prepared.push({
      peer,
      pickedPeer,
      common: commonScenarioNames(balBase, balPeer).map((s) => s.name),
    });
  }
  if (!prepared.length) {
    sendJson(res, 400, {
      error: "no_common_reports",
      userMessage: `所选对比模型都无法与基准并列：${skipped.map((s) => `${s.label}（${s.reason}）`).join("、")}。`,
    });
    return;
  }

  // N 方共享场景集 = 各 peer 与基准共有场景再取交集。空集也照样传下去（而不是退回"各用各的"）：
  // 那样基准列会随 peer 变化，破坏「N 列共享同一基准」的前提。此时场景派生指标为空，notes 里说明。
  let shared = new Set(prepared[0].common);
  for (const p of prepared.slice(1)) {
    const s = new Set(p.common);
    shared = new Set([...shared].filter((n) => s.has(n)));
  }

  // —— Pass 2：基准只聚合一次，各 peer 各聚合一次 ——
  const baseAgg = aggregateSubject({ files: pickedBase, label: labelOf(base), scenarioFilter: shared });
  const pairs = prepared.map(({ peer, pickedPeer }) => {
    const agg = aggregateSubject({ files: pickedPeer, label: labelOf(peer), scenarioFilter: shared });
    return { agg, cmp: buildComparison(baseAgg, agg) };
  });

  const usedNote = (agg) =>
    `${agg.reportCounts.scenario} 场景 / ${agg.reportCounts.run} 稳定性 / ${agg.reportCounts.admission} 准入${agg.reportCounts.load ? ` / ${agg.reportCounts.load} 压测` : ""}`;
  sendCompressedJson(
    res,
    200,
    {
      comparison: buildMultiComparisonView({ baseAgg, pairs, sharedScenarios: [...shared] }),
      skipped,
      notes: {
        base: usedNote(baseAgg),
        peers: pairs.map((p) => ({ label: p.agg.label, used: usedNote(p.agg) })),
        sharedScenarioCount: shared.size,
      },
    },
    req.headers["accept-encoding"],
  );
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
  const regressionAlerts = (await queryRegressionAlerts(soloProfileId ? { profileId: soloProfileId, limit: 200 } : { limit: 200 })).filter(
    (a) => withinWindow(a.created_at),
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
  const baseName = soloSlug
    ? `${soloSlug}_autodigest_${stamp}_${randomUUID().slice(0, 4)}`
    : `autodigest_${stamp}_${randomUUID().slice(0, 4)}`;
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
    const html = await readReportFileText(join(REPORTS_DIR, `${id}.html`));
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
// 「模型档案」：单个模型目标的完整画像 —— 指标当前值（aggregateSubject 读既有报告）
// + 历史曲线与 90 天可用性（buildProfileTrend 读 SQLite）+ 回归告警。
//
// 与 /api/reports/compare 的关系：那个是「两个对象比较」，走 loadBalancedCompareFiles 把双方
// 报告平衡成共有集；这里是「一个对象的自我画像」，不需要平衡，直接 pickRecentReports 取最近若干份。
// 只读，不发起任何测试。
async function handleModelProfile(req, res, { url }) {
  const targetId = url.searchParams.get("targetId") || "";
  if (!targetId) {
    sendJson(res, 400, { error: "missing_target", userMessage: "请提供 targetId。" });
    return;
  }
  const subjects = await loadCompareSubjects();
  const subject = subjects.find((s) => s.targetId === targetId);
  if (!subject) {
    sendJson(res, 404, { error: "target_not_found", userMessage: "找不到这个模型目标（可能已被删除）。" });
    return;
  }

  const names = await listReportMdNames();
  // splitAdmissionBudget：档案页要如实显示准入等级，不能被密集的稳定性报告挤掉（见该选项的注释）。
  const files = await collectSubjectReportFiles(names, subject, { splitAdmissionBudget: true });
  const picked = pickRecentReports(files);
  // 报告的结构化 summary（test_runs.raw_json）：让场景报告不必从渲染后的 markdown 表格反解析数字。
  // 与 loadBalancedCompareFiles 同样的处理，取不到就照旧解析 md（老报告/孤儿报告/库不可用都得能看）。
  await attachSummaries(picked);
  const agg = aggregateSubject({ files: picked, label: `${subject.channel} / ${subject.model}` });

  // 趋势与告警按 profileId(=targetId) 查库，与「稳定性趋势」页同一数据源。
  // 无报告也要能出页面：此时 agg 各项为空，趋势仍可能有数据（反之亦然），
  // 两边独立缺失都不该让整页 500。
  const [trend, alerts] = await Promise.all([
    buildProfileTrend(targetId, { limit: 200 }),
    queryRegressionAlerts({ profileId: targetId, limit: 50 }),
  ]);

  const lastTested = (await queryLastTestedByProfile())[targetId] || null;
  const view = buildModelProfileView({
    agg,
    trend,
    alerts,
    target: {
      id: targetId,
      channel: subject.channel,
      model: subject.model,
      protocol: subject.protocol,
      channelStatus: subject.channelStatus,
      lastTestedAt: lastTested,
    },
  });
  // 场景明细可达数十条、trend.rounds 可达数千条 —— 压缩后再发（同报告类端点的做法）。
  sendCompressedJson(res, 200, view, req.headers["accept-encoding"]);
  return;
}

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
  sendJson(
    res,
    200,
    (await querySpendSummary({ runBy, sinceMs })) || { runs: 0, totalActualCost: 0, totalEstimatedCost: 0, currency: "USD" },
  );
  return;
}

async function handleSupportBundle(req, res) {
  const profiles = await loadProfiles();
  const requests = await readRecentRequests();
  const testRuns = await readRecentTestRuns();
  const tasks = await readRecentTasks(taskManager.tasks, taskManager.publicTask);
  const errors = await readRecentErrors();
  const storage = getDbHealth();
  sendCompressedJson(
    res,
    200,
    buildSupportBundle({ profiles, requests, testRuns, tasks, errors, storage }),
    req.headers["accept-encoding"],
  );
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

async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

// 目录式路径 → 该目录下的 index.html。用于「模型档案」这类独立子页面（/model-profile/）。
// 只认**显式以 / 结尾**的路径，不做 SPA 式的 catch-all 回退：未知路径仍应 404，
// 否则拼错的资源路径会被静默喂回一个 HTML，排障时看到的是「脚本语法错误」而非 404。
function resolveStaticRequestPath(rawPathname) {
  if (rawPathname === "/") return "/index.html";
  if (rawPathname.endsWith("/")) return `${rawPathname}index.html`;
  return rawPathname;
}

async function serveStatic(req, res) {
  const rawPathname = getRawRequestPathname(req.url);
  // /model-profile → /model-profile/ ：少一条斜杠就 404 对用户太苛刻（手输、复制粘贴都会掉）。
  // 只对「确实存在同名目录且其中有 index.html」的路径重定向，不做通用兜底。
  if (!rawPathname.endsWith("/") && !extname(rawPathname)) {
    const asDir = resolveRequestPathInside(STATIC_ROOT, `${rawPathname}/index.html`);
    if (asDir && (await fileExists(asDir))) {
      res.writeHead(308, { location: `${rawPathname}/` });
      res.end();
      return;
    }
  }
  const requestedPath = resolveStaticRequestPath(rawPathname);
  const staticPath = resolveRequestPathInside(STATIC_ROOT, requestedPath);
  if (!staticPath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const content = await readFile(staticPath);
    const mimeType = MIME_TYPES[extname(staticPath)] || "application/octet-stream";
    const securityHeaders = staticSecurityHeaders(staticPath);
    const acceptEncoding = req.headers["accept-encoding"];

    await sendCompressedStatic(res, staticPath, content, mimeType, securityHeaders, acceptEncoding, {
      ifNoneMatch: req.headers["if-none-match"],
    });
    return;
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}
