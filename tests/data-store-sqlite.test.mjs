import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// env 必须在动态 import 前设好，让 paths.mjs 捕获临时数据目录（与 profile-store.test 同模式）。
test("ensureDataDir backfills requests.jsonl into SQLite and reads prefer SQLite", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "evaluator-ds-"));
  process.env.EVALUATOR_DATA_DIR = dataDir;
  const stamp = Date.now();
  try {
    const paths = await import(`../server/paths.mjs?case=${stamp}`);
    const db = await import(`../server/db.mjs?case=${stamp}`);
    const dataStore = await import(`../server/data-store.mjs?case=${stamp}`);

    await dataStore.ensureDataDir();

    // 模拟历史 JSONL 数据（ensureDataDir 已建空文件，这里写入真实内容）
    const line = (id) => JSON.stringify({ requestId: id, runId: "r", success: true, totalMs: 100, profileId: "p", profileName: "甲" });
    await writeFile(paths.REQUEST_LOG_FILE, ["h1", "h2", "h3"].map(line).join("\n") + "\n", "utf8");

    const imported = await dataStore.migrateRequestsToSqlite();
    assert.equal(imported, 3, "应回填 3 条历史记录");
    assert.equal(await db.countRequests(), 3);

    // 二次调用不重复回填（表非空）
    assert.equal(await dataStore.migrateRequestsToSqlite(), 0);

    const recent = await dataStore.readRecentRequests();
    assert.equal(recent.length, 3);
    assert.equal(recent[0].requestId, "h3", "newest-first 来自 SQLite");
    assert.equal(recent[0].profileName, "甲", "原始记录形状");

    db.closeDatabase();
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    delete process.env.EVALUATOR_DATA_DIR;
  }
});
