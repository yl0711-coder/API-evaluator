import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { fetchModelPlaza, fetchModelsPerKey, fetchTestKeys, login } from "../server/sub2api-import.mjs";

async function withMock(handler, run) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// mock 跑在 127.0.0.1，出站守卫会（正确地）拦它——测协议逻辑时关掉，守卫本身单独验证。
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

const send = (res, body, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
    });
    req.on("end", () => resolve(b ? JSON.parse(b) : {}));
  });

test(
  "login：普通登录取到 access_token，Bearer 前缀正确",
  withGuardOff(async () => {
    let seenBody = null;
    await withMock(
      async (req, res) => {
        seenBody = await readBody(req);
        send(res, { code: 0, message: "success", data: { access_token: "jwt-abc", token_type: "Bearer" } });
      },
      async (base) => {
        const token = await login({ base, email: "a@b.com", password: "pw" });
        assert.equal(token, "jwt-abc");
        assert.deepEqual(seenBody, { email: "a@b.com", password: "pw" });
      },
    );
  }),
);

test(
  "login：账号开了 TOTP → 走两步流程；未提供验证码时报明确错误",
  withGuardOff(async () => {
    const paths = [];
    await withMock(
      async (req, res) => {
        paths.push(req.url);
        const body = await readBody(req);
        if (req.url.endsWith("/auth/login")) {
          send(res, { code: 0, data: { requires_2fa: true, temp_token: "tmp-1", user_email_masked: "a***@b.com" } });
          return;
        }
        assert.equal(body.temp_token, "tmp-1", "第二步要带上 temp_token");
        assert.equal(body.totp_code, "123456");
        send(res, { code: 0, data: { access_token: "jwt-2fa" } });
      },
      async (base) => {
        // 不给验证码：必须明确告知需要 TOTP，而不是抛个含糊的解析错误
        await assert.rejects(() => login({ base, email: "a@b.com", password: "pw" }), /两步验证|TOTP/);
        // 给了验证码：走完两步
        const token = await login({ base, email: "a@b.com", password: "pw", totpCode: "123456" });
        assert.equal(token, "jwt-2fa");
        assert.ok(
          paths.some((p) => p.endsWith("/auth/login/2fa")),
          "应调用 /auth/login/2fa",
        );
      },
    );
  }),
);

test(
  "login：401 归一化为「邮箱或密码不正确」，且错误信息不含密码",
  withGuardOff(async () => {
    await withMock(
      (req, res) => send(res, { code: 401, message: "invalid credentials" }, 401),
      async (base) => {
        const password = "SuperSecret123!";
        await assert.rejects(
          () => login({ base, email: "a@b.com", password }),
          (err) => {
            assert.match(err.message, /邮箱或密码不正确/);
            assert.ok(!err.message.includes(password), "错误信息绝不能带出密码");
            return true;
          },
        );
      },
    );
  }),
);

test(
  "login：code 非 0（HTTP 200 但业务失败）也要抛错",
  withGuardOff(async () => {
    await withMock(
      (req, res) => send(res, { code: 1001, message: "账号被禁用" }),
      async (base) => {
        await assert.rejects(() => login({ base, email: "a@b.com", password: "pw" }), /账号被禁用/);
      },
    );
  }),
);

test(
  "fetchTestKeys：Bearer JWT、按 pages 翻页、只留名称含「测试」",
  withGuardOff(async () => {
    const seen = [];
    let seenAuth = null;
    await withMock(
      (req, res) => {
        seenAuth = req.headers.authorization;
        const u = new URL(req.url, "http://x");
        seen.push(u.searchParams.get("page"));
        assert.equal(u.searchParams.get("status"), "active", "只取启用状态的密钥");
        const page = Number(u.searchParams.get("page"));
        send(res, {
          code: 0,
          data: {
            items:
              page === 1
                ? [
                    { id: 1, name: "测试-A", key: "sk-a", group_id: 3, status: "active" },
                    { id: 2, name: "生产-B", key: "sk-b", group_id: 3, status: "active" },
                  ]
                : [{ id: 3, name: "测试-C", key: "sk-c", group_id: 7, status: "active" }],
            total: 3,
            page,
            page_size: 1000,
            pages: 2,
          },
        });
      },
      async (base) => {
        const rows = await fetchTestKeys({ base, token: "jwt-abc" });
        assert.equal(seenAuth, "Bearer jwt-abc", "面板接口用 JWT，带 Bearer 前缀");
        assert.deepEqual(seen, ["1", "2"], "按 pages 翻页，不靠猜");
        assert.equal(rows.length, 2, "生产-B 被过滤");
        assert.deepEqual(
          rows.map((r) => r.name),
          ["测试-A", "测试-C"],
        );
      },
    );
  }),
);

