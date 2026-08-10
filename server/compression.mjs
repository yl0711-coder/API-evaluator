// HTTP 响应压缩工具：根据 accept-encoding 协商，支持 brotli / gzip，内存缓存压缩结果。
import { createHash } from "node:crypto";
import { brotliCompress, gzip } from "node:zlib";
import { promisify } from "node:util";

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

// 压缩缓存：key = `${encoding}:${etag}`, value = { buffer, timestamp }
// 驱逐策略：简单 LRU，超过 MAX_CACHE_ENTRIES 时清理最老的 10%
const compressionCache = new Map();
const MAX_CACHE_ENTRIES = 200;
const EVICTION_BATCH_SIZE = 20;

// 根据内容计算 etag（用于缓存 key + HTTP etag 响应头）
export function computeEtag(buffer) {
  const hash = createHash("sha256").update(buffer).digest("hex");
  return `"${hash.slice(0, 16)}"`;
}

// 从 accept-encoding 头选择最优编码：brotli > gzip > identity
export function negotiateEncoding(acceptEncodingHeader) {
  if (!acceptEncodingHeader) return "identity";
  const lower = acceptEncodingHeader.toLowerCase();
  if (lower.includes("br")) return "br";
  if (lower.includes("gzip")) return "gzip";
  return "identity";
}

// 压缩 buffer，结果缓存在内存中（按 etag + encoding 做 key）
async function compressBuffer(buffer, encoding, etag) {
  const cacheKey = `${encoding}:${etag}`;
  const cached = compressionCache.get(cacheKey);
  if (cached) {
    cached.timestamp = Date.now();
    return cached.buffer;
  }

  let compressed;
  if (encoding === "br") {
    compressed = await brotliCompressAsync(buffer);
  } else if (encoding === "gzip") {
    compressed = await gzipAsync(buffer);
  } else {
    return buffer;
  }

  // 缓存淘汰：超过容量时删除最老的 EVICTION_BATCH_SIZE 条
  if (compressionCache.size >= MAX_CACHE_ENTRIES) {
    const entries = Array.from(compressionCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, EVICTION_BATCH_SIZE);
    for (const [key] of entries) {
      compressionCache.delete(key);
    }
  }

  compressionCache.set(cacheKey, { buffer: compressed, timestamp: Date.now() });
  return compressed;
}

// 静态资源响应：协商编码、压缩、缓存头（带 hash 的强缓存，index.html 用 etag）
export async function sendCompressedStatic(res, filePath, buffer, mimeType, securityHeaders, acceptEncoding) {
  const etag = computeEtag(buffer);
  const isHashed = /[.-][a-f0-9]{8,}\./.test(filePath); // Vite 产物：index-BzlLiOBH.js
  const isIndexHtml = filePath.endsWith("index.html");

  const headers = {
    "content-type": mimeType,
    ...securityHeaders,
  };

  // 缓存策略：带 hash 的资源强缓存 1 年，index.html 用 etag + no-cache
  if (isHashed) {
    headers["cache-control"] = "public, max-age=31536000, immutable";
  } else if (isIndexHtml) {
    headers["cache-control"] = "no-cache";
    headers.etag = etag;
  } else {
    // 其他静态资源（favicon 等）：短期缓存
    headers["cache-control"] = "public, max-age=3600";
    headers.etag = etag;
  }

  const encoding = negotiateEncoding(acceptEncoding);
  const compressed = await compressBuffer(buffer, encoding, etag);

  if (encoding !== "identity") {
    headers["content-encoding"] = encoding;
  }
  headers["content-length"] = compressed.length;

  res.writeHead(200, headers);
  res.end(compressed);
}

// JSON 响应压缩：超过阈值才压缩（小响应压缩反而增加开销）
const JSON_COMPRESSION_THRESHOLD = 1024; // 1 KB

export function sendCompressedJson(res, status, data, acceptEncoding) {
  const json = JSON.stringify(data, null, 2);
  const buffer = Buffer.from(json, "utf8");

  const headers = { "content-type": "application/json; charset=utf-8" };

  // 小响应直接发送
  if (buffer.length < JSON_COMPRESSION_THRESHOLD) {
    headers["content-length"] = buffer.length;
    res.writeHead(status, headers);
    res.end(buffer);
    return;
  }

  // 大响应协商压缩
  const encoding = negotiateEncoding(acceptEncoding);

  if (encoding === "identity") {
    headers["content-length"] = buffer.length;
    res.writeHead(status, headers);
    res.end(buffer);
    return;
  }

  // 异步压缩后发送
  const compressFunc = encoding === "br" ? brotliCompressAsync : gzipAsync;
  compressFunc(buffer)
    .then((compressed) => {
      headers["content-encoding"] = encoding;
      headers["content-length"] = compressed.length;
      res.writeHead(status, headers);
      res.end(compressed);
    })
    .catch(() => {
      // 压缩失败降级：发送原始内容
      headers["content-length"] = buffer.length;
      res.writeHead(status, headers);
      res.end(buffer);
    });
}
