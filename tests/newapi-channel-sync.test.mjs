// tests/newapi-channel-sync.test.mjs
// 渠道/模型反向推送到 new-api 的核心库测试（进程内假 new-api）。范式同 newapi-tag-writer.test.mjs。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { channelType, pushChannelToNewapi, addModelToNewapiChannel } from "../server/newapi-channel-sync.mjs";

async function withMockNewapi(handler, run) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((e) => {
      try {
        res.writeHead(500);
        res.end(String(e));
      } catch {
        /* sent */
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function readBody(req) {
  return new Promise((r) => {
    const c = [];
    req.on("data", (d) => c.push(d));
    req.on("end", () => r(Buffer.concat(c)));
  });
}

async function withEnv(opts, fn) {
  const { base } = opts;
  const token = "token" in opts ? opts.token : "tok-xyz";
  const userId = "userId" in opts ? opts.userId : undefined;
  const keys = ["EVALUATOR_NEWAPI_BASE_URL", "EVALUATOR_NEWAPI_IMPORT_TOKEN", "EVALUATOR_NEWAPI_USER_ID"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const set = (k, v) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  set("EVALUATOR_NEWAPI_BASE_URL", base);
  set("EVALUATOR_NEWAPI_IMPORT_TOKEN", token);
  set("EVALUATOR_NEWAPI_USER_ID", userId);
  try {
    return await fn();
  } finally {
    for (const k of keys) set(k, prev[k]);
  }
}

// 路由 /api/channel/ 的可配置 mock；闭包记录收到的 POST/PUT 体、GET id、search keyword。
function buildHandler({ record, getChannelData, searchItems, postResponse, putResponse }) {
  return async (req, res) => {
    const u = new URL(req.url, "http://x");
    const json = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "GET" && /^\/api\/channel\/\d+$/.test(u.pathname)) {
      record.getChannelId = u.pathname.split("/").pop();
      return json(200, { success: true, data: getChannelData });
    }
    if (req.method === "GET" && u.pathname === "/api/channel/search") {
      record.searchKeyword = u.searchParams.get("keyword");
      return json(200, { success: true, data: { items: searchItems || [] } });
    }
    if (req.method === "POST" && u.pathname === "/api/channel/") {
      record.post = JSON.parse((await readBody(req)).toString("utf8"));
      const r = postResponse || { status: 200, body: { success: true, data: { id: 777 } } };
      return json(r.status, r.body);
    }
    if (req.method === "PUT" && u.pathname === "/api/channel/") {
      record.put = JSON.parse((await readBody(req)).toString("utf8"));
      const r = putResponse || { status: 200, body: { success: true } };
      return json(r.status, r.body);
    }
    return json(404, { success: false, message: "nope" });
  };
}

const ch = (over = {}) => ({ name: "我的渠道", provider: "DeepSeek", baseUrl: "https://api.deepseek.com", protocol: "openai_compatible", models: ["deepseek-chat", "deepseek-reasoner"], ...over });

// ===================== channelType（纯函数）=====================

test("channelType：provider 映射优先，未知回退 protocol", () => {
  assert.equal(channelType(ch({ provider: "DeepSeek" })), 43);
  assert.equal(channelType(ch({ provider: "Anthropic" })), 14);
  assert.equal(channelType(ch({ provider: "OpenAI" })), 1);
  assert.equal(channelType(ch({ provider: "", protocol: "claude_messages" })), 14);
  assert.equal(channelType(ch({ provider: "未知厂商", protocol: "openai_compatible" })), 1);
});

// ===================== 渠道推送：新建 =====================

test("pushChannelToNewapi 新建：POST mode=single，体字段正确，回传新 id", async () => {
  const record = {};
  await withMockNewapi(buildHandler({ record }), async (base) => {
    await withEnv({ base, token: "tok-1", userId: "1" }, async () => {
      const r = await pushChannelToNewapi(ch(), "sk-upstream");
      assert.equal(r.action, "created");
      assert.equal(r.newapiChannelId, 777);
      assert.equal(record.post.mode, "single");
      const c = record.post.channel;
      assert.equal(c.type, 43, "DeepSeek→43");
      assert.equal(c.name, "我的渠道");
      assert.equal(c.base_url, "https://api.deepseek.com");
      assert.equal(c.key, "sk-upstream", "带上游 key");
      assert.equal(c.models, "deepseek-chat,deepseek-reasoner", "models 英文逗号拼接");
      assert.equal(c.group, "internal_test", "默认分组为 internal_test");
    });
  });
});

test("pushChannelToNewapi 新建：POST 不回 id → 按名搜索兜底", async () => {
  const record = {};
  const handler = buildHandler({
    record,
    postResponse: { status: 200, body: { success: true, data: true } }, // 无 id
    searchItems: [{ id: 555, name: "我的渠道" }, { id: 999, name: "别的" }],
  });
  await withMockNewapi(handler, async (base) => {
    await withEnv({ base }, async () => {
      const r = await pushChannelToNewapi(ch(), "sk-x");
      assert.equal(r.newapiChannelId, 555, "按名匹配搜索结果");
      assert.equal(record.searchKeyword, "我的渠道");
    });
  });
});

// ===================== 渠道推送：更新 =====================

test("pushChannelToNewapi 已关联：走 PUT 更新（带 id + key）", async () => {
  const record = {};
  await withMockNewapi(buildHandler({ record }), async (base) => {
    await withEnv({ base }, async () => {
      const r = await pushChannelToNewapi(ch({ newapiChannelId: 42 }), "sk-up");
      assert.equal(r.action, "updated");
      assert.equal(r.newapiChannelId, 42);
      assert.equal(record.put.id, 42);
      assert.equal(record.put.key, "sk-up");
      assert.equal(record.put.models, "deepseek-chat,deepseek-reasoner");
      assert.equal(record.post, undefined, "更新不应发 POST");
    });
  });
});

// ===================== 模型加入渠道 models =====================

test("addModelToNewapiChannel：GET 整条 → 并入 models → PUT 只带 id+models（不带 key）", async () => {
  const record = {};
  const handler = buildHandler({ record, getChannelData: { id: 42, models: "a,b", key: "sk-MASKED" } });
  await withMockNewapi(handler, async (base) => {
    await withEnv({ base }, async () => {
      const r = await addModelToNewapiChannel(42, "c");
      assert.equal(r.added, true);
      assert.equal(r.models, "a,b,c");
      assert.equal(record.getChannelId, "42");
      assert.equal(record.put.id, 42);
      assert.equal(record.put.models, "a,b,c");
      assert.equal("key" in record.put, false, "PUT 不回传 key，避免写坏掩码 key");
    });
  });
});

test("addModelToNewapiChannel：已存在 → unchanged，不发 PUT", async () => {
  const record = {};
  const handler = buildHandler({ record, getChannelData: { id: 42, models: "a,b,c" } });
  await withMockNewapi(handler, async (base) => {
    await withEnv({ base }, async () => {
      const r = await addModelToNewapiChannel(42, "b");
      assert.equal(r.added, false);
      assert.equal(record.put, undefined, "已存在不应 PUT");
    });
  });
});

// ===================== 错误冒泡 =====================

test("上游 success:false → 抛出 message", async () => {
  const record = {};
  const handler = buildHandler({ record, postResponse: { status: 200, body: { success: false, message: "渠道名重复" } } });
  await withMockNewapi(handler, async (base) => {
    await withEnv({ base }, async () => {
      await assert.rejects(() => pushChannelToNewapi(ch(), "k"), /渠道名重复/);
    });
  });
});

test("上游 HTTP 500 → 抛出（含管理员权限提示）", async () => {
  const record = {};
  const handler = buildHandler({ record, postResponse: { status: 500, body: { success: false } } });
  await withMockNewapi(handler, async (base) => {
    await withEnv({ base }, async () => {
      await assert.rejects(() => pushChannelToNewapi(ch(), "k"), /HTTP 500|管理员权限/);
    });
  });
});

test("令牌含非 ASCII → 抛出（不发请求）", async () => {
  const record = {};
  await withMockNewapi(buildHandler({ record }), async (base) => {
    await withEnv({ base, token: "tok中" }, async () => {
      await assert.rejects(() => pushChannelToNewapi(ch(), "k"), /非 ASCII/);
      assert.equal(record.post, undefined);
    });
  });
});
