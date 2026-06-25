import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { fetchNewapiChannels, normalizeMysqlDsn } from "../server/newapi-source.mjs";

async function withMockNewapi(handler, run) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("api 模式：调 new-api /api/channel/ 取渠道（透传 token、翻页到空停）", async () => {
  let seenAuth = null;
  let seenUser = null;
  await withMockNewapi(
    (req, res) => {
      seenAuth = req.headers.authorization;
      seenUser = req.headers["new-api-user"];
      const page = Number(new URL(req.url, "http://x").searchParams.get("p") || 0);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(page === 0
        ? { success: true, data: [
            { id: 1, type: 1, name: "A", base_url: "https://a.test", models: "gpt-4o", status: 1 },
            { id: 14, type: 14, name: "Claude", base_url: "https://c.test", models: "claude-sonnet-4-5", status: 2 },
          ] }
        : { success: true, data: [] }));
    },
    async (base) => {
      process.env.EVALUATOR_IMPORT_SOURCE = "api";
      process.env.EVALUATOR_NEWAPI_BASE_URL = base;
      process.env.EVALUATOR_NEWAPI_IMPORT_TOKEN = "tok-123";
      try {
        const rows = await fetchNewapiChannels();
        assert.equal(rows.length, 2);
        assert.equal(rows[0].name, "A");
        assert.equal(rows[1].type, 14);
        assert.equal(seenAuth, "tok-123");
        assert.equal(seenUser, "1", "需带 New-Api-User 头（默认管理员 1），否则 new-api 返回 401");
      } finally {
        delete process.env.EVALUATOR_IMPORT_SOURCE;
        delete process.env.EVALUATOR_NEWAPI_BASE_URL;
        delete process.env.EVALUATOR_NEWAPI_IMPORT_TOKEN;
      }
    },
  );
});

test("未配置来源 → 明确报错", async () => {
  delete process.env.EVALUATOR_IMPORT_SOURCE;
  await assert.rejects(() => fetchNewapiChannels(), /未配置导入来源/);
});

test("api 模式缺 token → 报错", async () => {
  process.env.EVALUATOR_IMPORT_SOURCE = "api";
  process.env.EVALUATOR_NEWAPI_BASE_URL = "https://x.test";
  delete process.env.EVALUATOR_NEWAPI_IMPORT_TOKEN;
  try {
    await assert.rejects(() => fetchNewapiChannels(), /NEWAPI_IMPORT_TOKEN/);
  } finally {
    delete process.env.EVALUATOR_IMPORT_SOURCE;
    delete process.env.EVALUATOR_NEWAPI_BASE_URL;
  }
});

test("db 模式缺 DSN → 报错", async () => {
  process.env.EVALUATOR_IMPORT_SOURCE = "db";
  delete process.env.EVALUATOR_NEWAPI_DB_DSN;
  try {
    await assert.rejects(() => fetchNewapiChannels(), /NEWAPI_DB_DSN/);
  } finally {
    delete process.env.EVALUATOR_IMPORT_SOURCE;
  }
});

test("normalizeMysqlDsn：兼容 monitor 的 Go 格式 DSN", () => {
  // monitor(Go 驱动) 的连接串可直接复用 -> 转成 mysql2 配置对象。
  const cfg = normalizeMysqlDsn("ro_user:p@ss:w0rd@tcp(db-host:3306)/newapi?charset=utf8mb4&timeout=5s");
  assert.deepEqual(cfg, { host: "db-host", port: 3306, user: "ro_user", password: "p@ss:w0rd", database: "newapi" });
});

test("normalizeMysqlDsn：mysql:// URI 与其它形式原样透传", () => {
  const uri = "mysql://ro:pw@db-host:3306/newapi";
  assert.equal(normalizeMysqlDsn(uri), uri);
  assert.equal(normalizeMysqlDsn("  " + uri + "  "), uri); // 仅 trim
});
