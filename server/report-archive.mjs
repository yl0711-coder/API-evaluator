import { createDeflateRaw } from "node:zlib";

const ZIP_LOCAL_FILE = 0x04034b50;
const ZIP_CENTRAL_FILE = 0x02014b50;
const ZIP_DATA_DESCRIPTOR = 0x08074b50;
const ZIP_END = 0x06054b50;
const ZIP_UTF8_AND_DESCRIPTOR = 0x0808;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function updateCrc32(value, buffer) {
  let next = value;
  for (const byte of buffer) next = CRC_TABLE[(next ^ byte) & 0xff] ^ (next >>> 8);
  return next;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function ensureEntryName(name) {
  if (!name || name.includes("/") || name.includes("\\")) throw new Error("invalid_zip_entry_name");
  return Buffer.from(name, "utf8");
}

function localHeader(nameLength, time, date) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(ZIP_LOCAL_FILE, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(ZIP_UTF8_AND_DESCRIPTOR, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  header.writeUInt16LE(0, 14);
  header.writeUInt32LE(0, 18);
  header.writeUInt32LE(0, 22);
  header.writeUInt16LE(nameLength, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function dataDescriptor(crc, compressedSize, sourceSize) {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(ZIP_DATA_DESCRIPTOR, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(compressedSize, 8);
  descriptor.writeUInt32LE(sourceSize, 12);
  return descriptor;
}

function centralHeader(file) {
  const record = Buffer.alloc(46 + file.nameBuffer.length);
  record.writeUInt32LE(ZIP_CENTRAL_FILE, 0);
  record.writeUInt16LE(20, 4);
  record.writeUInt16LE(20, 6);
  record.writeUInt16LE(ZIP_UTF8_AND_DESCRIPTOR, 8);
  record.writeUInt16LE(8, 10);
  record.writeUInt16LE(file.time, 12);
  record.writeUInt16LE(file.date, 14);
  record.writeUInt32LE(file.crc, 16);
  record.writeUInt32LE(file.compressedSize, 20);
  record.writeUInt32LE(file.sourceSize, 24);
  record.writeUInt16LE(file.nameBuffer.length, 28);
  record.writeUInt16LE(0, 30);
  record.writeUInt16LE(0, 32);
  record.writeUInt16LE(0, 34);
  record.writeUInt16LE(0, 36);
  record.writeUInt32LE(0, 38);
  record.writeUInt32LE(file.offset, 42);
  file.nameBuffer.copy(record, 46);
  return record;
}

function endRecord(entryCount, centralSize, centralOffset) {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return end;
}

function writeWithBackpressure(writable, chunk) {
  if (writable.destroyed) return Promise.reject(new Error("archive_response_closed"));
  if (writable.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      writable.off("drain", onDrain);
      writable.off("error", onError);
      writable.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("archive_response_closed"));
    };
    writable.once("drain", onDrain);
    writable.once("error", onError);
    writable.once("close", onClose);
  });
}

function waitForDrain(stream) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

async function streamEntry(entry, writable, state, { time, date, maxSourceBytes }) {
  const nameBuffer = ensureEntryName(String(entry?.name || ""));
  const source = await entry?.stream;
  if (!source || typeof source[Symbol.asyncIterator] !== "function") throw new Error("invalid_zip_entry_stream");

  const offset = state.offset;
  const header = localHeader(nameBuffer.length, time, date);
  await writeWithBackpressure(writable, header);
  await writeWithBackpressure(writable, nameBuffer);
  state.offset += header.length + nameBuffer.length;

  let crc = 0xffffffff;
  let sourceSize = 0;
  let compressedSize = 0;
  const deflater = createDeflateRaw();
  const writeCompressed = (async () => {
    for await (const chunk of deflater) {
      compressedSize += chunk.length;
      await writeWithBackpressure(writable, chunk);
    }
  })();

  try {
    for await (const chunk of source) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sourceSize += bytes.length;
      if (state.sourceBytes + bytes.length > maxSourceBytes) {
        const error = new Error("archive_source_limit_exceeded");
        error.code = "archive_source_limit_exceeded";
        throw error;
      }
      state.sourceBytes += bytes.length;
      crc = updateCrc32(crc, bytes);
      if (!deflater.write(bytes)) await waitForDrain(deflater);
    }
    deflater.end();
    await writeCompressed;
  } catch (error) {
    source.destroy?.(error);
    deflater.destroy(error);
    await writeCompressed.catch(() => {});
    throw error;
  }

  const descriptor = dataDescriptor((crc ^ 0xffffffff) >>> 0, compressedSize, sourceSize);
  await writeWithBackpressure(writable, descriptor);
  state.offset += compressedSize + descriptor.length;
  state.files.push({ nameBuffer, time, date, crc: (crc ^ 0xffffffff) >>> 0, compressedSize, sourceSize, offset });
}

// Streams an ordinary ZIP archive using data descriptors. Only compact central
// directory metadata is kept in memory; source and compressed payloads obey the
// response's backpressure instead of accumulating in Buffers.
export async function streamZipArchive(entries, writable, { now = new Date(), maxSourceBytes = Number.MAX_SAFE_INTEGER } = {}) {
  const { time, date } = dosDateTime(now);
  const state = { offset: 0, files: [], sourceBytes: 0 };
  for (const entry of entries || []) await streamEntry(entry, writable, state, { time, date, maxSourceBytes });

  const centralOffset = state.offset;
  for (const file of state.files) {
    const record = centralHeader(file);
    await writeWithBackpressure(writable, record);
    state.offset += record.length;
  }
  await writeWithBackpressure(writable, endRecord(state.files.length, state.offset - centralOffset, centralOffset));
}
