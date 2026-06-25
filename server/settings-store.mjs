// server/settings-store.mjs
// 运行时平台设置（完全脱离环境变量）：AI 总结模型、场景测试是否含 LiveBench / 安全红线题。
// 真源是 配置/settings.json + 内存缓存；未保存过时一律默认全关（AI 分析默认用被测模型自己）。
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { SETTINGS_FILE } from "./paths.mjs";

const DEFAULTS = { aiAnalysisModelTargetId: "", enableLivebench: false, enableSafety: false, enableHle: false, enableHardcoreLogic: false, enableDeleteSync: false, enableAutoTag: true };

let cache = null;

// 只接受已知字段、做类型校验，杜绝脏数据/多余字段进缓存。
function normalize(raw) {
  return {
    aiAnalysisModelTargetId: typeof raw?.aiAnalysisModelTargetId === "string" ? raw.aiAnalysisModelTargetId : "",
    enableLivebench: raw?.enableLivebench === true,
    enableSafety: raw?.enableSafety === true,
    enableHle: raw?.enableHle === true,
    enableHardcoreLogic: raw?.enableHardcoreLogic === true,
    enableDeleteSync: raw?.enableDeleteSync === true,
    // 高分通过场景测试自动授予能力标签：默认开启；仅显式 false 关闭（兼容旧 settings.json 缺该字段→视为开）。
    enableAutoTag: raw?.enableAutoTag !== false,
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
  await mkdir(dirname(SETTINGS_FILE), { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf8");
  cache = next;
  return next;
}

// 仅供测试：重置内存缓存（不动文件）。
export function __resetSettingsCacheForTest() {
  cache = null;
}

// 仅供测试：直接设置内存缓存（不动文件），免去文件 IO 副作用。
export function __setSettingsForTest(partial) {
  cache = normalize({ ...DEFAULTS, ...partial });
}
