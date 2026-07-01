// server/scenarios/store.mjs
// 场景测试的运行态单一真源：把各 bank 的静态字面量数组深拷贝进可变内存表，运行时统一从这里读，
// 编辑/新增/删除即时生效；并把改动「改写回源文件」(server/scenarios/*.mjs) 以便重启后自然加载。
// 源文件永远是 `export const NAME = <纯 JSON 数据>;`，改写只 JSON.stringify 纯数据，绝不拼接用户 JS。
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { BASIC_SCENARIOS } from "./basic.mjs";
import { CODING_SCENARIOS } from "./coding.mjs";
import { LONG_CONTEXT_SCENARIOS } from "./long-context.mjs";
import { CHINESE_SCENARIOS } from "./chinese.mjs";
import { CUSTOM_SCENARIOS } from "./custom.mjs";
import { SAFETY_SCENARIOS } from "./safety.mjs";
import { LIVEBENCH_SCENARIOS } from "./livebench.mjs";
import { HLE_SCENARIOS } from "./hle.mjs";
import { HARDCORE_LOGIC_SCENARIOS } from "./hardcore-logic.mjs";
import { getSettings } from "../settings-store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// —— 标签解析（自 index.mjs 迁入）：每个场景一个标签。优先用显式 tag（开发者分配），否则按规则推断。——
const TAG_BY_CATEGORY = {
  connectivity: "响应速度",
  speed: "响应速度",
  structured: "代码",
  writing: "写作",
  coding: "代码",
  long_context: "长上下文",
  reasoning: "逻辑推理",
  safety: "内容安全",
};
const TAG_BY_ID = {
  "chinese-knowledge-history": "知识事实",
  "chinese-language-idiom": "知识事实",
  "chinese-reasoning-work": "逻辑推理",
  "chinese-writing-notice": "写作",
  "chinese-instruction-format": "写作",
  "chinese-structured-json": "代码",
};
export function resolveScenarioTag(scenario) {
  if (TAG_BY_ID[scenario.id]) return TAG_BY_ID[scenario.id];
  if (scenario.category === "livebench") {
    return scenario.id.includes("data_analysis") ? "代码" : "逻辑推理";
  }
  if (scenario.category === "hle") {
    const reasoningCats = ["Math", "Physics", "Engineering", "Computer Science/AI"];
    return reasoningCats.includes(scenario.hleCategory) ? "逻辑推理" : "知识事实";
  }
  if (scenario.category === "hardcore-logic") return "逻辑推理";
  return TAG_BY_CATEGORY[scenario.category] || "";
}
// 浅拷贝挂上 tag，保留 id/prompt/scorer 等全部原字段；显式 tag 优先（支持「给场景分配标签」）。
function withTag(scenario) {
  const tag = typeof scenario.tag === "string" && scenario.tag ? scenario.tag : resolveScenarioTag(scenario);
  return { ...scenario, tag };
}

// —— bank 注册表：always=常开；flag=受设置开关控制。顺序即 getTestScenarios 输出顺序。——
const SOURCES = {
  basic: BASIC_SCENARIOS,
  coding: CODING_SCENARIOS,
  "long-context": LONG_CONTEXT_SCENARIOS,
  chinese: CHINESE_SCENARIOS,
  custom: CUSTOM_SCENARIOS,
  safety: SAFETY_SCENARIOS,
  livebench: LIVEBENCH_SCENARIOS,
  hle: HLE_SCENARIOS,
  "hardcore-logic": HARDCORE_LOGIC_SCENARIOS,
};
const BANK_META = [
  { key: "basic", exportName: "BASIC_SCENARIOS", file: "basic.mjs", always: true, flag: null },
  { key: "coding", exportName: "CODING_SCENARIOS", file: "coding.mjs", always: true, flag: null },
  { key: "long-context", exportName: "LONG_CONTEXT_SCENARIOS", file: "long-context.mjs", always: true, flag: null },
  { key: "chinese", exportName: "CHINESE_SCENARIOS", file: "chinese.mjs", always: true, flag: null },
  { key: "custom", exportName: "CUSTOM_SCENARIOS", file: "custom.mjs", always: true, flag: null },
  { key: "safety", exportName: "SAFETY_SCENARIOS", file: "safety.mjs", always: false, flag: "enableSafety" },
  { key: "livebench", exportName: "LIVEBENCH_SCENARIOS", file: "livebench.mjs", always: false, flag: "enableLivebench" },
  { key: "hle", exportName: "HLE_SCENARIOS", file: "hle.mjs", always: false, flag: "enableHle" },
  { key: "hardcore-logic", exportName: "HARDCORE_LOGIC_SCENARIOS", file: "hardcore-logic.mjs", always: false, flag: "enableHardcoreLogic" },
];

const clone = (arr) => JSON.parse(JSON.stringify(Array.isArray(arr) ? arr : []));

let BANKS = null;
let writeDirOverride = null; // 测试用：把改写重定向到临时目录，避免污染源码

