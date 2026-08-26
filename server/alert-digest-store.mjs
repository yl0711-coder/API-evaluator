// server/alert-digest-store.mjs
// 报警汇总：开关/节奏配置 + 待发队列。
//
// 【为什么要有这一层】原本每个（目标 × 规则）命中即发一封信 —— N 个渠道在同一时段跑定时测试、
// 各配 M 条规则，一批下来最多 N×M 封，收件人被淹没。改为：定时运行命中的报警先入队列，
// 到汇总时刻一次发一封；队列空也发（附本时段实测数字），让「没收到信」不再有歧义
// ——收不到信只可能是没跑测试或发信坏了，不会是"跑了但都正常所以没发"。
//
// 两份数据分开存，与 alert-rules.json / alert-rule-state.json 的分法同理：
//   config —— 低频写（管理员改设置），可以和规则定义一样被人直接读；
//   queue  —— 高频写（每次命中都追加），独立文件避免频繁写入污染配置。
//
// 持久层范式沿用 alert-rules-store：writeJsonAtomic 原子写 + 一把锁串行化读改写。
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { ALERT_DIGEST_CONFIG_FILE, ALERT_DIGEST_QUEUE_FILE } from "./paths.mjs";
import { writeJsonAtomic } from "./utils.mjs";

// 队列条目上限（alerts / runs 各自独立计）。SMTP 连续故障时队列只增不减，
// 无上限会把配置盘写爆、并让某次汇总信长到发不出去。
// 溢出时丢【最旧】的：报警的价值随时间衰减，最近的更值得送达。
export const MAX_QUEUE_ENTRIES = 500;

// 哪些自动测试作业的报警走汇总。
//   all      —— 全部自动测试作业，日后新建的作业【自动包含】；
//   selected —— 只有 jobIds 里列出的作业，日后新建的作业【不包含】（其报警按老规矩立即发信）。
// 语义要点：不在汇总范围内 ≠ 不报警。它只是不攒着，而是命中即发 —— 与关掉汇总时的行为一致。
// 绝不能理解成「静默」：那会让「取消勾选」变成一个悄悄关掉报警的开关，是最危险的误解。
export const JOB_SCOPES = ["all", "selected"];

const DEFAULTS = {
  // 默认关闭：装了这个版本的现有用户行为完全不变（仍是命中即发），要汇总得显式开。
  enabled: false,
  // 汇总时刻。默认每天 09:07 —— 避开整点，跟 cron 调度那边同一个考虑（整点是所有人的默认值，
  // 容易和别的定时任务撞在一起）。
  cron: "7 9 * * *",
  jobScope: "all",
  jobIds: [],
};

let configFile = ALERT_DIGEST_CONFIG_FILE;
let queueFile = ALERT_DIGEST_QUEUE_FILE;

export function __setDigestFilesForTest({ config, queue } = {}) {
  configFile = config || ALERT_DIGEST_CONFIG_FILE;
  queueFile = queue || ALERT_DIGEST_QUEUE_FILE;
}

// —— 配置 ——

function normalizeConfig(raw) {
  const cron = typeof raw?.cron === "string" && raw.cron.trim() ? raw.cron.trim() : DEFAULTS.cron;
  // 脏 jobScope 落回 "all"：宁可多汇总，不可因脏数据把某些作业的报警变成「立即发」而让人措手不及。
  const jobScope = JOB_SCOPES.includes(raw?.jobScope) ? raw.jobScope : DEFAULTS.jobScope;
  const jobIds = Array.isArray(raw?.jobIds)
    ? [...new Set(raw.jobIds.map((x) => String(x ?? "").trim()).filter(Boolean))].slice(0, 500)
    : [];
  return {
    enabled: raw?.enabled === true,
    cron,
    jobScope,
    jobIds,
    // 上次汇总发信时刻（ISO）。用于算下一个到期时刻；null = 从未发过。
    lastDigestAt: typeof raw?.lastDigestAt === "string" && raw.lastDigestAt ? raw.lastDigestAt : null,
    // 下一个到期时刻（ISO）。由 cron 算出并持久化，进程重启后凭它追补，与自动测试作业同一思路。
    nextDigestAt: typeof raw?.nextDigestAt === "string" && raw.nextDigestAt ? raw.nextDigestAt : null,
  };
}

