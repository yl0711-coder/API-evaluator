// 压缩功能单元测试：etag 计算、编码协商、缓存逻辑
import { describe, it } from "node:test";
import assert from "node:assert";
import { computeEtag, negotiateEncoding } from "../server/compression.mjs";

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