test(
  "fetchTestKeys：total 说有数据却解析出 0 条 → 抛错，不静默当成空结果",
  withGuardOff(async () => {
    await withMock(
      (req, res) => send(res, { code: 0, data: { records: [{ id: 1, name: "测试" }], total: 5, pages: 1 } }),
      async (base) => {
        await assert.rejects(() => fetchTestKeys({ base, token: "j" }), /无法解析|响应结构/);
      },
    );
  }),
);

test(
  "fetchTestKeys：真空结果正常返回空数组（不能误报错）",
  withGuardOff(async () => {
    await withMock(
      (req, res) => send(res, { code: 0, data: { items: [], total: 0, pages: 1 } }),
      async (base) => {
        assert.deepEqual(await fetchTestKeys({ base, token: "j" }), []);
      },
    );
  }),
);

test(
  "fetchTestKeys：429 给出限流专属提示",
  withGuardOff(async () => {
    await withMock(
      (req, res) => send(res, { code: 429, message: "too many" }, 429),
      async (base) => {
        await assert.rejects(() => fetchTestKeys({ base, token: "j" }), /限流|429/);
      },
    );
  }),
);

test(
  "fetchModelPlaza：404 = 功能未启用 → 返回 null 让上层回落，不抛错",
  withGuardOff(async () => {
    await withMock(
      (req, res) => send(res, { code: 404, message: "Model plaza is not enabled" }, 404),
      async (base) => {
        assert.equal(await fetchModelPlaza({ base, token: "j" }), null);
      },
    );
  }),
);

test(
  "fetchModelPlaza：正常返回 groups",
  withGuardOff(async () => {
    await withMock(
      (req, res) =>
        send(res, { code: 0, data: { groups: [{ id: 3, name: "标准组", platform: "anthropic", models: [{ name: "claude-opus-4" }] }] } }),
      async (base) => {
        const plaza = await fetchModelPlaza({ base, token: "j" });
        assert.equal(plaza.groups.length, 1);
        assert.equal(plaza.groups[0].platform, "anthropic");
      },
    );
  }),
);

test(
  "fetchModelsPerKey：用明文密钥而非 JWT 认证，路径无 /api/v1 前缀",
  withGuardOff(async () => {
    const auths = [];
    const paths = [];
    await withMock(
      (req, res) => {
        auths.push(req.headers.authorization);
        paths.push(req.url);
        send(res, { data: [{ id: "gpt-4o" }, { id: "claude-opus-4" }] });
      },
      async (base) => {
        const out = await fetchModelsPerKey({ base }, [
          { id: 1, key: "sk-plain-1" },
          { id: 2, key: "sk-plain-2" },
        ]);
        assert.deepEqual(auths, ["Bearer sk-plain-1", "Bearer sk-plain-2"], "必须用密钥明文，不是 JWT");
        assert.ok(
          paths.every((p) => p === "/v1/models"),
          `路径应为 /v1/models（无 /api/v1 前缀），实际: ${paths.join(",")}`,
        );
        assert.deepEqual(out["1"], ["gpt-4o", "claude-opus-4"]);
      },
    );
  }),
);

// 回归：回落路径是串行 + 间隔，耗时随密钥数线性增长（实测 120 个约 25 秒）。
// 没有上限时分页上限 20000 个会跑一个多小时、请求一直挂着，前端只显示「导入中…」。
// 宁可明确失败并指路（启用模型广场），不要不确定的长挂起。
test("fetchModelsPerKey：密钥过多时直接报错，不做几十分钟的串行请求", async () => {
  const rows = Array.from({ length: 151 }, (_, i) => ({ id: i + 1, key: `sk-${i}` }));
  await assert.rejects(
    () => fetchModelsPerKey({ base: "https://x.test" }, rows),
    (err) => {
      assert.match(err.message, /模型广场/, "要指出解决办法");
      assert.match(err.message, /151/, "要报出实际条数");
      return true;
    },
  );
});

