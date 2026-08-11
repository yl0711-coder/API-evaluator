// Build a small, dependency-free OOXML workbook for the model comparison export.

const textEncoder = new TextEncoder();

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBytes = textEncoder.encode(name);
    const bytes = typeof content === "string" ? textEncoder.encode(content) : content;
    const checksum = crc32(bytes);
    const header = new Uint8Array([
      0x50,
      0x4b,
      0x03,
      0x04,
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(checksum),
      ...u32(bytes.length),
      ...u32(bytes.length),
      ...u16(nameBytes.length),
      ...u16(0),
    ]);
    local.push(header, nameBytes, bytes);
    const centralHeader = new Uint8Array([
      0x50,
      0x4b,
      0x01,
      0x02,
      ...u16(20),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(checksum),
      ...u32(bytes.length),
      ...u32(bytes.length),
      ...u16(nameBytes.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(offset),
    ]);
    central.push(centralHeader, nameBytes);
    offset += header.length + nameBytes.length + bytes.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array([
    0x50,
    0x4b,
    0x05,
    0x06,
    ...u16(0),
    ...u16(0),
    ...u16(files.length),
    ...u16(files.length),
    ...u32(centralSize),
    ...u32(offset),
    ...u16(0),
  ]);
  const output = new Uint8Array(offset + centralSize + end.length);
  let cursor = 0;
  for (const part of [...local, ...central, end]) {
    output.set(part, cursor);
    cursor += part.length;
  }
  return output;
}

function columnName(index) {
  let name = "";
  let value = index + 1;
  while (value) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function cellXml(ref, value, style = 0) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}" s="${style}" t="n"><v>${value}</v></c>`;
  const text = xmlEscape(value);
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

