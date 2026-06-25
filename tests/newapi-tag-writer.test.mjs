// tests/newapi-tag-writer.test.mjs
// 高强度核心库测试：pushModelTagsToNewapi / isNewapiTagWriterConfigured。
// 进程内起假 new-api（node:http），覆盖配置门控、翻页(含 PAGE_CAP)、标签合并/去重、
// UTF-8 整条写回契约、头安全、分项失败与规模压力。范式照搬 tests/newapi-source.test.mjs。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { pushModelTagsToNewapi, isNewapiTagWriterConfigured } from "../server/newapi-tag-writer.mjs";

// —— 工具 ——
async function withMockNewapi(handler, run) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((e) => {
      try {
        res.writeHead(500);
        res.end(String(e));
      } catch {
        /* already sent */
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
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

// 设/还原 new-api 环境变量（每用例隔离，避免泄漏到其它测试）。
// 注意：用「属性是否存在」区分「省略→用默认」与「显式 undefined→删除该变量」，
// 不能用解构默认值（解构默认对显式 undefined 也会生效，会把「想删」变成「设默认」）。
async function withEnv(opts, fn) {
  const { base } = opts;
  const token = "token" in opts ? opts.token : "tok-xyz";
  const userId = "userId" in opts ? opts.userId : undefined;
  const keys = ["EVALUATOR_NEWAPI_BASE_URL", "EVALUATOR_NEWAPI_IMPORT_TOKEN", "EVALUATOR_NEWAPI_USER_ID"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const setOrDelete = (k, v) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  setOrDelete("EVALUATOR_NEWAPI_BASE_URL", base);
  setOrDelete("EVALUATOR_NEWAPI_IMPORT_TOKEN", token);
  setOrDelete("EVALUATOR_NEWAPI_USER_ID", userId);
  try {
    return await fn();
  } finally {
    for (const k of keys) setOrDelete(k, prev[k]);
  }
}

const mk = (name, tags = "", extra = {}) => ({ id: 1, model_name: name, tags, status: 1, ...extra });

// 标准翻页 + PUT 处理器：models 切成每页 100；putResponses[i] 控制第 i 次 PUT 的应答。
function buildHandler({ models = [], total, putResponses = [], record }) {
  let putCount = 0;
  return async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (req.method === "GET" && u.pathname === "/api/models/") {
      record.gets.push(Number(u.searchParams.get("p") || 0));
      record.getAuth = req.headers["authorization"];
      record.getUser = req.headers["new-api-user"];
      const p = Number(u.searchParams.get("p") || 1);
      const items = models.slice((p - 1) * 100, (p - 1) * 100 + 100);
      const t = total === undefined ? models.length : total;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { items, total: t } }));
      return;
    }
    if (req.method === "PUT" && u.pathname === "/api/models/") {
      const raw = await readBody(req);
      record.puts.push({ raw, json: JSON.parse(raw.toString("utf8")), headers: req.headers });
      const r = putResponses[putCount] || { status: 200, body: { success: true } };
      putCount += 1;
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? { success: true }));
      return;
    }
    res.writeHead(404);
    res.end("not-found");
  };
}

const newRecord = () => ({ gets: [], puts: [] });

// ===================== A. 配置 / 门控 =====================

test("未配置（缺 token）→ configured:false 且零网络请求", async () => {
  const record = newRecord();
  await withMockNewapi(buildHandler({ models: [mk("gpt-4o")], record }), async (base) => {
    await withEnv({ base, token: undefined }, async () => {
      const r = await pushModelTagsToNewapi({ "gpt-4o": ["对话"] });
      assert.equal(r.configured, false);
      assert.match(r.error, /NEWAPI_BASE_URL|NEWAPI_IMPORT_TOKEN/);
      assert.equal(record.gets.length, 0, "未配置时不应发任何请求");
      assert.equal(record.puts.length, 0);
    });
  });
});

test("isNewapiTagWriterConfigured：齐备→true，缺一→false", async () => {
  await withEnv({ base: "http://x.test", token: "t" }, async () => {
    assert.equal(isNewapiTagWriterConfigured(), true);
  });
  await withEnv({ base: "http://x.test", token: undefined }, async () => {
    assert.equal(isNewapiTagWriterConfigured(), false);
  });
  await withEnv({ base: undefined, token: "t" }, async () => {
    assert.equal(isNewapiTagWriterConfigured(), false);
  });
});

