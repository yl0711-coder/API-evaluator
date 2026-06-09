import assert from "node:assert/strict";
import test from "node:test";
import { HttpRequestError, readJson } from "../server/http-request.mjs";

test("readJson parses empty and valid JSON request bodies", async () => {
  assert.deepEqual(await readJson(fakeRequest([])), {});
  assert.deepEqual(await readJson(fakeRequest(['{"ok":true}'])), { ok: true });
});

test("readJson returns friendly request errors for bad or oversized JSON", async () => {
  await assert.rejects(
    readJson(fakeRequest(["{bad json"])),
    (error) => error instanceof HttpRequestError && error.status === 400 && error.code === "invalid_json",
  );

  await assert.rejects(
    readJson(fakeRequest(["123456"]), { limitBytes: 3 }),
    (error) => error instanceof HttpRequestError && error.status === 413 && error.code === "payload_too_large",
  );
});

async function* fakeRequest(chunks) {
  for (const chunk of chunks) {
    yield Buffer.from(chunk);
  }
}
