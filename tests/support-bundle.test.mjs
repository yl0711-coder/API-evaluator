import assert from "node:assert/strict";
import test from "node:test";
import { buildSupportBundle } from "../server/support-bundle.mjs";

test("support bundle exports useful diagnostics without API keys", () => {
  const bundle = buildSupportBundle({
    profiles: [
      {
        id: "p1",
        name: "Demo",
        provider: "Nexus",
        protocol: "openai_compatible",
        baseUrl: "https://api.example.com/tenant-a",
        defaultModel: "demo-model",
        apiKey: "sk-should-not-export",
        apiKeyRef: "ref",
        hasKey: true,
      },
    ],
    requests: [{ id: "r1", success: false, normalizedError: "timeout", rawError: "secret raw detail" }],
    testRuns: [
      {
        runId: "run1",
        type: "stability",
        successRateText: "90%",
        reportPath: "/Users/demo/private/report.md",
        reportHtmlPath: "/Users/demo/private/report.html",
      },
    ],
    tasks: [{ taskId: "t1", status: "failed", errorId: "err-test", message: "用户提示" }],
    errors: [{ id: "err-test", source: "server", message: "redacted detail" }],
  });

  const raw = JSON.stringify(bundle);
  assert.equal(bundle.summary.latestErrorId, "err-test");
  assert.equal(bundle.profiles[0].baseUrlHost, "api.example.com");
  assert.equal(bundle.profiles[0].hasKey, true);
  assert.equal(bundle.recentTestRuns[0].reportPath, "report.md");
  assert.equal(bundle.recentTestRuns[0].reportHtmlPath, "report.html");
  assert.doesNotMatch(raw, /sk-should-not-export/);
  assert.doesNotMatch(raw, /secret raw detail/);
  assert.doesNotMatch(raw, /\/Users\/demo\/private/);
});

test("support bundle surfaces storage health for diagnosing SQLite/JSONL drift", () => {
  const bundle = buildSupportBundle({
    profiles: [],
    requests: [],
    testRuns: [],
    tasks: [],
    errors: [],
    storage: { sqliteAvailable: true, requestWriteFailures: 3, runWriteFailures: 0, lastError: "recordRequest: disk full" },
  });
  assert.equal(bundle.storage.sqliteAvailable, true);
  assert.equal(bundle.storage.requestWriteFailures, 3);
  assert.equal(bundle.storage.lastError, "recordRequest: disk full");
  // 缺省时不报错，给出可识别占位
  const noStorage = buildSupportBundle({ profiles: [], requests: [], testRuns: [], tasks: [], errors: [] });
  assert.equal(noStorage.storage.sqliteAvailable, null);
});
