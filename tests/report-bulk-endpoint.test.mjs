import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomFillSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, inflateRawSync } from "node:zlib";
import test, { after, before } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = 5391;
const dataDir = mkdtempSync(join(tmpdir(), "report-bulk-endpoint-"));
const reportsDir = join(dataDir, "报告");
const baseUrl = `http://127.0.0.1:${port}`;
let server;
let ready = false;
let cookie = "";

const env = {
  EVALUATOR_SESSION_SECRET: "test-secret-0123456789abcdef-32b+",
  EVALUATOR_ADMIN_PASSWORD: "adminpw",
  EVALUATOR_LOCAL_USERS: "operator:oppw:10",
  EVALUATOR_SECRET_STORE: "memory",
  EVALUATOR_COOKIE_SECURE: "false",
  HOST: "127.0.0.1",
};

async function waitHealthy() {
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return true;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function loginAs(username, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ username, password }),
  });
  return (response.headers.get("set-cookie") || "").split(";")[0];
}

async function login() {
  return loginAs("admin", "adminpw");
}

async function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { origin: baseUrl, ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) },
  });
}

function parseZip(buffer) {
  const entries = new Map();
  const endOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(endOffset >= 0, "ZIP must contain an end-of-central-directory record");
  let offset = buffer.readUInt32LE(endOffset + 16);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "central directory entry expected");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const content = method === 8 ? inflateRawSync(compressed).toString("utf8") : compressed.toString("utf8");
    entries.set(name, content);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function writeHighEntropyFile(path, bytes) {
  const handle = await open(path, "w");
  const chunk = Buffer.alloc(256 * 1024);
  try {
    let written = 0;
    while (written < bytes) {
      randomFillSync(chunk);
      chunk[0] = 0; // Never look like a gzip header.
      const slice = chunk.subarray(0, Math.min(chunk.length, bytes - written));
      await handle.write(slice);
      written += slice.length;
    }
  } finally {
    await handle.close();
  }
}

before(async () => {
  await mkdir(reportsDir, { recursive: true });
  await writeFile(join(reportsDir, "bulk-one.html"), "<html>one</html>", "utf8");
  await writeFile(join(reportsDir, "bulk-one.md"), "# one", "utf8");
  await writeFile(join(reportsDir, "bulk-two.html"), gzipSync(Buffer.from("<html>two</html>", "utf8")));
  await writeFile(join(reportsDir, "bulk-two-ai-analysis.html"), "<html>ai</html>", "utf8");
  server = spawn(process.execPath, [join(root, "server.mjs")], {
    env: { ...process.env, ...env, EVALUATOR_DATA_DIR: dataDir, PORT: String(port) },
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
    // Best effort cleanup for Windows file handles.
  }
});

test("bulk report endpoints require a session", async () => {
  assert.ok(ready);
  const download = await request("/api/reports/files/download", { method: "POST", body: JSON.stringify({ ids: ["bulk-one"] }) });
  assert.equal(download.status, 401);
  const deletion = await request("/api/reports/files", { method: "DELETE", body: JSON.stringify({ ids: ["bulk-one"] }) });
  assert.equal(deletion.status, 401);
});

test("bulk download returns plain HTML entries, including gzip-backed files", async () => {
  const response = await request("/api/reports/files/download", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ ids: ["bulk-one", "bulk-two", "bulk-one"] }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /application\/zip/);
  assert.match(response.headers.get("content-disposition") || "", /api-evaluator-reports-.*\.zip/);
  assert.equal(response.headers.get("content-length"), null, "streamed exports must not prebuild a full ZIP for Content-Length");
  const entries = parseZip(Buffer.from(await response.arrayBuffer()));
  assert.deepEqual([...entries.keys()].sort(), ["bulk-one.html", "bulk-two.html"]);
  assert.equal(entries.get("bulk-one.html"), "<html>one</html>");
  assert.equal(entries.get("bulk-two.html"), "<html>two</html>");
  const operatorCookie = await loginAs("operator", "oppw");
  const operatorResponse = await request("/api/reports/files/download", {
    method: "POST",
    headers: { cookie: operatorCookie },
    body: JSON.stringify({ ids: ["bulk-one"] }),
  });
  assert.equal(operatorResponse.status, 403);
});

test("bulk download validates selection limits", async () => {
  const empty = await request("/api/reports/files/download", { method: "POST", headers: { cookie }, body: JSON.stringify({ ids: [] }) });
  assert.equal(empty.status, 400);
  const tooMany = await request("/api/reports/files/download", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ ids: Array.from({ length: 33 }, (_, index) => `report-${index}`) }),
  });
  assert.equal(tooMany.status, 413);
});

test("bulk download streams a high-entropy report while health checks remain responsive", async () => {
  const id = "bulk-high-entropy";
  const bytes = 20 * 1024 * 1024;
  await writeHighEntropyFile(join(reportsDir, `${id}.html`), bytes);

  const response = await request("/api/reports/files/download", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ ids: [id] }),
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);

  const startedAt = performance.now();
  const health = await request("/api/health");
  assert.equal(health.status, 200);
  assert.ok(performance.now() - startedAt < 1500, "stream compression must not block the event loop");

  let received = first.value.byteLength;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    received += next.value.byteLength;
  }
  assert.ok(received >= bytes, "archive must include the high-entropy report payload");
});

test("bulk download rejects high-entropy input above the 24 MiB preflight limit", async () => {
  const id = "bulk-too-large";
  await writeHighEntropyFile(join(reportsDir, `${id}.html`), 25 * 1024 * 1024);
  const response = await request("/api/reports/files/download", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ ids: [id] }),
  });
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.error, "reports_too_large");
});

test("bulk delete reports successes and failures independently", async () => {
  const response = await request("/api/reports/files", {
    method: "DELETE",
    headers: { cookie },
    body: JSON.stringify({ ids: ["bulk-one", "missing-report", "bulk-two"] }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.deleted.sort(), ["bulk-one", "bulk-two"]);
  assert.deepEqual(result.failed, [{ id: "missing-report", code: "not_found" }]);
  assert.equal(existsSync(join(reportsDir, "bulk-one.html")), false);
  assert.equal(existsSync(join(reportsDir, "bulk-one.md")), false);
  assert.equal(existsSync(join(reportsDir, "bulk-two.html")), false);
  assert.equal(readFileSync(join(reportsDir, "bulk-two-ai-analysis.html"), "utf8"), "<html>ai</html>");
});
