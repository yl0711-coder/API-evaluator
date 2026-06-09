import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendJsonLine, readTextTail, redactSensitiveText, summarizeText } from "../server/utils.mjs";

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
