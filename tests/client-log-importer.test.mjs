import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readClientLogDirectory } from "../server/client-log-importer.mjs";

test("client log directory importer reads supported log files with limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluator-log-import-test-"));

  try {
    await writeFile(join(root, "a.log"), "line-a\n", "utf8");
    await writeFile(join(root, "b.jsonl"), '{"requestId":"b"}\n', "utf8");
    await writeFile(join(root, "ignore.md"), "ignore\n", "utf8");

    const result = await readClientLogDirectory(root, { maxFiles: 10 });

    assert.equal(result.fileCount, 2);
    assert.match(result.logText, /line-a/);
    assert.match(result.logText, /requestId/);
    assert.equal(result.logText.includes("ignore"), false);
    assert.equal(result.files.every((item) => item.path.startsWith(root)), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("client log directory importer rejects non-directory input", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluator-log-import-test-"));
  const filePath = join(root, "a.log");

  try {
    await writeFile(filePath, "line-a\n", "utf8");
    await assert.rejects(() => readClientLogDirectory(filePath), /不是目录/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
