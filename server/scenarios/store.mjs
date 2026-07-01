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

// —— 分组解析：每个场景一个分组。显式 group 优先；否则按 bank 归入初始 5 组（与 scenarioGroups 默认清单一致）。——
const DEFAULT_SCENARIO_GROUPS = ["基础", "LiveBench", "安全红线", "HLE", "HardcoreLogic"];
const BANK_GROUP = {
  basic: "基础",
  coding: "基础",
  "long-context": "基础",
  chinese: "基础",
  custom: "基础",
  safety: "安全红线",
  livebench: "LiveBench",
  hle: "HLE",
  "hardcore-logic": "HardcoreLogic",
};
export function resolveScenarioGroup(scenario, bankKey) {
  if (typeof scenario.group === "string" && scenario.group) return scenario.group;
  return BANK_GROUP[bankKey] || "基础";
}
// 同时挂 tag + group（group 需要 bankKey，故不并入 withTag）。
function withMeta(scenario, bankKey) {
  return { ...withTag(scenario), group: resolveScenarioGroup(scenario, bankKey) };
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
// 把「改写源文件」重定向到别处，避免污染源码。测试/子进程可用 EVALUATOR_SCENARIO_WRITE_DIR 指定；
// 进程内单测用 __setScenarioWriteDirForTest 覆盖。生产不设 → 就地改写 server/scenarios/*.mjs。
let writeDirOverride = process.env.EVALUATOR_SCENARIO_WRITE_DIR || null;

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
    if (b.always || settings[b.flag]) out.push(...b.scenarios.map((s) => withMeta(s, b.key)));
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
    for (const s of b.scenarios) out.push({ ...s, bankKey: b.key, active, resolvedTag: withTag(s).tag, resolvedGroup: resolveScenarioGroup(s, b.key) });
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

// best-effort 改写一批 bank 文件，聚合首个错误。
async function rewriteBanks(bankList, persist) {
  if (!persist) return { persisted: false, persistError: null };
  let persistError = null;
  for (const b of bankList) {
    try {
      await rewriteBank(b);
    } catch (e) {
      if (!persistError) persistError = String(e?.message || e);
    }
  }
  return { persisted: !persistError, persistError };
}

// 重命名整组：把「解析后 == oldName」的所有场景写上显式 group=newName（含 materialize 派生项），改写受影响 bank。
export async function renameScenarioGroup(oldName, newName, { persist = true } = {}) {
  const from = String(oldName ?? "").trim();
  const to = String(newName ?? "").trim();
  if (!from || !to) return { ok: false, userMessage: "分组名不能为空。" };
  const changedBanks = new Set();
  let changed = 0;
  for (const b of banks()) {
    for (const s of b.scenarios) {
      if (resolveScenarioGroup(s, b.key) === from && s.group !== to) {
        s.group = to;
        changedBanks.add(b);
        changed += 1;
      }
    }
  }
  const { persisted, persistError } = await rewriteBanks([...changedBanks], persist);
  return { ok: true, changed, persisted, persistError };
}

// 删除组：清掉「显式 group === name」的字段（落回 bank 默认组），改写受影响 bank。
export async function clearScenarioGroup(name, { persist = true } = {}) {
  const target = String(name ?? "").trim();
  if (!target) return { ok: false, userMessage: "分组名不能为空。" };
  const changedBanks = new Set();
  let changed = 0;
  for (const b of banks()) {
    for (const s of b.scenarios) {
      if (s.group === target) {
        delete s.group;
        changedBanks.add(b);
        changed += 1;
      }
    }
  }
  const { persisted, persistError } = await rewriteBanks([...changedBanks], persist);
  return { ok: true, changed, persisted, persistError };
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