function banks() {
  if (!BANKS) BANKS = BANK_META.map((m) => ({ ...m, scenarios: clone(SOURCES[m.key]) }));
  return BANKS;
}
function findBankOf(id) {
  return banks().find((b) => b.scenarios.some((s) => s.id === id)) || null;
}

// —— 运行时场景列表：按设置开关拼装 always + 受控 bank，逐条挂 tag。getTestScenarios 等同步消费点用。——
export function getTestScenarios() {
  const settings = getSettings();
  const out = [];
  for (const b of banks()) {
    if (b.always || settings[b.flag]) out.push(...b.scenarios.map(withTag));
  }
  return out;
}

// 开发者页用：跨 bank 全量【原始】对象（含 prompt/答案）+ 元信息 bankKey/active/resolvedTag。
// 保留原始字段不动（含 scenario 自带的 tag，若有），meta 另挂，便于前端只编辑纯场景体。绝不脱敏，仅超管端点可达。
export function getAllScenariosForAdmin() {
  const settings = getSettings();
  const out = [];
  for (const b of banks()) {
    const active = b.always || Boolean(settings[b.flag]);
    for (const s of b.scenarios) out.push({ ...s, bankKey: b.key, active, resolvedTag: withTag(s).tag });
  }
  return out;
}

// 纯函数：序列化一个 bank 的导出（仅纯数据）。header 为可选前置注释。
export function serializeBank(exportName, arr, header = "") {
  return `${header}export const ${exportName} = ${JSON.stringify(arr, null, 2)};\n`;
}

// 改写某 bank 的源文件：保留其现有头注释（export 之前的内容），只换数据体。best-effort。
async function rewriteBank(bank) {
  const target = writeDirOverride ? join(writeDirOverride, basename(bank.file)) : join(HERE, bank.file);
  let header = "";
  try {
    const cur = await readFile(join(HERE, bank.file), "utf8");
    const idx = cur.indexOf("export const");
    if (idx > 0) header = cur.slice(0, idx);
  } catch {
    /* 源文件读不到（如新文件）→ 无头注释 */
  }
  await writeFile(target, serializeBank(bank.exportName, bank.scenarios, header), "utf8");
}

function validateScenario(scn) {
  if (!scn || typeof scn !== "object") return "场景必须是对象。";
  const id = String(scn.id ?? "").trim();
  if (!id) return "场景 id 不能为空。";
  const promptOk = (typeof scn.prompt === "string" && scn.prompt.trim()) || (Array.isArray(scn.prompt) && scn.prompt.length);
  if (!promptOk) return "提示词 prompt 不能为空。";
  return null;
}

// 新增/编辑：命中已有 id→替换其 bank；新 id→进 custom bank。persist 时改写源文件。
export async function upsertScenario(scn, { persist = true } = {}) {
  const err = validateScenario(scn);
  if (err) return { ok: false, userMessage: err };
  const id = String(scn.id).trim();
  const next = { ...scn, id };
  let bank = findBankOf(id);
  if (bank) {
    const i = bank.scenarios.findIndex((s) => s.id === id);
    bank.scenarios[i] = next;
  } else {
    bank = banks().find((b) => b.key === "custom");
    bank.scenarios.push(next);
  }
  let persisted = false;
  let persistError = null;
  if (persist) {
    try {
      await rewriteBank(bank);
      persisted = true;
    } catch (e) {
      persistError = String(e?.message || e);
    }
  }
  return { ok: true, scenario: withTag(next), bankKey: bank.key, persisted, persistError };
}

export async function deleteScenario(id, { persist = true } = {}) {
  const key = String(id ?? "").trim();
  const bank = findBankOf(key);
  if (!bank) return { ok: false, found: false, userMessage: "场景不存在。" };
  bank.scenarios = bank.scenarios.filter((s) => s.id !== key);
  let persisted = false;
  let persistError = null;
  if (persist) {
    try {
      await rewriteBank(bank);
      persisted = true;
    } catch (e) {
      persistError = String(e?.message || e);
    }
  }
  return { ok: true, found: true, bankKey: bank.key, persisted, persistError };
}

// —— 兼容导出（保持 index.mjs / 测试里的名字语义）——
// ABILITY = 4 个手写常开 bank（不含 custom），与原 index.mjs 一致，供静态测试。
export const ABILITY_SCENARIOS = [
  ...BASIC_SCENARIOS,
  ...CODING_SCENARIOS,
  ...LONG_CONTEXT_SCENARIOS,
  ...CHINESE_SCENARIOS,
].map(withTag);
// 向后兼容快照（import 期、设置缓存未加载 → 只含 always）。运行时一律调 getTestScenarios()。
export const TEST_SCENARIOS = getTestScenarios();

// —— 测试钩子 ——
export function __resetStoreForTest() {
  BANKS = null;
  writeDirOverride = null;
}
export function __setScenarioWriteDirForTest(dir) {
  writeDirOverride = dir || null;
}
