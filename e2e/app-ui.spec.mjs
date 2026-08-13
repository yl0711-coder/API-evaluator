import { expect, test } from "@playwright/test";

const channels = [{ id: "channel-1", name: "评测渠道", status: "enabled", aliases: [] }];
const modelTargets = [
  { id: "target-a", channelId: "channel-1", channelName: "评测渠道", model: "模型 A", aliases: [] },
  { id: "target-b", channelId: "channel-1", channelName: "评测渠道", model: "模型 B", aliases: [] },
];

function taskSnapshot({ status = "running", progress = 40, message = "正在执行", payload = { profileIds: ["target-a"] } } = {}) {
  return {
    taskId: "task-e2e-1",
    type: "admission-suite",
    status,
    progress,
    completedUnits: status === "completed" ? 2 : 1,
    totalUnits: 2,
    createdAt: "2026-08-11T08:00:00.000Z",
    startedAt: "2026-08-11T08:00:01.000Z",
    endedAt: status === "running" ? null : "2026-08-11T08:00:04.000Z",
    message,
    payload,
    steps: [
      {
        groupKey: "target-a",
        groupLabel: "模型 A",
        stepName: "admission",
        stepLabel: "准入评测",
        executionStatus: status === "running" ? "running" : "completed",
        verdict: status === "completed" ? "passed" : null,
        summary: message,
      },
    ],
  };
}

function comparisonFixture() {
  return {
    reportId: "e2e-compare-report",
    markdown: "# 对比报告",
    notes: { a: "1 场景 / 1 稳定性 / 1 准入", b: "1 场景 / 1 稳定性 / 1 准入" },
    comparison: {
      subjects: {
        a: { label: "对象 A 显示名很长，用于窄屏横向滚动验证" },
        b: { label: "对象 B 显示名很长，用于窄屏横向滚动验证" },
      },
      summary: [
        { id: "overall-score", label: "综合相对分", valueA: 82.5, valueB: 71.2, unit: "分", winner: "a" },
        { id: "ttft", label: "P50 首 Token 延迟", valueA: 380, valueB: 520, format: "milliseconds", winner: "a" },
      ],
      scenarios: [
        {
          name: "复杂检索",
          tier: "困难",
          winner: "a",
          a: { quality: 91, passRate: 1, avgMs: 860, p50FirstTokenMs: 380, outputTokens: 1600, cacheReadTokens: 320 },
          b: { quality: 83, passRate: 0.8, avgMs: 1120, p50FirstTokenMs: 520, outputTokens: 1900, cacheReadTokens: 180 },
        },
      ],
    },
  };
}

function multiComparisonFixture() {
  return {
    comparison: {
      subjects: [{ label: "评测渠道 / 模型 A" }, { label: "评测渠道 / 模型 B" }],
      sharedScenarioCount: 1,
      summary: [{ label: "综合相对分", values: [{ value: 50 }, { value: 62 }], bestIndex: 1 }],
      scenarios: [],
    },
    skipped: [],
    notes: { base: "基准报告", peers: [{ label: "评测渠道 / 模型 B", used: "对比报告" }] },
  };
}

async function installApiFixture(page, { role = 10, taskMode = "completed" } = {}) {
  const state = { cancelCalls: 0, detailReads: 0, compareRequests: [], multiCompareRequests: [] };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/api/auth/me")
      return json({ user: { username: role >= 100 ? "super-admin" : "operator", role, canConfig: role >= 100 } });
    if (path === "/api/channels") return json(channels);
    if (path === "/api/model-targets") return json(modelTargets);
    if (path === "/api/profiles" || path === "/api/scenarios" || path === "/api/requests/recent" || path === "/api/test-runs/recent")
      return json([]);
    if (path === "/api/settings") return json({});
    if (path === "/api/high-risk-alerts") return json([]);

    if (path === "/api/tasks/recent") {
      if (taskMode === "none") return json([]);
      if (taskMode === "cancel")
        return json([
          taskSnapshot({
            status: state.cancelCalls ? "cancelled" : "running",
            progress: state.cancelCalls ? 40 : 25,
            message: state.cancelCalls ? "任务已取消。" : "等待取消",
          }),
        ]);
      if (taskMode === "poll")
        return json([
          taskSnapshot({
            status: state.detailReads > 1 ? "completed" : "running",
            progress: state.detailReads > 1 ? 100 : 40,
            message: state.detailReads > 1 ? "任务已完成。" : "正在执行",
          }),
        ]);
      return json([taskSnapshot({ status: "completed", progress: 100, message: "任务已完成。" })]);
    }
    if (path === "/api/tasks/task-e2e-1/cancel" && request.method() === "POST") {
      state.cancelCalls += 1;
      return json(taskSnapshot({ status: "cancelled", message: "任务已取消。" }));
    }
    if (path === "/api/tasks/task-e2e-1") {
      state.detailReads += 1;
      if (taskMode === "cancel")
        return json(
          taskSnapshot({
            status: state.cancelCalls ? "cancelled" : "running",
            progress: 40,
            message: state.cancelCalls ? "任务已取消。" : "等待取消",
          }),
        );
      if (taskMode === "poll")
        return json(
          taskSnapshot({
            status: state.detailReads > 1 ? "completed" : "running",
            progress: state.detailReads > 1 ? 100 : 40,
            message: state.detailReads > 1 ? "任务已完成。" : "正在执行",
          }),
        );
      return json(taskSnapshot({ status: "completed", progress: 100, message: "任务已完成。" }));
    }

    if (path === "/api/reports/compare/scenarios") return json({ scenarios: [{ name: "复杂检索", tier: "困难" }] });
    if (path === "/api/reports/compare/gaps") return json({ onlyA: [], onlyB: [] });
    if (path === "/api/reports/compare/peers" && request.method() === "POST") {
      return json({
        peers: [
          {
            targetId: "target-b",
            channel: "评测渠道",
            model: "模型 B",
            compareCount: 1,
            lastComparedAt: "2026-08-11T08:00:00.000Z",
          },
        ],
      });
    }
    if (path === "/api/reports/compare/multi" && request.method() === "POST") {
      state.multiCompareRequests.push(request.postDataJSON());
      return json(multiComparisonFixture());
    }
    if (path === "/api/reports/compare" && request.method() === "POST") {
      state.compareRequests.push(request.postDataJSON());
      return json(comparisonFixture());
    }
    if (path === "/api/reports/files" || path === "/api/reports") return json([]);
    return json({});
  });
  return state;
}