test("readConfig 容错：base 去末尾斜杠、token 去行内注释", async () => {
  const record = newRecord();
  await withMockNewapi(buildHandler({ models: [mk("m1")], record }), async (base) => {
    await withEnv({ base: `${base}/`, token: "tok-abc # 这是注释" }, async () => {
      const r = await pushModelTagsToNewapi({ m1: ["x"] });
      // base 末尾斜杠未剥会打到 //api/models/ → 404 → 抛错；能成功即证明剥净。
      assert.equal(r.configured, true);
      assert.equal(record.getAuth, "tok-abc", "Authorization 应剥掉注释与空白");
      assert.equal(record.puts.length, 1);
    });
  });
});

// ===================== B. 翻页 fetchAllModels =====================

test("单页 data.items + total 命中即停", async () => {
  const record = newRecord();
  const models = [mk("a"), mk("b")];
  await withMockNewapi(buildHandler({ models, total: 2, record }), async (base) => {
    await withEnv({ base }, async () => {
      const r = await pushModelTagsToNewapi({});
      assert.equal(r.totalModels, 2);
      assert.deepEqual(record.gets, [1]);
    });
  });
});

test("data 为裸数组形状也能解析", async () => {
  const record = newRecord();
  await withMockNewapi(
    async (req, res) => {
      record.gets.push(1);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, data: [mk("a"), mk("b")] }));
    },
    async (base) => {
      await withEnv({ base }, async () => {
        const r = await pushModelTagsToNewapi({});
        assert.equal(r.totalModels, 2);
      });
    },
  );
});

test("多页：p 依次 1,2，第二页不足 100 即停", async () => {
  const record = newRecord();
  const models = Array.from({ length: 150 }, (_, i) => mk(`m${i}`));
  await withMockNewapi(buildHandler({ models, total: 150, record }), async (base) => {
    await withEnv({ base }, async () => {
      const r = await pushModelTagsToNewapi({});
      assert.equal(r.totalModels, 150);
      assert.deepEqual(record.gets, [1, 2]);
    });
  });
});

test("停止条件：整页但 out>=total 即停（不再多翻）", async () => {
  const record = newRecord();
  const models = Array.from({ length: 100 }, (_, i) => mk(`m${i}`));
  // total=100，第一页满 100 → out>=total → 停，不发第二页。
  await withMockNewapi(buildHandler({ models, total: 100, record }), async (base) => {
    await withEnv({ base }, async () => {
      const r = await pushModelTagsToNewapi({});
      assert.equal(r.totalModels, 100);
      assert.deepEqual(record.gets, [1]);
    });
  });
});

test("PAGE_CAP：永远回满 100 且无 total → 恰好 100 次 GET 后停", async () => {
  const record = newRecord();
  const page = Array.from({ length: 100 }, (_, i) => mk(`m${i}`));
  await withMockNewapi(
    async (req, res) => {
      const u = new URL(req.url, "http://x");
      record.gets.push(Number(u.searchParams.get("p")));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { items: page } })); // 不给 total
    },
    async (base) => {
      await withEnv({ base }, async () => {
        const r = await pushModelTagsToNewapi({}); // 空 tagMap：只翻页、不 PUT
        assert.equal(record.gets.length, 100, "应在 PAGE_CAP=100 处停");
        assert.equal(r.totalModels, 10000);
      });
    },
  );
});

test("GET 非 200 → 抛错（含管理员权限提示）", async () => {
  await withMockNewapi(
    async (req, res) => {
      res.writeHead(403);
      res.end("forbidden");
    },
    async (base) => {
      await withEnv({ base }, async () => {
        await assert.rejects(() => pushModelTagsToNewapi({ a: ["x"] }), /返回 403|管理员权限/);
      });
    },
  );
});

test("GET 返回非 JSON → items=[] 优雅停，totalModels=0", async () => {
  await withMockNewapi(
    async (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("not-json-at-all");
    },
    async (base) => {
      await withEnv({ base }, async () => {
        const r = await pushModelTagsToNewapi({ a: ["x"] });
        assert.equal(r.totalModels, 0);
        assert.equal(r.matched, 0);
      });
    },
  );
});

// ===================== C. 合并 / 匹配 =====================

test("空 tags 模型 + incoming → PUT 整条对象（仅 tags 改）", async () => {
  const record = newRecord();
  const model = mk("gpt-4o", "", { id: 42, status: 1, extra_field: "keep-me" });
  await withMockNewapi(buildHandler({ models: [model], total: 1, record }), async (base) => {
    await withEnv({ base }, async () => {
      const r = await pushModelTagsToNewapi({ "gpt-4o": ["对话"] });
      assert.equal(r.updated, 1);
      assert.equal(record.puts.length, 1);
      const body = record.puts[0].json;
      assert.equal(body.tags, "对话");
      assert.equal(body.id, 42, "整条回写：id 保留");
      assert.equal(body.model_name, "gpt-4o");
      assert.equal(body.status, 1, "整条回写：status 保留");
      assert.equal(body.extra_field, "keep-me", "整条回写：其它字段保留");
    });
  });
});

