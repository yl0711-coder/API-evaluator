// e2e/sub2api-channel-display.spec.mjs
// 验证前端渠道列表正确显示 sub2api 来源渠道的密钥 ID、分组名等元信息。
import { expect, test } from "@playwright/test";

const channels = [
  {
    id: "sub2api-key-abc123-5",
    name: "测试-Claude",
    status: "enabled",
    hasKey: true,
    protocol: "claude_messages",
    models: ["claude-opus-4", "claude-sonnet-4"],
    source: "sub2api",
    sub2apiKeyId: 5,
    sub2apiGroupId: 3,
    sub2apiGroupName: "Claude 组",
  },
  {
    id: "sub2api-key-def456-7",
    name: "测试-OpenAI",
    status: "enabled",
    hasKey: true,
    protocol: "openai_compatible",
    models: ["gpt-4o"],
    source: "sub2api",
    sub2apiKeyId: 7,
    sub2apiGroupId: 7,
    sub2apiGroupName: "OpenAI 组",
  },
  {
    id: "manual-channel",
    name: "手动配置渠道",
    status: "enabled",
    hasKey: true,
    protocol: "openai_compatible",
    models: ["gpt-4"],
    source: "",
  },
];

async function installApiFixture(page) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/api/auth/me")
      return json({ user: { username: "super-admin", role: 100, canConfig: true } });
    if (path === "/api/channels") return json(channels);
    if (path === "/api/model-targets") return json([]);
    if (
      path === "/api/profiles" ||
      path === "/api/scenarios" ||
      path === "/api/requests/recent" ||
      path === "/api/test-runs/recent"
    )
      return json([]);
    if (path === "/api/settings") return json({});
    if (path === "/api/high-risk-alerts") return json([]);
    if (path === "/api/tasks/recent") return json([]);
    if (path === "/api/reports/files" || path === "/api/reports") return json([]);
    return json({});
  });
}

async function openChannelsPage(page) {
  await installApiFixture(page);
  await page.goto("/");
  await expect(page.locator(".auth-userbar")).toBeVisible();
  await page.locator('[data-page="channels"]').click();
  await expect(page.locator("#channels")).toHaveClass(/active/);
}

test("sub2api 渠道显示密钥 ID 和分组名", async ({ page }) => {
  await openChannelsPage(page);
  const list = page.locator("#channel-list");
  await expect(list).toBeVisible();

  // 第一个渠道：Claude 组，密钥 ID 5
  const row1 = list.locator(".chan-row").nth(0);
  await expect(row1.locator("b")).toHaveText("测试-Claude");
  await expect(row1.locator("small")).toContainText("分组 Claude 组");
  await expect(row1.locator("small")).toContainText("密钥 ID 5");
  await expect(row1.locator("small")).toContainText("来自 sub2api");

  // 第二个渠道：OpenAI 组，密钥 ID 7
  const row2 = list.locator(".chan-row").nth(1);
  await expect(row2.locator("b")).toHaveText("测试-OpenAI");
  await expect(row2.locator("small")).toContainText("分组 OpenAI 组");
  await expect(row2.locator("small")).toContainText("密钥 ID 7");
  await expect(row2.locator("small")).toContainText("来自 sub2api");

  // 第三个渠道：手动配置，不显示 sub2api 信息
  const row3 = list.locator(".chan-row").nth(2);
  await expect(row3.locator("b")).toHaveText("手动配置渠道");
  await expect(row3.locator("small")).not.toContainText("来自 sub2api");
  await expect(row3.locator("small")).not.toContainText("密钥 ID");
});

test("sub2api 渠道缺少分组名时不显示分组字段", async ({ page }) => {
  // 模拟回落路径：模型广场未启用，拿不到分组名
  const fallbackChannels = [
    {
      id: "sub2api-key-xyz-9",
      name: "测试-回落",
      status: "enabled",
      hasKey: true,
      protocol: "openai_compatible",
      models: ["model-a"],
      source: "sub2api",
      sub2apiKeyId: 9,
      sub2apiGroupId: null,
      sub2apiGroupName: "",
    },
  ];

  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/api/auth/me")
      return json({ user: { username: "super-admin", role: 100, canConfig: true } });
    if (path === "/api/channels") return json(fallbackChannels);
    if (path === "/api/model-targets") return json([]);
    if (
      path === "/api/profiles" ||
      path === "/api/scenarios" ||
      path === "/api/requests/recent" ||
      path === "/api/test-runs/recent"
    )
      return json([]);
    if (path === "/api/settings") return json({});
    if (path === "/api/high-risk-alerts") return json([]);
    if (path === "/api/tasks/recent") return json([]);
    if (path === "/api/reports/files" || path === "/api/reports") return json([]);
    return json({});
  });

  await page.goto("/");
  await expect(page.locator(".auth-userbar")).toBeVisible();
  await page.locator('[data-page="channels"]').click();

  const row = page.locator("#channel-list .chan-row").first();
  await expect(row.locator("b")).toHaveText("测试-回落");
  await expect(row.locator("small")).toContainText("密钥 ID 9");
  await expect(row.locator("small")).toContainText("来自 sub2api");
  // 分组名为空时不显示「分组」字段
  await expect(row.locator("small")).not.toContainText("分组");
});
