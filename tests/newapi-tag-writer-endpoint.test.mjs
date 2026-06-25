// tests/newapi-tag-writer-endpoint.test.mjs
// 端点集成：真起 server.mjs 子进程，验证 POST /api/model-targets/push-tags 的聚合/鉴权/故障映射。
// - serverA：配置 NEWAPI 指向进程内 mock new-api，seed 同名模型多渠道带标签的 model-target。
// - serverB：不配置 NEWAPI（验证 400 not_configured）。
// 范式参考 tests/server-auth.test.mjs（spawn + 轮询健康 + 登录拿 cookie）。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test, { before, after } from "node:test";

import { saveModelTargets, closeDatabase } from "../server/db.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// —— 进程内 mock new-api：可切换正常/故障，记录 PUT 收到的 tags ——
let mockMode = "ok"; // "ok" | "get500"
const putByModel = {}; // model_name -> 最后一次写入的 tags 字符串
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
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, data: { items: [{ id: 1, model_name: "gpt-4o", tags: "", status: 1 }], total: 1 } }));
    return;
  }
  if (req.method === "PUT" && u.pathname === "/api/models/") {
    const body = JSON.parse((await readBody(req)).toString("utf8"));
    putByModel[body.model_name] = body.tags;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }
  res.writeHead(404);
  res.end("nope");
});

const PORT_A = 5398;
const PORT_B = 5399;
const dataDirA = mkdtempSync(join(tmpdir(), "tagwriter-ep-a-"));
const dataDirB = mkdtempSync(join(tmpdir(), "tagwriter-ep-b-"));
let mockBase = "";
let serverA;
let serverB;

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

let readyA = false;
let readyB = false;

before(async () => {
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  mockBase = `http://127.0.0.1:${mock.address().port}`;

  // seed：同名模型 gpt-4o 的两个渠道目标，各带不同标签 → 端点应取并集。
  const seed = [
    { id: "t1", channelId: "c1", model: "gpt-4o", tags: ["对话", "推荐"] },
    { id: "t2", channelId: "c2", model: "gpt-4o", tags: ["推荐", "长上下文"] },
    { id: "t3", channelId: "c3", model: "no-tags", tags: [] }, // 无标签：不参与
  ];
  await saveModelTargets(seed, { path: join(dataDirA, "evaluator.db") });
  closeDatabase(join(dataDirA, "evaluator.db")); // 释放 WAL 锁，子进程独占

  // serverB seed 同样有标签的目标，但不配置 NEWAPI。
  await saveModelTargets(seed, { path: join(dataDirB, "evaluator.db") });
  closeDatabase(join(dataDirB, "evaluator.db"));

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
  // 尽力清理临时库目录：Windows 上子进程刚被 kill 仍可能短暂持有 evaluator.db(-wal/-shm)，
  // rmSync 偶发 EPERM/EBUSY，与被测逻辑无关，吞掉避免误报测试失败。
  for (const dir of [dataDirA, dataDirB]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* best-effort temp cleanup */
    }
  }
});

test("聚合并集：同名模型多渠道 tags 取并集后写回 new-api", async () => {
  assert.ok(readyA, "serverA 未就绪");
  mockMode = "ok";
  const cookie = await login(PORT_A, "tester", "testerpw"); // role 10
  assert.ok(cookie, "登录失败");
  const res = await post(PORT_A, "/api/model-targets/push-tags", cookie);
  assert.equal(res.status, 200);
  const summary = await res.json();
  assert.equal(summary.configured, true);
  assert.equal(summary.matched, 1, "仅 gpt-4o 匹配（no-tags 无标签不推）");
  assert.equal(summary.updated, 1);
  // mock 收到的并集（顺序：t1 先→对话,推荐，再并入 t2 的长上下文）。
  assert.equal(putByModel["gpt-4o"], "对话,推荐,长上下文");
});

test("未登录 → 401", async () => {
  assert.ok(readyA);
  const res = await post(PORT_A, "/api/model-targets/push-tags", "");
  assert.equal(res.status, 401);
});

test("上游 GET 故障 → 端点 502 newapi_push_failed", async () => {
  assert.ok(readyA);
  mockMode = "get500";
  const cookie = await login(PORT_A, "tester", "testerpw");
  const res = await post(PORT_A, "/api/model-targets/push-tags", cookie);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "newapi_push_failed");
  mockMode = "ok";
});

test("未配置 NEWAPI → 400 newapi_not_configured", async () => {
  assert.ok(readyB, "serverB 未就绪");
  const cookie = await login(PORT_B, "tester", "testerpw");
  const res = await post(PORT_B, "/api/model-targets/push-tags", cookie);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "newapi_not_configured");
});

test("无任何带标签目标 → 200 且 note 早返回，不触上游", async () => {
  assert.ok(readyA);
  const cookie = await login(PORT_A, "tester", "testerpw");
  // 删掉 serverA 全部 model-target（DELETE 按 id），使聚合为空。
  for (const id of ["t1", "t2", "t3"]) {
    await fetch(`http://127.0.0.1:${PORT_A}/api/model-targets/${id}`, {
      method: "DELETE",
      headers: { origin: `http://127.0.0.1:${PORT_A}`, cookie },
    });
  }
  const before = JSON.stringify(putByModel);
  const res = await post(PORT_A, "/api/model-targets/push-tags", cookie);
  assert.equal(res.status, 200);
  const summary = await res.json();
  assert.match(summary.note || "", /没有已授予标签/);
  assert.equal(JSON.stringify(putByModel), before, "note 早返回不应再写上游");
});