function sheetXml(rows, merges = [], freezeRow = 0, widths = [], rowHeights = {}) {
  const rowXml = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((item, colIndex) => {
          const value = Array.isArray(item) ? item[0] : item;
          const style = Array.isArray(item) ? item[1] || 0 : 0;
          return cellXml(`${columnName(colIndex)}${rowIndex + 1}`, value, style);
        })
        .join("");
      const height = rowHeights[rowIndex + 1];
      return `<row r="${rowIndex + 1}"${height ? ` ht="${height}" customHeight="1"` : ""}>${cells}</row>`;
    })
    .join("");
  const cols = widths.length
    ? `<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const pane = freezeRow
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${freezeRow}" topLeftCell="A${freezeRow + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView></sheetViews>`
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  const mergeXml = merges.length
    ? `<mergeCells count="${merges.length}">${merges.map((merge) => `<mergeCell ref="${merge}"/>`).join("")}</mergeCells>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols}<sheetData>${rowXml}</sheetData>${mergeXml}</worksheet>`;
}

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0"/><numFmt numFmtId="165" formatCode="0.0%"/><numFmt numFmtId="166" formatCode="0.0"/></numFmts><fonts count="6"><font><sz val="11"/><name val="Aptos"/><color rgb="FF0F172A"/></font><font><b/><sz val="18"/><name val="Aptos Display"/><color rgb="FFFFFFFF"/></font><font><b/><sz val="11"/><name val="Aptos"/><color rgb="FFFFFFFF"/></font><font><b/><sz val="11"/><name val="Aptos"/><color rgb="FF1E3A8A"/></font><font><b/><sz val="11"/><name val="Aptos"/><color rgb="FF115E59"/></font><font><i/><sz val="11"/><name val="Aptos"/><color rgb="FF9A3412"/></font></fonts><fills count="9"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0F172A"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2563EB"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0F766E"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEFF6FF"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFECFDF5"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE2E8F0"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDCFCE7"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF7ED"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/></border><border><left style="thin"><color rgb="FFCBD5E1"/></left><right style="thin"><color rgb="FFCBD5E1"/></right><top style="thin"><color rgb="FFCBD5E1"/></top><bottom style="thin"><color rgb="FFCBD5E1"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="21"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="1" borderId="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="1" borderId="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="2" borderId="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="3" borderId="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="3" fillId="4" borderId="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="4" fillId="5" borderId="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="6" borderId="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="6" borderId="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="4" borderId="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="5" borderId="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="3" fillId="4" borderId="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="4" fillId="5" borderId="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="5" fillId="8" borderId="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="7" borderId="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="8" borderId="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="165" fontId="0" fillId="4" borderId="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="165" fontId="0" fillId="5" borderId="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="165" fontId="3" fillId="4" borderId="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="165" fontId="4" fillId="5" borderId="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf></cellXfs></styleSheet>`;

function metricValue(row, side) {
  const value = row?.[side === "a" ? "valueA" : "valueB"];
  return Number.isFinite(value) ? value : "";
}

function metricStyle(row, side) {
  const percent = row?.format === "percent";
  const winner = row?.winner === side;
  if (winner) return side === "a" ? (percent ? 19 : 11) : percent ? 20 : 12;
  return side === "a" ? (percent ? 17 : 9) : percent ? 18 : 10;
}

function scenarioStyle(row, side, field) {
  const data = row?.[side] || {};
  const value = data[field];
  if (!Number.isFinite(value)) return 13;
  const percent = field === "passRate";
  if (row?.winner === side) return side === "a" ? (percent ? 19 : 11) : percent ? 20 : 12;
  return side === "a" ? (percent ? 17 : 9) : percent ? 18 : 10;
}

function summaryRows(comparison) {
  const rows = comparison?.summary || [];
  const subjectA = comparison?.subjects?.a?.label || "对象 A";
  const subjectB = comparison?.subjects?.b?.label || "对象 B";
  const values = [
    [["模型对比报告", 1]],
    [],
    [
      ["对象 A", 3],
      ["", 3],
      ["", 3],
      ["对象 B", 4],
      ["", 4],
      ["", 4],
    ],
    [
      [subjectA, 5],
      ["", 5],
      ["", 5],
      [subjectB, 6],
      ["", 6],
      ["", 6],
    ],
    [],
    [["核心结果", 7]],
    [
      ["指标", 8],
      [subjectA, 8],
      [subjectB, 8],
      ["单位", 8],
      ["结论", 8],
      ["口径说明", 8],
    ],
  ];
  for (const row of rows) {
    const a = metricValue(row, "a");
    const b = metricValue(row, "b");
    const conclusion =
      row.status === "insufficient" ? "数据不足" : row.winner === "a" ? "对象 A 更优" : row.winner === "b" ? "对象 B 更优" : "平局";
    values.push([
      [row.label || "-", 7],
      [a, metricStyle(row, "a")],
      [b, metricStyle(row, "b")],
      [row.format === "percent" ? "%" : row.format === "milliseconds" ? "ms" : row.unit || "", 13],
      [conclusion, row.status === "insufficient" ? 16 : row.winner ? 7 : 13],
      [row.detail || "", 16],
    ]);
  }
  values.push([["注：Token 相关指标用于成本参考，不作为优劣判断。", 16]]);
  return {
    values,
    merges: ["A1:F1", "A3:C3", "D3:F3", "A4:C4", "D4:F4", "A6:F6", `A${values.length}:F${values.length}`],
    widths: [28, 17, 17, 12, 20, 56],
    rowHeights: { 1: 34, 3: 24, 4: 30, 6: 24, 7: 24, [values.length]: 24 },
  };
}

function detailRows(comparison) {
  const subjectA = comparison?.subjects?.a?.label || "对象 A";
  const subjectB = comparison?.subjects?.b?.label || "对象 B";
  const values = [
    [["逐场景评测明细", 1]],
    [[`对象 A：${subjectA}    |    对象 B：${subjectB}`, 16]],
    [
      ["场景信息", 8],
      ["", 8],
      ["质量分", 3],
      ["", 3],
      ["通过率", 4],
      ["", 4],
      ["平均耗时 (ms)", 2],
      ["", 2],
      ["P50 首 Token (ms)", 2],
      ["", 2],
      ["Token 用量", 2],
      ["", 2],
      ["问题摘要", 2],
      ["", 2],
    ],
    [
      ["场景", 8],
      ["难度", 8],
      ["对象 A", 8],
      ["对象 B", 8],
      ["对象 A", 8],
      ["对象 B", 8],
      ["对象 A", 8],
      ["对象 B", 8],
      ["对象 A", 8],
      ["对象 B", 8],
      ["对象 A 输出/缓存", 8],
      ["对象 B 输出/缓存", 8],
      ["对象 A", 8],
      ["对象 B", 8],
    ],
  ];
  for (const row of comparison?.scenarios || []) {
    const a = row.a || {};
    const b = row.b || {};
    const usage = (data) =>
      Number.isFinite(data.outputTokens) || Number.isFinite(data.cacheReadTokens)
        ? `${Number.isFinite(data.outputTokens) ? Math.round(data.outputTokens).toLocaleString("zh-CN") : "-"} / ${Number.isFinite(data.cacheReadTokens) ? Math.round(data.cacheReadTokens).toLocaleString("zh-CN") : "-"}`
        : "-";
    values.push([
      [row.name || "-", 7],
      [row.tier || "", 7],
      [Number.isFinite(a.quality) ? a.quality : "", scenarioStyle(row, "a", "quality")],
      [Number.isFinite(b.quality) ? b.quality : "", scenarioStyle(row, "b", "quality")],
      [Number.isFinite(a.passRate) ? a.passRate : "", scenarioStyle(row, "a", "passRate")],
      [Number.isFinite(b.passRate) ? b.passRate : "", scenarioStyle(row, "b", "passRate")],
      [Number.isFinite(a.avgMs) ? a.avgMs : "", scenarioStyle(row, "a", "avgMs")],
      [Number.isFinite(b.avgMs) ? b.avgMs : "", scenarioStyle(row, "b", "avgMs")],
      [Number.isFinite(a.p50FirstTokenMs) ? a.p50FirstTokenMs : "", scenarioStyle(row, "a", "p50FirstTokenMs")],
      [Number.isFinite(b.p50FirstTokenMs) ? b.p50FirstTokenMs : "", scenarioStyle(row, "b", "p50FirstTokenMs")],
      [usage(a), 13],
      [usage(b), 13],
      [a.issue || "", 16],
      [b.issue || "", 16],
    ]);
  }
  return {
    values,
    merges: ["A1:N1", "A2:N2", "A3:B3", "C3:D3", "E3:F3", "G3:H3", "I3:J3", "K3:L3", "M3:N3"],
    widths: [36, 22, 13, 13, 13, 13, 15, 15, 15, 15, 21, 21, 45, 45],
    rowHeights: { 1: 32, 2: 22, 3: 22, 4: 28 },
  };
}

export function buildComparisonXlsx(comparison) {
  const overview = summaryRows(comparison);
  const details = detailRows(comparison);
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="概览" sheetId="1" r:id="rId1"/><sheet name="逐场景明细" sheetId="2" r:id="rId2"/></sheets></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
  return zip([
    ["[Content_Types].xml", contentTypes],
    ["_rels/.rels", rootRels],
    ["xl/workbook.xml", workbook],
    ["xl/_rels/workbook.xml.rels", rels],
    ["xl/styles.xml", stylesXml],
    ["xl/worksheets/sheet1.xml", sheetXml(overview.values, overview.merges, 7, overview.widths, overview.rowHeights)],
    ["xl/worksheets/sheet2.xml", sheetXml(details.values, details.merges, 4, details.widths, details.rowHeights)],
  ]);
}
