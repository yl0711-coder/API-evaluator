// tests/newapi-channel-sync.test.mjs
// 渠道/模型反向推送到 new-api 的核心库测试（进程内假 new-api）。范式同 newapi-tag-writer.test.mjs。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  channelType,
  pushChannelToNewapi,
  addModelToNewapiChannel,
  deleteNewapiChannel,
  removeModelFromNewapiChannel,
} from "../server/newapi-channel-sync.mjs";

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
    if (req.method === "DELETE" && /^\/api\/channel\/\d+$/.test(u.pathname)) {
      record.deletedId = u.pathname.split("/").pop();
      return json(200, { success: true });
    }
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

test("userId 含非 ASCII → 抛出", async () => {
  const record = {};
  await withMockNewapi(buildHandler({ record }), async (base) => {
    await withEnv({ base, token: "ok", userId: "１" }, async () => {
      await assert.rejects(() => pushChannelToNewapi(ch(), "k"), /非 ASCII/);
    });
  });
});

// ===================== channelType 全映射 =====================

test("channelType：覆盖全部 provider 码", () => {
  const cases = { OpenAI: 1, Anthropic: 14, Baidu: 15, Zhipu: 16, Alibaba: 17, Google: 24, Moonshot: 25, DeepSeek: 43, xAI: 48 };
  for (const [provider, type] of Object.entries(cases)) {
    assert.equal(channelType(ch({ provider })), type, `${provider}→${type}`);
  }
});

// ===================== 渠道推送：默认分组 / 体边界 =====================

test("pushChannelToNewapi：默认分组 internal_test", async () => {
  const record = {};
  await withMockNewapi(buildHandler({ record }), async (base) => {
    await withEnv({ base }, async () => {
      await pushChannelToNewapi(ch(), "k");
      assert.equal(record.post.channel.group, "internal_test");
    });
  });
});

test("pushChannelToNewapi：models 为空数组 → models:''", async () => {
  const record = {};
  await withMockNewapi(buildHandler({ record }), async (base) => {
    await withEnv({ base }, async () => {
      await pushChannelToNewapi(ch({ models: [] }), "k");
      assert.equal(record.post.channel.models, "");
    });
  });
});

test("pushChannelToNewapi：UTF-8 中文渠道名/模型整条字节正确", async () => {
  const record = {};
  await withMockNewapi(buildHandler({ record }), async (base) => {
    await withEnv({ base }, async () => {
      await pushChannelToNewapi(ch({ name: "内部测试渠道", models: ["豆包-总结"] }), "k");
      assert.equal(record.post.channel.name, "内部测试渠道");
      assert.equal(record.post.channel.models, "豆包-总结");
    });
  });
});

test("pushChannelToNewapi 新建：POST 返回 data 为数字 id", async () => {
  const record = {};
  const handler = buildHandler({ record, postResponse: { status: 200, body: { success: true, data: 321 } } });
  await withMockNewapi(handler, async (base) => {
    await withEnv({ base }, async () => {
      const r = await pushChannelToNewapi(ch(), "k");
      assert.equal(r.newapiChannelId, 321);
    });
  });
});

test("pushChannelToNewapi 新建：data 缺失 + 搜索返回裸数组 → 取回 id", async () => {
  const record = {};
  const handler = buildHandler({ record, postResponse: { status: 200, body: { success: true } }, searchItems: [{ id: 88, name: "我的渠道" }] });
  await withMockNewapi(handler, async (base) => {
    await withEnv({ base }, async () => {
      const r = await pushChannelToNewapi(ch(), "k");
      assert.equal(r.newapiChannelId, 88);
    });
  });
});

test("pushChannelToNewapi 新建：搜索无匹配 → newapiChannelId=null", async () => {
  const record = {};
  const handler = buildHandler({ record, postResponse: { status: 200, body: { success: true } }, searchItems: [] });
  await withMockNewapi(handler, async (base) => {
    await withEnv({ base }, async () => {
      const r = await pushChannelToNewapi(ch(), "k");
      assert.equal(r.newapiChannelId, null);
    });
  });
});

test("pushChannelToNewapi 更新：PUT 体含 group=internal_test + id + key", async () => {
  const record = {};
  await withMockNewapi(buildHandler({ record }), async (base) => {
    await withEnv({ base }, async () => {
      await pushChannelToNewapi(ch({ newapiChannelId: 9 }), "sk-up");
      assert.equal(record.put.id, 9);
      assert.equal(record.put.group, "internal_test");
      assert.equal(record.put.key, "sk-up");
    });
  });
});

// ===================== 模型加入渠道：边界 =====================

