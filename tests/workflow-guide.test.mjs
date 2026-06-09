import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkflowStatus, getNextWorkflowStep, renderNextActionHtml } from "../src/workflow-guide.js";

test("workflow guide points operators to the next missing step", () => {
  const emptyStatus = buildWorkflowStatus({ profiles: [], requests: [], testRuns: [] });
  assert.equal(getNextWorkflowStep(emptyStatus).step, "profiles");

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
