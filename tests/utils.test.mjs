import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendJsonLine, readTextTail, redactSensitiveText, summarizeText, writeFileAtomic, writeJsonAtomic } from "../server/utils.mjs";

test("text summaries redact common API key and auth header patterns", () => {
  const raw = [
    "prompt includes sk-test-secret-1234567890",
    "preview has sk-should-not-be-in-report",
    "Authorization: Bearer very-secret-token-value",
    "api_key=another-secret-value",
  ].join(" ");

  const summary = summarizeText(raw);

  assert.doesNotMatch(summary, /sk-test-secret/);
  assert.doesNotMatch(summary, /sk-should-not-be-in-report/);
  assert.doesNotMatch(summary, /very-secret-token-value/);
  assert.doesNotMatch(summary, /another-secret-value/);
  assert.match(summary, /\[redacted-secret\]/);
});

test("redactSensitiveText leaves ordinary text readable", () => {
  assert.equal(redactSensitiveText("普通错误：模型不存在"), "普通错误：模型不存在");
});

test("jsonl append trims oversized log files and tail reader avoids old content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-jsonl-trim-test-"));
  const file = join(dir, "requests.jsonl");
  try {
    for (let index = 0; index < 20; index += 1) {
      await appendJsonLine(file, { index, payload: "x".repeat(40) }, { maxBytes: 500, tailBytes: 260 });
    }

    const raw = await readFile(file, "utf8");
    assert.equal(raw.includes('"index":0'), false);
    assert.match(raw, /"index":19/);

    const tail = await readTextTail(file, 160);
    assert.match(tail, /"index":19/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeJsonAtomic：写出合法 JSON、自动建目录、不留临时文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atomic-json-"));
  try {
    const file = join(dir, "nested", "data.json"); // 父目录不存在 → 应自动建
    await writeJsonAtomic(file, { a: 1, 中文: "值" });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { a: 1, 中文: "值" });
    const leftovers = (await readdir(join(dir, "nested"))).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "不留 .tmp 残留");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeJsonAtomic：并发写同一文件——目标始终是完整 JSON、无临时残留", async () => {
  // 原子性的核心保证：无论并发多少写，读到的目标文件永远是【某一次完整写】，绝不半截。
  // （Windows 上多个 rename 同时替换同一目标可能个别 EPERM——那是平台文件锁，非损坏；
  //  Linux/Docker 下 rename 替换是原子的、均成功。故只断言「不损坏」而非「全部成功」。）
  const dir = await mkdtemp(join(tmpdir(), "atomic-conc-"));
  try {
    const file = join(dir, "data.json");
    const results = await Promise.allSettled(Array.from({ length: 16 }, (_, i) => writeJsonAtomic(file, { writer: i })));
    assert.ok(
      results.some((r) => r.status === "fulfilled"),
      "至少一次写落地",
    );
    const parsed = JSON.parse(await readFile(file, "utf8")); // 不抛 = 未被写成半截
    assert.equal(typeof parsed.writer, "number", "目标是某次完整写的内容");
    assert.deepEqual(
      (await readdir(dir)).filter((f) => f.endsWith(".tmp")),
      [],
      "失败分支也清掉了临时文件，无残留",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeFileAtomic：写文本内容正确、无临时残留（用于主加密密钥）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atomic-text-"));
  try {
    const file = join(dir, "local-secret.key");
    await writeFileAtomic(file, "deadbeefcafe", { encoding: "utf8", mode: 0o600 });
    assert.equal(await readFile(file, "utf8"), "deadbeefcafe");
    assert.deepEqual(
      (await readdir(dir)).filter((f) => f.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
