// src/model-tags.js
// 标签词表与筛选的纯逻辑（无 DOM、无 I/O），供 channel-admin.js 复用、并单测。
// 标签为纯本地概念：模型表单可勾选词表 = 场景库标签 ∪ 用户自定义标签；列表可按标签筛选。

// trim、去空、去重、保序。前端添加自定义标签时用，保证与后端 settings-store.normalize 一致。
export function normalizeCustomTags(list) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const v = String(item ?? "").trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

// 模型表单可勾选标签词表：场景库 scenarios[].tag ∪ customTags（去重、保序，场景标签在前）。
export function unionTagVocabulary(scenarios, customTags) {
  const seen = new Set();
  const out = [];
  const add = (raw) => {
    const v = String(raw ?? "").trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  };
  for (const s of Array.isArray(scenarios) ? scenarios : []) add(s?.tag);
  for (const t of Array.isArray(customTags) ? customTags : []) add(t);
  return out;
}

// 模型目标上实际出现过的去重标签，按本地化排序——喂「按标签筛选」下拉。
export function distinctTargetTags(targets) {
  const seen = new Set();
  for (const t of Array.isArray(targets) ? targets : []) {
    for (const tag of Array.isArray(t?.tags) ? t.tags : []) {
      const v = String(tag ?? "").trim();
      if (v) seen.add(v);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

// 是否存在「无标签」的模型目标（决定筛选下拉是否提供「无标签」项）。
export function hasUntaggedTarget(targets) {
  return (Array.isArray(targets) ? targets : []).some((t) => !(Array.isArray(t?.tags) ? t.tags : []).length);
}

// 按标签筛选模型目标：""=全部不筛；"__none__"=无标签的；否则=tags 含该标签的。
export const NO_TAG_FILTER = "__none__";
export function filterTargetsByTag(targets, tag) {
  const list = Array.isArray(targets) ? targets : [];
  if (!tag) return list;
  if (tag === NO_TAG_FILTER) return list.filter((t) => !(Array.isArray(t?.tags) ? t.tags : []).length);
  return list.filter((t) => (Array.isArray(t?.tags) ? t.tags : []).includes(tag));
}
