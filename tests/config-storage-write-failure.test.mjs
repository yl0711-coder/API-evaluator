import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// 用“目录作为 SQLite 文件路径”稳定制造不可写数据库；paths/store 必须在环境变量之后加载。
const dataDir = mkdtempSync(join(tmpdir(), "evaluator-config-write-failure-"));
const previousDataDir = process.env.EVALUATOR_DATA_DIR;
const previousDbPath = process.env.EVALUATOR_SQLITE_DB;
process.env.EVALUATOR_DATA_DIR = dataDir;
process.env.EVALUATOR_SQLITE_DB = dataDir;

const db = await import("../server/db.mjs");
const channelStore = await import("../server/channel-store.mjs");
const { CHANNELS_FILE } = await import("../server/paths.mjs");

after(async () => {
  db.closeDatabase(dataDir);
  if (previousDataDir === undefined) delete process.env.EVALUATOR_DATA_DIR;
  else process.env.EVALUATOR_DATA_DIR = previousDataDir;
  if (previousDbPath === undefined) delete process.env.EVALUATOR_SQLITE_DB;
  else process.env.EVALUATOR_SQLITE_DB = previousDbPath;
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
});

test("SQLite 已可用但配置写入失败时必须报错，不能静默回退 JSON 并伪造成功", async () => {
  if (!(await db.isSqliteAvailable())) return;

  await assert.rejects(
    channelStore.saveChannels([{ id: "c1", name: "bad-db", baseUrl: "https://example.test", status: "enabled" }]),
    (error) => error instanceof db.PersistentStorageWriteError && error.scope === "saveChannels",
  );

  assert.equal(existsSync(CHANNELS_FILE), false, "SQLite 运行中写失败不得留下 JSON fallback，避免双事实源漂移");
  assert.ok(db.getDbHealth().configWriteFailures >= 1, "health/support bundle 必须暴露配置写失败");
});
