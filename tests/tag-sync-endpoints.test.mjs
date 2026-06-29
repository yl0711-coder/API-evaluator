// tests/tag-sync-endpoints.test.mjs
// 端点集成：真起 server.mjs 子进程 + 进程内 mock new-api，验证「标签同步/推送」端点的状态机：
//   - POST /api/model-targets/:id/sync-tags        覆盖式同步、全橙、同名统一
//   - POST /api/model-targets/sync-all-tags        全量覆盖式同步
//   - POST /api/model-targets/:id/remove-tag       橙→灰、黄→消失、同名统一
//   - POST /api/model-targets                       保存/编辑后同名统一
//   - POST /api/model-targets/push-tags            推送成功后本地标橙（黄→橙）
//   - 未配置 NEWAPI→400、上游故障→502、未登录→401
// 三态读回：GET /api/model-targets 返回 tags/pushedTags/removedTags。
// 范式照搬 tests/newapi-tag-writer-endpoint.test.mjs。
//
// 测试顺序敏感：push-tags / sync-all-tags 为全局操作（影响所有目标），排在逐目标用例之后。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test, { before, after } from "node:test";

import { saveModelTargets, saveChannels, closeDatabase } from "../server/db.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// —— 进程内 mock new-api：GET 返回可配置模型列表、PUT 记录写入、可切换 GET 故障 ——
let mockMode = "ok"; // "ok" | "get500"
let mockModels = []; // [{ id, model_name, tags(逗号串), status }]
const putByModel = {};
function readBody(req) {
  return new Promise((r) => {
    const c = [];
    req.on("data", (d) => c.push(d));
    req.on("end", () => r(Buffer.concat(c)));
  });
}
const mock = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.method === "GET" && u.pathname === "/api/models/") {
    if (mockMode === "get500") {
      res.writeHead(500);
      res.end("upstream-down");
      return;
    }
    const p = Number(u.searchParams.get("p") || 1);
    const items = mockModels.slice((p - 1) * 100, (p - 1) * 100 + 100);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, data: { items, total: mockModels.length } }));
    return;
  }
  if (req.method === "PUT" && u.pathname === "/api/models/") {
    const body = JSON.parse((await readBody(req)).toString("utf8"));
    putByModel[body.model_name] = body.tags;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }
  // —— addModelToNewapiChannel 用：读渠道整条 → PUT 并入 models ——
  if (req.method === "GET" && /^\/api\/channel\/\d+$/.test(u.pathname)) {
    const id = Number(u.pathname.split("/").pop());
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, data: { id, models: "" } }));
    return;
  }
  if (req.method === "PUT" && u.pathname === "/api/channel/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }
  res.writeHead(404);
  res.end("nope");
});

const PORT_A = 5396; // 配置 NEWAPI
const PORT_B = 5397; // 不配 NEWAPI（避开其它端点测试占用的 5394/5395/5398/5399）
const dataDirA = mkdtempSync(join(tmpdir(), "tagsync-a-"));
const dataDirB = mkdtempSync(join(tmpdir(), "tagsync-b-"));
let mockBase = "";
let serverA;
let serverB;
let readyA = false;
let readyB = false;
let cookieA = "";

const baseEnv = {
  EVALUATOR_SESSION_SECRET: "test-secret",
  EVALUATOR_ADMIN_PASSWORD: "adminpw",
  EVALUATOR_LOCAL_USERS: "tester:testerpw:10",
  EVALUATOR_SECRET_STORE: "memory",
  EVALUATOR_COOKIE_SECURE: "false",
  HOST: "127.0.0.1",
};

function spawnServer(port, dataDir, extraEnv) {
  return spawn(process.execPath, [join(root, "server.mjs")], {
    env: { ...process.env, ...baseEnv, ...extraEnv, EVALUATOR_DATA_DIR: dataDir, PORT: String(port) },
    stdio: "ignore",
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
async function login(port, username, password) {
  const r = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ username, password }),
  });
  return (r.headers.get("set-cookie") || "").split(";")[0];
}
async function post(port, path, cookie, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}`, cookie },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
}
async function getTargets(port, cookie) {
  const r = await fetch(`http://127.0.0.1:${port}/api/model-targets`, {
    headers: { origin: `http://127.0.0.1:${port}`, cookie },
  });
  return r.json();
}
const find = (arr, id) => arr.find((t) => t.id === id);

