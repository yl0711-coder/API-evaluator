// e2e/import-sub2api.spec.mjs
// 「从 sub2api 上游渠道导入测试分组」的浏览器级验证：真渲染、真点击。
// 与 import-test-tokens.spec.mjs 同构；重点是密码框、点遮罩不关（防误触）、提交禁用。
import { expect, test } from "@playwright/test";

const channels = [{ id: "channel-1", name: "评测渠道", status: "enabled", aliases: [] }];

async function installApiFixture(page, { role = 100, importReply = null } = {}) {
  const state = { importCalls: [] };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/api/auth/me")
      return json({ user: { username: role >= 100 ? "super-admin" : "operator", role, canConfig: role >= 100 } });
    if (path === "/api/channels") return json(channels);
    if (path === "/api/model-targets") return json([]);
    if (path === "/api/profiles" || path === "/api/scenarios" || path === "/api/requests/recent" || path === "/api/test-runs/recent")
      return json([]);
    if (path === "/api/settings") return json({});
    if (path === "/api/high-risk-alerts") return json([]);
    if (path === "/api/tasks/recent") return json([]);

    if (path === "/api/channels/import-sub2api-tokens" && request.method() === "POST") {
      state.importCalls.push(request.postDataJSON());
      if (importReply) return json(importReply.body, importReply.status ?? 200);
      return json({
        ok: true,
        summary: { total: 2, imported: 2, updated: 0, newTargets: 3, disabled: 0, noGroup: 0, noModels: 0, viaFallback: 0 },
      });
    }
    if (path === "/api/reports/files" || path === "/api/reports") return json([]);
    return json({});
  });
  return state;
}

async function openChannelsPage(page, options) {
  const state = await installApiFixture(page, options);
  await page.goto("/");
  await expect(page.locator(".auth-userbar")).toBeVisible();
  await page.locator('[data-page="channels"]').click();
  await expect(page.locator("#channels")).toHaveClass(/active/);
  return state;
}

test("按钮在渠道管理页可见，点击弹出导入框", async ({ page }) => {
  await openChannelsPage(page);
  const button = page.locator("#import-sub2api");
  await expect(button).toBeVisible();
  await expect(button).toHaveText("从 sub2api 上游渠道导入测试分组");
  await expect(page.locator("#sub2api-import-modal")).toBeHidden();
  await button.click();
  await expect(page.locator("#sub2api-import-modal")).toBeVisible();
  // 四个字段都在，密码必须是密码框
  await expect(page.locator("#sub2api-import-base")).toBeVisible();
  await expect(page.locator("#sub2api-import-email")).toBeVisible();
  await expect(page.locator("#sub2api-import-password")).toHaveAttribute("type", "password");
  await expect(page.locator("#sub2api-import-totp")).toBeVisible();
  // 两个导入按钮并列，互不影响
  await expect(page.locator("#import-test-tokens")).toBeVisible();
});

test("取消 / Esc 关闭，且关闭后清空密码与验证码（网址邮箱留着）", async ({ page }) => {
  await openChannelsPage(page);
  const modal = page.locator("#sub2api-import-modal");

  await page.locator("#import-sub2api").click();
  await page.locator("#sub2api-import-base").fill("https://relay.example.com");
  await page.locator("#sub2api-import-email").fill("a@b.com");
  await page.locator("#sub2api-import-password").fill("secret-pw");
  await page.locator("#sub2api-import-totp").fill("123456");
  await page.locator("#sub2api-import-cancel").click();
  await expect(modal).toBeHidden();
  await expect(page.locator("#sub2api-import-password")).toHaveValue("", "密码必须清空，不留在 DOM 里");
  await expect(page.locator("#sub2api-import-totp")).toHaveValue("", "TOTP 是一次性码，也该清空");
  await expect(page.locator("#sub2api-import-base")).toHaveValue("https://relay.example.com", "网址留着便于重试");
  await expect(page.locator("#sub2api-import-email")).toHaveValue("a@b.com");

  await page.locator("#import-sub2api").click();
  await expect(modal).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
});

