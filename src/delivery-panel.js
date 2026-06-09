import {
  buildHandoffTemplate,
  buildModelComparisonGroups,
  buildRankingRows,
  getLatestRuns,
  renderInsightCards,
  renderModelComparisonList,
  renderPlainConclusion,
  renderRankingList,
} from "./delivery-view.js";
import { renderProjectInfoSummary } from "./project-info.js";

export function renderDeliveryPanels({
  state,
  plainConclusion,
  projectInfoSummary,
  reportInsights,
  rankingList,
  modelComparisonList,
  handoffSummary,
  handoffTemplate,
}) {
  const latestRuns = getLatestRuns(state);
  plainConclusion.innerHTML = renderPlainConclusion(latestRuns);
  projectInfoSummary.innerHTML = renderProjectInfoSummary(state.projectInfo);
  reportInsights.innerHTML = renderInsightCards(latestRuns, { compact: true });
  const rankingRows = buildRankingRows(state.testRuns);
  rankingList.innerHTML = renderRankingList(rankingRows);
  modelComparisonList.innerHTML = renderModelComparisonList(buildModelComparisonGroups(rankingRows));
  handoffSummary.innerHTML = renderInsightCards(latestRuns, { compact: false });
  handoffTemplate.textContent = buildHandoffTemplate(latestRuns, state.projectInfo, rankingRows);
}
