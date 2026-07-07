// tests/persistence-smoke.test.mjs
// 上线前持久化冒烟：真起 server.mjs → 经 API 写入【所有持久化面】（渠道+密钥库、模型目标、设置、
// 场景提示词编辑）→ 杀进程 → 用【同一 EVALUATOR_DATA_DIR】重起 → 全部仍在。
// 等价验证「换镜像重部署 / docker restart 后我的配置是否还在」——线上稳定的核心保证。
// 说明：本测试验证的是「干净重启」的持久化（重部署场景）；不覆盖「写一半被杀」的原子性
// （那是另一条已知改进项，仅影响崩溃正中写盘的极小概率窗口）。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test, { after } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 5387; // 避开其它端点测试占用的 5388-5399
const dataDir = mkdtempSync(join(tmpdir(), "persist-smoke-"));

const baseEnv = {
  EVALUATOR_SESSION_SECRET: "test-secret",
  EVALUATOR_ADMIN_PASSWORD: "adminpw",
  EVALUATOR_SECRET_STORE: "local", // 用本地加密库（落 .vault），验证密钥库跨重启存活
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
async function api(method, path, cookie, body) {
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
    /* gone */
  }
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* best-effort：Windows 上刚 kill 的子进程可能短暂占用 SQLite 文件 */
  }
});

test("所有持久化面（渠道+密钥库/模型目标/设置/场景提示词）跨真实重启仍在", async () => {
  // —— 启动 #1，写入各持久化面 ——
  spawnServer();
  assert.ok(await waitHealthy(), "server #1 未就绪");
  let cookie = await login();
  assert.ok(cookie, "登录失败");

  // 1) 渠道（带上游 key → 进加密密钥库 .vault）
  const chRes = await api("POST", "/api/channels", cookie, {
    name: "冒烟渠道",
    provider: "OpenAI",
    baseUrl: "https://smoke-upstream.test",
    protocol: "openai_compatible",
    models: "smoke-model",
    apiKey: "sk-smoke-persist-key",
  });
  assert.equal(chRes.status, 200, "建渠道应成功");
  const channelId = chRes.body.id;
  assert.ok(channelId, "渠道有 id");
  assert.equal(chRes.body.hasKey, true, "渠道已挂 key（进密钥库）");
  const keyHash = chRes.body.keyHash;

  // 2) 模型目标
  const tRes = await api("POST", "/api/model-targets", cookie, { channelId, model: "smoke-model" });
  assert.equal(tRes.status, 200, "建模型目标应成功");
  const targetId = tRes.body.id;
  assert.ok(targetId, "目标有 id");

  // 3) 运行时设置（开关 + 自定义标签）
  const setRes = await api("PUT", "/api/settings", cookie, { enableHle: true, customTags: ["持久化冒烟-标签"] });
  assert.equal(setRes.status, 200, "改设置应成功");

  // 4) 场景提示词编辑（覆盖层）
  const list0 = await api("GET", "/api/dev/scenarios", cookie);
  const builtin = list0.body.find((s) => s.bankKey === "basic");
  assert.ok(builtin, "有内置 basic 场景");
  const MARK = "SMOKE-PERSIST-提示词-δ";
  const putScn = await api("PUT", `/api/dev/scenarios/${encodeURIComponent(builtin.id)}`, cookie, {
    name: builtin.name,
    category: builtin.category,
    difficulty: builtin.difficulty,
    prompt: MARK,
  });
  assert.equal(putScn.status, 200, "改场景提示词应成功");

  // 落卷证据：密钥库目录与覆盖层文件都在 dataDir 下（Docker /data 卷路径）
  assert.ok(existsSync(join(dataDir, ".vault")), "密钥库落在 dataDir/.vault");
  assert.ok(existsSync(join(dataDir, "配置", "scenario-overrides.json")), "场景覆盖层落在 dataDir/配置");

  // —— 重启：杀 #1，用同一 dataDir 起 #2 ——
  await stopServer();
  spawnServer();
  assert.ok(await waitHealthy(), "server #2 未就绪");
  cookie = await login();

  // —— 重启后逐面校验 ——
  const channels = await api("GET", "/api/channels", cookie);
  const ch2 = channels.body.find((c) => c.id === channelId);
  assert.ok(ch2, "重启后渠道仍在");
  assert.equal(ch2.hasKey, true, "重启后渠道仍持有 key（密钥库存活）");
  if (keyHash) assert.equal(ch2.keyHash, keyHash, "重启后 keyHash 不变（同一把 key）");

  const targets = await api("GET", "/api/model-targets", cookie);
  assert.ok(targets.body.some((t) => t.id === targetId), "重启后模型目标仍在");

  const settings = await api("GET", "/api/settings", cookie);
  assert.equal(settings.body.enableHle, true, "重启后设置开关仍在");
  assert.ok((settings.body.customTags || []).includes("持久化冒烟-标签"), "重启后自定义标签仍在");

  const list1 = await api("GET", "/api/dev/scenarios", cookie);
  const scn2 = list1.body.find((s) => s.id === builtin.id);
  assert.ok(scn2, "重启后场景仍在");
  assert.equal(scn2.prompt, MARK, "重启后场景提示词编辑仍持久");
});
