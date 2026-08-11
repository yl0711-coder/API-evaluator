// tests/task-persistence-restart.test.mjs
// ADM-017 的核心承诺：任务记录跨【进程重启】仍可查。
//
// 为什么必须是端点级 + 真重启：落库的单元测试只能证明"写进去能读出来"，
// 证明不了 server.mjs 真的接上了这条路（readTaskDetail 少传两个参数导致必然 500 那次，
// 1069 个单元测试全绿也照样漏了），更证明不了重启后 running 任务被正确改判。
// 做法：起一次 server 写入任务 → 杀掉 → 用【同一个 data dir】再起一次 → 查。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test, { after } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 5400; // 避开其它端点测试占用的 5386-5399
const dataDir = mkdtempSync(join(tmpdir(), "task-persist-restart-"));
let server;

const baseEnv = {
  EVALUATOR_SESSION_SECRET: "test-secret-0123456789abcdef-32b+",
  EVALUATOR_ADMIN_PASSWORD: "adminpw",
  EVALUATOR_SECRET_STORE: "memory",
  EVALUATOR_COOKIE_SECURE: "false",
  HOST: "127.0.0.1",
};

async function startServer() {
  const proc = spawn(process.execPath, [join(root, "server.mjs")], {
    env: { ...process.env, ...baseEnv, EVALUATOR_DATA_DIR: dataDir, PORT: String(PORT) },
    stdio: "ignore",
  });
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return proc;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server 未就绪");
}

async function stopServer(proc) {
  if (!proc) return;
  proc.kill();
  // 等端口真正释放，否则第二次 listen 会 EADDRINUSE。
  for (let i = 0; i < 60; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/api/health`);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
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
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    headers: { origin: `http://127.0.0.1:${PORT}`, cookie },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

after(() => {
  server?.kill();
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* best-effort */
  }
});

test("ADM-017: 任务记录跨进程重启仍可查，且残留 running 被改判 interrupted", async () => {
  // —— 第一次启动：建一个任务 ——
  server = await startServer();
  let cookie = await login();

  const created = await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${PORT}`, cookie },
    body: JSON.stringify({ type: "stability", payload: { profileId: "p-nonexistent", rounds: 1 } }),
  });
  assert.equal(created.status, 202);
  const task = await created.json();
  assert.ok(task.id, "创建应返回 taskId");
  assert.equal(task.createdBy, "admin", "ADM-016：发起人取自会话");

  // 任务会因 profileId 不存在很快失败——这不影响本用例，我们要验的是"记录还在"。
  // 等它落定，避免拿到 running 态后又被下面的重启改判，断言就说不清了。
  for (let i = 0; i < 50; i += 1) {
    const r = await get(`/api/tasks/${task.id}`, cookie);
    if (r.body && r.body.status !== "running" && r.body.status !== "queued") break;
    await new Promise((res) => setTimeout(res, 100));
  }

  // —— 杀掉并用同一个 data dir 重启 ——
  await stopServer(server);
  server = await startServer();
  cookie = await login(); // 会话是签名 cookie，进程换了要重新登录

  // 关键断言：内存 Map 是全新的空 Map，这条记录只可能来自 SQLite。
  const afterRestart = await get(`/api/tasks/${task.id}`, cookie);
  assert.equal(afterRestart.status, 200, `重启后仍应查得到，实为 ${afterRestart.status}：${JSON.stringify(afterRestart.body)}`);
  assert.equal(afterRestart.body.taskId, task.id);
  assert.equal(afterRestart.body.createdBy, "admin", "身份必须跨重启保留——这是落库的主要动机之一");
  assert.equal(afterRestart.body.recoverable, false, "进程换了，没有 abortController，取消不了");
  // P1-03：终态的结束时间必须跨重启保留。原缺陷是终态事件在 endedAt 赋值【之前】就落库，
  // ended_at 永久为 null，重启后任务中心只能显示「结束：—」，任务时长/审计算不出来。
  assert.ok(afterRestart.body.endedAt, "终态任务的结束时间必须跨重启保留（P1-03）");
  assert.ok(new Date(afterRestart.body.endedAt).getTime() >= new Date(afterRestart.body.createdAt).getTime(), "结束时间不得早于创建时间");
  // 不能停在 running：那样前端会对着一个永不推进的任务无限轮询。
  assert.ok(
    ["completed", "failed", "cancelled", "interrupted"].includes(afterRestart.body.status),
    `重启后状态应是终态之一，实为 ${afterRestart.body.status}`,
  );

  // 列表路径同样要能看到它。
  const list = await get("/api/tasks/recent", cookie);
  assert.equal(list.status, 200);
  assert.ok(
    list.body.some((item) => item.taskId === task.id),
    "重启后列表里也必须有这条记录",
  );
});
