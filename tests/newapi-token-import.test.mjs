import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { fetchPricing, fetchSelfGroup, fetchTestTokens, fetchTokenKeys } from "../server/newapi-token-import.mjs";

async function withMockNewapi(handler, run) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// mock 跑在 127.0.0.1，出站守卫会（正确地）拦它——测的是协议/翻页逻辑时关掉，
// 守卫本身由专门的用例验证。
function withGuardOff(fn) {
  return async (...args) => {
    process.env.EVALUATOR_EGRESS_DENY_PRIVATE = "false";
    try {
      return await fn(...args);
    } finally {
      delete process.env.EVALUATOR_EGRESS_DENY_PRIVATE;
    }
  };
}

const jsonRes = (res, body) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

test(
  "fetchTestTokens：带双认证头、分页从 p=1 起、只留名称含「测试」的",
  withGuardOff(async () => {
    const seenPages = [];
    let seenAuth = null;
    let seenUser = null;
    await withMockNewapi(
      (req, res) => {
        seenAuth = req.headers.authorization;
        seenUser = req.headers["new-api-user"];
        const p = new URL(req.url, "http://x").searchParams.get("p");
        seenPages.push(p);
        // 第 1 页给满 100 条（迫使继续翻页），第 2 页给 2 条收尾
        if (p === "1") {
          const items = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `测试-${i + 1}`, group: "vip", status: 1 }));
          jsonRes(res, { success: true, data: { items, total: 102 } });
          return;
        }
        jsonRes(res, {
          success: true,
          data: {
            items: [
              { id: 101, name: "生产令牌", group: "", status: 1 },
              { id: 102, name: "测试-末", group: "", status: 1 },
            ],
            total: 102,
          },
        });
      },
      async (base) => {
        const rows = await fetchTestTokens({ base, token: "tok-abc", userId: "7" });
        assert.equal(seenAuth, "tok-abc", "Authorization 放令牌原文，不加 Bearer 前缀");
        assert.equal(seenUser, "7", "必须带 New-Api-User，缺了 new-api 返 401");
        assert.deepEqual(seenPages, ["1", "2"], "分页必须从 p=1 起（new-api 的 p 是 1 起页码）");
        assert.equal(rows.length, 101, "100 条含「测试」+ 第 2 页那 1 条，生产令牌被过滤掉");
        assert.ok(
          rows.every((r) => r.name.includes("测试")),
          "不含「测试」的必须被过滤",
        );
      },
    );
  }),
);

test(
  "fetchTestTokens：success:false 必须抛错，不能当成空结果静默通过",
  withGuardOff(async () => {
    await withMockNewapi(
      (req, res) => jsonRes(res, { success: false, message: "访问令牌无效" }),
      async (base) => {
        await assert.rejects(() => fetchTestTokens({ base, token: "bad", userId: "1" }), /访问令牌无效/);
      },
    );
  }),
);

test(
  "fetchTestTokens：非 200 抛错并提示用户ID与令牌须匹配",
  withGuardOff(async () => {
    await withMockNewapi(
      (req, res) => {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: false, message: "用户 ID 不匹配" }));
      },
      async (base) => {
        await assert.rejects(() => fetchTestTokens({ base, token: "t", userId: "999" }), /401/);
      },
    );
  }),
);

// 回归：响应字段名变更（items -> records 之类）不能表现成「没有含『测试』的令牌」——
// 那会让用户去怀疑自己的令牌命名，而真因是解析失败。total 报了正数却一条没解析出来时必须抛错。
test(
  "fetchTestTokens：total 说有数据却解析出 0 条 → 抛错，不静默当成空结果",
  withGuardOff(async () => {
    await withMockNewapi(
      (req, res) => jsonRes(res, { success: true, data: { records: [{ id: 1, name: "测试" }], total: 5 } }),
      async (base) => {
        await assert.rejects(() => fetchTestTokens({ base, token: "t", userId: "1" }), /无法解析|响应字段名/);
      },
    );
  }),
);

