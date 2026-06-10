import assert from "node:assert/strict";
import test from "node:test";

process.env.EVALUATOR_SESSION_SECRET = "test-secret-please-change";
process.env.EVALUATOR_COOKIE_SECURE = "false";
process.env.EVALUATOR_ALLOWED_ROLES = "100,10";
process.env.EVALUATOR_CONFIG_WRITE_ROLE = "100";
process.env.EVALUATOR_LOGIN_MAX_FAIL = "3";
process.env.EVALUATOR_LOGIN_LOCK_MS = "10000";

const auth = await import("../server/auth.mjs");

test("session sign/verify roundtrip", () => {
  const token = auth.createSessionToken({ userId: "7", username: "admin", role: 100 });
  const payload = auth.verifySession(token);
  assert.equal(payload.username, "admin");
  assert.equal(payload.role, 100);
  assert.ok(payload.exp > Date.now());
});

test("verifySession rejects tampered signature", () => {
  const token = auth.createSessionToken({ userId: "1", username: "a", role: 10 });
  const tampered = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
  assert.equal(auth.verifySession(tampered), null);
});

test("verifySession rejects expired token", () => {
  const expired = auth.signSession({ userId: "1", username: "a", role: 10, exp: Date.now() - 1000 });
  assert.equal(auth.verifySession(expired), null);
});

test("verifySession rejects garbage / empty / null", () => {
  assert.equal(auth.verifySession(""), null);
  assert.equal(auth.verifySession("not-a-token"), null);
  assert.equal(auth.verifySession(null), null);
});

test("role gates: only 100/10 allowed; only 100 writes config", () => {
  assert.equal(auth.isRoleAllowed(100), true);
  assert.equal(auth.isRoleAllowed(10), true);
  assert.equal(auth.isRoleAllowed(1), false);
  assert.equal(auth.canWriteConfig(100), true);
  assert.equal(auth.canWriteConfig(10), false);
});

test("cookie parse + build flags", () => {
  assert.deepEqual(auth.parseCookies("a=1; evaluator_session=xyz"), { a: "1", evaluator_session: "xyz" });
  const c = auth.buildSessionCookie("tok");
  assert.match(c, /evaluator_session=tok/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  assert.ok(!/Secure/.test(c), "Secure should be off when EVALUATOR_COOKIE_SECURE=false");
});

test("getSessionFromRequest reads valid cookie, null otherwise", () => {
  const token = auth.createSessionToken({ userId: "7", username: "admin", role: 100 });
  const req = { headers: { cookie: `evaluator_session=${token}` } };
  assert.equal(auth.getSessionFromRequest(req).role, 100);
  assert.equal(auth.getSessionFromRequest({ headers: {} }), null);
});

test("login throttle blocks after max failures, resets on success", () => {
  auth._resetLoginThrottle();
  const key = "1.2.3.4|admin";
  assert.equal(auth.loginThrottleCheck(key).blocked, false);
  auth.loginThrottleFail(key);
  auth.loginThrottleFail(key);
  assert.equal(auth.loginThrottleCheck(key).blocked, false); // 2 < 3
  auth.loginThrottleFail(key); // 3rd -> lock
  assert.equal(auth.loginThrottleCheck(key).blocked, true);
  auth.loginThrottleReset(key);
  assert.equal(auth.loginThrottleCheck(key).blocked, false);
});

test("authenticateWithNewApi: success with role in login response (no /self call)", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      json: async () => ({ success: true, data: { id: 9, username: "root", role: 100 } }),
      headers: { get: () => "" },
    };
  };
  const r = await auth.authenticateWithNewApi("root", "pw", { baseUrl: "http://newapi.test", fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.user.role, 100);
  assert.equal(r.user.username, "root");
  assert.equal(calls.length, 1);
});

