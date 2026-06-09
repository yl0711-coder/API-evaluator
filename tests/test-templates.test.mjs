import assert from "node:assert/strict";
import test from "node:test";
import { applyScenarioTemplate } from "../src/test-templates.js";

test("safety template does not select all scenarios when safety scenarios are hidden", () => {
  const form = {
    elements: {
      repeats: {},
      maxParallelProfiles: {},
      requestConcurrency: {},
    },
  };
  const scenarioSelect = {
    options: [
      { value: "connectivity-basic", selected: true },
      { value: "coding-debug", selected: true },
    ],
  };

  applyScenarioTemplate({
    form,
    template: { value: "scenario-safety" },
    scenarios: [
      { id: "connectivity-basic", category: "connectivity" },
      { id: "coding-debug", category: "coding" },
    ],
    scenarioSelect,
    hint: null,
    updateEstimates: () => {},
  });

  assert.deepEqual(scenarioSelect.options.map((option) => option.selected), [false, false]);
  assert.equal(form.elements.repeats.value, "1");
});
