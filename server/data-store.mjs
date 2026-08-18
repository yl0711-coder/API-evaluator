// server/data-store.mjs
// 数据目录布局与读取：确保可见的数据目录结构、迁移旧版 app-data，
// 读取最近的请求 / 错误 / 测试运行 / 任务记录。
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { envCompat } from "./env-compat.mjs";
import {
  CONFIG_DIR,
  DATA_DIR,
  ERROR_LOG_FILE,
  LEGACY_DATA_DIR,
  LOGS_DIR,
  PROFILES_FILE,
  REPORTS_DIR,
  REQUEST_LOG_FILE,
  RUNTIME_DIR,
  TASK_EVENTS_FILE,
  TEST_RUNS_FILE,
  VAULT_DIR,
  LOCAL_SECRET_FILE,
  LOCAL_VAULT_FILE,
} from "./paths.mjs";
import { readTextTail, safeJson } from "./utils.mjs";
import {
  countRequests,
  importRequestsFromJsonl,
  isSqliteAvailable,
  markInterruptedEvaluationTasks,
  queryEvaluationTask,
  queryRecentEvaluationTasks,
  queryRecentRequests,
  queryRecentTestRuns,
} from "./db.mjs";

export async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(CONFIG_DIR, { recursive: true });
  await mkdir(LOGS_DIR, { recursive: true });
  await mkdir(REPORTS_DIR, { recursive: true });
  await mkdir(VAULT_DIR, { recursive: true });
  await mkdir(RUNTIME_DIR, { recursive: true });
  await migrateLegacyDataDir();
  await ensureFile(PROFILES_FILE, "[]\n");
  await ensureFile(REQUEST_LOG_FILE, "");
  await ensureFile(TEST_RUNS_FILE, "");
  await ensureFile(TASK_EVENTS_FILE, "");
  await ensureFile(ERROR_LOG_FILE, "");
  await migrateRequestsToSqlite();
  await reconcileInterruptedTasks();
}

// 启动时把上次残留的 running/queued 任务改判 interrupted（ADM-017）。
// 进程已经换了，那些任务不可能自己再推进；不改判则重启后列表永远挂着一批「运行中」，
// 前端还会对着它们无限轮询。事件流路径早有等价逻辑（composeTaskFromEvents 里按 latest.status
// 判断），但那是【读时】推断、不落痕；落库后状态是持久的，必须在启动时真正写回去。
// best-effort：失败不影响启动（读时仍有事件流那层兜底）。
export async function reconcileInterruptedTasks() {
  try {
    return await markInterruptedEvaluationTasks();
  } catch {
    return 0;
  }
}

