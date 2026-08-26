import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkflowStatus, getNextWorkflowStep, renderNextActionHtml } from "../src/workflow-guide.js";

test("workflow guide points operators to the next missing step", () => {
  const emptyStatus = buildWorkflowStatus({ profiles: [], channels: [], modelTargets: [], requests: [], testRuns: [] });
  assert.equal(getNextWorkflowStep(emptyStatus).step, "channels");

  // 有渠道但还没配模型 -> 引导去配模型
  const channelOnly = buildWorkflowStatus({ profiles: [], channels: [{ id: "c1" }], modelTargets: [], requests: [], testRuns: [] });
  assert.equal(getNextWorkflowStep(channelOnly).step, "models");

  // 渠道 + 模型目标齐 -> 直接去标准评测。
  // 准入评测已归入侧边栏「高级测试」组，是可选的深入手段，不再是标准评测的前置门槛；
  // 推荐流程只剩 渠道→模型→标准（→交付），仪表盘流程条也同步去掉了「准入」那一环。
  const ready = buildWorkflowStatus({
    profiles: [],
    channels: [{ id: "c1" }],
    modelTargets: [{ channelId: "c1", model: "m" }],
    requests: [],
    testRuns: [],
  });
  assert.equal(getNextWorkflowStep(ready).step, "standard");

  // 老的孤儿 profile（渠道+模型二合一）也算就绪 -> 同样直接去标准评测
  const quickStatus = buildWorkflowStatus({
    profiles: [{ role: "target" }],
    requests: [],
    testRuns: [],
  });
  assert.equal(getNextWorkflowStep(quickStatus).step, "standard");

  // 只跑过准入：status.admission 仍会被算出来（其它地方可能用），但它不再让引导跳过标准评测——
  // 没有非准入类报告时，下一步依然是标准评测。
  const admissionStatus = buildWorkflowStatus({
    profiles: [{ role: "target" }],
    requests: [],
    testRuns: [{ type: "admission" }],
  });
  assert.equal(admissionStatus.admission, true);
  assert.equal(admissionStatus.standard, false);
  assert.equal(getNextWorkflowStep(admissionStatus).step, "standard");

  const handoffStatus = buildWorkflowStatus({
    profiles: [{ role: "target" }],
    requests: [{ success: true }],
    testRuns: [{ type: "stability" }, { type: "scenario" }],
  });
  assert.equal(getNextWorkflowStep(handoffStatus).step, "handoff");
  assert.equal(handoffStatus.reports, true);
  assert.equal(handoffStatus.handoff, false);
});

test("workflow guide escapes operator-facing html", () => {
  const html = renderNextActionHtml({
    page: "profiles",
    title: "<script>alert(1)</script>",
    detail: "safe",
    button: "go",
  });

  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});
