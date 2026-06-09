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

export async function readRecentTasks(taskMap, publicTask) {
  const events = await readJsonLines(TASK_EVENTS_FILE, 300);
  const grouped = new Map();
  for (const event of events) {
    const current = grouped.get(event.taskId);
    if (!current || new Date(event.loggedAt || 0) >= new Date(current.loggedAt || 0)) {
      grouped.set(event.taskId, event);
    }
  }
  return [...grouped.values()]
    .map((event) => {
      const active = taskMap.get(event.taskId);
      if (active) {
        return {
          ...event,
          ...publicTask(active),
          event: event.event,
          recoverable: true,
        };
      }
      if (event.status === "running") {
        return {
          ...event,
          status: "interrupted",
          event: "interrupted",
          message: "程序曾在任务运行中退出，任务已中断，需要重新测试。",
          recoverable: false,
        };
      }
      return {
        ...event,
        recoverable: false,
      };
    })
    .sort((a, b) => new Date(b.loggedAt || b.startedAt || 0) - new Date(a.loggedAt || a.startedAt || 0))
    .slice(0, 30);
}

async function ensureFile(file, content) {
  if (!existsSync(file)) {
    await writeFile(file, content, "utf8");
  }
}

async function migrateLegacyDataDir() {
  if (
    (envCompat("DATA_DIR") && !envCompat("LEGACY_DATA_DIR")) ||
    !existsSync(LEGACY_DATA_DIR) ||
    LEGACY_DATA_DIR === DATA_DIR
  ) {
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