test(
  "fetchModelsPerKey：单个密钥失败不中断整体，记空清单继续",
  withGuardOff(async () => {
    let n = 0;
    await withMock(
      (req, res) => {
        n += 1;
        if (n === 1) {
          send(res, { code: 403, message: "key disabled" }, 403);
          return;
        }
        send(res, { data: [{ id: "gpt-4o" }] });
      },
      async (base) => {
        const out = await fetchModelsPerKey({ base }, [
          { id: 1, key: "sk-bad" },
          { id: 2, key: "sk-good" },
        ]);
        assert.deepEqual(out["1"], [], "失败的记空清单");
        assert.deepEqual(out["2"], ["gpt-4o"], "后续密钥仍要继续");
      },
    );
  }),
);

// —— P3-2 回归：回落路径要有【总耗时】上限，不只是条数上限 ——
// 条数上限只在上游正常响应时才等于时间上限：每个密钥各自享有完整的 timeoutMs，
// 上游挂起不答时 150 个密钥能跑约 38 分钟（实测耗时随密钥数线性增长：1/3/6 个 → 613/2240/4697ms），
// 期间请求一直挂着、前端只显示「导入中…」。故必须另按墙钟兜一道。
test(
  "fetchModelsPerKey：上游挂起时按总耗时预算中止，不无限拖下去",
  withGuardOff(async () => {
    // 每次请求都挂起 → 每个密钥耗满 timeoutMs。把 timeout 压到 300ms、预算压到 700ms，
    // 于是约 3 个密钥后就该触发预算中止，而不是把 40 个都跑完（40 × 300ms = 12s）。
    process.env.EVALUATOR_SUB2API_IMPORT_TIMEOUT_MS = "300";
    process.env.EVALUATOR_SUB2API_FALLBACK_BUDGET_MS = "700";
    let served = 0;
    try {
      await withMock(
        () => {
          served += 1; // 刻意不响应：模拟上游挂起
        },
        async (base) => {
          const rows = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, key: `sk-${i}` }));
          const startedAt = Date.now();
          await assert.rejects(
            () => fetchModelsPerKey({ base }, rows),
            (err) => {
              assert.match(err.message, /模型广场/, "要指出解决办法");
              assert.match(err.message, /上限|耗时/, "要说明是超时中止");
              return true;
            },
          );
          const elapsed = Date.now() - startedAt;
          assert.ok(elapsed < 6000, `应在预算附近就中止，实际耗时 ${elapsed}ms`);
          assert.ok(served < 40, `不该把全部 40 个密钥都打完，实际发出 ${served} 次`);
        },
      );
    } finally {
      delete process.env.EVALUATOR_SUB2API_IMPORT_TIMEOUT_MS;
      delete process.env.EVALUATOR_SUB2API_FALLBACK_BUDGET_MS;
    }
  }),
);

// 反向用例：预算别设得过紧，把正常（快速响应）的导入也掐掉。
test(
  "fetchModelsPerKey：上游响应正常时不受预算影响，全部密钥都查完",
  withGuardOff(async () => {
    let served = 0;
    await withMock(
      (req, res) => {
        served += 1;
        send(res, { data: [{ id: "gpt-4o" }] });
      },
      async (base) => {
        const rows = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, key: `sk-${i}` }));
        const out = await fetchModelsPerKey({ base }, rows);
        assert.equal(Object.keys(out).length, 6, "6 个密钥都要有结果");
        assert.equal(served, 6);
        for (const id of ["1", "6"]) assert.deepEqual(out[id], ["gpt-4o"]);
      },
    );
  }),
);

// 出站守卫：与本仓其它出站点一致，内网/元数据地址必须在发请求前就被拦。
test("base 指向内网 → 被出站守卫拦截，不发请求", async () => {
  delete process.env.EVALUATOR_EGRESS_DENY_PRIVATE;
  for (const base of ["http://169.254.169.254", "http://10.0.0.5:3000", "http://127.0.0.1:3000"]) {
    await assert.rejects(
      () => login({ base, email: "a@b.com", password: "pw" }),
      (err) => err.name === "EgressBlockedError" || /内网|私有|保留|egress|blocked/i.test(err.message),
      `${base} 应被守卫拦下`,
    );
  }
});

test(
  "尾斜杠归一化：base 带斜杠也拼得出正确路径",
  withGuardOff(async () => {
    let seenPath = null;
    await withMock(
      (req, res) => {
        seenPath = req.url;
        send(res, { code: 0, data: { access_token: "jwt" } });
      },
      async (base) => {
        await login({ base: `${base}/`, email: "a@b.com", password: "pw" });
        assert.equal(seenPath, "/api/v1/auth/login", "不该出现 // 或缺斜杠");
      },
    );
  }),
);
