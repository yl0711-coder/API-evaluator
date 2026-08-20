// shared/newapi-token-keyword.mjs
// 「从 new-api 上游渠道导入测试分组」的令牌筛选关键词，前后端共用同一份定义。
//
// 为什么放 shared/：后端 server/newapi-token-plan.mjs 用它过滤令牌，前端 src/channel-admin.js
// 用它写提示文案。两边各写一份字面量，改口径时漏掉一边就会出现「提示说筛『测试』、实际筛别的」
// 这类对不上的情况——同一个常量只定义一次。
export const TEST_TOKEN_KEYWORD = "测试";

export function isTestTokenName(name) {
  return String(name || "").includes(TEST_TOKEN_KEYWORD);
}
