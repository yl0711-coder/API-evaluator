// src/scenario-grouping.js
// 场景分组筛选的纯逻辑（无 DOM、无 I/O），供 scenario-case-picker.js 复用并单测。
// row 形状：{ id, name, tag, difficulty, group, selected }。group 为 "" 表示无分组。
// 与 src/model-tags.js 同为「纯逻辑抽离供单测」范式。

const ALL_GROUPS = ""; // 分组筛选的「全部分组」哨兵值（下拉的空 value）。

// 当前 rows 里出现过的去重分组（丢空串/假值、保序）——喂分组筛选下拉。
export function distinctGroups(rows) {
  return [...new Set((Array.isArray(rows) ? rows : []).map((r) => r?.group).filter(Boolean))];
}

// 按分组筛选 rows：""（ALL_GROUPS）＝不筛全部；否则只留 group 全等的。
export function filterRowsByGroup(rows, group) {
  const list = Array.isArray(rows) ? rows : [];
  return group ? list.filter((r) => r?.group === group) : list;
}

// 重建分组下拉后，决定应保留的选中值：当前值仍在分组里则保留，否则回落「全部分组」。
export function resolveGroupFilterValue(groups, current) {
  return (Array.isArray(groups) ? groups : []).includes(current) ? current : ALL_GROUPS;
}

// 「全选/清空」应作用的 id 集合＝当前分组筛选下可见项的 id。
// 关键防呆：筛到某分组后全选，绝不能波及被隐藏的其它分组（如误勾昂贵的 HLE）。
export function visibleSelectableIds(rows, group) {
  return new Set(filterRowsByGroup(rows, group).map((r) => r?.id).filter(Boolean));
}

// 跨分组的全部已选项——chips 与「已选 X / Y」计数用（不受当前筛选影响）。
export function selectedRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r?.selected);
}