// 这次运行的报警该不该攒进汇总。纯函数，便于单测。
//
// jobId 为空 = 无从判断是哪个作业触发的（手动测试，或调度器没传上下文）。
// 此时【不攒】—— 与 evaluateAlertRules 里「source 缺省视为手动」同一保守取向：
// 宁可多发几封立即信，不可把报警攒进一个可能几小时后才发的队列。
export function jobInDigestScope(config, jobId) {
  if (!config?.enabled) return false;
  if (config.jobScope === "selected") {
    if (!jobId) return false;
    return Array.isArray(config.jobIds) && config.jobIds.includes(jobId);
  }
  return true; // "all"：全部自动测试作业，含日后新建的
}

export async function loadDigestConfig() {
  try {
    if (!existsSync(configFile)) return normalizeConfig(null);
    return normalizeConfig(JSON.parse((await readFile(configFile, "utf8")) || "{}"));
  } catch {
    return normalizeConfig(null);
  }
}

let configChain = Promise.resolve();
// 串行化读改写，与 alert-rules-store.updateRules 同形：load → mutator(原地改) → 原子写。
export function updateDigestConfig(mutator) {
  const runOnce = async () => {
    const cfg = await loadDigestConfig();
    const value = await mutator(cfg);
    await writeJsonAtomic(configFile, cfg);
    return value;
  };
  const next = configChain.then(runOnce, runOnce);
  configChain = next.then(
    () => {},
    () => {},
  );
  return next;
}

// —— 待发队列 ——

// 队列形状：{ alerts: [...], runs: [...] }。
// 【为什么 runs 也要记】你选了「冷却期内完全不出现」，于是一个持续挂着的渠道进入冷却后，
// 本时段可能一条报警都不入队 —— 若汇总信此时只说「无报警」，读信人会理解成"一切正常"，
// 而真相是"我们已经报过、现在不重复"。把本时段实际跑了哪些目标、各自的实测数字一并列出，
// 难看的数字自己会说话：信里不下"全部稳定"这种断言，只陈述事实。
// 与 regression.mjs 里 incomparable 分支防的是同一类错误——不把「不知道」或「不再重复说」
// 讲成「没问题」。
function normalizeQueue(raw) {
  const list = (v) => (Array.isArray(v) ? v.filter((e) => e && typeof e === "object") : []);
  // 兼容早期纯数组形状（若有人升级中途落过盘）：整个数组当成 alerts。
  if (Array.isArray(raw)) return { alerts: list(raw), runs: [] };
  return { alerts: list(raw?.alerts), runs: list(raw?.runs) };
}

export async function loadQueue() {
  try {
    if (!existsSync(queueFile)) return { alerts: [], runs: [] };
    return normalizeQueue(JSON.parse((await readFile(queueFile, "utf8")) || "{}"));
  } catch {
    return { alerts: [], runs: [] };
  }
}

// 溢出裁剪：只留最近 MAX_QUEUE_ENTRIES 条。
function capList(arr) {
  if (arr.length > MAX_QUEUE_ENTRIES) arr.splice(0, arr.length - MAX_QUEUE_ENTRIES);
}

let queueChain = Promise.resolve();
function updateQueue(mutator) {
  const runOnce = async () => {
    const queue = await loadQueue();
    const value = await mutator(queue);
    await writeJsonAtomic(queueFile, queue);
    return value;
  };
  const next = queueChain.then(runOnce, runOnce);
  queueChain = next.then(
    () => {},
    () => {},
  );
  return next;
}

