// server/settings-store.mjs
// 运行时平台设置（完全脱离环境变量）：AI 总结模型、场景测试是否含 LiveBench / 安全红线题。
// 真源是 配置/settings.json + 内存缓存；未保存过时一律默认全关（AI 分析默认用被测模型自己）。
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { SETTINGS_FILE } from "./paths.mjs";
import { writeJsonAtomic } from "./utils.mjs";

// 注意：new-api 系统访问令牌（敏感）不在此——它走加密库（secret-store），绝不入 settings.json。
const DEFAULT_SCENARIO_GROUPS = ["基础", "LiveBench", "安全红线", "HLE", "HardcoreLogic"];
const DEFAULTS = { aiAnalysisModelTargetId: "", enableLivebench: false, enableSafety: false, enableHle: false, enableHardcoreLogic: false, enableAutoTag: true, customTags: [], scenarioGroups: [...DEFAULT_SCENARIO_GROUPS], newapiBaseUrl: "", newapiUserId: "" };

let cache = null;

// 只接受已知字段、做类型校验，杜绝脏数据/多余字段进缓存。
function normalize(raw) {
  return {
    aiAnalysisModelTargetId: typeof raw?.aiAnalysisModelTargetId === "string" ? raw.aiAnalysisModelTargetId : "",
    enableLivebench: raw?.enableLivebench === true,
    enableSafety: raw?.enableSafety === true,
    enableHle: raw?.enableHle === true,
    enableHardcoreLogic: raw?.enableHardcoreLogic === true,
    // 高分通过场景测试自动授予能力标签：默认开启；仅显式 false 关闭（兼容旧 settings.json 缺该字段→视为开）。
    enableAutoTag: raw?.enableAutoTag !== false,
    // 用户自定义能力标签清单：trim、去空、去重、保序；非数组→空。并入模型表单的可勾选标签词表。
    customTags: Array.isArray(raw?.customTags) ? [...new Set(raw.customTags.map((t) => String(t ?? "").trim()).filter(Boolean))] : [],
    // 场景分组清单：trim、去空、去重、保序；非数组→回落默认 5 组（默认非空，供场景测试/开发者页筛选）。
    scenarioGroups: Array.isArray(raw?.scenarioGroups) ? [...new Set(raw.scenarioGroups.map((g) => String(g ?? "").trim()).filter(Boolean))] : [...DEFAULT_SCENARIO_GROUPS],
    // new-api 网关非密配置（脱离环境变量）；令牌不在此，走加密库（见 newapi-tag-writer / server.mjs）。
    newapiBaseUrl: typeof raw?.newapiBaseUrl === "string" ? raw.newapiBaseUrl : "",
    newapiUserId: typeof raw?.newapiUserId === "string" ? raw.newapiUserId : "",
  };
}

// 同步取当前设置；未加载/无文件 → 默认全关（getTestScenarios 等同步消费点用）。
export function getSettings() {
  return cache || { ...DEFAULTS };
}

// 启动时调用一次，把文件读进缓存。best-effort：读失败 / 无文件 → 默认。
export async function loadSettings() {
  try {
    cache = existsSync(SETTINGS_FILE) ? normalize(JSON.parse((await readFile(SETTINGS_FILE, "utf8")) || "{}")) : { ...DEFAULTS };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

// 合并写回（只认 patch 里的已知字段），更新缓存并落盘。
export async function saveSettings(patch) {
  const next = normalize({ ...getSettings(), ...patch });
  await writeJsonAtomic(SETTINGS_FILE, next);
  cache = next;
  return next;
}

// 迁移旧版：读 settings.json 里残留的明文 new-api 令牌（只读，不改文件）。供启动时挪进加密库。
export async function peekLegacyNewapiToken() {
  try {
    if (!existsSync(SETTINGS_FILE)) return "";
    const raw = JSON.parse((await readFile(SETTINGS_FILE, "utf8")) || "{}");
    return typeof raw.newapiImportToken === "string" ? raw.newapiImportToken.trim() : "";
  } catch {
    return "";
  }
}

// 迁移旧版：把 settings.json 重写为规范化（已不含 newapiImportToken）形态 → 抹除残留明文令牌。
// 须在令牌已写入加密库之后调用，保证不丢令牌。
export async function stripLegacyNewapiToken() {
  await saveSettings({});
}

// 仅供测试：重置内存缓存（不动文件）。
export function __resetSettingsCacheForTest() {
  cache = null;
}

// 仅供测试：直接设置内存缓存（不动文件），免去文件 IO 副作用。
export function __setSettingsForTest(partial) {
  cache = normalize({ ...DEFAULTS, ...partial });
}
