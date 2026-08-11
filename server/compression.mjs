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

// 判断文件名是否带内容 hash（可安全强缓存）。
//
// Vite 默认产出 base64url 风格的 8 位 hash（index-BzlLiOBH.js），**不是**小写十六进制，
// 所以不能只匹配 [a-f0-9]。但也不能宽到把普通带连字符的文件名（vendor-legacy.js）当成
// 带 hash：那会让改了内容却没改名的文件被浏览器强缓存一年，发版后拿不到新版本。
//
// 判据：扩展名前最后一个「-」之后的片段长度 ≥ 8，且不是纯字母
// （真 hash 几乎必然混合大小写或含数字，人写的单词则不会）。
export function isHashedAssetPath(filePath) {
  const base = filePath.replace(/\\/g, "/").split("/").pop() || "";
  const match = /-([A-Za-z0-9_-]{8,})\.[^.]+$/.exec(base);
  if (!match) return false;
  const segment = match[1];
  const hasDigit = /[0-9]/.test(segment);
  const hasMixedCase = /[a-z]/.test(segment) && /[A-Z]/.test(segment);
  return hasDigit || hasMixedCase;
}

// 静态资源响应：协商编码、压缩、缓存头（带 hash 的强缓存，index.html 用 etag）
//
// options.ifNoneMatch 传入请求的 if-none-match 头：命中则回 304，浏览器复用本地副本。
// 不处理它的话 etag 只是装饰——每次刷新仍然整包重传。
export async function sendCompressedStatic(
  res,
  filePath,
  buffer,
  mimeType,
  securityHeaders,
  acceptEncoding,
  options = {},
) {
  const etag = computeEtag(buffer);
  const isHashed = isHashedAssetPath(filePath);
  const isIndexHtml = filePath.endsWith("index.html");

  const headers = {
    "content-type": mimeType,
    ...securityHeaders,
    // 响应体随 accept-encoding 变化：不声明 vary，共享缓存 / CDN 可能把 brotli 的
    // body 喂给只支持 gzip 的客户端，对方直接解不开。
    vary: "accept-encoding",
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

  // 条件请求：etag 匹配则回 304（空 body）。
  // if-none-match 可能是逗号分隔的多值，也可能带 W/ 弱校验前缀。
  if (headers.etag && etagMatches(options.ifNoneMatch, etag)) {
    res.writeHead(304, {
      etag: headers.etag,
      "cache-control": headers["cache-control"],
      vary: headers.vary,
    });
    res.end();
    return;
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

// 比对 if-none-match 与当前 etag。支持 "*"、逗号分隔多值、W/ 弱校验前缀。
export function etagMatches(ifNoneMatchHeader, etag) {
  if (!ifNoneMatchHeader) return false;
  const normalize = (v) => v.trim().replace(/^W\//, "");
  const candidates = ifNoneMatchHeader.split(",").map(normalize);
  if (candidates.includes("*")) return true;
  return candidates.includes(normalize(etag));
}

// JSON 响应压缩：超过阈值才压缩（小响应压缩反而增加开销）
const JSON_COMPRESSION_THRESHOLD = 1024; // 1 KB

export function sendCompressedJson(res, status, data, acceptEncoding) {
  const json = JSON.stringify(data, null, 2);
  const buffer = Buffer.from(json, "utf8");

  // vary 同上：响应体形态取决于请求方的 accept-encoding。
  const headers = { "content-type": "application/json; charset=utf-8", vary: "accept-encoding" };

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
