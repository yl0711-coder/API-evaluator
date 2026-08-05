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
import { countRequests, importRequestsFromJsonl, isSqliteAvailable, queryRecentRequests, queryRecentTestRuns } from "./db.mjs";

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

export async function readRecentTasks(taskMap, publicTask) {
  const events = await readJsonLines(TASK_EVENTS_FILE, 300);
  return [...foldTaskEvents(events).values()]
    .map((entry) => {
      // 列表【刻意不带 steps】：一屏 30 个任务 × 每个最多 20 步，够把列表响应撑到几百 KB，
      // 而列表只画聚合状态。逐步骤明细走 readTaskDetail（一次只取一个任务）。
      const { steps, ...task } = composeTaskFromEvents(entry, taskMap, publicTask);
      return task;
    })
    .sort((a, b) => new Date(b.loggedAt || b.startedAt || 0) - new Date(a.loggedAt || a.startedAt || 0))
    .slice(0, 30);
}

// 单个任务详情。内存里没有就回事件流里找——任务结束满 1 小时会被逐出内存
// （task-manager 的 cleanupTimer），重启则全部清空。少了这条回退，任务中心的详情页
// 会对一个昨天刚跑完的任务报「没有找到测试任务」。
// 能力边界：只在事件流最后 300 行内找得到；更早的任务要靠 SQLite 落库才能查（P2，未做）。
export async function readTaskDetail(taskId, taskMap, publicTask) {
  const wanted = String(taskId || "");
  if (!wanted) return null;
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
