// 压缩功能单元测试：etag 计算、编码协商、缓存逻辑
import { describe, it } from "node:test";
import assert from "node:assert";
import { computeEtag, etagMatches, isHashedAssetPath, negotiateEncoding, sendCompressedStatic } from "../server/compression.mjs";

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

  // q=0 的语义是「我解不了这个编码」（RFC 9110 §12.5.3）。此前用 includes() 子串匹配，
  // 对 `br;q=0, gzip` 仍回 brotli——只支持 gzip 的客户端拿到 brotli body 直接解压失败、页面白屏。
  // 实测复现过：真起服务请求 /assets/*.js 拿到 `content-encoding: br`，body 首字节 5b 4f（非 gzip magic）。
  it("negotiateEncoding respects q=0 as explicit refusal", () => {
    assert.strictEqual(negotiateEncoding("br;q=0, gzip"), "gzip", "拒绝 br 时必须退到 gzip");
    assert.strictEqual(negotiateEncoding("gzip;q=0"), "identity", "拒绝 gzip 且无 br 时必须不压缩");
    assert.strictEqual(negotiateEncoding("br;q=0, gzip;q=0"), "identity", "两者都拒绝时必须原样发送");
    assert.strictEqual(negotiateEncoding("gzip;q=0.0"), "identity", "0.0 与 0 等价");
    assert.strictEqual(negotiateEncoding("br ; q=0"), "identity", "参数前后的空白不影响判定");
  });

  // 非零 q 只表示「可以用」，用哪个由服务端定（我们固定 br 优先），不照抄客户端的 q 排序。
  it("negotiateEncoding treats any positive q as acceptable", () => {
    assert.strictEqual(negotiateEncoding("br;q=0.5, gzip;q=1.0"), "br");
    assert.strictEqual(negotiateEncoding("gzip;q=0.1"), "gzip");
  });

  // 通配符：`*` 表示接受任意编码；`*;q=0` 表示除已列出的之外一律拒绝。
  it("negotiateEncoding handles the * wildcard", () => {
    assert.strictEqual(negotiateEncoding("*"), "br");
    assert.strictEqual(negotiateEncoding("*;q=0"), "identity");
    assert.strictEqual(negotiateEncoding("br;q=0, *"), "gzip", "显式 q=0 优先于通配");
  });

  // 反向误判：含 "br" / "gzip" 子串但并非该编码的 token 不得命中，
  // 否则会对不支持压缩的客户端发压缩体。
  it("negotiateEncoding does not substring-match unrelated tokens", () => {
    for (const header of ["xbr", "brotli", "nobr", "deflate, x-gzip"]) {
      assert.strictEqual(negotiateEncoding(header), "identity", `${header} 不应被当成 br/gzip`);
    }
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
