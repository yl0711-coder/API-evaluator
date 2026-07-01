// tests/newapi-channel-sync-endpoint.test.mjs
// 端点集成：真起 server.mjs 子进程，覆盖 POST /api/channels/:id/push-to-newapi 与
// POST /api/model-targets/:id/push-to-newapi 的鉴权、Key 取用、回存 newapiChannelId、故障映射。
// 有状态 mock new-api（建/取/改渠道），让“模型加入渠道 + 幂等”能端到端验证。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test, { before, after } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// —— 有状态 mock new-api ——
const mockStore = new Map(); // id -> channel
let mockNextId = 1000;
let mockMode = "ok"; // "ok" | "error"
const mockLast = {};
function readBody(req) {
  return new Promise((r) => {
    const c = [];
    req.on("data", (d) => c.push(d));
    req.on("end", () => r(Buffer.concat(c)));
  });
}
const mock = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const json = (s, o) => {
    res.writeHead(s, { "content-type": "application/json" });
    res.end(JSON.stringify(o));
  };
  if (req.method === "POST" && u.pathname === "/api/channel/") {
    if (mockMode === "error") return json(500, { success: false });
    mockLast.post = JSON.parse((await readBody(req)).toString("utf8"));
    const id = mockNextId++;
    mockStore.set(id, { id, ...mockLast.post.channel });
    return json(200, { success: true, data: { id } });
  }
  if (req.method === "DELETE" && /^\/api\/channel\/\d+$/.test(u.pathname)) {
    if (mockMode === "error") return json(500, { success: false });
    const id = Number(u.pathname.split("/").pop());
    mockLast.deletedId = id;
    mockStore.delete(id);
    return json(200, { success: true });
  }
  if (req.method === "GET" && /^\/api\/channel\/\d+$/.test(u.pathname)) {
    const id = Number(u.pathname.split("/").pop());
    return json(200, { success: true, data: mockStore.get(id) || {} });
  }
  if (req.method === "PUT" && u.pathname === "/api/channel/") {
    if (mockMode === "error") return json(500, { success: false });
    mockLast.put = JSON.parse((await readBody(req)).toString("utf8"));
    const c = mockStore.get(mockLast.put.id) || { id: mockLast.put.id };
    mockStore.set(mockLast.put.id, { ...c, ...mockLast.put });
    return json(200, { success: true });
  }
  if (req.method === "GET" && u.pathname === "/api/channel/search") {
    return json(200, { success: true, data: { items: [] } });
  }
  return json(404, { success: false });
});

const PORT_A = 5394;
const PORT_B = 5395;
const dataDirA = mkdtempSync(join(tmpdir(), "chsync-a-"));
const dataDirB = mkdtempSync(join(tmpdir(), "chsync-b-"));
let mockBase = "";
let serverA;
let serverB;
let readyA = false;
let readyB = false;

const baseEnv = {
  EVALUATOR_SESSION_SECRET: "test-secret",
  EVALUATOR_ADMIN_PASSWORD: "adminpw",
  EVALUATOR_LOCAL_USERS: "tester:testerpw:10",
  EVALUATOR_SECRET_STORE: "memory",
  EVALUATOR_COOKIE_SECURE: "false",
  HOST: "127.0.0.1",
};
function spawnServer(port, dataDir, extra) {
  return spawn(process.execPath, [join(root, "server.mjs")], {
    env: { ...process.env, ...baseEnv, ...extra, EVALUATOR_DATA_DIR: dataDir, PORT: String(port), API_PORT: String(port) },
    stdio: "ignore",
  });
}
async function waitHealthy(port) {
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return true;
    } catch {
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
async function login(port, u, p) {
  const r = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ username: u, password: p }),
  });
  return (r.headers.get("set-cookie") || "").split(";")[0];
}
function call(port, method, path, cookie, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}`, cookie: cookie || "" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function createChannel(port, cookie, body) {
  const r = await call(port, "POST", "/api/channels", cookie, body);
  assert.equal(r.status, 200, `建渠道失败：${r.status}`);
  return r.json();
}

before(async () => {
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  mockBase = `http://127.0.0.1:${mock.address().port}`;
  serverA = spawnServer(PORT_A, dataDirA, {
    EVALUATOR_NEWAPI_BASE_URL: mockBase,
    EVALUATOR_NEWAPI_IMPORT_TOKEN: "tok-ep",
    EVALUATOR_NEWAPI_USER_ID: "1",
  });
  serverB = spawnServer(PORT_B, dataDirB, {}); // 无 NEWAPI 配置
  readyA = await waitHealthy(PORT_A);
  readyB = await waitHealthy(PORT_B);
});
after(() => {
  serverA?.kill();
  serverB?.kill();
  mock.close();
  for (const dir of [dataDirA, dataDirB]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* best-effort */
    }
  }
});