test("合并去重保序：existing + incoming", async () => {
  const record = newRecord();
  await withMockNewapi(buildHandler({ models: [mk("m", "对话,推荐")], total: 1, record }), async (base) => {
    await withEnv({ base }, async () => {
      const r = await pushModelTagsToNewapi({ m: ["推荐", "长上下文"] });
      assert.equal(r.updated, 1);
      assert.equal(record.puts[0].json.tags, "对话,推荐,长上下文");
    });
  });
});

test("未变：incoming 已全含 → unchanged，无 PUT", async () => {
  const record = newRecord();
  await withMockNewapi(buildHandler({ models: [mk("m", "对话,推荐")], total: 1, record }), async (base) => {
    await withEnv({ base }, async () => {
      const r = await pushModelTagsToNewapi({ m: ["推荐"] });
      assert.equal(r.unchanged, 1);
      assert.equal(r.updated, 0);
      assert.equal(record.puts.length, 0);
    });
  });
});

test("全角逗号 existing：splitTags 切「，」，去重并归一化为半角", async () => {
  const record = newRecord();
  await withMockNewapi(buildHandler({ models: [mk("m", "对话，推荐")], total: 1, record }), async (base) => {
    await withEnv({ base }, async () => {
      const r = await pushModelTagsToNewapi({ m: ["对话"] }); // 已含，但全角→半角属变化
      assert.equal(r.updated, 1);
      assert.equal(record.puts[0].json.tags, "对话,推荐", "全角逗号归一化为半角且不重复 加入");
    });
  });
});

test("不在 tagMap 的模型跳过；tagMap 值为 [] 跳过", async () => {
  const record = newRecord();
  const models = [mk("in-map", ""), mk("not-in-map", ""), mk("empty-tags", "")];
  await withMockNewapi(buildHandler({ models, total: 3, record }), async (base) => {
    await withEnv({ base }, async () => {
      const r = await pushModelTagsToNewapi({ "in-map": ["x"], "empty-tags": [] });
      assert.equal(r.matched, 1, "仅 in-map 计 matched（空数组不算）");
      assert.equal(r.updated, 1);
      assert.equal(record.puts.length, 1);
      assert.equal(record.puts[0].json.model_name, "in-map");
    });
  });
});

// ===================== D. 写回契约 / 编码 =====================

test("PUT 契约：method/path/双头/Content-Type；userId 默认 1", async () => {
  const record = newRecord();
  await withMockNewapi(buildHandler({ models: [mk("m", "")], total: 1, record }), async (base) => {
    await withEnv({ base, token: "tok-raw", userId: undefined }, async () => {
      await pushModelTagsToNewapi({ m: ["x"] });
      const h = record.puts[0].headers;
      assert.equal(h["authorization"], "tok-raw", "原样令牌，无 Bearer");
      assert.equal(h["new-api-user"], "1", "userId 默认 1");
      assert.match(h["content-type"], /application\/json/);
    });
  });
});

test("自定义 userId 透传到 New-Api-User", async () => {
  const record = newRecord();
  await withMockNewapi(buildHandler({ models: [mk("m", "")], total: 1, record }), async (base) => {
    await withEnv({ base, userId: "7" }, async () => {
      await pushModelTagsToNewapi({ m: ["x"] });
      assert.equal(record.puts[0].headers["new-api-user"], "7");
      assert.equal(record.getUser, "7", "GET 也带 New-Api-User");
    });
  });
});

test("UTF-8：中文标签整条回写无乱码", async () => {
  const record = newRecord();
  await withMockNewapi(buildHandler({ models: [mk("m", "")], total: 1, record }), async (base) => {
    await withEnv({ base }, async () => {
      await pushModelTagsToNewapi({ m: ["对话", "长上下文", "推荐"] });
      // 直接核对原始字节解码后的中文，坐实 Buffer.from(...,"utf8")
      assert.equal(record.puts[0].json.tags, "对话,长上下文,推荐");
      assert.ok(record.puts[0].raw.includes(Buffer.from("长上下文", "utf8")), "原始请求体含正确 UTF-8 字节");
    });
  });
});

// ===================== E. 头安全（抛） =====================

