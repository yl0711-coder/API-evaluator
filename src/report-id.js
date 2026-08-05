// 解析新格式报告 id：渠道_模型_测试_YYYYMMDD_HHMMSS_哈希（多目标为 多目标_测试_…）。
// 以 8 位日期 token 为锚点：其前一个=测试种类、其后一个=时间；之前的 head=渠道_模型。
// 模型名用连字符不用下划线 → 取 head 最后一个 token 为模型、其余为渠道（可处理含下划线/空格的渠道名）。
// 老格式（type-日期-哈希，无下划线分段）→ { isNew:false }，不参与筛选。
export function parseReportId(id) {
  const base = String(id || "").replace(/[-_]ai-analysis$/i, ""); // AI 分析归到母报告
  const parts = base.split("_");
  const dateIdx = parts.findIndex((p) => /^\d{8}$/.test(p));
  if (dateIdx < 1) return { isNew: false };
  const type = parts[dateIdx - 1];
  const date = parts[dateIdx]; // YYYYMMDD
  const head = parts.slice(0, dateIdx - 1);
  // Model-comparison reports contain two targets joined by `_vs_`. They are
  // aggregate reports, not reports belonging to a single channel/model.
  const isComparison = type === "compare" && base.includes("_vs_");
  if (isComparison) return { isNew: true, type, date, channel: null, model: null, isComparison: true };
  const channel = head.length >= 2 ? head.slice(0, -1).join("_") : null;
  const model = head.length >= 2 ? head[head.length - 1] : null; // head 仅「多目标」→ null
  return { isNew: true, type, date, channel, model };
}

// 名字规范化：把报告文件名里的「曾用名」折算成「当前名」。map 为 {曾用名→当前名}；
// 缺省或未命中则原样返回。用于渠道/模型改名后，仍把改名前的历史报告归并到当前对象。
function canonName(name, map) {
  if (name == null) return name;
  return (map && Object.prototype.hasOwnProperty.call(map, name) && map[name]) || name;
}

// 一条报告（其 parseReportId 结果）是否匹配筛选条件。
// filter: { channel, model, type, from, to }，date 边界 from/to 为 YYYYMMDD（含端点）。
// aliasMaps: { channel: {曾用名→当前名}, model: {曾用名→当前名} }（可选）——比较前把报告里的名字折算成当前名。
// 无任何条件 → 全部命中（含老报告）；一旦有条件 → 只命中新格式且各项都匹配（老报告不参与）。
export function matchesReportFilter(parsed, { channel = "", model = "", type = "", from = "", to = "" } = {}, aliasMaps = null) {
  if (!channel && !model && !type && !from && !to) return true;
  if (!parsed || !parsed.isNew) return false;
  if (channel && canonName(parsed.channel, aliasMaps?.channel) !== channel) return false;
  if (model && canonName(parsed.model, aliasMaps?.model) !== model) return false;
  if (type && parsed.type !== type) return false;
  if (from && parsed.date < from) return false; // YYYYMMDD 零填充 → 字符串比较即时间序
  if (to && parsed.date > to) return false;
  return true;
}

// 渠道↔模型联动：给定各报告的 parse 结果与当前所选渠道/模型，算出两个下拉的可选项（已排序）。
// 渠道候选 = 「未选模型 或 模型相符」的报告的渠道集；模型候选 = 「未选渠道 或 渠道相符」的报告的模型集。
// 故：选了渠道 → 模型下拉只剩该渠道的模型；选了模型 → 渠道下拉只剩该模型所属渠道。老报告(!isNew)不参与。
export function reportChannelModelOptions(parsedList, { channel = "", model = "" } = {}, aliasMaps = null) {
  const channels = new Set();
  const models = new Set();
  for (const p of parsedList || []) {
    if (!p || !p.isNew) continue;
    // 折算成当前名后再收集，让曾用名归并到当前渠道/模型（下拉只呈现当前名）。
    const pChannel = canonName(p.channel, aliasMaps?.channel);
    const pModel = canonName(p.model, aliasMaps?.model);
    if (pChannel && (!model || pModel === model)) channels.add(pChannel);
    if (pModel && (!channel || pChannel === channel)) models.add(pModel);
  }
  return { channels: [...channels].sort(), models: [...models].sort() };
}

// 日期范围联动边界：终止不早于起始、起始不晚于终止，且都夹在报告实际日期范围内。
// 入参/返回均为 <input type=date> 的 YYYY-MM-DD 值；空串表示不限。
export function computeDateBounds(fromVal, toVal, reportMin, reportMax) {
  return {
    toMin: fromVal || reportMin || "",
    fromMax: toVal || reportMax || "",
  };
}
