// server/scenarios/index.mjs
// 场景聚合入口。真源与运行态在 store.mjs（内存表 + 源文件改写）；这里仅再导出，保持既有调用名不变。
// 运行时一律调 getTestScenarios()（按「设置」开关纳入 LiveBench/安全/HLE/HardcoreLogic）。
export {
  getTestScenarios,
  getAllScenariosForAdmin,
  upsertScenario,
  deleteScenario,
  resolveScenarioTag,
  ABILITY_SCENARIOS,
  TEST_SCENARIOS,
} from "./store.mjs";
