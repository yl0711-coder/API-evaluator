// server/scenarios/store.mjs
// 场景测试的运行态单一真源：把各 bank 的静态字面量数组深拷贝进可变内存表，运行时统一从这里读，
// 编辑/新增/删除即时生效；并把改动写进「覆盖层」JSON（持久卷 /data 下的 CONFIG_DIR），
// 启动时 loadScenarioOverrides() 读回、按 id 合并到内置 bank 之上，故重启/换镜像后仍在。
// 内置 server/scenarios/*.mjs 保持纯代码不被改写；覆盖层只 JSON.stringify 纯数据，绝不拼接用户 JS。
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { SCENARIO_OVERRIDES_FILE } from "../paths.mjs";

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
// 编辑覆盖层（按 id）：upserts=新建/改过的场景（含仅改 group），deletes=被删的【内置】场景 id 墓碑。
// 不变量：同一 id 不同时在 upserts 与 deletes。写盘目标默认 SCENARIO_OVERRIDES_FILE，测试可覆盖。
let overlay = { upserts: {}, deletes: [] };
let overridesFile = SCENARIO_OVERRIDES_FILE;
// 内置场景 id 全集：删除内置项才需要墓碑；纯自定义 id 删除时从 upserts 移除即可。
const builtinIds = new Set(Object.values(SOURCES).flatMap((arr) => (Array.isArray(arr) ? arr.map((s) => s.id) : [])));

// 把覆盖层套到「克隆自 SOURCES」的 bank 列表上：先按墓碑删、再按 upserts 原地替换或落 custom（复刻 upsert 落位）。
function applyOverlay(bankList) {
  if (overlay.deletes.length) {
    const dead = new Set(overlay.deletes);
    for (const b of bankList) b.scenarios = b.scenarios.filter((s) => !dead.has(s.id));
  }
  for (const [id, scn] of Object.entries(overlay.upserts)) {
    const next = { ...scn, id };
    let placed = false;
    for (const b of bankList) {
      const i = b.scenarios.findIndex((s) => s.id === id);
      if (i >= 0) {
        b.scenarios[i] = next;
        placed = true;
        break;
      }
    }
    if (!placed) bankList.find((b) => b.key === "custom").scenarios.push(next);
  }
}

function banks() {
  if (!BANKS) {
    BANKS = BANK_META.map((m) => ({ ...m, scenarios: clone(SOURCES[m.key]) }));
    applyOverlay(BANKS);
  }
  return BANKS;
}
function findBankOf(id) {
  return banks().find((b) => b.scenarios.some((s) => s.id === id)) || null;
}

// 启动时读回覆盖层（best-effort，仿 loadSettings）：读失败/无文件 → 空覆盖层。置 BANKS=null 触发下次重建合并。
export async function loadScenarioOverrides() {
  try {
    if (existsSync(overridesFile)) {
      const raw = JSON.parse((await readFile(overridesFile, "utf8")) || "{}");
      overlay = normalizeOverlay(raw);
    } else {
      overlay = { upserts: {}, deletes: [] };
    }
  } catch {
    overlay = { upserts: {}, deletes: [] };
  }
  BANKS = null;
  return overlay;
}

// 只认已知结构，杜绝脏数据：upserts 取「值为对象且带 id」的项，deletes 取去重后的非空字符串。
function normalizeOverlay(raw) {
  const upserts = {};
  if (raw && typeof raw.upserts === "object" && raw.upserts) {
    for (const [id, scn] of Object.entries(raw.upserts)) {
      if (scn && typeof scn === "object" && String(scn.id ?? id).trim()) upserts[id] = scn;
    }
  }
  const deletes = Array.isArray(raw?.deletes) ? [...new Set(raw.deletes.map((x) => String(x ?? "").trim()).filter(Boolean))] : [];
  return { upserts, deletes };
}

