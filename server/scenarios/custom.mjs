// server/scenarios/custom.mjs
// 开发者页「新增场景」的落点。常开 bank。由 server/scenarios/store.mjs 在保存时改写本文件。
export const CUSTOM_SCENARIOS = [
  {
    "id": "test",
    "name": "test_nobody",
    "category": "basic",
    "difficulty": "small",
    "prompt": "你是全自动收到机，请你输出“收到”，并简要回答自己输出“收到”的原因。",
    "minChars": 1,
    "requiredAny": [
      "收到",
      "收到",
      "收到",
      "收到"
    ],
    "tag": "测试",
    "group": "测试"
  }
];
