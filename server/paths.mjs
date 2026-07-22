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
// 场景编辑覆盖层：超管在「测试场景维护」页的增删改按 id 落到这里（持久卷 /data），
// 启动时读回合并到内置 bank 之上。内置 server/scenarios/*.mjs 保持纯代码不被改写。
export const SCENARIO_OVERRIDES_FILE = join(CONFIG_DIR, "scenario-overrides.json");
// 自动测试作业配置：超管在「自动测试配置」页配置的定时测试作业，按 id 落到这里（持久卷 /data）。
export const AUTO_TEST_JOBS_FILE = join(CONFIG_DIR, "auto-test-jobs.json");
// 高危报告提示的未读集合：运行完成时判危记入，用户点掉后移除（持久卷 /data）。
export const HIGH_RISK_ALERTS_FILE = join(CONFIG_DIR, "high-risk-alerts.json");
// 邮件报警的发信配置（SMTP 服务器/端口/账号/发件人/收件人）；密码不在此，走加密库（secret-store）。
export const NOTIFY_CONFIG_FILE = join(CONFIG_DIR, "notify-config.json");
export const SQLITE_DB_FILE = envCompat("SQLITE_DB") || join(DATA_DIR, "evaluator.db");
export const REQUEST_LOG_FILE = join(LOGS_DIR, "requests.jsonl");
export const TEST_RUNS_FILE = join(LOGS_DIR, "test-runs.jsonl");
export const TASK_EVENTS_FILE = join(LOGS_DIR, "task-events.jsonl");
export const ERROR_LOG_FILE = join(LOGS_DIR, "errors.jsonl");
export const LOCAL_SECRET_FILE = join(VAULT_DIR, "local-secret.key");
export const LOCAL_VAULT_FILE = join(VAULT_DIR, "key-vault.json");