test("渠道推送（超管）：mock 收到正确体（type/group/key/models），本地回存 newapiChannelId", async () => {
  assert.ok(readyA, "serverA 未就绪");
  mockMode = "ok";
  const admin = await login(PORT_A, "admin", "adminpw");
  const c1 = await createChannel(PORT_A, admin, { name: "内部渠道", provider: "DeepSeek", baseUrl: "https://up1.test", protocol: "openai_compatible", models: "m1,m2", apiKey: "sk-up1" });
  const res = await call(PORT_A, "POST", `/api/channels/${c1.id}/push-to-newapi`, admin);
  assert.equal(res.status, 200);
  const summary = await res.json();
  assert.equal(summary.action, "created");
  // mock 收到的渠道体
  const ch = mockLast.post.channel;
  assert.equal(ch.type, 43, "DeepSeek→43");
  assert.equal(ch.group, "internal_test");
  assert.equal(ch.key, "sk-up1", "带上游 key");
  assert.equal(ch.models, "m1,m2");
  // 本地回存
  const channels = await (await call(PORT_A, "GET", "/api/channels", admin)).json();
  const saved = channels.find((x) => x.id === c1.id);
  assert.equal(saved.newapiChannelId, summary.newapiChannelId);
});

test("渠道推送：管理员(role 10) → 403", async () => {
  const tester = await login(PORT_A, "tester", "testerpw");
  const channels = await (await call(PORT_A, "GET", "/api/channels", await login(PORT_A, "admin", "adminpw"))).json();
  const res = await call(PORT_A, "POST", `/api/channels/${channels[0].id}/push-to-newapi`, tester);
  assert.equal(res.status, 403);
});

test("渠道推送：未登录 → 401", async () => {
  const res = await call(PORT_A, "POST", "/api/channels/whatever/push-to-newapi", "");
  assert.equal(res.status, 401);
});

test("渠道推送：渠道不存在 → 404", async () => {
  const admin = await login(PORT_A, "admin", "adminpw");
  const res = await call(PORT_A, "POST", "/api/channels/does-not-exist/push-to-newapi", admin);
  assert.equal(res.status, 404);
});

test("渠道推送：渠道无 Key → 400 missing_key", async () => {
  const admin = await login(PORT_A, "admin", "adminpw");
  const c2 = await createChannel(PORT_A, admin, { name: "无Key渠道", provider: "OpenAI", baseUrl: "https://up2.test", protocol: "openai_compatible", models: "x" });
  const res = await call(PORT_A, "POST", `/api/channels/${c2.id}/push-to-newapi`, admin);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "missing_key");
});

test("渠道推送：上游故障 → 502", async () => {
  const admin = await login(PORT_A, "admin", "adminpw");
  const channels = await (await call(PORT_A, "GET", "/api/channels", admin)).json();
  const pushed = channels.find((x) => x.newapiChannelId); // 已关联 → 走 PUT
  mockMode = "error";
  const res = await call(PORT_A, "POST", `/api/channels/${pushed.id}/push-to-newapi`, admin);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "newapi_push_failed");
  mockMode = "ok";
});

test("模型推送：所属渠道未推送 → 400 channel_not_pushed", async () => {
  const admin = await login(PORT_A, "admin", "adminpw");
  const c3 = await createChannel(PORT_A, admin, { name: "未推渠道", provider: "OpenAI", baseUrl: "https://up3.test", protocol: "openai_compatible", models: "z", apiKey: "sk-up3" });
  const t = await (await call(PORT_A, "POST", "/api/model-targets", admin, { channelId: c3.id, model: "z" })).json();
  const res = await call(PORT_A, "POST", `/api/model-targets/${t.id}/push-to-newapi`, admin);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "channel_not_pushed");
});

