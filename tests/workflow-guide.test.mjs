import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkflowStatus, getNextWorkflowStep, renderNextActionHtml } from "../src/workflow-guide.js";

test("workflow guide points operators to the next missing step", () => {
  const emptyStatus = buildWorkflowStatus({ profiles: [], channels: [], modelTargets: [], requests: [], testRuns: [] });
  assert.equal(getNextWorkflowStep(emptyStatus).step, "channels");

  // 有渠道但还没配模型 -> 引导去配模型
  const channelOnly = buildWorkflowStatus({ profiles: [], channels: [{ id: "c1" }], modelTargets: [], requests: [], testRuns: [] });
  assert.equal(getNextWorkflowStep(channelOnly).step, "models");

  // 渠道 + 模型目标齐 -> 去准入
  const ready = buildWorkflowStatus({ profiles: [], channels: [{ id: "c1" }], modelTargets: [{ channelId: "c1", model: "m" }], requests: [], testRuns: [] });
  assert.equal(getNextWorkflowStep(ready).step, "admission");

  // 老的孤儿 profile（渠道+模型二合一）也算就绪 -> 去准入
  const quickStatus = buildWorkflowStatus({
    profiles: [{ role: "target" }],
    requests: [],
    testRuns: [],
  });
  assert.equal(getNextWorkflowStep(quickStatus).step, "admission");

  const admissionStatus = buildWorkflowStatus({
    profiles: [{ role: "target" }],
    requests: [],
    testRuns: [{ type: "admission" }],
  });
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
