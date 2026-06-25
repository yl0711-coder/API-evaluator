import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { envCompat } from "./env-compat.mjs";

const SOURCE_ROOT = fileURLToPath(new URL("../", import.meta.url));

export const ROOT = envCompat("APP_ROOT") || SOURCE_ROOT;
export const STATIC_ROOT = envCompat("STATIC_DIR") || join(ROOT, "dist");
export const LEGACY_DATA_DIR = envCompat("LEGACY_DATA_DIR") || join(ROOT, "app-data");
export const DATA_DIR = envCompat("DATA_DIR") || join(ROOT, "评测数据");
export const CONFIG_DIR = join(DATA_DIR, "配置");
export const REPORTS_DIR = join(DATA_DIR, "报告");
export const LOGS_DIR = join(DATA_DIR, "日志");
export const WORKSPACES_DIR = join(DATA_DIR, "工作区");
export const VAULT_DIR = join(DATA_DIR, ".vault");
export const RUNTIME_DIR = join(DATA_DIR, ".runtime");
export const PROFILES_FILE = join(CONFIG_DIR, "profiles.json");
export const CHANNELS_FILE = join(CONFIG_DIR, "channels.json");
export const MODEL_TARGETS_FILE = join(CONFIG_DIR, "model-targets.json");
export const SETTINGS_FILE = join(CONFIG_DIR, "settings.json");
export const SQLITE_DB_FILE = envCompat("SQLITE_DB") || join(DATA_DIR, "evaluator.db");
export const REQUEST_LOG_FILE = join(LOGS_DIR, "requests.jsonl");
export const TEST_RUNS_FILE = join(LOGS_DIR, "test-runs.jsonl");
export const TASK_EVENTS_FILE = join(LOGS_DIR, "task-events.jsonl");
export const ERROR_LOG_FILE = join(LOGS_DIR, "errors.jsonl");
export const LOCAL_SECRET_FILE = join(VAULT_DIR, "local-secret.key");
export const LOCAL_VAULT_FILE = join(VAULT_DIR, "key-vault.json");
