import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildUserErrorMessage, logTechnicalError } from "../server/error-log.mjs";

test("technical error log records details without exposing secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-error-log-test-"));
  try {
    const errorLogFile = join(dir, "errors.jsonl");
    const errorId = await logTechnicalError(errorLogFile, {
      source: "server",
      error: new Error("upstream failed with sk-secret-token"),
      context: {
        url: "/api/tests/quick",
        apiKey: "sk-should-not-appear",
        nested: { authorization: "Bearer secret-token-value" },
      },
    });

    const raw = await readFile(errorLogFile, "utf8");
    assert.match(raw, new RegExp(errorId));
    assert.match(raw, /"source":"server"/);
    assert.doesNotMatch(raw, /sk-should-not-appear/);
    assert.doesNotMatch(raw, /Bearer secret-token-value/);
    assert.match(buildUserErrorMessage(errorId), new RegExp(errorId));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
