// tests/channels-import-sub2api-endpoint.test.mjs
// 端点集成：真起 server.mjs 子进程 + 一个 mock sub2api，验证
// POST /api/channels/import-sub2api-tokens 的权限、校验、幂等、模型广场回落，
// 以及最关键的「明文密钥进加密库、绝不回响应体/不下发浏览器」。
//
// 端口 5403（5386–5402 已被其它端点测试占用；端口撞车会导致单跑绿、全跑红）。
// 子进程需访问跑在 127.0.0.1 的 mock，故给它 EVALUATOR_EGRESS_DENY_PRIVATE=false；
// 守卫本身由 tests/sub2api-import.test.mjs 专门验证。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test, { before, after } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 5403;
const dataDir = mkdtempSync(join(tmpdir(), "s2a-endpoint-"));
let server;
let mock;
let mockBase = "";
let ready = false;
let cookieAdmin = "";
let cookieUser = "";
// 由各用例切换 mock 行为
let mockMode = "normal";
let mockCalls = [];

const baseEnv = {
  EVALUATOR_SESSION_SECRET: "test-secret-0123456789abcdef-32b+",
  EVALUATOR_ADMIN_PASSWORD: "adminpw", // admin / role=100（超管）
  EVALUATOR_LOCAL_USERS: "tester:testerpw:10", // tester / role=10（普通管理员）
  EVALUATOR_SECRET_STORE: "memory",
  EVALUATOR_COOKIE_SECURE: "false",
  EVALUATOR_EGRESS_DENY_PRIVATE: "false",
  HOST: "127.0.0.1",
};

const KEYS = [
  { id: 1, name: "测试-Claude", key: "sk-SECRET-1", group_id: 3, status: "active" },
  { id: 2, name: "测试-OpenAI", key: "sk-SECRET-2", group_id: 7, status: "active" },
  { id: 3, name: "生产密钥", key: "sk-SECRET-3", group_id: 3, status: "active" },
];
const PLAZA = {
  groups: [
    { id: 3, name: "Claude 组", platform: "anthropic", models: [{ name: "claude-opus-4" }, { name: "claude-sonnet-4" }] },
    { id: 7, name: "OpenAI 组", platform: "openai", models: [{ name: "gpt-4o" }] },
  ],
};

