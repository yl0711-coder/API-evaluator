// tests/task-detail-endpoint.test.mjs
// 端点集成：真起 server.mjs 子进程，验证 GET /api/tasks/:id 能查到【只存在于事件日志】的任务
// ——即任务落定满 1 小时被逐出内存、或程序重启后的场景。任务中心的明细页全靠这条回退。
//
// 为什么必须是端点级测试：data-store 的 readTaskDetail(taskId, taskMap, publicTask) 有三个参数，
// 而 server.mjs 里少传后两个也照样能通过所有单元测试——直到运行时 taskMap.get() 抛 TypeError → 500。
// 这类「接线错误」只有真发一次 HTTP 请求才抓得到。范式照搬 tests/auto-test-digest-endpoint.test.mjs。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test, { before, after } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 5396; // 避开其它端点测试占用的 5386-5395（并发跑时端口撞了会一起失败）
const dataDir = mkdtempSync(join(tmpdir(), "task-detail-endpoint-"));
let server;
let ready = false;
let cookie = "";

const baseEnv = {
  EVALUATOR_SESSION_SECRET: "test-secret-0123456789abcdef-32b+",
  EVALUATOR_ADMIN_PASSWORD: "adminpw",
  EVALUATOR_SECRET_STORE: "memory",
  EVALUATOR_COOKIE_SECURE: "false",
  HOST: "127.0.0.1",
};

// 预置事件日志：两个任务都【不】在内存里（服务器刚启动，内存 Map 是空的），
// 正是「昨天跑完的任务」与「上次运行中途被 kill 的任务」两种真实场景。
const EVENTS = [
  {
    taskId: "task-finished",
    type: "admission-suite",
    event: "started",
    status: "running",
    loggedAt: "2026-08-04T10:00:00.000Z",
    payload: { profileIds: ["p-1"], modelNames: ["claude-sonnet-5"] },
  },
  {
    taskId: "task-finished",
    type: "admission-suite",
    event: "completed",
    status: "completed",
    progress: 100,
    loggedAt: "2026-08-04T10:08:00.000Z",
    steps: [
      {
        groupKey: "p-1",
        groupLabel: "渠道A / sonnet",
        stepName: "quick",
        stepLabel: "快速测试",
        executionStatus: "completed",
        verdict: "passed",
      },
      {
        groupKey: "p-1",
        groupLabel: "渠道A / sonnet",
        stepName: "admission",
        stepLabel: "标准准入",
        executionStatus: "completed",
        verdict: "not_passed",
      },
    ],
  },
  {
    taskId: "task-zombie",
    type: "stability",
    event: "started",
    status: "running",
    loggedAt: "2026-08-04T11:00:00.000Z",
    payload: { profileId: "p-2" },
  },
];

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

async function get(path, ck) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    headers: { origin: `http://127.0.0.1:${PORT}`, cookie: ck || "" },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

before(async () => {
  // 事件日志所在目录须与 server/paths.mjs 的布局一致（评测数据/日志/task-events.jsonl）。
  mkdirSync(join(dataDir, "日志"), { recursive: true });
  writeFileSync(join(dataDir, "日志", "task-events.jsonl"), EVENTS.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf8");
  server = spawn(process.execPath, [join(root, "server.mjs")], {
    env: { ...process.env, ...baseEnv, EVALUATOR_DATA_DIR: dataDir, PORT: String(PORT) },
    stdio: "ignore",
  });
  ready = await waitHealthy();
  if (ready) cookie = await login();
});

after(() => {
  server?.kill();
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* best-effort */
  }
});

test("未登录取任务明细 → 401", async () => {
  assert.ok(ready, "server 未就绪");
  const r = await get("/api/tasks/task-finished", "");
  assert.equal(r.status, 401);
});

test("内存里没有的已完成任务 → 200，且带回 steps 与 payload（不是 404/500）", async () => {
  const r = await get("/api/tasks/task-finished", cookie);
  // 500 = server.mjs 少传了 taskMap/publicTask；404 = 回退没接上。两者都是真实发生过的接线错误。
  assert.equal(r.status, 200, `期望 200，实为 ${r.status}：${JSON.stringify(r.body)}`);
  assert.equal(r.body.status, "completed");
  assert.equal(r.body.steps.length, 2, "逐步骤明细必须回得来，这正是任务中心明细页要画的东西");
  assert.equal(r.body.steps[1].verdict, "not_passed", "「跑完了但没通过」不能被抹成通过");
  assert.deepEqual(r.body.payload.profileIds, ["p-1"], "payload 供「再测一次」回填表单");
});

test("上次运行中途被 kill 的任务 → 改判 interrupted，而不是永远「运行中」", async () => {
  const r = await get("/api/tasks/task-zombie", cookie);
  assert.equal(r.status, 200, `期望 200，实为 ${r.status}：${JSON.stringify(r.body)}`);
  assert.equal(r.body.status, "interrupted");
  assert.equal(r.body.recoverable, false);
});

test("不存在的任务 → 404（且带可读文案）", async () => {
  const r = await get("/api/tasks/no-such-task", cookie);
  assert.equal(r.status, 404);
  assert.equal(r.body.error, "task_not_found");
});

test("/api/tasks/recent 排在 /api/tasks/:id 之前，不会被当成 id=recent", async () => {
  const r = await get("/api/tasks/recent", cookie);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body), "recent 必须返回数组；若被 :id 规则截获会返回单个对象或 404");
  assert.equal(r.body.length, 2, "两个任务各折叠成一条");
  assert.ok(
    r.body.every((task) => task.steps === undefined),
    "列表刻意不带 steps（30 任务 × 20 步会把响应撑到几百 KB）",
  );
});

// 接线：会话里的用户名要真的到达 task-manager。单元测试里 createTask 的第三个参数怎么传都对，
// 只有真发一次 HTTP 才能证明 server.mjs 确实从 req.session 取到了它——readTaskDetail 那次
// 少传两个参数的 500 就是这么漏过去的。
test("创建任务时把会话用户名记为发起人（不靠前端上报）", async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${PORT}`, cookie },
    body: JSON.stringify({ type: "stability", payload: { profileId: "p-nonexistent", rounds: 1 } }),
  });
  assert.equal(r.status, 202, `期望 202，实为 ${r.status}`);
  const body = await r.json();
  // 登录用的就是 admin；发起人必须来自服务端会话，前端说自己是谁一概不算。
  assert.equal(body.createdBy, "admin", "发起人应取自会话；为 null 说明 server.mjs 没把 actor 传下去");
  assert.equal(body.cancelledBy, null);
  // 任务本身会因为 profileId 不存在而失败，与本用例无关——这里只验身份接线。
});