// 一次性把现存 requests.jsonl 全量回填进 SQLite（仅当 SQLite 可用且表为空）。
// best-effort：失败不影响启动。读全文件（非尾部），避免截断历史。
export async function migrateRequestsToSqlite() {
  try {
    if (!(await isSqliteAvailable())) return 0;
    if ((await countRequests()) > 0) return 0;
    if (!existsSync(REQUEST_LOG_FILE)) return 0;
    const raw = await readFile(REQUEST_LOG_FILE, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return 0;
    return await importRequestsFromJsonl(lines);
  } catch {
    return 0;
  }
}

export async function readRecentRequests() {
  // 优先读 SQLite（全量、不截断）；空或不可用则回退 JSONL 尾部。
  const fromDb = await queryRecentRequests(50);
  if (fromDb && fromDb.length > 0) return fromDb;
  return readJsonLines(REQUEST_LOG_FILE, 50).then((items) => items.reverse());
}

export async function readRecentErrors() {
  return readJsonLines(ERROR_LOG_FILE, 100).then((items) => items.reverse());
}

export async function readRecentTestRuns() {
  const fromDb = await queryRecentTestRuns(20);
  if (fromDb && fromDb.length > 0) return fromDb;
  return readJsonLines(TEST_RUNS_FILE, 20).then((items) => items.reverse());
}

// 把事件流按 taskId 折叠成「每个任务一条」。同时留住两端：
//   · latest —— 任务当前状态（status/progress/steps/result 都看它）
//   · first  —— 只有它带 payload（summarizeTaskPayload 只在 queued/started 时写一次，
//               后续 completed/failed 事件不再重复。见 task-manager.mjs createTask）
// 不留住 first，任务一结束 payload 就查不到了，「复制参数 / 重新测试」也就无从谈起。
function foldTaskEvents(events) {
  const folded = new Map();
  for (const event of events) {
    const at = new Date(event.loggedAt || 0);
    const current = folded.get(event.taskId);
    if (!current) {
      folded.set(event.taskId, { first: event, latest: event, firstAt: at, latestAt: at });
      continue;
    }
    if (at >= current.latestAt) {
      current.latest = event;
      current.latestAt = at;
    }
    if (at < current.firstAt) {
      current.first = event;
      current.firstAt = at;
    }
  }
  return folded;
}

// 把折叠后的一条整成前端任务对象。内存里还在的任务以 publicTask 为准（它有最新的 steps 与
// queuePosition），已被逐出内存的走事件流快照。
function composeTaskFromEvents({ first, latest }, taskMap, publicTask) {
  const payload = first?.payload ?? latest?.payload ?? null;
  const active = taskMap.get(latest.taskId);
  if (active) {
    return { ...latest, ...publicTask(active), payload, event: latest.event, recoverable: true };
  }
  // 事件流最后停在 running = 进程在任务跑到一半时退出了。这类任务不可能自己再动，
  // 必须显式改判为 interrupted，否则前端会对着一个永不推进的「运行中」一直轮询。
  if (latest.status === "running") {
    return {
      ...latest,
      payload,
      status: "interrupted",
      event: "interrupted",
      message: "程序曾在任务运行中退出，任务已中断，需要重新测试。",
      recoverable: false,
    };
  }
  return { ...latest, payload, recoverable: false };
}

// 两个数据源【合并】而非二选一（ADM-017）：
//   · SQLite —— 全量、不受 300 行限制，落库起点之后的任务都在（权威当前态）
//   · JSONL  —— 升级前就存在的历史任务只在这里；SQLite 不可用时它是唯一来源
// 刻意不写成"有库就只读库"：升级那一刻 evaluation_tasks 是空的而 JSONL 有历史，
// 一旦跑第一个新任务，库里有了 1 行，"只读库"就会让全部历史任务凭空消失。
// 同一个 taskId 两边都有时以库为准（它是落库后每次状态跃迁都更新的当前态）。
export async function readRecentTasks(taskMap, publicTask) {
  const fromDb = (await queryRecentEvaluationTasks(30)) || [];
  const byId = new Map(fromDb.map((task) => [task.taskId, task]));

  const events = await readJsonLines(TASK_EVENTS_FILE, 300);
  for (const entry of foldTaskEvents(events).values()) {
    // 列表【刻意不带 steps】：一屏 30 个任务 × 每个最多 20 步，够把列表响应撑到几百 KB，
    // 而列表只画聚合状态。逐步骤明细走 readTaskDetail（一次只取一个任务）。
    const { steps, ...task } = composeTaskFromEvents(entry, taskMap, publicTask);
    if (!byId.has(task.taskId)) byId.set(task.taskId, task);
  }

  return [...byId.values()]
    .map((task) => overlayActiveTask(task, taskMap, publicTask))
    .sort((a, b) => taskSortTime(b) - taskSortTime(a))
    .slice(0, 30);
}

// 两条来源的时间字段不同名：库里是 createdAt/startedAt，事件流折叠后还带 loggedAt。
// 统一取"最能代表这条记录新旧"的那个，否则合并后的排序会把两批数据交错乱放。
function taskSortTime(task) {
  return new Date(task.loggedAt || task.endedAt || task.startedAt || task.createdAt || 0).getTime();
}

// 库里的行可能已过时（进度只在状态跃迁时落库）。内存里还在的任务以 publicTask 为准，
// 并标回 recoverable:true —— 它有 abortController，是真能取消的。
// withSteps=false（列表）时剥掉 steps，与 SQLite 列表口径一致；明细路径要保留。
function overlayActiveTask(task, taskMap, publicTask, { withSteps = false } = {}) {
  const active = taskMap?.get(task.taskId);
  if (!active) return task;
  const { steps, ...live } = publicTask(active);
  const merged = { ...task, ...live, taskId: task.taskId, payload: task.payload, recoverable: true, event: live.status };
  // 内存里的 steps 比库里新（进度推进不落库），有就用它覆盖。
  if (withSteps) merged.steps = steps ?? task.steps;
  return merged;
}

// 单个任务详情。内存里没有就回落库/事件流里找——任务结束满 1 小时会被逐出内存
// （task-manager 的 cleanupTimer），重启则全部清空。少了这条回退，任务中心的详情页
// 会对一个昨天刚跑完的任务报「没有找到测试任务」。
// 查找顺序：SQLite（ADM-017 起，无 300 行限制）→ 事件流最后 300 行 → 内存（刚建好还没落盘）。
export async function readTaskDetail(taskId, taskMap, publicTask) {
  const wanted = String(taskId || "");
  if (!wanted) return null;
  const fromDb = await queryEvaluationTask(wanted);
  if (fromDb) return overlayActiveTask(fromDb, taskMap, publicTask, { withSteps: true });
  const events = await readJsonLines(TASK_EVENTS_FILE, 300);
  const entry = foldTaskEvents(events.filter((event) => event.taskId === wanted)).get(wanted);
  if (!entry) {
    // 事件流里没有，但内存里可能刚建好还没落盘（appendTaskEvent 是 await 的，窗口极窄但存在）。
    const active = taskMap.get(wanted);
    return active ? { ...publicTask(active), payload: null, recoverable: true } : null;
  }
  return composeTaskFromEvents(entry, taskMap, publicTask);
}

async function ensureFile(file, content) {
  if (!existsSync(file)) {
    await writeFile(file, content, "utf8");
  }
}

async function migrateLegacyDataDir() {
  if ((envCompat("DATA_DIR") && !envCompat("LEGACY_DATA_DIR")) || !existsSync(LEGACY_DATA_DIR) || LEGACY_DATA_DIR === DATA_DIR) {
    return;
  }
  await copyIfMissing(join(LEGACY_DATA_DIR, "profiles.json"), PROFILES_FILE);
  await copyIfMissing(join(LEGACY_DATA_DIR, "requests.jsonl"), REQUEST_LOG_FILE);
  await copyIfMissing(join(LEGACY_DATA_DIR, "test-runs.jsonl"), TEST_RUNS_FILE);
  await copyIfMissing(join(LEGACY_DATA_DIR, "task-events.jsonl"), TASK_EVENTS_FILE);
  await copyIfMissing(join(LEGACY_DATA_DIR, "errors.jsonl"), ERROR_LOG_FILE);
  await copyIfMissing(join(LEGACY_DATA_DIR, "local-secret.key"), LOCAL_SECRET_FILE);
  await copyIfMissing(join(LEGACY_DATA_DIR, "key-vault.json"), LOCAL_VAULT_FILE);
  await copyReportsIfMissing(join(LEGACY_DATA_DIR, "reports"));
}

async function copyIfMissing(source, target) {
  if (!existsSync(source) || existsSync(target)) return;
  await copyFile(source, target);
}

async function copyReportsIfMissing(sourceDir) {
  if (!existsSync(sourceDir)) return;
  const items = await readdir(sourceDir);
  for (const item of items) {
    const source = join(sourceDir, item);
    const info = await stat(source);
    if (!info.isFile()) continue;
    await copyIfMissing(source, join(REPORTS_DIR, item));
  }
}

async function readJsonLines(file, limit) {
  if (!existsSync(file)) {
    return [];
  }
  const raw = await readTextTail(file);
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .map((line) => safeJson(line))
    .filter(Boolean);
}