test("token 含非 ASCII → 抛错且不发请求", async () => {
  const record = newRecord();
  await withMockNewapi(buildHandler({ models: [mk("m")], record }), async (base) => {
    await withEnv({ base, token: "tok中" }, async () => {
      await assert.rejects(() => pushModelTagsToNewapi({ m: ["x"] }), /非 ASCII/);
      assert.equal(record.gets.length, 0);
    });
  });
});

test("userId 含全角字符 → 抛错", async () => {
  const record = newRecord();
  await withMockNewapi(buildHandler({ models: [mk("m")], record }), async (base) => {
    await withEnv({ base, token: "ok", userId: "１" }, async () => {
      await assert.rejects(() => pushModelTagsToNewapi({ m: ["x"] }), /非 ASCII/);
    });
  });
});

// ===================== F. 分项失败 / 规模压力 =====================

test("单模型 PUT 500 → 收 errors，不中断后续", async () => {
  const record = newRecord();
  const models = [mk("a", ""), mk("b", "")];
  const putResponses = [{ status: 500, body: "err" }, { status: 200, body: { success: true } }];
  await withMockNewapi(buildHandler({ models, total: 2, putResponses, record }), async (base) => {
    await withEnv({ base }, async () => {
      const r = await pushModelTagsToNewapi({ a: ["x"], b: ["y"] });
      assert.equal(r.updated, 1);
      assert.equal(r.errors.length, 1);
      assert.equal(r.errors[0].model, "a");
      assert.match(r.errors[0].error, /HTTP 500/);
    });
  });
});

test("PUT 200 但 success:false（带/不带 message）", async () => {
  const record = newRecord();
  const models = [mk("a", ""), mk("b", "")];
  const putResponses = [
    { status: 200, body: { success: false, message: "配额超限" } },
    { status: 200, body: { success: false } },
  ];
  await withMockNewapi(buildHandler({ models, total: 2, putResponses, record }), async (base) => {
    await withEnv({ base }, async () => {
      const r = await pushModelTagsToNewapi({ a: ["x"], b: ["y"] });
      assert.equal(r.updated, 0);
      assert.equal(r.errors.length, 2);
      assert.equal(r.errors[0].error, "配额超限");
      assert.match(r.errors[1].error, /success=false/);
    });
  });
});

test("PUT 200 非 JSON body → 仍计 updated", async () => {
  const record = newRecord();
  const putResponses = [{ status: 200, body: "OKK" }];
  await withMockNewapi(buildHandler({ models: [mk("a", "")], total: 1, putResponses, record }), async (base) => {
    await withEnv({ base }, async () => {
      const r = await pushModelTagsToNewapi({ a: ["x"] });
      assert.equal(r.updated, 1);
      assert.equal(r.errors.length, 0);
    });
  });
});

test("规模：250 模型跨 3 页全匹配 → 250 次 PUT，顺序串行", async () => {
  const record = newRecord();
  const models = Array.from({ length: 250 }, (_, i) => mk(`m${i}`, ""));
  const tagMap = Object.fromEntries(models.map((m) => [m.model_name, ["x"]]));
  await withMockNewapi(buildHandler({ models, total: 250, record }), async (base) => {
    await withEnv({ base }, async () => {
      const r = await pushModelTagsToNewapi(tagMap);
      assert.equal(r.totalModels, 250);
      assert.equal(r.updated, 250);
      assert.equal(record.puts.length, 250);
      assert.deepEqual(record.gets, [1, 2, 3]);
      // 串行顺序：PUT 的 model_name 序列与模型序列一致。
      assert.equal(record.puts[0].json.model_name, "m0");
      assert.equal(record.puts[249].json.model_name, "m249");
    });
  });
});

test("混合压力：60 模型，每第 10 个 PUT 失败 → updated=54、errors=6", async () => {
  const record = newRecord();
  const models = Array.from({ length: 60 }, (_, i) => mk(`m${i}`, ""));
  const tagMap = Object.fromEntries(models.map((m) => [m.model_name, ["x"]]));
  const putResponses = Array.from({ length: 60 }, (_, i) =>
    (i + 1) % 10 === 0 ? { status: 500, body: "boom" } : { status: 200, body: { success: true } },
  );
  await withMockNewapi(buildHandler({ models, total: 60, putResponses, record }), async (base) => {
    await withEnv({ base }, async () => {
      const r = await pushModelTagsToNewapi(tagMap);
      assert.equal(r.matched, 60);
      assert.equal(r.updated, 54);
      assert.equal(r.errors.length, 6);
    });
  });
});
