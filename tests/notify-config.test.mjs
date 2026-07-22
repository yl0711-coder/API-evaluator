// tests/notify-config.test.mjs
// 单元：notify-config.mjs 的默认值/归一化/原子落盘往返。密码字段本身不在这个 store 里
// （只有 smtpPasswordSet 布尔），真密码走 secret-store，见 tests/notify-endpoint.test.mjs。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, after, beforeEach } from "node:test";

let dataDir;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "notify-config-"));
  process.env.EVALUATOR_DATA_DIR = dataDir;
});

after(() => {
  delete process.env.EVALUATOR_DATA_DIR;
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* best-effort temp cleanup */
  }
});

const { loadNotifyConfig, saveNotifyConfig, getNotifyConfig, __resetNotifyConfigCacheForTest } = await import(
  "../server/notify-config.mjs"
);
const { NOTIFY_CONFIG_FILE } = await import("../server/paths.mjs");

beforeEach(() => {
  __resetNotifyConfigCacheForTest();
});

test("loadNotifyConfig：文件不存在 → 默认值（465/SSL 开/其余全空）", async () => {
  const cfg = await loadNotifyConfig();
  assert.deepEqual(cfg, {
    smtpHost: "",
    smtpPort: 465,
    smtpSsl: true,
    smtpUser: "",
    smtpFrom: "",
    recipients: "",
    smtpPasswordSet: false,
  });
});

test("saveNotifyConfig：合并写入、类型归一化，落盘可复读", async () => {
  const saved = await saveNotifyConfig({
    smtpHost: "  smtp.example.com  ",
    smtpPort: "587",
    smtpSsl: false,
    smtpUser: "  bot@example.com ",
    smtpFrom: " alerts@example.com ",
    recipients: "a@example.com, b@example.com",
  });
  assert.equal(saved.smtpHost, "smtp.example.com", "trim");
  assert.equal(saved.smtpPort, 587, "字符串端口转数字");
  assert.equal(saved.smtpSsl, false);
  assert.equal(saved.smtpUser, "bot@example.com");
  assert.equal(saved.smtpFrom, "alerts@example.com");
  assert.equal(saved.recipients, "a@example.com, b@example.com");
  assert.equal(saved.smtpPasswordSet, false, "本次未涉及密码");

  // 内存缓存立即可见。
  assert.deepEqual(getNotifyConfig(), saved);

  // 落盘内容可被重新加载还原（新会话/重启场景）。
  __resetNotifyConfigCacheForTest();
  const reloaded = await loadNotifyConfig();
  assert.deepEqual(reloaded, saved);

  // 磁盘文件本身不含密码字段（本 store 从不持有密码）。
  const onDisk = JSON.parse(readFileSync(NOTIFY_CONFIG_FILE, "utf8"));
  assert.equal(Object.prototype.hasOwnProperty.call(onDisk, "smtpPassword"), false);
});

test("saveNotifyConfig：非法端口兜底 465", async () => {
  const saved = await saveNotifyConfig({ smtpPort: "not-a-number" });
  assert.equal(saved.smtpPort, 465);
  const saved2 = await saveNotifyConfig({ smtpPort: -1 });
  assert.equal(saved2.smtpPort, 465);
  const saved3 = await saveNotifyConfig({ smtpPort: 99999 });
  assert.equal(saved3.smtpPort, 465);
});

test("saveNotifyConfig：patch 只更新给到的字段，其余保留", async () => {
  await saveNotifyConfig({ smtpHost: "first.example.com", smtpUser: "u1" });
  const after1 = await saveNotifyConfig({ smtpHost: "second.example.com" });
  assert.equal(after1.smtpHost, "second.example.com");
  assert.equal(after1.smtpUser, "u1", "未提及字段保留原值");
});

test("saveNotifyConfig：smtpPasswordSet 可由调用方（handler 层）显式置真并保留", async () => {
  const saved = await saveNotifyConfig({ smtpHost: "x.example.com", smtpPasswordSet: true });
  assert.equal(saved.smtpPasswordSet, true);
  const after1 = await saveNotifyConfig({ smtpHost: "y.example.com" });
  assert.equal(after1.smtpPasswordSet, true, "未显式提及 smtpPasswordSet 时保留");
});
