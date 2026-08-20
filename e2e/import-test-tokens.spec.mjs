// e2e/import-test-tokens.spec.mjs
// 「从 new-api 上游渠道导入测试分组」的浏览器级验证：真渲染、真点击。
// 单测和端点测试都碰不到这些——弹窗开关、按钮在表单里会不会误提交、超管/管理员可见性、
// 提交期间禁用、失败后能否重试。
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

    if (path === "/api/channels/import-test-tokens" && request.method() === "POST") {
      state.importCalls.push(request.postDataJSON());
      if (importReply) return json(importReply.body, importReply.status ?? 200);
      return json({
        ok: true,
        summary: { total: 2, imported: 2, updated: 0, newTargets: 4, disabled: 0, noGroup: 0, noModels: 0, mixedProtocol: 0 },
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
  const button = page.locator("#import-test-tokens");
  await expect(button).toBeVisible();
  await expect(button).toHaveText("从 new-api 上游渠道导入测试分组");
  // 默认应收起
  await expect(page.locator("#token-import-modal")).toBeHidden();
  await button.click();
  await expect(page.locator("#token-import-modal")).toBeVisible();
  // 三个输入框都在
  await expect(page.locator("#token-import-base")).toBeVisible();
  await expect(page.locator("#token-import-token")).toBeVisible();
  await expect(page.locator("#token-import-userid")).toBeVisible();
  // 个人令牌必须是密码框（不能明文显示在屏幕上）
  await expect(page.locator("#token-import-token")).toHaveAttribute("type", "password");
});

test("弹窗可用取消 / Esc 关闭，且关闭后清空令牌", async ({ page }) => {
  await openChannelsPage(page);
  const modal = page.locator("#token-import-modal");

  // 取消按钮
  await page.locator("#import-test-tokens").click();
  await page.locator("#token-import-token").fill("tok-secret");
  await page.locator("#token-import-cancel").click();
  await expect(modal).toBeHidden();
  await expect(page.locator("#token-import-token")).toHaveValue("", "关框必须清空令牌，别把凭据留在 DOM 里");

  // Esc
  await page.locator("#import-test-tokens").click();
  await expect(modal).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
});

// 本框要手填三项凭据（个人令牌还得去 new-api 后台翻），误点空白就全作废、令牌还会被清空。
// 故刻意【不】做「点遮罩即关」——这条把「不关」钉住，防止日后有人为了跟其它弹窗一致而加回来。
test("点遮罩不关闭弹窗，已填内容不丢（防误触）", async ({ page }) => {
  await openChannelsPage(page);
  const modal = page.locator("#token-import-modal");

  await page.locator("#import-test-tokens").click();
  await page.locator("#token-import-base").fill("https://relay.example.com");
  await page.locator("#token-import-token").fill("tok-secret");
  await expect(modal).toBeVisible();

  // 点模态框自身的左上角（遮罩区，非卡片内部）
  await modal.click({ position: { x: 5, y: 5 } });
  await expect(modal).toBeVisible("点遮罩不该关闭本框——填了一半的凭据会全部作废");
  await expect(page.locator("#token-import-token")).toHaveValue("tok-secret", "已填的令牌不得被清空");
  await expect(page.locator("#token-import-base")).toHaveValue("https://relay.example.com");
});

test("三项填全后提交，把凭据原样发给后端并提示导入结果", async ({ page }) => {
  const state = await openChannelsPage(page);
  await page.locator("#import-test-tokens").click();
  await page.locator("#token-import-base").fill("https://relay.example.com");
  await page.locator("#token-import-token").fill("tok-abc");
  await page.locator("#token-import-userid").fill("7");
  await page.locator("#token-import-submit").click();

  await expect.poll(() => state.importCalls.length).toBe(1);
  expect(state.importCalls[0]).toMatchObject({
    baseUrl: "https://relay.example.com",
    token: "tok-abc",
    userId: "7",
  });
  // 成功后弹窗自动收起，并给出汇总提示
  await expect(page.locator("#token-import-modal")).toBeHidden();
  await expect(page.locator(".toast, #toast")).toContainText("新增 2");
});

test("导入失败时保留弹窗，按钮恢复可用，可以直接重试", async ({ page }) => {
  const state = await openChannelsPage(page, {
    importReply: { status: 400, body: { error: "newapi_error", userMessage: "访问令牌无效" } },
  });
  await page.locator("#import-test-tokens").click();
  await page.locator("#token-import-base").fill("https://relay.example.com");
  await page.locator("#token-import-token").fill("bad-token");
  await page.locator("#token-import-userid").fill("1");
  await page.locator("#token-import-submit").click();

  await expect.poll(() => state.importCalls.length).toBe(1);
  // 失败必须留在弹窗里，否则用户填的网址/用户ID全丢、得重头填
  await expect(page.locator("#token-import-modal")).toBeVisible();
  await expect(page.locator("#token-import-submit")).toBeEnabled();
  await expect(page.locator("#token-import-submit")).toHaveText("开始导入", "按钮文案必须复原，不能卡在「导入中…」");
  await expect(page.locator("#token-import-base")).toHaveValue("https://relay.example.com", "网址应保留，便于重试");
});

test("缺字段时不发请求（浏览器原生 required 拦住）", async ({ page }) => {
  const state = await openChannelsPage(page);
  await page.locator("#import-test-tokens").click();
  await page.locator("#token-import-base").fill("https://relay.example.com");
  // 故意不填令牌和用户ID
  await page.locator("#token-import-submit").click();
  // 等一小会儿确认确实没发出去
  await page.waitForTimeout(300);
  expect(state.importCalls.length).toBe(0);
  await expect(page.locator("#token-import-modal")).toBeVisible();
});

test("普通管理员(role 10)看不到这个按钮 —— 渠道持 key，只超管可导", async ({ page }) => {
  await installApiFixture(page, { role: 10 });
  await page.goto("/");
  await expect(page.locator(".auth-userbar")).toBeVisible();
  // 非超管连渠道管理入口都被隐藏，按钮自然不可见
  await expect(page.locator("#import-test-tokens")).toBeHidden();
});

test("提交期间按钮禁用且文案变「导入中…」，防重复点", async ({ page }) => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const state = { importCalls: [] };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/auth/me") return json({ user: { username: "super-admin", role: 100, canConfig: true } });
    if (path === "/api/channels") return json(channels);
    if (path === "/api/model-targets") return json([]);
    if (path === "/api/profiles" || path === "/api/scenarios" || path === "/api/requests/recent" || path === "/api/test-runs/recent")
      return json([]);
    if (path === "/api/settings") return json({});
    if (path === "/api/high-risk-alerts") return json([]);
    if (path === "/api/tasks/recent") return json([]);
    if (path === "/api/channels/import-test-tokens" && request.method() === "POST") {
      state.importCalls.push(request.postDataJSON());
      await gate; // 卡住响应，好观察「导入中」这个中间态
      return json({
        ok: true,
        summary: { total: 1, imported: 1, updated: 0, newTargets: 1, disabled: 0, noGroup: 0, noModels: 0, mixedProtocol: 0 },
      });
    }
    return json({});
  });
  await page.goto("/");
  await expect(page.locator(".auth-userbar")).toBeVisible();
  await page.locator('[data-page="channels"]').click();
  await page.locator("#import-test-tokens").click();
  await page.locator("#token-import-base").fill("https://relay.example.com");
  await page.locator("#token-import-token").fill("tok-abc");
  await page.locator("#token-import-userid").fill("1");

  const submit = page.locator("#token-import-submit");
  await submit.click();
  await expect(submit).toBeDisabled();
  await expect(submit).toHaveText("导入中…");
  // 禁用期间再点几次，不该发出第二个请求
  await submit.click({ force: true }).catch(() => {});
  await submit.click({ force: true }).catch(() => {});
  expect(state.importCalls.length).toBe(1);

  release();
  await expect(page.locator("#token-import-modal")).toBeHidden();
  await expect(submit).toBeEnabled();
});
