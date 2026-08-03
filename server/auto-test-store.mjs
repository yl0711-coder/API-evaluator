// server/auto-test-store.mjs
// 自动测试作业存储（纯 JSON，仿 model-target-store）：超管在「自动测试配置」页配置的定时测试作业，
// 按 id 存进持久卷 /data 下的 AUTO_TEST_JOBS_FILE。作业只是纯数据，绝不含密钥（targetId 指向 model-target，
// 密钥在渠道加密库）。load/save 用 writeJsonAtomic 原子写，防写一半崩溃损坏 JSON。
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { AUTO_TEST_JOBS_FILE } from "./paths.mjs";
import { writeJsonAtomic } from "./utils.mjs";
import { parseCron, cronNextAfter } from "./cron-schedule.mjs";

// 支持的测试种类：均有独立后端 runner 入口（见 auto-test-scheduler 的 kind→runner 映射）。
export const AUTO_TEST_KINDS = ["quick", "admission", "stability", "scenario"];

let jobsFile = AUTO_TEST_JOBS_FILE;

export function __setJobsFileForTest(file) {
  jobsFile = file || AUTO_TEST_JOBS_FILE;
}

export async function loadJobs() {
  try {
    if (!existsSync(jobsFile)) return [];
    const raw = JSON.parse((await readFile(jobsFile, "utf8")) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.map((job) => normalizeJob(job, job)).filter(Boolean);
  } catch {
    return [];
  }
}

export async function saveJobs(jobs) {
  await writeJsonAtomic(jobsFile, Array.isArray(jobs) ? jobs : []);
}

// 抛出此错误的 updateJobs mutator 表示"校验失败、勿保存"，端点据此回 400。
export class JobValidationError extends Error {}

// 串行化的读改写：load → mutator(jobs)（原地改数组）→ save，全程一把锁排队。
// 消除并发写竞争——调度器回写 lastRunAt 与端点增删改共用同一条链，绝不互相覆盖。
// mutator 可返回一个值（如刚 upsert 的作业），updateJobs 解析为该值；mutator 抛错则不落盘。
let writeChain = Promise.resolve();
export function updateJobs(mutator) {
  const runOnce = async () => {
    const jobs = await loadJobs();
    const value = await mutator(jobs); // 原地改 jobs；抛错 → 下面 saveJobs 不执行
    await saveJobs(jobs);
    return value;
  };
  const next = writeChain.then(runOnce, runOnce); // 无论前一次成败都接着排队
  writeChain = next.then(
    () => {},
    () => {},
  ); // 链本身吞掉结果/错误，各调用方只看自己的 next
  return next;
}

export function __resetWriteChainForTest() {
  writeChain = Promise.resolve();
}

// 下次运行时刻。双模式：
//   - 数字入参 computeNextRunAt(periodHours, fromMs)：间隔模式，推 periodHours 小时（老调用，保持兼容）。
//   - 对象入参 computeNextRunAt(job, fromMs)：有 job.cron 走 cron；否则退回 job.periodHours 间隔。
// cron 366 天内无匹配（见下方分支注释：真实可构造，非纯理论）时回退成 24h 间隔，绝不返回 null 卡死调度。
export function computeNextRunAt(jobOrPeriod, fromMs = Date.now()) {
  if (jobOrPeriod && typeof jobOrPeriod === "object") {
    const job = jobOrPeriod;
    if (job.cron) {
      const next = cronNextAfter(job.cron, fromMs);
      if (next != null) return new Date(next).toISOString();
      // cron 解析【语法】合法但 366 天内无匹配日期时才会落到这里——不是"不该发生"的兜底，
      // 而是真实可构造的输入（如 `0 0 30 2 *`：2 月没有 30 号，永远不会命中）。validateJob 只查
      // parseCron 是否抛错，不检查语义上"是否存在任何匹配日期"，故这类表达式会通过校验，
      // 然后在这里悄悄退回每天固定时间跑一次，用户毫无提示地得到一个跟预期完全不同的调度。
      // 已知问题（暂不修）：改进方向是 validateJob 里试算一次 cronNextAfter，无匹配就直接拒绝保存。
      return new Date(fromMs + 24 * 3600 * 1000).toISOString();
    }
    return intervalNextRunAt(job.periodHours, fromMs);
  }
  return intervalNextRunAt(jobOrPeriod, fromMs);
}

function intervalNextRunAt(periodHours, fromMs) {
  const hours = Math.max(0.1, Number(periodHours) || 0.1);
  return new Date(fromMs + hours * 3600 * 1000).toISOString();
}

// 规范化：只认已知字段 + 类型强制，杜绝脏数据。existing 用于保留运行态字段（lastRunAt 等）与 id/createdAt。
export function normalizeJob(raw, existing = null) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id ?? existing?.id ?? "").trim() || `atj_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const kind = AUTO_TEST_KINDS.includes(raw.kind) ? raw.kind : String(existing?.kind || "quick");
  // 周期允许小数、最短 0.1 小时（6 分钟）；无效/非正 → 默认 24。保留两位小数避免浮点噪声。
  const rawPeriod = Number(raw.periodHours ?? existing?.periodHours);
  const periodHours = Number.isFinite(rawPeriod) && rawPeriod > 0 ? Math.max(0.1, Math.round(rawPeriod * 100) / 100) : 24;
  const scenarioIds = Array.isArray(raw.scenarioIds)
    ? [...new Set(raw.scenarioIds.map((x) => String(x ?? "").trim()).filter(Boolean))]
    : Array.isArray(existing?.scenarioIds)
      ? existing.scenarioIds
      : [];
  const rawOptions = raw.options && typeof raw.options === "object" ? raw.options : existing?.options || {};
  const options = normalizeOptions(rawOptions);
  // cron 表达式（可选）：非空即启用 cron 调度、periodHours 作后备保留。空串=用间隔模式。
  const cron = String(raw.cron ?? existing?.cron ?? "")
    .trim()
    .slice(0, 120);
  return {
    id,
    name: String(raw.name ?? existing?.name ?? "")
      .trim()
      .slice(0, 120),
    targetId: String(raw.targetId ?? existing?.targetId ?? "").trim(),
    kind,
    periodHours,
    cron,
    scenarioIds,
    options,
    enabled: raw.enabled === undefined ? existing?.enabled !== false : Boolean(raw.enabled),
    createdAt: existing?.createdAt || raw.createdAt || new Date().toISOString(),
    // 运行态字段：仅由调度器写；规范化时保留既有值（新建时为空）。
    lastRunAt: existing?.lastRunAt ?? raw.lastRunAt ?? null,
    nextRunAt: raw.nextRunAt ?? existing?.nextRunAt ?? null,
    lastStatus: existing?.lastStatus ?? raw.lastStatus ?? null,
    lastReportId: existing?.lastReportId ?? raw.lastReportId ?? null,
    lastError: existing?.lastError ?? raw.lastError ?? null,
    // 连续失败计数 + 自动停用时刻（熔断用）：同为运行态，须在此保留，否则每次 load 归一化会丢失、熔断永不生效。
    consecutiveFailures: clampFailures(existing?.consecutiveFailures ?? raw.consecutiveFailures),
    autoDisabledAt: existing?.autoDisabledAt ?? raw.autoDisabledAt ?? null,
  };
}

function clampFailures(v) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 稳定性「测试文案分组」：{presetId, prompt, repeats}[]，与 test-runner.mjs 的 normalizeStabilityGroups
// 同一套校验口径（repeats 夹 [1,20]，非法/数量<=0 项丢弃）。预设 id 允许任意字符串（前端自定义预设时也能存），
// 只做类型强制与截断，不校验是否在已知预设表里——已知预设表随时可能改，作业存储不该耦合它。
function normalizeStabilityGroupsOption(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((group) => {
      if (!group || typeof group !== "object") return null;
      const repeats = Math.floor(Number(group.repeats));
      if (!Number.isFinite(repeats) || repeats <= 0) return null;
      return {
        presetId: typeof group.presetId === "string" && group.presetId ? group.presetId.slice(0, 64) : null,
        prompt: typeof group.prompt === "string" ? group.prompt.slice(0, 4000) : "",
        repeats: Math.min(20, Math.max(1, repeats)),
      };
    })
    .filter(Boolean);
}

// 迁移改造前保存的扁平字段（rounds/promptPresetId/prompt）到单组 groups，供 normalizeOptions 在
// 没有 groups 时兜底。normalizeJob 每次 load 都会重新 normalize 一遍旧作业，若不迁移，旧作业的
// 轮数与自定义文案会在这里被悄悄丢弃、退化成运行期默认的 10 轮基础文案——这是数据丢失，不是兼容。
function migrateLegacyStabilityOptions(raw) {
  if (!("rounds" in raw) && !("prompt" in raw) && !("promptPresetId" in raw)) return [];
  const repeats = Math.floor(Number(raw.rounds));
  const presetId = typeof raw.promptPresetId === "string" && raw.promptPresetId ? raw.promptPresetId.slice(0, 64) : "basic";
  const prompt = typeof raw.prompt === "string" ? raw.prompt.slice(0, 4000) : "";
  return [{ presetId, prompt, repeats: Number.isFinite(repeats) && repeats > 0 ? Math.min(20, repeats) : 10 }];
}

function normalizeOptions(raw) {
  const clampInt = (v, min, max, dflt) => {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
  };
  const groups = Array.isArray(raw.groups) ? normalizeStabilityGroupsOption(raw.groups) : migrateLegacyStabilityOptions(raw);
  return {
    concurrency: clampInt(raw.concurrency, 1, 5, 1),
    repeats: clampInt(raw.repeats, 1, 5, 1),
    packageLevel: ["quick", "standard", "deep"].includes(raw.packageLevel) ? raw.packageLevel : "standard",
    // 稳定性「测试文案分组」：多组预设+数量，取代原来的单预设+单轮数（rounds/promptPresetId/prompt）。
    groups,
  };
}

// 校验：返回可读错误串，null 表示通过。referential 校验（targetId 是否可运行）在端点层做。
export function validateJob(job) {
  if (!job || typeof job !== "object") return "作业必须是对象。";
  if (!job.targetId) return "请选择被测渠道与模型。";
  if (!AUTO_TEST_KINDS.includes(job.kind)) return "测试种类不合法。";
  // 稳定性作业至少要有一个数量>0 的文案分组，否则调度器触发时无题可测。
  if (job.kind === "stability" && !(job.options?.groups?.length > 0)) return "请至少选择一个测试文案分组（数量框大于 0）。";
  // cron 模式：校验表达式合法即可，periodHours 只作后备不强校验。
  if (job.cron) {
    try {
      parseCron(job.cron);
    } catch (error) {
      return `定时表达式不合法：${error.message}`;
    }
    return null;
  }
  // 间隔模式：要求 periodHours ≥ 0.1（6 分钟）。
  if (!(Number.isFinite(job.periodHours) && job.periodHours >= 0.1)) return "测试周期必须是不小于 0.1 的数（小时）。";
  return null;
}
