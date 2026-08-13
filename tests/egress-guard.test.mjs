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

// 回归：IPv4-mapped 必须按【十六进制归一化形态】判定。
// 上面那条老用例测的是点分写法 "::ffff:10.0.0.1"，而 WHATWG URL 会先把它归一化成
// "::ffff:a00:1"——所以老用例一直是绿的，生产路径却从来没被保护过（旧正则要求点分书写）。
test("IPv6-mapped 内网地址：十六进制归一化形态也必须判为内网（P1-1 回归）", () => {
  // 这些正是 new URL() 交给守卫的真实形态
  assert.equal(new URL("http://[::ffff:169.254.169.254]/").hostname, "[::ffff:a9fe:a9fe]");
  assert.equal(new URL("http://[::ffff:127.0.0.1]/").hostname, "[::ffff:7f00:1]");

  assert.equal(isPrivateOrReservedIp("::ffff:a9fe:a9fe"), true); // 169.254.169.254 云元数据
  assert.equal(isPrivateOrReservedIp("::ffff:7f00:1"), true); // 127.0.0.1 回环
  assert.equal(isPrivateOrReservedIp("::ffff:a00:1"), true); // 10.0.0.1
  assert.equal(isPrivateOrReservedIp("::ffff:c0a8:1"), true); // 192.168.0.1
  // 公网地址被 mapped 包裹时仍应放行，避免误伤
  assert.equal(isPrivateOrReservedIp("::ffff:101:101"), false); // 1.1.1.1
});

test("IPv6 其它内嵌 / 保留网段（P1-1 回归）", () => {
  assert.equal(isPrivateOrReservedIp("::"), true); // unspecified
  assert.equal(isPrivateOrReservedIp("::127.0.0.1"), true); // 已废弃的 IPv4-compatible
  assert.equal(isPrivateOrReservedIp("64:ff9b::a9fe:a9fe"), true); // NAT64 包裹云元数据
  assert.equal(isPrivateOrReservedIp("64:ff9b::1:a9fe:a9fe"), true); // NAT64 /48 变体
  assert.equal(isPrivateOrReservedIp("febf::1"), true); // fe80::/10 上边界（旧的 "fe80" 前缀判定漏掉）
  assert.equal(isPrivateOrReservedIp("fea0::1"), true); // fe80::/10 中段
  assert.equal(isPrivateOrReservedIp("fdff::1"), true); // fc00::/7 ULA 上边界
  assert.equal(isPrivateOrReservedIp("ff02::1"), true); // multicast
  assert.equal(isPrivateOrReservedIp("2002:7f00:1::1"), true); // 6to4 包裹 127.0.0.1
  assert.equal(isPrivateOrReservedIp("2002:101:101::1"), false); // 6to4 包裹公网 1.1.1.1 → 放行
  // 公网不受影响
  assert.equal(isPrivateOrReservedIp("2001:4860:4860::8888"), false);
  assert.equal(isPrivateOrReservedIp("fe00::1"), false); // 不在 fe80::/10 内
});

test("IPv6 解析失败一律 fail-closed（P1-1 回归）", () => {
  assert.equal(isPrivateOrReservedIp("::ffff:999.1.1.1"), true);
  assert.equal(isPrivateOrReservedIp("1::2::3"), true);
  assert.equal(isPrivateOrReservedIp("gggg::1"), true);
});

test("assertPublicTarget 拦住 IPv6 字面量绕过（P1-1 端到端回归）", async () => {
  // 审查复现用的两条：过去这两条会被直接放行，通向云元数据 / 本机回环
  await assert.rejects(
    () => assertPublicTarget("http://[::ffff:a9fe:a9fe]/latest/meta-data/iam/security-credentials/"),
    EgressBlockedError,
  );
  await assert.rejects(() => assertPublicTarget("http://[::ffff:7f00:1]/"), EgressBlockedError);
  await assert.rejects(() => assertPublicTarget("http://[::ffff:127.0.0.1]/"), EgressBlockedError);
  await assert.rejects(() => assertPublicTarget("http://[64:ff9b::a9fe:a9fe]/"), EgressBlockedError);
  await assert.rejects(() => assertPublicTarget("http://[::1]/"), EgressBlockedError);
  // 公网 IPv6 仍可用
  assert.deepEqual(await assertPublicTarget("http://[2606:4700:4700::1111]/"), ["2606:4700:4700::1111"]);
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
