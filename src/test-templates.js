import { applyProfileTemplateToForm } from "./operator-guidance.js";

export function applyStabilityTemplate({ form, template, updateEstimates }) {
  const value = template.value;
  const rounds = form.elements.rounds;
  const concurrency = form.elements.concurrency;
  if (value === "smoke") {
    rounds.value = "3";
    concurrency.value = "1";
  } else if (value === "candidate") {
    rounds.value = "30";
    concurrency.value = "1";
  } else if (value === "concurrency") {
    rounds.value = "10";
    concurrency.value = "2";
  } else {
    rounds.value = "10";
    concurrency.value = "1";
  }
  updateEstimates();
}

export function applyBatchTemplate({ form, template, updateEstimates }) {
  const value = template.value;
  form.elements.rounds.value = value === "batch-smoke" ? "3" : value === "batch-candidate" ? "30" : "10";
  form.elements.maxParallelProfiles.value = "2";
  form.elements.concurrency.value = "1";
  updateEstimates();
}

export function applyProfileTemplate({ form, templateSelect, onApplied }) {
  const template = applyProfileTemplateToForm(form, templateSelect.value);
  if (template) {
    onApplied(template);
  }
}
