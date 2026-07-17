import assert from "node:assert/strict";
import test from "node:test";
import { createRouter, findShadowedRoutes } from "../server/router.mjs";

const noop = () => {};

test("router matches an exact path and method", () => {
  const router = createRouter([["GET", "/api/health", noop]]);

  assert.deepEqual(router.match("GET", "/api/health").params, {});
  assert.equal(router.match("POST", "/api/health"), null);
  assert.equal(router.match("GET", "/api/other"), null);
});

test("router method matching is case-insensitive on both sides", () => {
  const router = createRouter([["get", "/api/health", noop]]);

  assert.ok(router.match("GET", "/api/health"));
  assert.ok(router.match("get", "/api/health"));
});

test("router keeps the exact-compare semantics of the if-chain it replaces", () => {
  const router = createRouter([["GET", "/api/health", noop]]);

  // 原写法是 url.pathname === "/api/health"，这些都不该命中
  assert.equal(router.match("GET", "/api/health/"), null);
  assert.equal(router.match("GET", "//api/health"), null);
  assert.equal(router.match("GET", "/api//health"), null);
  assert.equal(router.match("GET", "/api/health/extra"), null);
});

test("router captures a single-segment param and decodes it", () => {
  const router = createRouter([["DELETE", "/api/dev/scenarios/:id", noop]]);

  assert.deepEqual(router.match("DELETE", "/api/dev/scenarios/abc").params, { id: "abc" });
  // 等价于原写法 decodeURIComponent(pathname.slice(prefix.length))
  assert.deepEqual(router.match("DELETE", "/api/dev/scenarios/a%2Fb").params, { id: "a/b" });
  assert.deepEqual(router.match("DELETE", "/api/dev/scenarios/%E4%B8%AD%E6%96%87").params, { id: "中文" });
});

test("router param does not span segments and does not match an empty value", () => {
  const router = createRouter([["DELETE", "/api/dev/scenarios/:id", noop]]);

  assert.equal(router.match("DELETE", "/api/dev/scenarios/a/b"), null);
  assert.equal(router.match("DELETE", "/api/dev/scenarios/"), null);
  assert.equal(router.match("DELETE", "/api/dev/scenarios"), null);
});

test("router treats malformed percent-encoding as no-match instead of throwing", () => {
  const router = createRouter([["DELETE", "/api/dev/scenarios/:id", noop]]);

  // 原写法里 decodeURIComponent("%ZZ") 会抛 URIError，被顶层兜成 500；这里降级为不命中 → 404
  assert.doesNotThrow(() => router.match("DELETE", "/api/dev/scenarios/%ZZ"));
  assert.equal(router.match("DELETE", "/api/dev/scenarios/%ZZ"), null);
});

test("router matches a literal segment after a param", () => {
  const router = createRouter([["POST", "/api/auto-test-jobs/:id/run", noop]]);

  assert.deepEqual(router.match("POST", "/api/auto-test-jobs/job-1/run").params, { id: "job-1" });
  assert.equal(router.match("POST", "/api/auto-test-jobs/job-1"), null);
  assert.equal(router.match("POST", "/api/auto-test-jobs/job-1/run/extra"), null);
});

test("router returns the first declared rule, mirroring if-chain short-circuit", () => {
  const first = () => "first";
  const second = () => "second";
  const router = createRouter([
    ["GET", "/api/profiles/export", first],
    ["GET", "/api/profiles/:id", second],
  ]);

  assert.equal(router.match("GET", "/api/profiles/export").handler, first);
  assert.equal(router.match("GET", "/api/profiles/other").handler, second);
});

test("router refuses to build a table whose ordering makes a rule unreachable", () => {
  // 这是原 if 链里最难查的坑：加错顺序不报错，只是安静走错分支。建表阶段直接打死。
  assert.throws(
    () =>
      createRouter([
        ["GET", "/api/profiles/:id", noop],
        ["GET", "/api/profiles/export", noop],
      ]),
    /顺序有误.*GET \/api\/profiles\/export 被 GET \/api\/profiles\/:id 遮蔽/s,
  );
});

test("router rejects duplicate rules at construction time", () => {
  assert.throws(
    () =>
      createRouter([
        ["GET", "/api/health", noop],
        ["GET", "/api/health", noop],
      ]),
    /重复规则/,
  );
});

test("router rejects malformed patterns at construction time", () => {
  assert.throws(() => createRouter([["GET", "api/health", noop]]), /必须是以/);
  assert.throws(() => createRouter([["GET", "/api/:", noop]]), /缺少名字/);
  assert.throws(() => createRouter([["GET", "/api/health", null]]), /不是函数/);
});

test("router exposes the route list for introspection", () => {
  const router = createRouter([
    ["get", "/api/health", noop],
    ["DELETE", "/api/dev/scenarios/:id", noop],
  ]);

  assert.deepEqual(router.list(), [
    { method: "GET", pattern: "/api/health" },
    { method: "DELETE", pattern: "/api/dev/scenarios/:id" },
  ]);
});

test("shadow check finds a later rule fully covered by an earlier param rule", () => {
  const conflicts = findShadowedRoutes([
    ["GET", "/api/profiles/:id", noop],
    ["GET", "/api/profiles/export", noop], // 永远轮不到：被上面的 :id 截胡
  ]);

  assert.deepEqual(conflicts, [{ shadowed: "GET /api/profiles/export", by: "GET /api/profiles/:id" }]);
});

test("shadow check stays quiet for correctly ordered and non-overlapping rules", () => {
  assert.deepEqual(
    findShadowedRoutes([
      ["GET", "/api/profiles/export", noop],
      ["GET", "/api/profiles/:id", noop],
    ]),
    [],
  );
  assert.deepEqual(
    findShadowedRoutes([
      ["GET", "/api/profiles/:id", noop],
      ["POST", "/api/profiles/export", noop], // 方法不同，不构成遮蔽
      ["GET", "/api/channels/:id", noop], // 前缀不同，不构成遮蔽
    ]),
    [],
  );
});