// 覆盖层落盘（建目录 + 写 JSON）。抛错由各调用方 try/catch 成 persistError。
async function persistOverlay() {
  await mkdir(dirname(overridesFile), { recursive: true });
  await writeFile(overridesFile, JSON.stringify({ version: 1, ...overlay }, null, 2), "utf8");
}
// 覆盖层记账小工具：记一次 upsert（顺带从墓碑移除）/ 记一次删除。
function overlayUpsert(scn) {
  overlay.upserts[scn.id] = scn;
  if (overlay.deletes.length) overlay.deletes = overlay.deletes.filter((x) => x !== scn.id);
}
function overlayDelete(id) {
  delete overlay.upserts[id];
  if (builtinIds.has(id) && !overlay.deletes.includes(id)) overlay.deletes.push(id);
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

// 覆盖层记账 + 落盘。persist=false → 不动覆盖层、不写盘（供纯内存单测）。record 可记多条 upsert/delete。
async function persistChange(persist, record) {
  if (!persist) return { persisted: false, persistError: null };
  record();
  try {
    await persistOverlay();
    return { persisted: true, persistError: null };
  } catch (e) {
    return { persisted: false, persistError: String(e?.message || e) };
  }
}

function validateScenario(scn) {
  if (!scn || typeof scn !== "object") return "场景必须是对象。";
  const id = String(scn.id ?? "").trim();
  if (!id) return "场景 id 不能为空。";
  const promptOk = (typeof scn.prompt === "string" && scn.prompt.trim()) || (Array.isArray(scn.prompt) && scn.prompt.length);
  if (!promptOk) return "提示词 prompt 不能为空。";
  return null;
}

// 新增/编辑：命中已有 id→替换其 bank；新 id→进 custom bank。persist 时记进覆盖层并落盘。
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
  const { persisted, persistError } = await persistChange(persist, () => overlayUpsert(next));
  return { ok: true, scenario: withTag(next), bankKey: bank.key, persisted, persistError };
}

export async function deleteScenario(id, { persist = true } = {}) {
  const key = String(id ?? "").trim();
  const bank = findBankOf(key);
  if (!bank) return { ok: false, found: false, userMessage: "场景不存在。" };
  bank.scenarios = bank.scenarios.filter((s) => s.id !== key);
  const { persisted, persistError } = await persistChange(persist, () => overlayDelete(key));
  return { ok: true, found: true, bankKey: bank.key, persisted, persistError };
}

// 重命名整组：把「解析后 == oldName」的所有场景写上显式 group=newName（含 materialize 派生项），改动记进覆盖层。
export async function renameScenarioGroup(oldName, newName, { persist = true } = {}) {
  const from = String(oldName ?? "").trim();
  const to = String(newName ?? "").trim();
  if (!from || !to) return { ok: false, userMessage: "分组名不能为空。" };
  const changedScenarios = [];
  for (const b of banks()) {
    for (const s of b.scenarios) {
      if (resolveScenarioGroup(s, b.key) === from && s.group !== to) {
        s.group = to;
        changedScenarios.push(s);
      }
    }
  }
  const { persisted, persistError } = await persistChange(persist, () => changedScenarios.forEach(overlayUpsert));
  return { ok: true, changed: changedScenarios.length, persisted, persistError };
}

// 删除组：清掉「显式 group === name」的字段（落回 bank 默认组），改动记进覆盖层。
export async function clearScenarioGroup(name, { persist = true } = {}) {
  const target = String(name ?? "").trim();
  if (!target) return { ok: false, userMessage: "分组名不能为空。" };
  const changedScenarios = [];
  for (const b of banks()) {
    for (const s of b.scenarios) {
      if (s.group === target) {
        delete s.group;
        changedScenarios.push(s);
      }
    }
  }
  const { persisted, persistError } = await persistChange(persist, () => changedScenarios.forEach(overlayUpsert));
  return { ok: true, changed: changedScenarios.length, persisted, persistError };
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
  overlay = { upserts: {}, deletes: [] };
  overridesFile = SCENARIO_OVERRIDES_FILE;
}
export function __setScenarioOverridesFileForTest(file) {
  overridesFile = file || SCENARIO_OVERRIDES_FILE;
}