test("模型推送（超管）：加入已推渠道 models + 幂等", async () => {
  const admin = await login(PORT_A, "admin", "adminpw");
  const channels = await (await call(PORT_A, "GET", "/api/channels", admin)).json();
  const pushed = channels.find((x) => x.newapiChannelId);
  const t = await (await call(PORT_A, "POST", "/api/model-targets", admin, { channelId: pushed.id, model: "m3" })).json();
  // 超管首次推送
  const r1 = await call(PORT_A, "POST", `/api/model-targets/${t.id}/push-to-newapi`, admin);
  assert.equal(r1.status, 200);
  const s1 = await r1.json();
  assert.equal(s1.added, true);
  assert.ok(String(mockStore.get(pushed.newapiChannelId).models).split(",").includes("m3"));
  // 幂等
  const s2 = await (await call(PORT_A, "POST", `/api/model-targets/${t.id}/push-to-newapi`, admin)).json();
  assert.equal(s2.added, false);
});

test("模型推送：管理员(role 10) → 403（仅超管可推送模型）", async () => {
  const admin = await login(PORT_A, "admin", "adminpw");
  const tester = await login(PORT_A, "tester", "testerpw");
  const channels = await (await call(PORT_A, "GET", "/api/channels", admin)).json();
  const pushed = channels.find((x) => x.newapiChannelId);
  const t = await (await call(PORT_A, "POST", "/api/model-targets", admin, { channelId: pushed.id, model: "m10" })).json();
  // 管理员维护模型目标(POST)可以，但推送被拒。
  const res = await call(PORT_A, "POST", `/api/model-targets/${t.id}/push-to-newapi`, tester);
  assert.equal(res.status, 403);
});

test("模型推送：目标不存在 → 404", async () => {
  const admin = await login(PORT_A, "admin", "adminpw");
  const res = await call(PORT_A, "POST", "/api/model-targets/nope/push-to-newapi", admin);
  assert.equal(res.status, 404);
});

test("渠道推送：未配置 NEWAPI（serverB）→ 400 newapi_not_configured", async () => {
  assert.ok(readyB, "serverB 未就绪");
  const admin = await login(PORT_B, "admin", "adminpw");
  const c = await createChannel(PORT_B, admin, { name: "B渠道", provider: "OpenAI", baseUrl: "https://b1.test", protocol: "openai_compatible", models: "m", apiKey: "sk-b" });
  const res = await call(PORT_B, "POST", `/api/channels/${c.id}/push-to-newapi`, admin);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "newapi_not_configured");
});

// 推送一个带 key 的渠道，返回 {channel, newapiId}。
async function pushFreshChannel(admin, suffix, models = "k1") {
  const c = await createChannel(PORT_A, admin, { name: `del-${suffix}`, provider: "OpenAI", baseUrl: `https://del-${suffix}.test`, protocol: "openai_compatible", models, apiKey: `sk-${suffix}` });
  const r = await (await call(PORT_A, "POST", `/api/channels/${c.id}/push-to-newapi`, admin)).json();
  return { channel: c, newapiId: r.newapiChannelId };
}

// 超管安全开关「允许删除同步至 new-api」：后端 syncNewapiDelete 据此放行/忽略 ?syncNewapi=1。
async function setDeleteSync(admin, on) {
  const r = await call(PORT_A, "PUT", "/api/settings", admin, { enableDeleteSync: on });
  assert.equal(r.status, 200, "设置 enableDeleteSync 失败");
}

test("删除同步：渠道删除 ?syncNewapi=1 → new-api 收到 DELETE，newapiSynced=true", async () => {
  mockMode = "ok";
  const admin = await login(PORT_A, "admin", "adminpw");
  await setDeleteSync(admin, true);
  const { channel, newapiId } = await pushFreshChannel(admin, "d1");
  assert.ok(mockStore.has(newapiId));
  const res = await call(PORT_A, "DELETE", `/api/channels/${channel.id}?syncNewapi=1`, admin);
  assert.equal(res.status, 200);
  const summary = await res.json();
  assert.equal(summary.newapiSynced, true);
  assert.equal(mockLast.deletedId, newapiId);
  assert.equal(mockStore.has(newapiId), false, "new-api 侧已删");
});

