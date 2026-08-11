// 压缩功能单元测试：etag 计算、编码协商、缓存逻辑
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  computeEtag,
  etagMatches,
  isHashedAssetPath,
  negotiateEncoding,
  sendCompressedStatic,
} from "../server/compression.mjs";

// 收集 writeHead / end 的假 res，用于断言响应头
function fakeRes() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

describe("compression utils", () => {
  it("computeEtag returns consistent hash for same content", () => {
    const buf1 = Buffer.from("hello world", "utf8");
    const buf2 = Buffer.from("hello world", "utf8");
    const etag1 = computeEtag(buf1);
    const etag2 = computeEtag(buf2);
    assert.strictEqual(etag1, etag2);
    assert.ok(etag1.startsWith('"'));
    assert.ok(etag1.endsWith('"'));
  });

  it("computeEtag returns different hash for different content", () => {
    const buf1 = Buffer.from("hello", "utf8");
    const buf2 = Buffer.from("world", "utf8");
    assert.notStrictEqual(computeEtag(buf1), computeEtag(buf2));
  });

  it("negotiateEncoding prefers brotli over gzip", () => {
    assert.strictEqual(negotiateEncoding("gzip, br"), "br");
    assert.strictEqual(negotiateEncoding("br, gzip"), "br");
    assert.strictEqual(negotiateEncoding("gzip, deflate, br"), "br");
  });

  it("negotiateEncoding falls back to gzip if br unavailable", () => {
    assert.strictEqual(negotiateEncoding("gzip, deflate"), "gzip");
    assert.strictEqual(negotiateEncoding("deflate, gzip"), "gzip");
  });

  it("negotiateEncoding returns identity if no compression available", () => {
    assert.strictEqual(negotiateEncoding(""), "identity");
    assert.strictEqual(negotiateEncoding(undefined), "identity");
    assert.strictEqual(negotiateEncoding("deflate"), "identity");
  });

  it("negotiateEncoding is case-insensitive", () => {
    assert.strictEqual(negotiateEncoding("GZIP, BR"), "br");
    assert.strictEqual(negotiateEncoding("Gzip"), "gzip");
  });
});

describe("isHashedAssetPath", () => {
  it("识别 Vite 默认的 base64url 风格 hash（混合大小写，非十六进制）", () => {
    // 曾经的正则只匹配 /[a-f0-9]{8,}/，这几个真实产物名全部漏判，
    // 导致 immutable 强缓存实际没生效。
    assert.strictEqual(isHashedAssetPath("dist/assets/index-BzlLiOBH.js"), true);
    assert.strictEqual(isHashedAssetPath("dist/assets/index-DfG_h2Kq.css"), true);
    assert.strictEqual(isHashedAssetPath("D:\\dist\\assets\\vendor-C1x9Zk_p.js"), true);
  });

  it("识别十六进制 hash", () => {
    assert.strictEqual(isHashedAssetPath("assets/index-4a7f9c21.css"), true);
  });

  it("不把普通文件名误判成带 hash（否则改了内容会被强缓存一年）", () => {
    assert.strictEqual(isHashedAssetPath("index.html"), false);
    assert.strictEqual(isHashedAssetPath("favicon.ico"), false);
    assert.strictEqual(isHashedAssetPath("assets/vendor-legacy.js"), false);
    assert.strictEqual(isHashedAssetPath("assets/main-bundle.js"), false);
    assert.strictEqual(isHashedAssetPath("assets/index-abc.js"), false); // 太短
  });
});

describe("sendCompressedStatic 响应头", () => {
  it("带 hash 的资源用 immutable 强缓存，并声明 vary", async () => {
    const res = fakeRes();
    const body = Buffer.from("x".repeat(4096), "utf8");
    await sendCompressedStatic(res, "dist/assets/index-BzlLiOBH.js", body, "text/javascript", {}, "gzip, br");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.strictEqual(res.headers["content-encoding"], "br");
    assert.strictEqual(res.headers.vary, "accept-encoding");
    assert.ok(res.body.length < body.length, "压缩后应比原文小");
    assert.strictEqual(res.headers["content-length"], res.body.length);
  });

  it("index.html 用 no-cache + etag，绝不强缓存", async () => {
    const res = fakeRes();
    const body = Buffer.from("<html></html>", "utf8");
    await sendCompressedStatic(res, "dist/index.html", body, "text/html", {}, "gzip");
    assert.strictEqual(res.headers["cache-control"], "no-cache");
    assert.ok(res.headers.etag);
    assert.strictEqual(res.headers["content-encoding"], "gzip");
  });

  it("客户端不支持压缩时原样发送，且不带 content-encoding", async () => {
    const res = fakeRes();
    const body = Buffer.from("plain", "utf8");
    await sendCompressedStatic(res, "favicon.ico", body, "image/x-icon", {}, undefined);
    assert.strictEqual(res.headers["content-encoding"], undefined);
    assert.strictEqual(res.headers["cache-control"], "public, max-age=3600");
    assert.deepStrictEqual(res.body, body);
  });

  it("securityHeaders 被透传", async () => {
    const res = fakeRes();
    await sendCompressedStatic(res, "index.html", Buffer.from("h"), "text/html", { "x-frame-options": "DENY" }, "br");
    assert.strictEqual(res.headers["x-frame-options"], "DENY");
  });
});

describe("条件请求（if-none-match → 304）", () => {
  it("etagMatches 处理多值、W/ 弱校验、通配符", () => {
    assert.strictEqual(etagMatches('"abc"', '"abc"'), true);
    assert.strictEqual(etagMatches('W/"abc"', '"abc"'), true);
    assert.strictEqual(etagMatches('"xyz", "abc"', '"abc"'), true);
    assert.strictEqual(etagMatches("*", '"abc"'), true);
    assert.strictEqual(etagMatches('"xyz"', '"abc"'), false);
    assert.strictEqual(etagMatches(undefined, '"abc"'), false);
    assert.strictEqual(etagMatches("", '"abc"'), false);
  });

  it("etag 命中 → 304 且无 body（否则 etag 只是装饰，刷新仍整包重传）", async () => {
    const body = Buffer.from("<html></html>", "utf8");
    const etag = computeEtag(body);
    const res = fakeRes();
    await sendCompressedStatic(res, "dist/index.html", body, "text/html", {}, "gzip", { ifNoneMatch: etag });
    assert.strictEqual(res.status, 304);
    assert.strictEqual(res.body, undefined);
    assert.strictEqual(res.headers.etag, etag);
    assert.strictEqual(res.headers["content-encoding"], undefined);
  });

  it("etag 不匹配 → 正常 200 带 body", async () => {
    const res = fakeRes();
    const body = Buffer.from("<html></html>", "utf8");
    await sendCompressedStatic(res, "dist/index.html", body, "text/html", {}, "gzip", { ifNoneMatch: '"stale"' });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body);
  });

  it("带 hash 的资源没有 etag，不参与 304 协商（走 immutable 强缓存）", async () => {
    const res = fakeRes();
    const body = Buffer.from("x".repeat(2048), "utf8");
    await sendCompressedStatic(res, "assets/index-BzlLiOBH.js", body, "text/javascript", {}, "br", {
      ifNoneMatch: "*",
    });
    assert.strictEqual(res.status, 200);
  });
});
