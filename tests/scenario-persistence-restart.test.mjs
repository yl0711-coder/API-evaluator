// tests/scenario-persistence-restart.test.mjs
// 场景「提示词改动」持久化的最高保真验证：真起 server.mjs 子进程 → 经 /api/dev 编辑/新增/删除场景
// → 断言覆盖层落到 EVALUATOR_DATA_DIR/配置（= Docker /data 卷）→ 杀进程 → 用【同一 dataDir】重起
// → 编辑仍在。等价模拟 docker restart / 换镜像重部署（新进程只继承 /data 卷）。
// 范式照搬 tests/dev-scenarios-endpoint.test.mjs，但把 server 起两次。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test, { after } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 5388; // 避开其它端点测试占用的 5391-5399
const dataDir = mkdtempSync(join(tmpdir(), "scn-restart-"));
const overlayFile = join(dataDir, "配置", "scenario-overrides.json");
const MARK = "RESTART-PERSIST-标记-δ"; // 编辑后的提示词内容，重起后据此判定持久

const baseEnv = {
  EVALUATOR_SESSION_SECRET: "test-secret",
  EVALUATOR_ADMIN_PASSWORD: "adminpw",
  EVALUATOR_SECRET_STORE: "memory",
  EVALUATOR_COOKIE_SECURE: "false",
  HOST: "127.0.0.1",
};

let server = null;

function spawnServer() {
  server = spawn(process.execPath, [join(root, "server.mjs")], {
    env: { ...process.env, ...baseEnv, EVALUATOR_DATA_DIR: dataDir, PORT: String(PORT) },
    stdio: "ignore",
  });
  return server;
}
async function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  s.kill();
  if (s.exitCode === null && s.signalCode === null) await once(s, "exit");
}
async function waitHealthy() {
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
async function login() {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${PORT}` },
    body: JSON.stringify({ username: "admin", password: "adminpw" }),
  });
  return (r.headers.get("set-cookie") || "").split(";")[0];
}
async function get(path, cookie) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { origin: `http://127.0.0.1:${PORT}`, cookie } });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function send(method, path, cookie, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${PORT}`, cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

after(async () => {
  try {
    await stopServer();
  } catch {
    /* already gone */
  }
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* best-effort：Windows 上子进程刚 kill 时 SQLite 文件可能短暂占用 */
  }
});

test("提示词编辑/新增/删除跨真实进程重启仍持久（Docker restart/重部署等价）", async () => {
  // —— 启动 #1 ——
  spawnServer();
  assert.ok(await waitHealthy(), "server #1 未就绪");
  let cookie = await login();
  assert.ok(cookie, "登录失败");

  // 选两条内置题：B 用来改提示词，D 用来删除（内置 → 留墓碑）。
  const list0 = await get("/api/dev/scenarios", cookie);
  assert.equal(list0.status, 200);
  const builtins = list0.body.filter((s) => s.bankKey === "basic");
  assert.ok(builtins.length >= 2, "需要至少两条内置 basic 题");
  const B = builtins[0];
  const D = builtins[1];

  // 三种写改动（覆盖提示词编辑核心路径）。
  const put = await send("PUT", `/api/dev/scenarios/${encodeURIComponent(B.id)}`, cookie, {
    name: B.name,
    category: B.category,
    difficulty: B.difficulty,
    prompt: MARK,
  });
  assert.equal(put.status, 200, "PUT 编辑提示词应成功");
  const created = await send("POST", "/api/dev/scenarios", cookie, {
    id: "restart-new",
    name: "重启新增题",
    category: "basic",
    difficulty: "small",
    prompt: "NEW-PERSIST",
  });
  assert.equal(created.status, 200, "POST 新增应成功");
  const deleted = await send("DELETE", `/api/dev/scenarios/${encodeURIComponent(D.id)}`, cookie);
  assert.equal(deleted.status, 200, "DELETE 应成功");

  // —— 落卷断言：覆盖层写到 EVALUATOR_DATA_DIR/配置 下（Docker 的持久卷路径）——
  assert.ok(existsSync(overlayFile), "覆盖层 JSON 应落在 dataDir/配置 下");
  const saved = JSON.parse(readFileSync(overlayFile, "utf8"));
  assert.equal(saved.upserts[B.id].prompt, MARK, "编辑后的提示词进覆盖层 upserts");
  assert.ok(saved.upserts["restart-new"], "新增题进 upserts");
  assert.ok(saved.deletes.includes(D.id), "删除的内置题进 deletes 墓碑");

  // —— 重启：杀 #1，用同一 dataDir 起 #2 ——
  await stopServer();
  spawnServer();
  assert.ok(await waitHealthy(), "server #2 未就绪");
  cookie = await login();

  // —— 重启后断言：编辑/新增仍在，删除仍删 ——
  const list1 = await get("/api/dev/scenarios", cookie);
  assert.equal(list1.status, 200);
  const afterB = list1.body.find((s) => s.id === B.id);
  assert.ok(afterB, "被编辑的内置题重启后仍在");
  assert.equal(afterB.prompt, MARK, "重启后提示词编辑仍持久");
  assert.ok(list1.body.some((s) => s.id === "restart-new" && s.prompt === "NEW-PERSIST"), "重启后新增题仍在");
  assert.equal(list1.body.some((s) => s.id === D.id), false, "重启后被删内置题仍不在（墓碑生效）");
});
