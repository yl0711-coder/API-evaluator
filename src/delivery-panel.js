import {
  buildHandoffTemplate,
  buildModelComparisonGroups,
  buildRankingRows,
  getLatestRuns,
  renderInsightCards,
  renderModelComparisonList,
  renderRankingList,
} from "./delivery-view.js";
import { renderProjectInfoSummary } from "./project-info.js";

export function renderDeliveryPanels({
  state,
  projectInfoSummary,
  reportInsights,
  rankingList,
  modelComparisonList,
  handoffSummary,
  handoffTemplate,
}) {
  const latestRuns = getLatestRuns(state);
  projectInfoSummary.innerHTML = renderProjectInfoSummary(state.projectInfo);
  reportInsights.innerHTML = renderInsightCards(latestRuns, { compact: true });
  const rankingRows = buildRankingRows(state.testRuns);
  rankingList.innerHTML = renderRankingList(rankingRows);
  modelComparisonList.innerHTML = renderModelComparisonList(buildModelComparisonGroups(rankingRows));
  handoffSummary.innerHTML = renderInsightCards(latestRuns, { compact: false });
  handoffTemplate.textContent = buildHandoffTemplate(latestRuns, state.projectInfo, rankingRows);
}