function startMock() {
  return new Promise((resolve) => {
    const srv = createServer(async (req, res) => {
      const path = req.url.split("?")[0];
      mockCalls.push(`${req.method} ${path}`);
      const json = (b, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(b));
      };
      if (path === "/api/v1/auth/login") {
        if (mockMode === "badcreds") return json({ code: 401, message: "invalid" }, 401);
        return json({ code: 0, data: { access_token: "jwt-abc" } });
      }
      if (path === "/api/v1/keys") {
        const page = Number(new URL(req.url, "http://x").searchParams.get("page"));
        return json({ code: 0, data: { items: page === 1 ? KEYS : [], total: KEYS.length, pages: 1 } });
      }
      if (path === "/api/v1/model-plaza") {
        if (mockMode === "noplaza") return json({ code: 404, message: "Model plaza is not enabled" }, 404);
        return json({ code: 0, data: PLAZA });
      }
      if (path === "/v1/models") {
        // 回落路径：按密钥返回其可调模型
        return json({ data: [{ id: "fallback-model-a" }, { id: "fallback-model-b" }] });
      }
      json({ code: 404 }, 404);
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
  post("/api/channels/import-sub2api-tokens", cookie, {
    baseUrl: mockBase,
    email: "a@b.com",
    password: "pw",
    ...overrides,
  });

before(async () => {
  mock = await startMock();
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
  await new Promise((r) => setTimeout(r, 300));
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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

test("必填校验：缺网址/邮箱/密码都报 400", async () => {
  assert.ok(ready, "server 未就绪");
  for (const missing of [{ baseUrl: "" }, { email: "" }, { password: "" }]) {
    const { status, body } = await doImport(cookieAdmin, missing);
    assert.equal(status, 400);
    assert.equal(body.error, "missing_fields");
  }
});

test("登录失败 → 400 且透出原因", async () => {
  assert.ok(ready, "server 未就绪");
  mockMode = "badcreds";
  try {
    const { status, body } = await doImport(cookieAdmin);
    assert.equal(status, 400);
    assert.equal(body.error, "sub2api_login_error");
    assert.match(body.userMessage, /邮箱或密码不正确/);
  } finally {
    mockMode = "normal";
  }
});

test("快乐路径：协议按分组 platform 判定，模型目标一并建出", async () => {
  assert.ok(ready, "server 未就绪");
  mockCalls = [];
  const { status, body } = await doImport(cookieAdmin);
  assert.equal(status, 200);
  assert.equal(body.summary.total, 2, "3 个密钥里只有 2 个含「测试」");
  assert.equal(body.summary.imported, 2);
  assert.equal(body.summary.viaFallback, 0, "模型广场可用时不该走回落");

  const { body: channels } = await get("/api/channels", cookieAdmin);
  assert.equal(channels.length, 2);
  const byName = Object.fromEntries(channels.map((c) => [c.name, c]));
  const claude = byName["测试-Claude"];
  const openai = byName["测试-OpenAI"];
  assert.ok(claude && openai);
  assert.equal(claude.protocol, "claude_messages", "anthropic 分组 → Claude Messages");
  assert.deepEqual(claude.models, ["claude-opus-4", "claude-sonnet-4"]);
  assert.equal(claude.sub2apiGroupName, "Claude 组");
  assert.equal(openai.protocol, "openai_compatible");
  assert.equal(claude.baseUrl, mockBase, "渠道指回 sub2api 自己");
  assert.equal(claude.source, "sub2api");

  const { body: targets } = await get("/api/model-targets", cookieAdmin);
  assert.equal(targets.length, 3, "2 + 1 个模型");

  assert.ok(mockCalls.includes("POST /api/v1/auth/login"));
  assert.ok(mockCalls.some((c) => c.startsWith("GET /api/v1/keys")));
  assert.ok(mockCalls.some((c) => c.startsWith("GET /api/v1/model-plaza")));
  assert.ok(!mockCalls.some((c) => c.startsWith("GET /v1/models")), "广场可用时不该逐密钥调 /v1/models");
});

test("明文密钥进加密库，不回响应体、不下发浏览器、不落盘", async () => {
  assert.ok(ready, "server 未就绪");
  const { body } = await doImport(cookieAdmin);
  assert.doesNotMatch(JSON.stringify(body), /sk-SECRET/, "响应体绝不能带明文密钥");
  assert.equal(body.keys, undefined);
  assert.equal(body.channels, undefined, "只回汇总，不回渠道明细");

  const { body: channels } = await get("/api/channels", cookieAdmin);
  assert.doesNotMatch(JSON.stringify(channels), /sk-SECRET/, "渠道列表绝不能带明文密钥");
  for (const c of channels) {
    assert.equal(c.hasKey, true, "密钥应已存进加密库");
    assert.equal(c.apiKey, "已安全保存");
    assert.equal(c.apiKeyRef, undefined);
    assert.equal(c.keyHash, undefined);
  }

  // 全盘扫描：整个 data 目录不得出现明文密钥
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      try {
        if (readFileSync(p).includes("sk-SECRET")) hits.push(p.replace(dataDir, "<data>"));
      } catch {
        /* 读不到就跳过 */
      }
    }
  };
  walk(dataDir);
  assert.deepEqual(hits, [], `明文密钥泄漏进了落盘文件: ${hits.join(", ")}`);
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

test("模型广场未启用 → 按密钥回落 /v1/models，并在 summary 里报明", async () => {
  assert.ok(ready, "server 未就绪");
  mockMode = "noplaza";
  mockCalls = [];
  try {
    const { status, body } = await doImport(cookieAdmin);
    assert.equal(status, 200);
    assert.equal(body.summary.viaFallback, 2, "两个密钥都走了回落");
    assert.ok(
      mockCalls.some((c) => c.startsWith("GET /v1/models")),
      "应逐密钥调 /v1/models",
    );
    const { body: channels } = await get("/api/channels", cookieAdmin);
    const c = channels.find((x) => x.name === "测试-Claude");
    assert.deepEqual(c.models, ["fallback-model-a", "fallback-model-b"]);
    assert.equal(c.protocol, "openai_compatible", "拿不到 platform 时落 OpenAI 兼容");
  } finally {
    mockMode = "normal";
  }
});
