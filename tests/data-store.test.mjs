import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("data store migrates legacy app-data into the visible data layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluator-data-migration-test-"));
  const legacyDir = join(root, "app-data");
  const dataDir = join(root, "评测数据");
  process.env.EVALUATOR_DATA_DIR = dataDir;
  process.env.EVALUATOR_LEGACY_DATA_DIR = legacyDir;

  try {
    await mkdir(join(legacyDir, "reports"), { recursive: true });
    await writeFile(join(legacyDir, "profiles.json"), `${JSON.stringify([{ id: "old-profile" }])}\n`, "utf8");
    await writeFile(join(legacyDir, "requests.jsonl"), `${JSON.stringify({ id: "request-old" })}\n`, "utf8");
    await writeFile(join(legacyDir, "test-runs.jsonl"), `${JSON.stringify({ runId: "run-old" })}\n`, "utf8");
    await writeFile(join(legacyDir, "task-events.jsonl"), `${JSON.stringify({ taskId: "task-old" })}\n`, "utf8");
    await writeFile(join(legacyDir, "errors.jsonl"), `${JSON.stringify({ id: "err-old" })}\n`, "utf8");
    await writeFile(join(legacyDir, "local-secret.key"), "legacy-secret", "utf8");
    await writeFile(join(legacyDir, "key-vault.json"), "{}", "utf8");
    await writeFile(join(legacyDir, "reports", "report-old.md"), "# old report", "utf8");

    const dataStore = await import(`../server/data-store.mjs?case=migrate-${Date.now()}`);
    const paths = await import(`../server/paths.mjs?case=migrate-${Date.now()}`);
    await dataStore.ensureDataDir();

    assert.match(await readFile(paths.PROFILES_FILE, "utf8"), /old-profile/);
    assert.match(await readFile(paths.REQUEST_LOG_FILE, "utf8"), /request-old/);
    assert.match(await readFile(paths.TEST_RUNS_FILE, "utf8"), /run-old/);
    assert.match(await readFile(paths.TASK_EVENTS_FILE, "utf8"), /task-old/);
    assert.match(await readFile(paths.ERROR_LOG_FILE, "utf8"), /err-old/);
    assert.equal(await readFile(paths.LOCAL_SECRET_FILE, "utf8"), "legacy-secret");
    assert.equal(await readFile(join(paths.REPORTS_DIR, "report-old.md"), "utf8"), "# old report");
  } finally {
    delete process.env.EVALUATOR_DATA_DIR;
    delete process.env.EVALUATOR_LEGACY_DATA_DIR;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});
