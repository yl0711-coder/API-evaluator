import assert from "node:assert/strict";
import test from "node:test";

import { evaluateApiAccess, requiresAdmin, PUBLIC_API_PATHS } from "../server/api-access.mjs";

const admin = { username: "admin", role: 100 };
const user = { username: "u", role: 10 };
const lowRole = { username: "x", role: 1 };

test("白名单端点免登录放行", () => {
  for (const p of PUBLIC_API_PATHS) {
    const r = evaluateApiAccess({ method: "GET", pathname: p, session: null });
    assert.equal(r.allow, true);
    assert.equal(r.public, true);
  }
});

test("非白名单 + 无会话 → 401", () => {
  const r = evaluateApiAccess({ method: "POST", pathname: "/api/tests/quick", session: null });
  assert.equal(r.allow, false);
  assert.equal(r.status, 401);
  assert.equal(r.error, "unauthorized");
});

test("会话角色不在放行名单 → 403 forbidden_role", () => {
  const r = evaluateApiAccess({ method: "POST", pathname: "/api/tests/quick", session: lowRole });
  assert.equal(r.allow, false);
  assert.equal(r.status, 403);
  assert.equal(r.error, "forbidden_role");
});

test("普通用户(10)可访问非配置端点", () => {
  const r = evaluateApiAccess({ method: "POST", pathname: "/api/tests/quick", session: user });
  assert.equal(r.allow, true);
  assert.equal(r.session, user);
});

test("配置写入(POST /api/profiles)：普通用户 403、超管放行", () => {
  const denied = evaluateApiAccess({ method: "POST", pathname: "/api/profiles", session: user });
  assert.equal(denied.allow, false);
  assert.equal(denied.status, 403);
  assert.equal(denied.error, "forbidden_admin");

  const ok = evaluateApiAccess({ method: "POST", pathname: "/api/profiles", session: admin });
  assert.equal(ok.allow, true);
});

test("GET /api/profiles 不需要超管，普通用户放行", () => {
  const r = evaluateApiAccess({ method: "GET", pathname: "/api/profiles", session: user });
  assert.equal(r.allow, true);
});

test("/api/support-bundle 仅超管：普通用户 403、超管放行", () => {
  assert.equal(evaluateApiAccess({ method: "GET", pathname: "/api/support-bundle", session: user }).error, "forbidden_admin");
  assert.equal(evaluateApiAccess({ method: "GET", pathname: "/api/support-bundle", session: admin }).allow, true);
});

test("requiresAdmin 规则", () => {
  assert.equal(requiresAdmin("POST", "/api/profiles"), true);
  assert.equal(requiresAdmin("POST", "/api/profiles/abc/key"), true);
  assert.equal(requiresAdmin("GET", "/api/profiles"), false);
  assert.equal(requiresAdmin("GET", "/api/support-bundle"), true);
  assert.equal(requiresAdmin("POST", "/api/tests/quick"), false);
});
