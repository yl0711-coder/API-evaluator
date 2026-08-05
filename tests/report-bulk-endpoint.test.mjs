import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const dataStart = nameStart + nameLength + extraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const content = method === 8 ? inflateRawSync(compressed).toString("utf8") : compressed.toString("utf8");
    entries.set(name, content);
    offset = dataStart + compressedSize;
  }
  return entries;
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
  assert.equal(operatorResponse.status, 200);
});

test("bulk download validates selection limits", async () => {
  const empty = await request("/api/reports/files/download", { method: "POST", headers: { cookie }, body: JSON.stringify({ ids: [] }) });
  assert.equal(empty.status, 400);
  const tooMany = await request("/api/reports/files/download", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ ids: Array.from({ length: 201 }, (_, index) => `report-${index}`) }),
  });
  assert.equal(tooMany.status, 413);
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
