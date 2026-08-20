// tests/channels-import-test-tokens-endpoint.test.mjs
// 端点集成：真起 server.mjs 子进程 + 一个 mock new-api，验证
// POST /api/channels/import-test-tokens 的权限、校验、幂等，以及最关键的
// 「明文 key 进加密库、绝不回响应体/不下发浏览器」。
//
// 端口 5402（5386–5401 已被其它端点测试占用；端口撞车会导致单跑绿、全跑红）。
// 子进程需要访问跑在 127.0.0.1 的 mock，故给它 EVALUATOR_EGRESS_DENY_PRIVATE=false；
// 守卫本身由 tests/newapi-token-import.test.mjs 专门验证。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test, { before, after } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 5402;
const dataDir = mkdtempSync(join(tmpdir(), "itt-endpoint-"));
let server;
let mock;
let mockBase = "";
let ready = false;
let cookieAdmin = "";
let cookieUser = "";
let mockCalls = [];

const baseEnv = {
  EVALUATOR_SESSION_SECRET: "test-secret-0123456789abcdef-32b+",
  EVALUATOR_ADMIN_PASSWORD: "adminpw", // admin / role=100（超管）
  EVALUATOR_LOCAL_USERS: "tester:testerpw:10", // tester / role=10（普通管理员）
  EVALUATOR_SECRET_STORE: "memory",
  EVALUATOR_COOKIE_SECURE: "false",
  EVALUATOR_EGRESS_DENY_PRIVATE: "false", // 需访问 127.0.0.1 上的 mock new-api
  HOST: "127.0.0.1",
};

const TOKENS = [
  { id: 1, name: "测试-默认组", group: "", status: 1 },
  { id: 2, name: "测试-VIP", group: "vip", status: 1 },
  { id: 3, name: "生产令牌", group: "vip", status: 1 }, // 不含「测试」，必须被过滤
];
const PRICING = [
  { model_name: "gpt-4o", enable_groups: ["default"] },
  { model_name: "claude-opus", enable_groups: ["vip"] },
  { model_name: "shared", enable_groups: ["all"] },
];

function startMockNewapi() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      mockCalls.push(`${req.method} ${req.url.split("?")[0]}`);
      const json = (body) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url.startsWith("/api/token/batch/keys")) {
        let body = "";
        req.on("data", (c) => {
          body += c;
        });
        req.on("end", () => {
          const ids = JSON.parse(body || "{}").ids || [];
          json({ success: true, data: { keys: Object.fromEntries(ids.map((i) => [String(i), `sk-plain-${i}`])) } });
        });
        return;
      }
      if (req.url.startsWith("/api/token/")) {
        const p = new URL(req.url, "http://x").searchParams.get("p");
        json({ success: true, data: { items: p === "1" ? TOKENS : [], total: TOKENS.length } });
        return;
      }
      if (req.url.startsWith("/api/user/self")) {
        json({ success: true, data: { id: 1, group: "default" } });
        return;
      }
      if (req.url.startsWith("/api/pricing")) {
        json({ success: true, data: PRICING });
        return;
      }
      res.writeHead(404).end("{}");
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

async function waitHealthy(port) {
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
async function login(username, password) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${PORT}` },
    body: JSON.stringify({ username, password }),
  });
  return (r.headers.get("set-cookie") || "").split(";")[0];
}
async function get(path, cookie) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { origin: `http://127.0.0.1:${PORT}`, cookie } });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function post(path, cookie, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${PORT}`, cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const doImport = (cookie, overrides = {}) =>
  post("/api/channels/import-test-tokens", cookie, { baseUrl: mockBase, token: "tok-abc", userId: "1", ...overrides });

before(async () => {
  mock = await startMockNewapi();
  mockBase = `http://127.0.0.1:${mock.address().port}`;
  server = spawn(process.execPath, [join(root, "server.mjs")], {
    env: { ...process.env, ...baseEnv, EVALUATOR_DATA_DIR: dataDir, PORT: String(PORT) },
    stdio: "ignore",
  });
  ready = await waitHealthy(PORT);
  if (ready) {
    cookieAdmin = await login("admin", "adminpw");
    cookieUser = await login("tester", "testerpw");
  }
});

after(async () => {
  server?.kill();
  await new Promise((r) => mock?.close(r));
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* best-effort */
  }
});

test("前置：server 就绪", () => {
  assert.ok(ready, "server 未就绪");
});

test("未登录 401", async () => {
  assert.ok(ready, "server 未就绪");
  const { status } = await doImport("");
  assert.equal(status, 401);
});

test("普通管理员(role 10)不能导入渠道 —— 渠道持 key，只超管可写", async () => {
  assert.ok(ready, "server 未就绪");
  const { status } = await doImport(cookieUser);
  assert.equal(status, 403);
});

test("三项必填：缺一个报 400 且不打上游", async () => {
  assert.ok(ready, "server 未就绪");
  for (const missing of [{ baseUrl: "" }, { token: "" }, { userId: "" }]) {
    const { status, body } = await doImport(cookieAdmin, missing);
    assert.equal(status, 400);
    assert.equal(body.error, "missing_fields");
  }
});

