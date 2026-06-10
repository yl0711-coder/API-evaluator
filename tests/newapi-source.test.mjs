import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { fetchNewapiChannels } from "../server/newapi-source.mjs";

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
  await withMockNewapi(
    (req, res) => {
      seenAuth = req.headers.authorization;
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

test("db 模式 mysql2 未安装 → 给出可操作的安装提示", async () => {
  // 核心依赖不含 mysql2；db 模式应懒加载失败并提示安装，而不是崩。
  process.env.EVALUATOR_IMPORT_SOURCE = "db";
  process.env.EVALUATOR_NEWAPI_DB_DSN = "ro:pw@tcp(127.0.0.1:3306)/newapi";
  try {
    await assert.rejects(() => fetchNewapiChannels(), /mysql2/);
  } finally {
    delete process.env.EVALUATOR_IMPORT_SOURCE;
    delete process.env.EVALUATOR_NEWAPI_DB_DSN;
  }
});
