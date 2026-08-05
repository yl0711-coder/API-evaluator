import { deflateRawSync } from "node:zlib";

// ZIP writer kept dependency-free. Entries are deflated individually and the
// archive is returned as one bounded Buffer by the download endpoint.
const ZIP_LOCAL_FILE = 0x04034b50;
const ZIP_CENTRAL_FILE = 0x02014b50;
const ZIP_END = 0x06054b50;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function createZipArchive(entries, { now = new Date() } = {}) {
  const files = [];
  let offset = 0;
  const { time, date } = dosDateTime(now);

  for (const entry of entries || []) {
    const name = String(entry?.name || "");
    if (!name || name.includes("/") || name.includes("\\")) throw new Error("invalid_zip_entry_name");
    const nameBuffer = Buffer.from(name, "utf8");
    const source = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content ?? ""), "utf8");
    const compressed = deflateRawSync(source);
    const crc = crc32(source);
    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(ZIP_LOCAL_FILE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuffer.copy(local, 30);
    files.push({ nameBuffer, sourceLength: source.length, compressed, crc, local, offset, time, date });
    offset += local.length + compressed.length;
  }

  const central = files.map((file) => {
    const record = Buffer.alloc(46 + file.nameBuffer.length);
    record.writeUInt32LE(ZIP_CENTRAL_FILE, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt16LE(file.time, 12);
    record.writeUInt16LE(file.date, 14);
    record.writeUInt32LE(file.crc, 16);
    record.writeUInt32LE(file.compressed.length, 20);
    record.writeUInt32LE(file.sourceLength, 24);
    record.writeUInt16LE(file.nameBuffer.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE(0, 38);
    record.writeUInt32LE(file.offset, 42);
    file.nameBuffer.copy(record, 46);
    return record;
  });
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...files.flatMap((file) => [file.local, file.compressed]), centralBuffer, end]);
}