test("addModelToNewapiChannel：渠道 models 为空 → 直接加该模型", async () => {
  const record = {};
  const handler = buildHandler({ record, getChannelData: { id: 5, models: "" } });
  await withMockNewapi(handler, async (base) => {
    await withEnv({ base }, async () => {
      const r = await addModelToNewapiChannel(5, "solo");
      assert.equal(r.added, true);
      assert.equal(r.models, "solo");
    });
  });
});

test("addModelToNewapiChannel：GET models 含空格/重复 → 归一去重后再加", async () => {
  const record = {};
  const handler = buildHandler({ record, getChannelData: { id: 5, models: " a , b , a " } });
  await withMockNewapi(handler, async (base) => {
    await withEnv({ base }, async () => {
      const r = await addModelToNewapiChannel(5, "c");
      assert.equal(r.models, "a,b,c");
    });
  });
});

test("addModelToNewapiChannel：空模型名 → 抛错", async () => {
  const record = {};
  const handler = buildHandler({ record, getChannelData: { id: 5, models: "a" } });
  await withMockNewapi(handler, async (base) => {
    await withEnv({ base }, async () => {
      await assert.rejects(() => addModelToNewapiChannel(5, "   "), /模型名为空/);
      assert.equal(record.put, undefined);
    });
  });
});

// ===================== callNewapi 错误分支 =====================

test("上游 success:false 无 message → 默认中文错误", async () => {
  const record = {};
  const handler = buildHandler({ record, postResponse: { status: 200, body: { success: false } } });
  await withMockNewapi(handler, async (base) => {
    await withEnv({ base }, async () => {
      await assert.rejects(() => pushChannelToNewapi(ch(), "k"), /success=false/);
    });
  });
});

test("上游 HTTP 403 → 抛出（含管理员权限提示）", async () => {
  const record = {};
  const handler = buildHandler({ record, postResponse: { status: 403, body: { success: false } } });
  await withMockNewapi(handler, async (base) => {
    await withEnv({ base }, async () => {
      await assert.rejects(() => pushChannelToNewapi(ch(), "k"), /HTTP 403|管理员权限/);
    });
  });
});

test("addModel：GET 渠道 HTTP 500 → 抛出，不发 PUT", async () => {
  const record = {};
  // getChannelData 设为 undefined 时 mock 仍回 200；这里改用自定义 handler 让 GET 返回 500。
  await withMockNewapi(
    async (req, res) => {
      const u = new URL(req.url, "http://x");
      if (req.method === "PUT") {
        record.put = "called";
      }
      res.writeHead(req.method === "GET" && /^\/api\/channel\/\d+$/.test(u.pathname) ? 500 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false }));
    },
    async (base) => {
      await withEnv({ base }, async () => {
        await assert.rejects(() => addModelToNewapiChannel(5, "x"), /HTTP 500|管理员权限/);
        assert.equal(record.put, undefined);
      });
    },
  );
});

// ===================== 删除同步：deleteNewapiChannel =====================

test("deleteNewapiChannel：命中 DELETE /api/channel/:id", async () => {
  const record = {};
  await withMockNewapi(buildHandler({ record }), async (base) => {
    await withEnv({ base }, async () => {
      const r = await deleteNewapiChannel(55);
      assert.equal(r.deleted, true);
      assert.equal(record.deletedId, "55");
    });
  });
});

test("deleteNewapiChannel：上游 500 → 抛出", async () => {
  await withMockNewapi(
    async (req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false }));
    },
    async (base) => {
      await withEnv({ base }, async () => {
        await assert.rejects(() => deleteNewapiChannel(55), /HTTP 500|管理员权限/);
      });
    },
  );
});

// ===================== 删除同步：removeModelFromNewapiChannel =====================

test("removeModelFromNewapiChannel：移除存在的模型 → PUT 去掉它（不带 key）", async () => {
  const record = {};
  const handler = buildHandler({ record, getChannelData: { id: 7, models: "a,b,c", key: "sk-MASK" } });
  await withMockNewapi(handler, async (base) => {
    await withEnv({ base }, async () => {
      const r = await removeModelFromNewapiChannel(7, "b");
      assert.equal(r.removed, true);
      assert.equal(r.models, "a,c");
      assert.equal(record.put.id, 7);
      assert.equal(record.put.models, "a,c");
      assert.equal("key" in record.put, false, "PUT 不回传 key");
    });
  });
});

test("removeModelFromNewapiChannel：模型本就不在 → removed=false，不发 PUT", async () => {
  const record = {};
  const handler = buildHandler({ record, getChannelData: { id: 7, models: "a,c" } });
  await withMockNewapi(handler, async (base) => {
    await withEnv({ base }, async () => {
      const r = await removeModelFromNewapiChannel(7, "b");
      assert.equal(r.removed, false);
      assert.equal(record.put, undefined);
    });
  });
});
