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
  const channel = head.length >= 2 ? head.slice(0, -1).join("_") : null;
  const model = head.length >= 2 ? head[head.length - 1] : null; // head 仅「多目标」→ null
  return { isNew: true, type, date, channel, model };
}

// 一条报告（其 parseReportId 结果）是否匹配筛选条件。
// filter: { channel, model, type, from, to }，date 边界 from/to 为 YYYYMMDD（含端点）。
// 无任何条件 → 全部命中（含老报告）；一旦有条件 → 只命中新格式且各项都匹配（老报告不参与）。
export function matchesReportFilter(parsed, { channel = "", model = "", type = "", from = "", to = "" } = {}) {
  if (!channel && !model && !type && !from && !to) return true;
  if (!parsed || !parsed.isNew) return false;
  if (channel && parsed.channel !== channel) return false;
  if (model && parsed.model !== model) return false;
  if (type && parsed.type !== type) return false;
  if (from && parsed.date < from) return false; // YYYYMMDD 零填充 → 字符串比较即时间序
  if (to && parsed.date > to) return false;
  return true;
}

// 日期范围联动边界：终止不早于起始、起始不晚于终止，且都夹在报告实际日期范围内。
// 入参/返回均为 <input type=date> 的 YYYY-MM-DD 值；空串表示不限。
export function computeDateBounds(fromVal, toVal, reportMin, reportMax) {
  return {
    toMin: fromVal || reportMin || "",
    fromMax: toVal || reportMax || "",
  };
}
