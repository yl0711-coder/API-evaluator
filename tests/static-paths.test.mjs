import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { getRawRequestPathname, resolveRequestPathInside } from "../server/static-paths.mjs";

test("raw request pathname keeps encoded traversal segments before URL normalization", () => {
  assert.equal(getRawRequestPathname("/%2e%2e/package.json?x=1"), "/%2e%2e/package.json");
  assert.equal(getRawRequestPathname("http://127.0.0.1/%2e%2e/package.json?x=1"), "/%2e%2e/package.json");
  assert.equal(new URL("http://127.0.0.1/%2e%2e/package.json").pathname, "/package.json");
});

test("static path resolver keeps normal requests inside the root", () => {
  const root = resolve("/tmp/evaluator-static");

  assert.equal(resolveRequestPathInside(root, "/"), resolve(root, "index.html"));
  assert.equal(resolveRequestPathInside(root, "/assets/app.js"), resolve(root, "assets/app.js"));
});

test("static path resolver rejects encoded and plain traversal attempts", () => {
  const root = resolve("/tmp/evaluator-static");

  assert.equal(resolveRequestPathInside(root, "/../package.json"), "");
  assert.equal(resolveRequestPathInside(root, "/%2e%2e/package.json"), "");
  assert.equal(resolveRequestPathInside(root, "/assets/%2e%2e/%2e%2e/package.json"), "");
  assert.equal(resolveRequestPathInside(root, "/%5c..%5cpackage.json"), "");
});

test("static path resolver does not trust prefix-only directory matches", () => {
  const root = resolve("/tmp/evaluator-static");

  assert.equal(resolveRequestPathInside(root, "/../evaluator-static-evil/app.js"), "");
});

test("resolveRequestPathInside keeps requests inside the root and rejects traversal", () => {
  const root = resolve("/tmp/evaluator-app/assets");

  assert.equal(resolveRequestPathInside(root, "/app.js"), resolve(root, "app.js"));
  assert.equal(resolveRequestPathInside(root, "/../package.json"), "");
});
