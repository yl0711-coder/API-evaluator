import assert from "node:assert/strict";
import test from "node:test";

const { isPrivateOrReservedIp, assertPublicTarget, EgressBlockedError } = await import("../server/egress-guard.mjs");

test("flags private/reserved IPv4", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "224.0.0.1",
  ]) {
    assert.equal(isPrivateOrReservedIp(ip), true, `${ip} 应判为内网/保留`);
  }
});

test("allows public IPv4", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "203.0.113.9"]) {
    assert.equal(isPrivateOrReservedIp(ip), false, `${ip} 应为公网`);
  }
});

test("handles IPv6 incl. mapped", () => {
  assert.equal(isPrivateOrReservedIp("::1"), true);
  assert.equal(isPrivateOrReservedIp("fc00::1"), true);
  assert.equal(isPrivateOrReservedIp("fe80::1"), true);
  assert.equal(isPrivateOrReservedIp("::ffff:10.0.0.1"), true);
  assert.equal(isPrivateOrReservedIp("2606:4700:4700::1111"), false);
});

test("treats junk as unsafe (fail-closed)", () => {
  assert.equal(isPrivateOrReservedIp(""), true);
  assert.equal(isPrivateOrReservedIp("not-an-ip"), true);
  assert.equal(isPrivateOrReservedIp(null), true);
});

test("assertPublicTarget rejects literal internal IP", async () => {
  await assert.rejects(() => assertPublicTarget("http://169.254.169.254/latest/meta-data/"), EgressBlockedError);
  await assert.rejects(() => assertPublicTarget("http://127.0.0.1:3000/"), EgressBlockedError);
});

test("assertPublicTarget rejects domain resolving to internal", async () => {
  const lookup = async () => ["10.0.0.5"];
  await assert.rejects(() => assertPublicTarget("https://evil.example.com/x", { lookup }), EgressBlockedError);
});

test("assertPublicTarget allows public domain", async () => {
  const lookup = async () => ["8.8.8.8"];
  const ips = await assertPublicTarget("https://api.example.com/v1", { lookup });
  assert.deepEqual(ips, ["8.8.8.8"]);
});

test("assertPublicTarget rejects non-http protocol", async () => {
  await assert.rejects(() => assertPublicTarget("file:///etc/passwd"), EgressBlockedError);
});

test("assertPublicTarget can be disabled via env", async () => {
  process.env.EVALUATOR_EGRESS_DENY_PRIVATE = "false";
  try {
    const ips = await assertPublicTarget("http://127.0.0.1:3000/");
    assert.deepEqual(ips, []);
  } finally {
    delete process.env.EVALUATOR_EGRESS_DENY_PRIVATE;
  }
});
