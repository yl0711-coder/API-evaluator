// server/tokenizer-probes.mjs
//
// 分词器指纹「探针文本」——单一可信源（single source of truth）。
//
// 这组固定文本既用于:
//   1) 用 Claude 官方 count_tokens 建立「精确 token 数基线」(scripts/claude-token-baseline.mjs)
//   2) 将来在准入评测里发给被测渠道,读其 usage.input_tokens 与基线做线性拟合判定家族
//      (reported ≈ slope·exact + intercept,见 token-auditor.mjs 的 auditAbsoluteTokens)
//
// ⚠️ 两处必须用「逐字节相同」的字符串,否则基线对不上 → 误判。所以集中定义在此,谁都别复制改写。
//
// 探针设计目标:让不同分词器家族(Claude vs OpenAI o200k/cl100k vs Llama 等)的 token 数尽量拉开,
//   故刻意覆盖 CJK / emoji / 罕见 Unicode / 代码符号 / 长数字串 / 连续空白 / URL路径 / 重复串,
//   并跨多个长度档(给线性拟合足够的 x 轴跨度去估 slope/intercept)。
//
// 版本号:改动任一探针文本都必须 +1,基线 JSON 会记录它,审计时版本不一致应拒绝比对。
export const TOKENIZER_PROBE_VERSION = "2026.06.17";

export const TOKENIZER_PROBES = [
  {
    id: "p01-en-short",
    category: "english",
    note: "纯 ASCII 英文(基线短)",
    text: "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.",
  },
  {
    id: "p02-en-long",
    category: "english",
    note: "纯英文段落(基线长)",
    text:
      "Tokenization is the process of splitting text into the discrete units a language model actually reads. " +
      "Different model families ship different vocabularies, so the same paragraph can resolve to a noticeably " +
      "different number of tokens depending on which tokenizer produced the count. That divergence is exactly what " +
      "makes the token count usable as a lightweight backend fingerprint.",
  },
  {
    id: "p03-zh-short",
    category: "cjk",
    note: "中文短句(CJK,与 BPE 词表差异大)",
    text: "今天天气很好，我们一起去公园散步，顺便买杯咖啡吧。",
  },
  {
    id: "p04-zh-long",
    category: "cjk",
    note: "中文长段(CJK)",
    text:
      "分词是把文本切成模型真正读取的最小单位的过程。不同的模型家族自带不同的词表，" +
      "因此同一段中文在不同分词器下得到的 token 数往往明显不同。正是这种系统性的差异，" +
      "让「输入 token 数」可以当作一种轻量的后端指纹：如果某个渠道声称自己是 Claude，" +
      "那么它返回的输入 token 数就应当与官方分词器算出的数值高度线性一致。",
  },
  {
    id: "p05-emoji",
    category: "emoji",
    note: "emoji 连串(含变体选择符/ZWJ,各家切法差异极大)",
    text: "🚀🔥😀🎉🌟 💡🧠📊🔬⚙️ 🌍🦄🍕🎯✨ 🛰️🧬🪐👩‍🚀👨‍👩‍👧‍👦 🏳️‍🌈🧑‍💻🤖",
  },
  {
    id: "p06-mixed",
    category: "mixed",
    note: "中英数字标点混排(真实日志样态)",
    text: "用户 user_42 于 2026-06-17 14:30:00 调用了 /v1/chat/completions，返回 200 OK（耗时 123ms，消耗 4096 tokens）。",
  },
  {
    id: "p07-code-json",
    category: "code",
    note: "JSON 代码(密集括号/引号/冒号)",
    text:
      '{"model":"claude-opus-4-8","stream":false,"messages":[{"role":"user",' +
      '"content":"hi"}],"max_tokens":1024,"metadata":{"id":"req_001","nested":{"a":[1,2,3],"b":null,"c":true}}}',
  },
  {
    id: "p08-code-py",
    category: "code",
    note: "Python 代码(缩进/运算符/下划线)",
    text:
      "def fibonacci(n: int) -> list[int]:\n" +
      "    seq = [0, 1]\n" +
      "    while len(seq) < n:\n" +
      "        seq.append(seq[-1] + seq[-2])\n" +
      "    return seq[:n]\n\n" +
      "print([x**2 for x in fibonacci(10) if x % 2 == 0])",
  },
  {
    id: "p09-digits",
    category: "digits",
    note: "长数字串(数字分组规则各家不同)",
    text: "3141592653589793238462643383279502884197 16939937510582097494459230781640628620899 8628034825342117067",
  },
  {
    id: "p10-whitespace",
    category: "whitespace",
    note: "连续空白(空格/制表/换行,合并行为各家不同)",
    text: "alpha    beta\t\t\tgamma\n\n\n   delta\t \t epsilon          zeta\n\t\neta",
  },
  {
    id: "p11-unicode-rare",
    category: "unicode",
    note: "罕见 Unicode:数学符号 + 组合附加符 + 生僻汉字",
    text: "ℕ⊆ℤ⊆ℚ⊆ℝ⊆ℂ ∀ε>0 ∃δ>0 ∑∞ ∫∂∇ Z̷̧͝a̴l̶g̵o̶ 龘靐齉爩 𠮷 café naïve",
  },
  {
    id: "p12-url-path",
    category: "url",
    note: "URL / 文件路径(斜杠/查询串/反斜杠)",
    text: "https://api.example.com/v1/users?id=123&token=abc-XYZ_98.def#section-2 /usr/local/bin/node C:\\\\Windows\\\\System32\\\\cmd.exe",
  },
  {
    id: "p13-repeat",
    category: "repeat",
    note: "高重复串(测合并/压缩行为)",
    text: "spam spam spam spam spam lovely spam wonderful spam " + "ha".repeat(40),
  },
  {
    id: "p14-markdown",
    category: "markdown",
    note: "Markdown 结构(标记符号密集)",
    text:
      "# 标题 Heading\n\n" +
      "- **粗体** 与 *斜体* 和 `inline code`\n" +
      "- [链接](https://example.com) 与 ![图片](img.png)\n\n" +
      "> 引用块 blockquote\n\n" +
      "| 列A | 列B |\n|-----|-----|\n| 1 | 2 |",
  },
];

// 便捷查找(审计阶段按 id 取回完全相同的文本)。
export function getProbeById(id) {
  return TOKENIZER_PROBES.find((p) => p.id === id) || null;
}