// 与 new-api 那个框同样的理由：本框要手填多项凭据，误点空白就全作废、密码还会被清空。
test("点遮罩不关闭弹窗，已填内容不丢（防误触）", async ({ page }) => {
  await openChannelsPage(page);
  const modal = page.locator("#sub2api-import-modal");
  await page.locator("#import-sub2api").click();
  await page.locator("#sub2api-import-base").fill("https://relay.example.com");
  await page.locator("#sub2api-import-password").fill("secret-pw");
  await modal.click({ position: { x: 5, y: 5 } });
  await expect(modal).toBeVisible("点遮罩不该关闭本框——填了一半的凭据会全部作废");
  await expect(page.locator("#sub2api-import-password")).toHaveValue("secret-pw");
});

test("填全后提交，凭据原样发给后端并提示导入结果", async ({ page }) => {
  const state = await openChannelsPage(page);
  await page.locator("#import-sub2api").click();
  await page.locator("#sub2api-import-base").fill("https://relay.example.com");
  await page.locator("#sub2api-import-email").fill("a@b.com");
  await page.locator("#sub2api-import-password").fill("secret-pw");
  await page.locator("#sub2api-import-submit").click();

  await expect.poll(() => state.importCalls.length).toBe(1);
  expect(state.importCalls[0]).toMatchObject({
    baseUrl: "https://relay.example.com",
    email: "a@b.com",
    password: "secret-pw",
    totpCode: "",
  });
  await expect(page.locator("#sub2api-import-modal")).toBeHidden();
  await expect(page.locator(".toast, #toast")).toContainText("新增 2");
});

test("导入失败时保留弹窗，按钮恢复可用，可以直接重试", async ({ page }) => {
  const state = await openChannelsPage(page, {
    importReply: { status: 400, body: { error: "sub2api_login_error", userMessage: "登录失败：邮箱或密码不正确。" } },
  });
  await page.locator("#import-sub2api").click();
  await page.locator("#sub2api-import-base").fill("https://relay.example.com");
  await page.locator("#sub2api-import-email").fill("a@b.com");
  await page.locator("#sub2api-import-password").fill("wrong-pw");
  await page.locator("#sub2api-import-submit").click();

  await expect.poll(() => state.importCalls.length).toBe(1);
  await expect(page.locator("#sub2api-import-modal")).toBeVisible();
  await expect(page.locator("#sub2api-import-submit")).toBeEnabled();
  await expect(page.locator("#sub2api-import-submit")).toHaveText("开始导入", "按钮文案必须复原");
  await expect(page.locator("#sub2api-import-base")).toHaveValue("https://relay.example.com");
});

test("缺字段时不发请求（浏览器原生 required 拦住）", async ({ page }) => {
  const state = await openChannelsPage(page);
  await page.locator("#import-sub2api").click();
  await page.locator("#sub2api-import-base").fill("https://relay.example.com");
  // 故意不填邮箱和密码
  await page.locator("#sub2api-import-submit").click();
  await page.waitForTimeout(300);
  expect(state.importCalls.length).toBe(0);
  await expect(page.locator("#sub2api-import-modal")).toBeVisible();
});

test("普通管理员(role 10)看不到这个按钮 —— 渠道持 key，只超管可导", async ({ page }) => {
  await installApiFixture(page, { role: 10 });
  await page.goto("/");
  await expect(page.locator(".auth-userbar")).toBeVisible();
  await expect(page.locator("#import-sub2api")).toBeHidden();
});

test("TOTP 填了就一并发给后端", async ({ page }) => {
  const state = await openChannelsPage(page);
  await page.locator("#import-sub2api").click();
  await page.locator("#sub2api-import-base").fill("https://relay.example.com");
  await page.locator("#sub2api-import-email").fill("a@b.com");
  await page.locator("#sub2api-import-password").fill("pw");
  await page.locator("#sub2api-import-totp").fill("654321");
  await page.locator("#sub2api-import-submit").click();
  await expect.poll(() => state.importCalls.length).toBe(1);
  expect(state.importCalls[0].totpCode).toBe("654321");
});
