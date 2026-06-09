import {
  estimateBatchCost,
  estimateScenarioCost,
  estimateStabilityCost,
  formatEstimate,
} from "./cost-estimates.js";

export function updateEstimateLabels({
  stabilityForm,
  stabilityEstimate,
  batchForm,
  batchProfileSelect,
  batchEstimate,
  scenarioForm,
  scenarioProfileSelect,
  scenarioCaseSelect,
  scenarioEstimate,
  scenarios,
}) {
  stabilityEstimate.textContent = formatEstimate(estimateStabilityCost(Object.fromEntries(new FormData(stabilityForm).entries())));

  const batchPayload = Object.fromEntries(new FormData(batchForm).entries());
  batchPayload.profileIds = Array.from(batchProfileSelect.selectedOptions).map((option) => option.value);
  batchEstimate.textContent = formatEstimate(estimateBatchCost(batchPayload));

  const scenarioPayload = Object.fromEntries(new FormData(scenarioForm).entries());
  scenarioPayload.profileIds = Array.from(scenarioProfileSelect.selectedOptions).map((option) => option.value);
  scenarioPayload.scenarioIds = Array.from(scenarioCaseSelect.selectedOptions).map((option) => option.value);
  scenarioEstimate.textContent = formatEstimate(estimateScenarioCost(scenarioPayload, scenarios));
}
