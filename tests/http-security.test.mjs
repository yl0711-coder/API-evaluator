import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedBrowserOrigin, staticSecurityHeaders } from "../server/http-security.mjs";

test("browser origin guard only allows local tool origins", () => {
  assert.equal(isAllowedBrowserOrigin(""), true);
  assert.equal(isAllowedBrowserOrigin("http://127.0.0.1:5179"), true);
  assert.equal(isAllowedBrowserOrigin("http://localhost:5179"), true);
  assert.equal(isAllowedBrowserOrigin("https://example.com"), false);
  assert.equal(isAllowedBrowserOrigin("not a url"), false);
});

test("static security headers include CSP for html and nosniff for assets", () => {
  const htmlHeaders = staticSecurityHeaders("/tmp/index.html");
  assert.match(htmlHeaders["content-security-policy"], /default-src 'self'/);
  assert.match(htmlHeaders["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(htmlHeaders["x-content-type-options"], "nosniff");

  const jsHeaders = staticSecurityHeaders("/tmp/app.js");
  assert.equal(jsHeaders["content-security-policy"], undefined);
  assert.equal(jsHeaders["x-content-type-options"], "nosniff");
});
