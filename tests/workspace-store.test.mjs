import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sanitizeWorkspaceSegment, saveRunArtifacts } from "../server/workspace-store.mjs";

test("workspace segments are safe for local artifact directories", () => {
  assert.equal(sanitizeWorkspaceSegment("../bad/run"), "bad-run");
  assert.equal(sanitizeWorkspaceSegment("admission-20260531-abcd"), "admission-20260531-abcd");
  assert.equal(sanitizeWorkspaceSegment(""), "run");
});

test("run artifacts are written as redacted JSON", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "evaluator-workspace-test-"));

  try {
    const files = await saveRunArtifacts(
      "../run-with-secret",
      {
        summary: { runId: "../run-with-secret" },
        records: [
          {
            requestHeaders: {
              authorization: "Bearer sk-test-secret-1234567890",
            },
            responseSummary: "normal response",
          },
        ],
      },
      { rootDir },
    );

    assert.match(files.workspaceDir, /run-with-secret$/);
    assert.match(files.rawJsonPath, /result\.json$/);

    const content = await readFile(files.rawJsonPath, "utf8");
    assert.match(content, /normal response/);
    assert.equal(content.includes("sk-test-secret-1234567890"), false);
    assert.match(content, /\[redacted-secret\]/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