test("用户ID 必须是数字", async () => {
  assert.ok(ready, "server 未就绪");
  const { status, body } = await doImport(cookieAdmin, { userId: "abc" });
  assert.equal(status, 400);
  assert.equal(body.error, "bad_user_id");
});

test("快乐路径：每个「测试」令牌建一个渠道 + 其分组下的模型目标", async () => {
  assert.ok(ready, "server 未就绪");
  mockCalls = [];
  const { status, body } = await doImport(cookieAdmin);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.summary.total, 2, "3 个令牌里只有 2 个含「测试」");
  assert.equal(body.summary.imported, 2);

  const { body: channels } = await get("/api/channels", cookieAdmin);
  assert.equal(channels.length, 2);
  const byName = Object.fromEntries(channels.map((c) => [c.name, c]));
  const def = byName["测试-默认组"];
  const vip = byName["测试-VIP"];
  assert.ok(def && vip, "两个渠道都该按令牌名命名");

  // group 为空 -> 回落用户分组 default -> gpt-4o + shared
  assert.deepEqual(def.models, ["gpt-4o", "shared"]);
  // group=vip -> claude-opus + shared
  assert.deepEqual(vip.models, ["claude-opus", "shared"]);
  // baseUrl 指回 new-api 自己
  assert.equal(def.baseUrl, mockBase);
  assert.equal(def.source, "newapi-token");

  // 模型目标：2 渠道 × 2 模型
  const { body: targets } = await get("/api/model-targets", cookieAdmin);
  assert.equal(targets.length, 4);

  // 确实调了这几个上游接口
  assert.ok(mockCalls.some((c) => c.startsWith("GET /api/token/")));
  assert.ok(mockCalls.includes("POST /api/token/batch/keys"));
  assert.ok(mockCalls.some((c) => c.startsWith("GET /api/pricing")));
});

test("明文 key 进加密库，不回响应体、不下发浏览器", async () => {
  assert.ok(ready, "server 未就绪");
  const { body } = await doImport(cookieAdmin);
  // 响应体里不能出现明文 key，也不该有 keys 映射
  const raw = JSON.stringify(body);
  assert.doesNotMatch(raw, /sk-plain-/, "响应体绝不能带明文 key");
  assert.equal(body.keys, undefined);
  assert.equal(body.channels, undefined, "只回汇总，不回渠道明细");

  // 渠道列表（maskChannel 后）应只有 hasKey 标记，无明文、无内部凭证字段
  const { body: channels } = await get("/api/channels", cookieAdmin);
  const rawChannels = JSON.stringify(channels);
  assert.doesNotMatch(rawChannels, /sk-plain-/, "渠道列表绝不能带明文 key");
  for (const c of channels) {
    assert.equal(c.hasKey, true, "key 应已存进加密库");
    assert.equal(c.apiKey, "已安全保存");
    assert.equal(c.apiKeyRef, undefined);
    assert.equal(c.keyHash, undefined);
  }
});

test("重复导入幂等：渠道数与模型目标数不增长", async () => {
  assert.ok(ready, "server 未就绪");
  const before = await get("/api/channels", cookieAdmin);
  const beforeTargets = await get("/api/model-targets", cookieAdmin);
  const { body } = await doImport(cookieAdmin);
  assert.equal(body.summary.imported, 0, "第二次全是 updated");
  assert.equal(body.summary.updated, 2);
  assert.equal(body.summary.newTargets, 0);
  const after = await get("/api/channels", cookieAdmin);
  const afterTargets = await get("/api/model-targets", cookieAdmin);
  assert.equal(after.body.length, before.body.length);
  assert.equal(afterTargets.body.length, beforeTargets.body.length);
});

