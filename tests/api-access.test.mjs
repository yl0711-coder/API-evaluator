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

// 白名单端点的响应体等于对任何能访问到本服务的人公开，所以这个集合不该被顺手加成员。
// 这条断言不是「防止改动」，而是「强制改动者先去读 PUBLIC_API_PATHS 上方那段注释」——
// 那里写明了两个现有成员各自为什么可以公开、以及 /api/health 公开了哪些进程诊断信息。
// 有意新增时：更新这里的期望值 + 在那段注释里补上新成员为什么能公开。
test("免登录白名单只含这两个端点（新增前请先读 PUBLIC_API_PATHS 的注释）", () => {
  assert.deepEqual(
    [...PUBLIC_API_PATHS].sort(),
    ["/api/client-errors", "/api/health"],
    "免登录白名单变了。白名单端点的响应对未登录者完全可见——/api/health 已经暴露了 pid、" +
      "版本号、内存/CPU/事件循环延迟、并发队列与上游错误计数（有意接受，见 api-access.mjs 注释）。" +
      "新成员必须同样满足「不含 key / baseUrl / 渠道名 / 模型名 / prompt / 用户数据」。",
  );
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
  assert.equal(requiresAdmin("POST", "/api/reports/files/download"), true);
  assert.equal(requiresAdmin("POST", "/api/tests/quick"), false);
  // 设置读写都不再一刀切要超管：普通管理员可改「不影响 new-api」的设置，
  // new-api 相关字段在端点内字段级门禁（见 server.mjs PUT /api/settings）。
  assert.equal(requiresAdmin("GET", "/api/settings"), false);
  assert.equal(requiresAdmin("PUT", "/api/settings"), false);
});

test("删除报告文件仅超管：DELETE /api/reports/* 需超管，GET 列表/查看不受影响", () => {
  // 只有 DELETE 需超管
  assert.equal(requiresAdmin("DELETE", "/api/reports/files/foo"), true);
  // GET 列表 / 查看 不误伤
  assert.equal(requiresAdmin("GET", "/api/reports/files"), false);
  assert.equal(requiresAdmin("GET", "/api/reports/foo/view"), false);
  assert.equal(requiresAdmin("GET", "/api/reports"), false);

  // 普通用户(10) DELETE → 403 forbidden_admin；超管(100) → 放行
  assert.equal(evaluateApiAccess({ method: "DELETE", pathname: "/api/reports/files/foo", session: user }).error, "forbidden_admin");
  assert.equal(evaluateApiAccess({ method: "DELETE", pathname: "/api/reports/files/foo", session: admin }).allow, true);
  // 普通用户看列表/查看 → 放行
  assert.equal(evaluateApiAccess({ method: "GET", pathname: "/api/reports/files", session: user }).allow, true);
  assert.equal(evaluateApiAccess({ method: "GET", pathname: "/api/reports/foo/view", session: user }).allow, true);
  assert.equal(evaluateApiAccess({ method: "POST", pathname: "/api/reports/files/download", session: user }).error, "forbidden_admin");
  assert.equal(evaluateApiAccess({ method: "POST", pathname: "/api/reports/files/download", session: admin }).allow, true);
});

test("v0.3.0 渠道写=超管(100)，模型目标写=管理员(10)即可", () => {
  // 渠道持 key，写操作仅超管
  assert.equal(requiresAdmin("POST", "/api/channels"), true);
  assert.equal(requiresAdmin("DELETE", "/api/channels/abc"), true);
  assert.equal(requiresAdmin("GET", "/api/channels"), false);
  // 模型目标不持 key，管理员可写（增删改）
  assert.equal(requiresAdmin("POST", "/api/model-targets"), false);
  assert.equal(requiresAdmin("DELETE", "/api/model-targets/x"), false);

  // 管理员(10)写渠道 → 403；超管(100) → 放行
  assert.equal(evaluateApiAccess({ method: "POST", pathname: "/api/channels", session: user }).error, "forbidden_admin");
  assert.equal(evaluateApiAccess({ method: "POST", pathname: "/api/channels", session: admin }).allow, true);
  // 管理员(10)看渠道列表(GET)、写模型目标 → 放行
  assert.equal(evaluateApiAccess({ method: "GET", pathname: "/api/channels", session: user }).allow, true);
  assert.equal(evaluateApiAccess({ method: "POST", pathname: "/api/model-targets", session: user }).allow, true);
});