before(async () => {
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  mockBase = `http://127.0.0.1:${mock.address().port}`;

  const channels = [
    { id: "c1", name: "C1", baseUrl: "https://c1.test", protocol: "openai_compatible", provider: "", models: [], status: "enabled", source: "manual" },
    { id: "c2", name: "C2", baseUrl: "https://c2.test", protocol: "openai_compatible", provider: "", models: [], status: "enabled", source: "manual" },
    // 已推送到 new-api 的渠道（带 newapiChannelId）→ 供「卡片推送」端到端测试。
    { id: "cpush", name: "CPush", baseUrl: "https://cpush.test", protocol: "openai_compatible", provider: "", models: [], status: "enabled", source: "newapi", newapiChannelId: 2000 },
  ];
  // 各用例使用互不相同的 model 名，避免逐目标用例间互相影响。
  const seed = [
    // sync-tags 覆盖+统一：同名 sync-m 挂 c1/c2，标签各异。
    { id: "s1", channelId: "c1", model: "sync-m", tags: ["A", "本地多"], pushedTags: ["A"], removedTags: [] },
    { id: "s2", channelId: "c2", model: "sync-m", tags: ["X"], pushedTags: [], removedTags: [] },
    // remove-tag 橙→灰
    { id: "ro", channelId: "c1", model: "rm-orange", tags: ["O"], pushedTags: ["O"], removedTags: [] },
    // remove-tag 黄→消失
    { id: "ry", channelId: "c1", model: "rm-yellow", tags: ["Y"], pushedTags: [], removedTags: [] },
    // save 同名统一：同名 save-m 挂 c1/c2
    { id: "sv1", channelId: "c1", model: "save-m", tags: [], pushedTags: [], removedTags: [] },
    { id: "sv2", channelId: "c2", model: "save-m", tags: ["old"], pushedTags: [], removedTags: [] },
    // push-tags 标橙：push-m 初始为黄
    { id: "pm", channelId: "c1", model: "push-m", tags: ["P"], pushedTags: [], removedTags: [] },
    // 卡片推送：cpush 渠道（已推 new-api）下带明黄标签的模型
    { id: "cp", channelId: "cpush", model: "card-push-m", tags: ["CP"], pushedTags: [], removedTags: [] },
  ];
  await saveChannels(channels, { path: join(dataDirA, "evaluator.db") });
  await saveModelTargets(seed, { path: join(dataDirA, "evaluator.db") });
  closeDatabase(join(dataDirA, "evaluator.db"));

  await saveModelTargets([{ id: "b1", channelId: "c1", model: "m", tags: ["A"], pushedTags: [], removedTags: [] }], { path: join(dataDirB, "evaluator.db") });
  closeDatabase(join(dataDirB, "evaluator.db"));

  serverA = spawnServer(PORT_A, dataDirA, {
    EVALUATOR_NEWAPI_BASE_URL: mockBase,
    EVALUATOR_NEWAPI_IMPORT_TOKEN: "tok-ep",
    EVALUATOR_NEWAPI_USER_ID: "1",
  });
  serverB = spawnServer(PORT_B, dataDirB, {}); // 不配 NEWAPI
  readyA = await waitHealthy(PORT_A);
  readyB = await waitHealthy(PORT_B);
  if (readyA) cookieA = await login(PORT_A, "tester", "testerpw");
});

after(() => {
  serverA?.kill();
  serverB?.kill();
  mock.close();
  for (const dir of [dataDirA, dataDirB]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* best-effort temp cleanup（Windows 上子进程刚 kill 可能短暂持有 db 文件）*/
    }
  }
});

// ===================== 逐目标用例（先跑）=====================

test("sync-tags：橙以 new-api 为准、保留本地明黄，并同名统一", async () => {
  assert.ok(readyA, "serverA 未就绪");
  mockMode = "ok";
  mockModels = [{ id: 1, model_name: "sync-m", tags: "A,B", status: 1 }];
  // 种子 s1：tags=["A","本地多"]、pushedTags=["A"] → A 橙、本地多 明黄。
  const res = await post(PORT_A, "/api/model-targets/s1/sync-tags", cookieA);
  assert.equal(res.status, 200, await res.text().catch(() => ""));
  const targets = await getTargets(PORT_A, cookieA);
  const s1 = find(targets, "s1");
  const s2 = find(targets, "s2");
  assert.deepEqual(s1.tags, ["A", "B", "本地多"], "new-api 的 A/B 为橙，本地明黄「本地多」保留");
  assert.deepEqual(s1.pushedTags, ["A", "B"], "只有 new-api 标签为橙");
  assert.deepEqual(s1.removedTags, []);
  assert.deepEqual(s2.tags, ["A", "B", "本地多"], "同名 s2 完全统一");
  assert.deepEqual(s2.pushedTags, ["A", "B"], "同名 s2 也只有 A/B 为橙");
});

