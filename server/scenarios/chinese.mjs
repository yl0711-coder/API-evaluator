// server/scenarios/chinese.mjs
//
// 中文能力场景集。国内厂商/中文业务必测维度。
//
// 诚实边界：这是**自编的代表性中文测试集，不是官方 CMMLU/C-Eval 原题**。
//   - 不臆造、不冒充官方 benchmark 条目（那需要原数据集 + 授权 + 防污染处理）。
//   - 当前用现有关键词/长度启发式评分（与其它场景一致），是粗筛级别。
//   - 后续可作为校准步骤：导入官方 CMMLU/C-Eval 子集 + 升级为 MCQ 精确判分。
//
// 覆盖：中文知识、中文推理、中文写作、指令遵循、语言理解、结构化输出。
// 统一 category="chinese"，在报告里作为"中文能力"维度聚合。

export const CHINESE_SCENARIOS = [
  {
    id: "chinese-knowledge-history",
    name: "中文知识：历史常识",
    category: "chinese",
    difficulty: "normal",
    prompt: [
      "你是一名中国历史老师。请用中文向学生简述“安史之乱”：它发生在哪个朝代、大致哪个世纪，以及对该王朝的主要影响。",
      "要求：史实准确，条理清楚，不要编造。",
    ].join("\n"),
    minChars: 80,
    requiredAny: ["唐", "唐朝", "8世纪", "八世纪", "由盛转衰", "藩镇"],
  },
  {
    id: "chinese-reasoning-work",
    name: "中文推理：应用题分步",
    category: "chinese",
    difficulty: "complex",
    prompt: [
      "你是一名数学老师。请用中文分步解答下面的应用题，写出每一步推理，并在最后单独给出最终答案：",
      "一项工程，甲单独做需要 12 天，乙单独做需要 18 天。两人合作 4 天后，乙因故离开，",
      "剩下的工作由甲单独完成。问甲还需要多少天才能完成？",
    ].join("\n"),
    minChars: 120,
    // 正确答案 16/3 ≈ 5.33 天；合作效率 5/36，4 天完成 5/9，剩余 4/9。
    requiredAny: ["16/3", "5.33", "5又", "4/9", "5/36"],
  },
  {
    id: "chinese-writing-notice",
    name: "中文写作：正式通知",
    category: "chinese",
    difficulty: "normal",
    prompt: [
      "你是公司的行政专员。请用中文写一则不超过 150 字的正式通知：",
      "公司本周五下午两点举行全员安全演练，地点在一楼大厅，要求携带工牌、准时参加。",
      "语气正式、条理清楚，不要夸张。",
    ].join("\n"),
    minChars: 80,
    requiredAny: ["演练", "周五", "一楼", "工牌", "准时"],
  },
  {
    id: "chinese-instruction-format",
    name: "中文指令遵循：严格格式",
    category: "chinese",
    difficulty: "normal",
    prompt: [
      "请严格按以下格式用中文输出，不要任何多余文字：",
      "第一行以“标题：”开头，后接一个不超过 10 个字的标题；",
      "第二行以“要点：”开头，后接三个用顿号（、）分隔的要点。",
      "主题：远程办公的好处。",
    ].join("\n"),
    minChars: 30,
    requiredAny: ["标题：", "要点：", "、"],
    // 用 IFEval 可验证判分替代关键词软匹配：必须含两个标签 + 顿号分隔
    scorer: "ifeval",
    instructions: [
      { type: "include_keyword", keyword: "标题：" },
      { type: "include_keyword", keyword: "要点：" },
      { type: "include_keyword", keyword: "、" },
    ],
  },
  {
    id: "chinese-language-idiom",
    name: "中文语言：成语理解",
    category: "chinese",
    difficulty: "normal",
    prompt: [
      "你是一名语文老师。请用中文解释成语“画蛇添足”的含义，并给出一个现代生活或工作中的使用例句。",
      "要求：解释准确，例句自然。",
    ].join("\n"),
    minChars: 60,
    requiredAny: ["多余", "多此一举", "弄巧成拙", "本来", "例句"],
  },
  {
    id: "chinese-structured-json",
    name: "中文结构化：JSON 简评",
    category: "chinese",
    difficulty: "normal",
    prompt: [
      "你是一名中文 AI 客服渠道的评审员。请对该渠道做简评，只输出 JSON，不要输出 Markdown。",
      "JSON 字段必须包含：",
      "模型表现（中文字符串）、主要风险（字符串数组，至少 2 项）、是否推荐（布尔）、理由（中文字符串）。",
    ].join("\n"),
    minChars: 80,
    expectsJson: true,
    requiredAny: ["模型表现", "主要风险", "是否推荐", "理由"],
  },
];