// 入队一条命中。返回入队后的 alerts 长度。
// 【必须串行化】批量稳定性一次运行有 N 个 target，各自命中会并发调本函数；
// 非串行的读改写会让后写的覆盖先写的，报警静默丢失。
export async function enqueueAlert(entry) {
  return updateQueue((queue) => {
    queue.alerts.push({
      at: new Date().toISOString(),
      ruleId: entry?.ruleId || "",
      ruleName: entry?.ruleName || "",
      ruleKind: entry?.ruleKind || "threshold",
      targetId: entry?.targetId || "",
      targetLabel: entry?.targetLabel || "",
      reason: entry?.reason || "",
      // 折叠判据（不含实测值，见 alert-rules-evaluator.hitKeyOf）。缺省时 collapseRepeats
      // 会退回用 reason 当键——那是老队列文件的行为，折叠不住但不会出错。
      reasonKey: entry?.reasonKey || "",
      runId: entry?.runId || "",
    });
    capList(queue.alerts);
    return queue.alerts.length;
  });
}

// 入队一条「本时段跑过什么」的记录（无论是否命中报警）。汇总信用它列实测数字。
//
// 【按目标覆盖，不追加】同一目标在一个汇总窗口内只保留最后一次，另记本窗口内跑了几次。
// 汇总表本来就只显示每目标的最后一次，所以追加没有信息增益，却会引入一个真实故障：
// runs 自己有 500 条上限（与 alerts 各自独立计，非共用一个池）、裁剪时丢最旧的，
// 于是追加式记账下【一个吵闹的渠道会把安静的渠道整个挤出汇总表】。
// 实测：一个渠道每分钟一测（550 条）+ 一个成功率仅 10% 的安静渠道，
// 裁剪后安静渠道被挤光——恰恰是最该被看到的那个消失了。
// 覆盖式记账让 runs 的条数上界变成「目标数」，与测试频率无关，这个失败模式随之消失。
export async function enqueueRun(entry) {
  const targetId = entry?.targetId || "";
  return updateQueue((queue) => {
    const next = {
      at: new Date().toISOString(),
      targetId,
      targetLabel: entry?.targetLabel || "",
      testType: entry?.testType || "",
      runId: entry?.runId || "",
      // 只留展示要用的几个量，不整份 summary 入队（那会让队列文件迅速膨胀）。
      successRate: entry?.successRate ?? null,
      p95TotalMs: entry?.p95TotalMs ?? null,
      grade: entry?.grade || null,
      runCount: 1,
    };
    const idx = queue.runs.findIndex((r) => (r.targetId || "") === targetId);
    if (idx >= 0) {
      next.runCount = (Number(queue.runs[idx].runCount) || 1) + 1;
      queue.runs[idx] = next;
    } else {
      queue.runs.push(next);
    }
    capList(queue.runs);
    return queue.runs.length;
  });
}

// 取出并清空队列，一次原子操作。返回 { alerts, runs }。
// 【为什么必须原子】若分成「读 → 发信 → 清空」，发信那几秒里新命中的报警会被随后的清空吞掉。
// 这里先把内容取走再清空，发信失败由调用方回填（见 requeue）。
export async function drainQueue() {
  return updateQueue((queue) => {
    const taken = { alerts: queue.alerts.slice(), runs: queue.runs.slice() };
    queue.alerts.length = 0;
    queue.runs.length = 0;
    return taken;
  });
}

// 移除某条规则在队列里尚未发出的报警，返回移除条数。规则被删除时调用。
// 运行记录（runs）不动：它记的是「跑了什么」，与哪条规则无关。
export async function removeAlertsByRule(ruleId) {
  if (!ruleId) return 0;
  return updateQueue((queue) => {
    const before = queue.alerts.length;
    queue.alerts = queue.alerts.filter((a) => a?.ruleId !== ruleId);
    return before - queue.alerts.length;
  });
}

// 发信失败时把取走的内容放回队列头部（它们比队列里现有的更旧），下个周期重试。
export async function requeue(taken) {
  const alerts = Array.isArray(taken?.alerts) ? taken.alerts : [];
  const runs = Array.isArray(taken?.runs) ? taken.runs : [];
  if (!alerts.length && !runs.length) return { alerts: 0, runs: 0 };
  return updateQueue((queue) => {
    queue.alerts.unshift(...alerts);
    queue.runs.unshift(...runs);
    capList(queue.alerts);
    capList(queue.runs);
    return { alerts: queue.alerts.length, runs: queue.runs.length };
  });
}

// —— 测试钩子 ——
export function __resetDigestChainsForTest() {
  configChain = Promise.resolve();
  queueChain = Promise.resolve();
}
