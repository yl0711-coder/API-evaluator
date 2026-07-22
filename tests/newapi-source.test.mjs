import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { fetchNewapiChannels, fetchNewapiSmtp, normalizeMysqlDsn } from "../server/newapi-source.mjs";

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
      // 本用例的 mock 跑在 127.0.0.1，出站守卫会（正确地）拦它——这里测的是翻页/透传逻辑，
      // 故关掉守卫；守卫本身由下一个用例专门验证。
      process.env.EVALUATOR_EGRESS_DENY_PRIVATE = "false";
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
        delete process.env.EVALUATOR_EGRESS_DENY_PRIVATE;
      }
    },
  );
});

// 回归（P2-1）：导入出站此前漏在守卫之外。base 指向内网/元数据时必须被拦，不能去打。
test("api 模式：base 指向内网 → 被出站守卫拦截，不发请求", async () => {
  process.env.EVALUATOR_IMPORT_SOURCE = "api";
  process.env.EVALUATOR_NEWAPI_IMPORT_TOKEN = "tok-123";
  delete process.env.EVALUATOR_EGRESS_DENY_PRIVATE; // 默认开启守卫
  for (const base of ["http://169.254.169.254", "http://[::ffff:a9fe:a9fe]", "http://10.0.0.5:3000"]) {
    process.env.EVALUATOR_NEWAPI_BASE_URL = base;
    await assert.rejects(() => fetchNewapiChannels(), /安全策略拦截|内网|保留/, `${base} 应被拦`);
  }
  delete process.env.EVALUATOR_IMPORT_SOURCE;
  delete process.env.EVALUATOR_NEWAPI_BASE_URL;
  delete process.env.EVALUATOR_NEWAPI_IMPORT_TOKEN;
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
    await assert.rejects(() => fetchNewapiChannels(), /系统访问令牌/);
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

// 「邮件报警配置」一键同步：不连真实数据库，只覆盖「未配 DSN」这条不碰网络的错误路径
// （真连库/合并语义留给人工验收，见计划文档——测试环境不该也不能连生产 new-api 库）。
test("fetchNewapiSmtp：未配置 EVALUATOR_NEWAPI_DB_DSN → 明确报错", async () => {
  delete process.env.EVALUATOR_NEWAPI_DB_DSN;
  await assert.rejects(() => fetchNewapiSmtp(), /EVALUATOR_NEWAPI_DB_DSN/);
});

// 回归：导入出站此前无超时——new-api 主机挂起会让本请求无限期吊住（undici 无默认响应超时）。
// 用一个「收到请求但永不响应」的 mock + 短超时覆盖，断言在超时内以可读错误失败，而不是挂死。
test("api 模式：上游挂起不响应 → 按超时失败，不无限期吊住", async () => {
  const hung = [];
  const server = createServer((req, res) => {
    hung.push(res); // 攥住响应对象，永不 end：模拟 new-api 建连后不回数据
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.EVALUATOR_IMPORT_SOURCE = "api";
  process.env.EVALUATOR_NEWAPI_BASE_URL = base;
  process.env.EVALUATOR_NEWAPI_IMPORT_TOKEN = "tok-123";
  process.env.EVALUATOR_EGRESS_DENY_PRIVATE = "false"; // mock 在 127.0.0.1，本用例测超时而非守卫
  process.env.EVALUATOR_NEWAPI_IMPORT_TIMEOUT_MS = "300"; // 短超时，避免拖慢测试
  const started = Date.now();
  try {
    await assert.rejects(() => fetchNewapiChannels(), /超时|timeout/i, "上游不响应应以超时错误失败");
    assert.ok(Date.now() - started < 5000, "必须在远早于默认吊死的时间内返回");
  } finally {
    for (const res of hung) res.destroy(); // 放掉攥住的连接
    await new Promise((r) => server.close(r));
    delete process.env.EVALUATOR_IMPORT_SOURCE;
    delete process.env.EVALUATOR_NEWAPI_BASE_URL;
    delete process.env.EVALUATOR_NEWAPI_IMPORT_TOKEN;
    delete process.env.EVALUATOR_EGRESS_DENY_PRIVATE;
    delete process.env.EVALUATOR_NEWAPI_IMPORT_TIMEOUT_MS;
  }
});