test("删除同步：渠道删除不带 flag → 不调 new-api（本地仍删）", async () => {
  const admin = await login(PORT_A, "admin", "adminpw");
  const { channel, newapiId } = await pushFreshChannel(admin, "d2");
  mockLast.deletedId = undefined;
  const summary = await (await call(PORT_A, "DELETE", `/api/channels/${channel.id}`, admin)).json();
  assert.equal(summary.newapiSynced, undefined, "未请求同步时无 newapiSynced 字段");
  assert.equal(mockLast.deletedId, undefined, "不应调 new-api DELETE");
  assert.equal(mockStore.has(newapiId), true, "new-api 侧仍在");
});

test("删除同步：渠道未推送(?syncNewapi=1) → newapiSynced=false+skipped，本地仍删", async () => {
  const admin = await login(PORT_A, "admin", "adminpw");
  await setDeleteSync(admin, true);
  const c = await createChannel(PORT_A, admin, { name: "del-d3", provider: "OpenAI", baseUrl: "https://del-d3.test", protocol: "openai_compatible", models: "x", apiKey: "sk-d3" });
  const summary = await (await call(PORT_A, "DELETE", `/api/channels/${c.id}?syncNewapi=1`, admin)).json();
  assert.equal(summary.newapiSynced, false);
  assert.ok(summary.newapiSkipped, "应说明未推送跳过");
  const channels = await (await call(PORT_A, "GET", "/api/channels", admin)).json();
  assert.equal(channels.some((x) => x.id === c.id), false, "本地已删");
});

test("删除同步：模型删除 ?syncNewapi=1 → 从 new-api 渠道 models 移除该模型", async () => {
  mockMode = "ok";
  const admin = await login(PORT_A, "admin", "adminpw");
  await setDeleteSync(admin, true);
  const tester = await login(PORT_A, "tester", "testerpw");
  const { channel, newapiId } = await pushFreshChannel(admin, "d4", "k1,k2");
  const t = await (await call(PORT_A, "POST", "/api/model-targets", admin, { channelId: channel.id, model: "k1" })).json();
  const summary = await (await call(PORT_A, "DELETE", `/api/model-targets/${t.id}?syncNewapi=1`, tester)).json();
  assert.equal(summary.newapiSynced, true);
  assert.equal(mockStore.get(newapiId).models, "k2", "new-api 渠道 models 去掉 k1");
});

test("删除同步：模型所属渠道未推送(?syncNewapi=1) → newapiSynced=false+skipped，本地仍删", async () => {
  const admin = await login(PORT_A, "admin", "adminpw");
  await setDeleteSync(admin, true);
  const c = await createChannel(PORT_A, admin, { name: "del-d5", provider: "OpenAI", baseUrl: "https://del-d5.test", protocol: "openai_compatible", models: "z", apiKey: "sk-d5" });
  const t = await (await call(PORT_A, "POST", "/api/model-targets", admin, { channelId: c.id, model: "z" })).json();
  const summary = await (await call(PORT_A, "DELETE", `/api/model-targets/${t.id}?syncNewapi=1`, admin)).json();
  assert.equal(summary.newapiSynced, false);
  assert.ok(summary.newapiSkipped);
});

test("删除同步：开关关闭时后端强制忽略 ?syncNewapi=1（绝不连带删 new-api）", async () => {
  mockMode = "ok";
  const admin = await login(PORT_A, "admin", "adminpw");
  await setDeleteSync(admin, false); // 超管关掉安全开关
  const { channel, newapiId } = await pushFreshChannel(admin, "off1");
  assert.ok(mockStore.has(newapiId), "new-api 侧已存在该渠道");
  mockLast.deletedId = undefined;
  const summary = await (await call(PORT_A, "DELETE", `/api/channels/${channel.id}?syncNewapi=1`, admin)).json();
  assert.equal(summary.newapiSynced, undefined, "开关关 → 后端忽略 syncNewapi，无同步字段");
  assert.equal(mockLast.deletedId, undefined, "绝不调 new-api DELETE");
  assert.equal(mockStore.has(newapiId), true, "new-api 侧仍在");
  // 本地确已删（仅本地删生效）。
  const channels = await (await call(PORT_A, "GET", "/api/channels", admin)).json();
  assert.equal(channels.some((x) => x.id === channel.id), false, "本地已删");
});