test("authenticateWithNewApi: falls back to /self when login lacks role", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.endsWith("/api/user/login")) {
      return {
        ok: true,
        json: async () => ({ success: true, data: { id: 3, username: "u" } }),
        headers: { get: () => "session=abc; Path=/" },
      };
    }
    return { ok: true, json: async () => ({ data: { id: 3, username: "u", role: 10 } }), headers: { get: () => "" } };
  };
  const r = await auth.authenticateWithNewApi("u", "pw", { baseUrl: "http://newapi.test", fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.user.role, 10);
  assert.ok(seen.some((u) => u.endsWith("/api/user/self")));
});

test("authenticateWithNewApi: bad credentials", async () => {
  const fetchImpl = async () => ({
    ok: false,
    json: async () => ({ success: false, message: "wrong" }),
    headers: { get: () => "" },
  });
  const r = await auth.authenticateWithNewApi("x", "y", { baseUrl: "http://newapi.test", fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad_credentials");
});

test("authenticateLocal: matches configured user, rejects wrong password / unknown user", () => {
  const users = new Map([["admin", { userId: "admin", username: "admin", role: 100, password: "s3cret" }]]);
  const ok = auth.authenticateLocal("admin", "s3cret", { users });
  assert.equal(ok.ok, true);
  assert.equal(ok.user.role, 100);
  assert.equal(auth.authenticateLocal("admin", "wrong", { users }).ok, false);
  assert.equal(auth.authenticateLocal("ghost", "s3cret", { users }).ok, false);
  assert.equal(auth.authenticateLocal("admin", "", { users }).ok, false);
});

test("localUsers parses EVALUATOR_ADMIN_PASSWORD and EVALUATOR_LOCAL_USERS (password may contain colon)", () => {
  process.env.EVALUATOR_ADMIN_PASSWORD = "pw100";
  process.env.EVALUATOR_LOCAL_USERS = "tester:pw10:10, bad-entry, ops:p:o:100";
  const users = auth.localUsers();
  assert.equal(users.get("admin").role, 100);
  assert.equal(users.get("admin").password, "pw100");
  assert.equal(users.get("tester").role, 10);
  assert.equal(users.get("ops").password, "p:o"); // name=ops, role=100, password 中间含冒号
  assert.equal(users.get("ops").role, 100);
  assert.equal(users.has("bad-entry"), false);
  delete process.env.EVALUATOR_ADMIN_PASSWORD;
  delete process.env.EVALUATOR_LOCAL_USERS;
});

test("authenticate dispatches to local by default, newapi when backend set", async () => {
  const users = new Map([["admin", { userId: "admin", username: "admin", role: 100, password: "pw" }]]);
  const localOk = await auth.authenticate("admin", "pw", { users });
  assert.equal(localOk.ok, true);
  assert.equal(localOk.user.role, 100);
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ success: true, data: { id: 1, username: "root", role: 100 } }),
    headers: { get: () => "" },
  });
  const napi = await auth.authenticate("root", "pw", { backend: "newapi", baseUrl: "http://newapi.test", fetchImpl });
  assert.equal(napi.ok, true);
  assert.equal(napi.user.username, "root");
});

test("clientIp ignores forged X-Forwarded-For unless EVALUATOR_TRUST_PROXY=true", () => {
  const req = { headers: { "x-forwarded-for": "9.9.9.9, 8.8.8.8" }, socket: { remoteAddress: "10.0.0.5" } };
  // 默认安全档：无视可伪造的 XFF，认 socket 真实地址 → 攻击者换假 IP 也绕不过限流
  delete process.env.EVALUATOR_TRUST_PROXY;
  assert.equal(auth.clientIp(req), "10.0.0.5");
  // 显式声明在可信反代后：才取 XFF 第一段作真实客户端
  process.env.EVALUATOR_TRUST_PROXY = "true";
  try {
    assert.equal(auth.clientIp(req), "9.9.9.9");
  } finally {
    delete process.env.EVALUATOR_TRUST_PROXY;
  }
});