test("remove-tag：删橙标签 → 转灰名单（且同名统一）", async () => {
  const res = await post(PORT_A, "/api/model-targets/ro/remove-tag", cookieA, { tag: "O" });
  assert.equal(res.status, 200);
  const ro = find(await getTargets(PORT_A, cookieA), "ro");
  assert.deepEqual(ro.tags, [], "O 离开存活标签");
  assert.deepEqual(ro.pushedTags, []);
  assert.deepEqual(ro.removedTags, ["O"], "橙标签删除 → 变灰提示");
});

test("remove-tag：删黄标签 → 彻底消失、不进灰名单", async () => {
  const res = await post(PORT_A, "/api/model-targets/ry/remove-tag", cookieA, { tag: "Y" });
  assert.equal(res.status, 200);
  const ry = find(await getTargets(PORT_A, cookieA), "ry");
  assert.deepEqual(ry.tags, []);
  assert.deepEqual(ry.pushedTags, []);
  assert.deepEqual(ry.removedTags, [], "黄标签未推送过 → 直接消失，不留灰");
});

test("save：编辑模型标签后同名模型完全统一", async () => {
  const res = await post(PORT_A, "/api/model-targets", cookieA, { id: "sv1", channelId: "c1", model: "save-m", tags: ["NEW"] });
  assert.equal(res.status, 200, await res.text().catch(() => ""));
  const targets = await getTargets(PORT_A, cookieA);
  const sv1 = find(targets, "sv1");
  const sv2 = find(targets, "sv2");
  assert.deepEqual(sv1.tags, ["NEW"]);
  assert.deepEqual(sv1.pushedTags, [], "新勾选 → 黄");
  assert.deepEqual(sv2.tags, ["NEW"], "同名 sv2 镜像一致（原 old 被覆盖）");
  assert.deepEqual(sv2.pushedTags, []);
  assert.deepEqual(sv2.removedTags, []);
});

test("卡片推送：并入渠道 models 的同时推送该模型标签、本地黄→橙", async () => {
  mockMode = "ok";
  mockModels = [{ id: 9, model_name: "card-push-m", tags: "", status: 1 }];
  delete putByModel["card-push-m"];
  const res = await post(PORT_A, "/api/model-targets/cp/push-to-newapi", cookieA);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok(body.tagSummary, "返回里含标签推送结果 tagSummary");
  assert.equal(putByModel["card-push-m"], "CP", "该模型标签 CP 被写入 new-api 模型广场");
  const cp = find(await getTargets(PORT_A, cookieA), "cp");
  assert.deepEqual(cp.tags, ["CP"]);
  assert.deepEqual(cp.pushedTags, ["CP"], "推送后由黄转橙");
});

test("push-tags：推送成功后本地标签由黄转橙", async () => {
  mockMode = "ok";
  mockModels = [{ id: 1, model_name: "push-m", tags: "", status: 1 }];
  const res = await post(PORT_A, "/api/model-targets/push-tags", cookieA);
  assert.equal(res.status, 200);
  const pm = find(await getTargets(PORT_A, cookieA), "pm");
  assert.ok(pm.pushedTags.includes("P"), "push-m 的标签 P 推送后标橙");
  assert.deepEqual(pm.tags, ["P"]);
});

test("sync-all-tags：全量覆盖式同步（命中模型变 new-api 标签、全橙）", async () => {
  mockMode = "ok";
  mockModels = [{ id: 1, model_name: "push-m", tags: "P,Q", status: 1 }];
  const res = await post(PORT_A, "/api/model-targets/sync-all-tags", cookieA);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.ok);
  const pm = find(await getTargets(PORT_A, cookieA), "pm");
  assert.deepEqual(pm.tags, ["P", "Q"], "push-m 覆盖为 new-api 标签");
  assert.deepEqual(pm.pushedTags, ["P", "Q"], "全橙");
});

// ===================== 故障 / 鉴权 =====================

test("sync-tags：未配置 NEWAPI → 400 newapi_not_configured", async () => {
  assert.ok(readyB, "serverB 未就绪");
  const cookieB = await login(PORT_B, "tester", "testerpw");
  const res = await post(PORT_B, "/api/model-targets/b1/sync-tags", cookieB);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "newapi_not_configured");
});

test("sync-all-tags：未配置 NEWAPI → 400", async () => {
  const cookieB = await login(PORT_B, "tester", "testerpw");
  const res = await post(PORT_B, "/api/model-targets/sync-all-tags", cookieB);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "newapi_not_configured");
});

test("sync-tags：上游 GET 故障 → 502 newapi_sync_failed", async () => {
  mockMode = "get500";
  const res = await post(PORT_A, "/api/model-targets/s1/sync-tags", cookieA);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "newapi_sync_failed");
  mockMode = "ok";
});

test("未登录访问 sync-tags → 401", async () => {
  const res = await post(PORT_A, "/api/model-targets/s1/sync-tags", "");
  assert.equal(res.status, 401);
});