test(
  "fetchTestTokens：total=0 的真空结果正常返回空数组（不能误报错）",
  withGuardOff(async () => {
    await withMockNewapi(
      (req, res) => jsonRes(res, { success: true, data: { items: [], total: 0 } }),
      async (base) => {
        assert.deepEqual(await fetchTestTokens({ base, token: "t", userId: "1" }), []);
      },
    );
  }),
);

test(
  "fetchTestTokens：空 items 立即停，不会翻满 50 页",
  withGuardOff(async () => {
    let calls = 0;
    await withMockNewapi(
      (req, res) => {
        calls += 1;
        jsonRes(res, { success: true, data: { items: [], total: 0 } });
      },
      async (base) => {
        const rows = await fetchTestTokens({ base, token: "t", userId: "1" });
        assert.deepEqual(rows, []);
        assert.equal(calls, 1);
      },
    );
  }),
);

test(
  "fetchTokenKeys：切成每批 ≤100 调 batch/keys，合并明文",
  withGuardOff(async () => {
    const batches = [];
    await withMockNewapi(
      (req, res) => {
        let body = "";
        req.on("data", (c) => {
          body += c;
        });
        req.on("end", () => {
          const ids = JSON.parse(body).ids;
          batches.push(ids.length);
          jsonRes(res, { success: true, data: { keys: Object.fromEntries(ids.map((i) => [String(i), `sk-${i}`])) } });
        });
      },
      async (base) => {
        const ids = Array.from({ length: 250 }, (_, i) => i + 1);
        const keys = await fetchTokenKeys({ base, token: "t", userId: "1" }, ids);
        assert.deepEqual(batches, [100, 100, 50], "上限 100，必须切片");
        assert.equal(Object.keys(keys).length, 250);
        assert.equal(keys["1"], "sk-1");
        assert.equal(keys["250"], "sk-250");
      },
    );
  }),
);

test(
  "fetchTokenKeys：空 ids 不发请求",
  withGuardOff(async () => {
    let calls = 0;
    await withMockNewapi(
      (req, res) => {
        calls += 1;
        jsonRes(res, { success: true, data: { keys: {} } });
      },
      async (base) => {
        const keys = await fetchTokenKeys({ base, token: "t", userId: "1" }, []);
        assert.deepEqual(keys, {});
        assert.equal(calls, 0);
      },
    );
  }),
);

test(
  "fetchSelfGroup / fetchPricing：取回分组与定价表",
  withGuardOff(async () => {
    await withMockNewapi(
      (req, res) => {
        if (req.url.startsWith("/api/user/self")) {
          jsonRes(res, { success: true, data: { id: 7, group: "vip" } });
          return;
        }
        jsonRes(res, { success: true, data: [{ model_name: "gpt-4o", enable_groups: ["vip"] }] });
      },
      async (base) => {
        const creds = { base, token: "t", userId: "7" };
        assert.equal(await fetchSelfGroup(creds), "vip");
        const pricing = await fetchPricing(creds);
        assert.equal(pricing.length, 1);
        assert.equal(pricing[0].model_name, "gpt-4o");
      },
    );
  }),
);

// 出站守卫：与本仓其它出站点一致，内网/元数据地址必须在发请求前就被拦。
test("base 指向内网 → 被出站守卫拦截，不发请求", async () => {
  delete process.env.EVALUATOR_EGRESS_DENY_PRIVATE; // 默认开启守卫
  for (const base of ["http://169.254.169.254", "http://10.0.0.5:3000", "http://127.0.0.1:3000"]) {
    await assert.rejects(
      () => fetchTestTokens({ base, token: "t", userId: "1" }),
      (err) => err.name === "EgressBlockedError" || /内网|私有|保留|egress|blocked/i.test(err.message),
      `${base} 应被守卫拦下`,
    );
  }
});

test(
  "尾斜杠归一化：base 带斜杠也拼得出正确路径",
  withGuardOff(async () => {
    let seenPath = null;
    await withMockNewapi(
      (req, res) => {
        seenPath = req.url;
        jsonRes(res, { success: true, data: { items: [], total: 0 } });
      },
      async (base) => {
        await fetchTestTokens({ base: `${base}/`, token: "t", userId: "1" });
        assert.match(seenPath, /^\/api\/token\/\?p=1/, "不该出现 // 或缺斜杠");
      },
    );
  }),
);
