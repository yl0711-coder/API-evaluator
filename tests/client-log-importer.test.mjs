import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readClientLogDirectory } from "../server/client-log-importer.mjs";

test("client log directory importer reads supported log files with limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluator-log-import-test-"));
  process.env.EVALUATOR_LOG_IMPORT_ROOTS = root;

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
    delete process.env.EVALUATOR_LOG_IMPORT_ROOTS;
    await rm(root, { recursive: true, force: true });
  }
});

test("client log directory importer rejects non-directory input", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluator-log-import-test-"));
  const filePath = join(root, "a.log");
  process.env.EVALUATOR_LOG_IMPORT_ROOTS = root;

  try {
    await writeFile(filePath, "line-a\n", "utf8");
    await assert.rejects(() => readClientLogDirectory(filePath), /不是目录/);
  } finally {
    delete process.env.EVALUATOR_LOG_IMPORT_ROOTS;
    await rm(root, { recursive: true, force: true });
  }
});

test("client log directory importer is fail-closed without an allow-list", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluator-log-import-test-"));
  delete process.env.EVALUATOR_LOG_IMPORT_ROOTS;
  try {
    await writeFile(join(root, "a.log"), "line-a\n", "utf8");
    await assert.rejects(() => readClientLogDirectory(root), /未配置允许导入/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("client log directory importer rejects directories outside the allow-list", async () => {
  const allowed = await mkdtemp(join(tmpdir(), "evaluator-log-allowed-"));
  const outside = await mkdtemp(join(tmpdir(), "evaluator-log-outside-"));
  process.env.EVALUATOR_LOG_IMPORT_ROOTS = allowed;
  try {
    await writeFile(join(outside, "a.log"), "secret\n", "utf8");
    await assert.rejects(() => readClientLogDirectory(outside), /不在允许导入的范围内/);
  } finally {
    delete process.env.EVALUATOR_LOG_IMPORT_ROOTS;
    await rm(allowed, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