async function openApp(page, options) {
  const state = await installApiFixture(page, options);
  await page.goto("/");
  await expect(page.locator(".auth-userbar")).toBeVisible();
  return state;
}

async function openTaskDetail(page) {
  await page.getByRole("button", { name: "任务中心" }).click();
  await expect(page.locator("#tc-list [data-tc-detail]")).toBeVisible();
  await page.locator("#tc-list [data-tc-detail]").click();
  await expect(page.locator("#tc-detail")).toBeVisible();
}

async function generateComparison(page) {
  await page.getByRole("button", { name: "模型比对" }).click();
  await page.locator("#mc-a-channel").selectOption("channel-1");
  await page.locator("#mc-a-model").selectOption("target-a");
  await page.locator("#mc-b-channel").selectOption("channel-1");
  await page.locator("#mc-b-model").selectOption("target-b");
  await page.locator("#mc-load-scenarios").click();
  await expect(page.locator("#mc-scenarios")).toContainText("复杂检索");
  await page.locator("#mc-form").getByRole("button", { name: "生成对比报告" }).click();
  await expect(page.locator("#mc-result .mc-compare-table")).toBeVisible();
}

test("普通管理员看不到平台级入口", async ({ page }) => {
  await openApp(page, { role: 10, taskMode: "none" });
  await expect(page.locator(".auth-userbar__role")).toHaveText("管理员");
  await expect(page.locator('[data-page="load-test"]')).toBeHidden();
  await expect(page.locator('[data-page="developer"]')).toBeHidden();
});

test("超级管理员可见平台级入口", async ({ page }) => {
  await openApp(page, { role: 100, taskMode: "none" });
  await expect(page.locator(".auth-userbar__role")).toHaveText("超级管理员");
  await expect(page.locator('[data-page="load-test"]')).toBeVisible();
  await expect(page.locator('[data-page="developer"]')).toBeVisible();
});

test("任务中心轮询会把运行中任务刷新为完成", async ({ page }) => {
  await openApp(page, { taskMode: "poll" });
  await openTaskDetail(page);
  await expect(page.locator("#tc-detail")).toContainText("运行中");
  await expect(page.locator("#tc-detail")).toContainText("已完成", { timeout: 5_000 });
  await expect(page.locator("#tc-detail")).toContainText("100%");
});

test("任务中心允许登录用户取消任务", async ({ page }) => {
  const state = await openApp(page, { role: 10, taskMode: "cancel" });
  await openTaskDetail(page);
  await page.locator("#tc-detail [data-tc-cancel]").click();
  await expect(page.locator("#confirm-modal")).toBeVisible();
  await page.locator("#confirm-modal-ok").click();
  await expect.poll(() => state.cancelCalls).toBe(1);
  await expect(page.locator("#tc-detail")).toContainText("已取消", { timeout: 5_000 });
});

test("再测一次只回填标准评测，不会直接创建任务", async ({ page }) => {
  await openApp(page, { taskMode: "completed" });
  await openTaskDetail(page);
  await page.locator("#tc-detail [data-tc-retest]").click();
  await expect(page.locator("#standard-eval")).toHaveClass(/active/);
  await expect(page.locator("#standard-profile-select")).toHaveJSProperty("value", "target-a");
  await expect(page.locator("#standard-eval-submit")).toBeEnabled();
});

test.describe("窄屏模型比对", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("生成直观对比并保留可横向滚动的表格", async ({ page }) => {
    const state = await openApp(page, { taskMode: "none" });
    await generateComparison(page);
    await expect.poll(() => state.compareRequests.length).toBe(1);
    await expect(page.locator(".mc-compare-summary .is-winner")).toHaveCount(2);
    await page.locator(".mc-scenario-details summary").click();
    await expect(page.locator(".mc-scenario-details")).toContainText("复杂检索");
    const dimensions = await page
      .locator("#mc-result .mc-compare-scroll")
      .first()
      .evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
  });
});

test("多模型并排对比会加载历史对手并展示同一基准下的结果", async ({ page }) => {
  const state = await openApp(page, { taskMode: "none" });
  await page.locator('[data-page="model-compare"]').click();
  await page.locator("#mcm-base-channel").selectOption("channel-1");
  await page.locator("#mcm-base-model").selectOption("target-a");
  await page.locator("#mcm-load-peers").click();
  await expect(page.locator("[data-mcm-peer]")).toHaveCount(1);
  await page.locator("[data-mcm-peer]").check();
  await page.locator("#mcm-generate").click();

  await expect.poll(() => state.multiCompareRequests.length).toBe(1);
  expect(state.multiCompareRequests[0]).toMatchObject({
    base: { targetId: "target-a" },
    peers: [{ targetId: "target-b" }],
  });
  await expect(page.locator("#mcm-result .mc-compare-table")).toBeVisible();
  await expect(page.locator("#mcm-result .mc-compare-summary .is-base")).toContainText("50");
  await expect(page.locator("#mcm-result .mc-compare-summary .is-winner")).toContainText("62");
});