// —— P2-1 端到端：用户在 UI 里改过的渠道，重新导入后修改仍在，且 summary 报出 preserved ——
// 这条走完整链路（HTTP → 三方合并 → 落库 → 再读回），覆盖 plan 层单测覆盖不到的一环：
// importSnapshot 必须能穿过 normalizeChannel 的字段白名单存活下来。漏加白名单的表现是
// 用户在 UI 里编辑过一次快照就没了，下次导入退化成全量覆盖 —— 正是本修复要解决的问题。
test("重新导入：用户在 UI 里改过的协议/名称不被推翻，summary 报出 preserved", async () => {
  assert.ok(ready, "server 未就绪");
  await doImport(cookieAdmin); // 确保渠道已存在且带快照
  const { body: before } = await get("/api/channels", cookieAdmin);
  const target = before.find((c) => c.name === "测试-VIP");
  assert.ok(target, "前置：应有「测试-VIP」渠道");

  // 模拟用户在 UI 里编辑：改名 + 改协议。
  // 注意协议要选一个与上游口径【不同】的值才有意义：本 mock 的 vip 组是 claude-opus + shared
  // （claude 1 : 其他 1，不构成多数），guessProtocol 给的是 openai_compatible，
  // 所以这里改成 claude_messages 才构成真正的用户覆盖。
  assert.equal(target.protocol, "openai_compatible", "前置：上游口径应是 openai_compatible");
  const edit = await post("/api/channels", cookieAdmin, { ...target, name: "我改的渠道名", protocol: "claude_messages" });
  assert.equal(edit.status, 200);

  // 关键断言：编辑过后快照仍在（normalizeChannel 白名单里有 importSnapshot）
  const { body: mid } = await get("/api/channels", cookieAdmin);
  const edited = mid.find((c) => c.id === target.id);
  assert.ok(edited.importSnapshot, "UI 编辑不能把 importSnapshot 抹掉，否则下次导入退化成全量覆盖");

  const { body } = await doImport(cookieAdmin);
  assert.ok(body.summary.preserved >= 1, `应上报保留了手工修改，实际 summary=${JSON.stringify(body.summary)}`);

  const { body: after } = await get("/api/channels", cookieAdmin);
  const kept = after.find((c) => c.id === target.id);
  assert.equal(kept.name, "我改的渠道名", "用户改的名字必须活过重新导入");
  assert.equal(kept.protocol, "claude_messages", "用户改的协议必须活过重新导入");
  assert.match(kept.notes, /已保留你的手工设置/, "notes 要说实话，不能还声称协议是推断来的");

  // 复原，避免影响后续用例
  await post("/api/channels", cookieAdmin, { ...kept, name: "测试-VIP", protocol: kept.importSnapshot.protocol });
});

// —— P2-3 端到端：任何回给浏览器的错误信息都不得带出凭据 ——
// 原先含 CR/LF 的令牌会让 undici 的 Headers.append 抛 TypeError，其 message 内嵌令牌原文，
// 经 catch 变成 userMessage 回显（实测复现过）。现在源头自检 + 端点 redact 两道防线。
test("凭据含控制字符 → 400，且响应体绝不回显令牌原文", async () => {
  assert.ok(ready, "server 未就绪");
  const secret = "sk-LEAKCHECK-TOKEN-4242";
  const cr = String.fromCharCode(13);
  const lf = String.fromCharCode(10);
  const { status, body } = await doImport(cookieAdmin, { token: `${secret}${cr}${lf}X-Injected: 1` });
  assert.equal(status, 400);
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes(secret), `响应体绝不能带出令牌原文，实际：${raw}`);
  assert.ok(!raw.includes("X-Injected"), "也不该回显注入内容");
});

// 脱敏兜底本身：即便上游把一个 sk- 形态的串放进业务错误消息，也不该原样回给浏览器。
test("上游错误消息里的 sk- 形态凭据被脱敏后才回给浏览器", async () => {
  assert.ok(ready, "server 未就绪");
  const leaky = await new Promise((resolve) => {
    const srv = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, message: "令牌 sk-UPSTREAM-ECHOED-SECRET-123456 无效" }));
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
  try {
    const { status, body } = await doImport(cookieAdmin, { baseUrl: `http://127.0.0.1:${leaky.address().port}` });
    assert.equal(status, 400);
    assert.ok(!body.userMessage.includes("sk-UPSTREAM-ECHOED-SECRET-123456"), `凭据形态的串应被脱敏，实际：${body.userMessage}`);
    assert.match(body.userMessage, /redacted/, "应留下脱敏标记，便于排查");
  } finally {
    await new Promise((r) => leaky.close(r));
  }
});

test("上游 success:false → 400 且透出原因，不静默建空渠道", async () => {
  assert.ok(ready, "server 未就绪");
  // 换一个只回 success:false 的 mock
  const bad = await new Promise((resolve) => {
    const srv = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, message: "访问令牌无效" }));
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
  try {
    const { status, body } = await doImport(cookieAdmin, { baseUrl: `http://127.0.0.1:${bad.address().port}` });
    assert.equal(status, 400);
    assert.equal(body.error, "newapi_error");
    assert.match(body.userMessage, /访问令牌无效/);
  } finally {
    await new Promise((r) => bad.close(r));
  }
});

test("没有含「测试」的令牌 → 200 且 total=0，不建任何渠道", async () => {
  assert.ok(ready, "server 未就绪");
  const empty = await new Promise((resolve) => {
    const srv = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url.startsWith("/api/token/")) {
        res.end(JSON.stringify({ success: true, data: { items: [{ id: 9, name: "生产", group: "vip", status: 1 }], total: 1 } }));
        return;
      }
      res.end(JSON.stringify({ success: true, data: [] }));
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
  try {
    const before = await get("/api/channels", cookieAdmin);
    const { status, body } = await doImport(cookieAdmin, { baseUrl: `http://127.0.0.1:${empty.address().port}` });
    assert.equal(status, 200);
    assert.equal(body.summary.total, 0);
    const after = await get("/api/channels", cookieAdmin);
    assert.equal(after.body.length, before.body.length, "不该新建渠道");
  } finally {
    await new Promise((r) => empty.close(r));
  }
});
