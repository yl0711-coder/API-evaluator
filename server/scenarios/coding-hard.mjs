// server/scenarios/coding-hard.mjs
//
// 「编程硬核」题库：针对前沿模型高失败区（精细算法推理 / 复杂分类讨论 / 非标准博弈 / 对抗性精确模拟）
// 的自制硬题。参考 LiveCodeBench Pro（arXiv:2506.11928）的结论——前沿模型在 hard 档 pass@1≈0%，
// 且套路题会做、"unseen hard"就崩——故这里的题都是新颖、非教科书的组合。
//
// 判分方案①：本平台不跑测试用例，只能比对唯一确定答案。所以每题都要求模型
//   「写出解决该问题的程序，并给出它在指定输入上的运行结果」，用 scorer=exact 比对那个结果。
//   写错代码 → 结果就错，藏不住。答案（expected）均已在本机用暴力/交叉验证算出并锁定：
//     A 组合计数 = 121626（DP 已用 L=1..10 暴力交叉验证）
//     B 非标准博弈 nim-sum = 6（各堆 Grundy [3,6,3,4,4]）
//     C 对抗性 8-bit 模拟 = 171
//
// 默认关闭，经 设置→场景测试题库「加入 编程硬核」(settings.enableCodingHard) 开启（见 store.mjs 的 BANK_META）。
// exact 判分器优先从 <solution>…</solution> 抽取答案（见 benchmark-scorers.mjs extractAnswer）。

export const CODING_HARD_SCENARIOS = [
  {
    id: "coding-hard-count-automaton",
    name: "编程硬核：约束组合计数",
    category: "coding",
    difficulty: "complex",
    maxTokens: 8192,
    prompt: [
      "Write a program (in any language) that counts the number of strings of length exactly 24 over the alphabet {a, b, c} satisfying ALL of the following conditions simultaneously:",
      "  1. No two adjacent characters are equal (no `aa`, `bb`, or `cc`).",
      "  2. The string contains neither `abc` nor `cba` as a contiguous substring.",
      "  3. The number of `a` characters in the string is even (0 counts as even).",
      "",
      "Design the counting logic carefully (an automaton/DP over the last two characters plus the parity of the `a` count works), then compute the exact total.",
      "",
      "Reason briefly (a few sentences at most) so your output is not cut off, then put ONLY the final integer count inside <solution></solution> tags. The <solution> block must be the last thing you output.",
    ].join("\n"),
    scorer: "exact",
    expected: "121626",
  },
  {
    id: "coding-hard-grundy-game",
    name: "编程硬核：非标准博弈 Grundy",
    category: "coding",
    difficulty: "complex",
    maxTokens: 8192,
    prompt: [
      "Two players play a combinatorial game on piles of stones. The initial position has 5 piles with sizes: [10, 17, 23, 29, 34].",
      "Players alternate turns. On a turn a player must make exactly one move on exactly one pile, choosing either:",
      "  (i)  remove exactly s stones from a pile, where s is a perfect square (1, 4, 9, 16, 25, ...) and s is at most that pile's current size; or",
      "  (ii) take a pile of size at least 2 and split it into two nonempty piles whose sizes are DIFFERENT from each other.",
      "This is normal play: the player who cannot move (no pile allows any legal move) loses.",
      "",
      "Write a program that computes the Sprague-Grundy value of a single pile of size n (memoized recursion over both move types), evaluates it for each of the 5 piles, and outputs the XOR (nim-sum) of the five Grundy values.",
      "",
      "Reason briefly (a few sentences at most) so your output is not cut off, then put ONLY that nim-sum (a single nonnegative integer) inside <solution></solution> tags. The <solution> block must be the last thing you output.",
    ].join("\n"),
    scorer: "exact",
    expected: "6",
  },
  {
    id: "coding-hard-vm-sim",
    name: "编程硬核：对抗性精确模拟",
    category: "coding",
    difficulty: "complex",
    maxTokens: 8192,
    prompt: [
      "Simulate the following process exactly. You have an 8-bit register R holding an integer in 0..255; every assignment to R is taken modulo 256. R starts at 100.",
      "For step = 1, 2, 3, ..., 1000 (in increasing order), first apply the MAIN operation for that step:",
      "  - if step is prime:                 R = (R * 3 + 1) mod 256",
      "  - else if step is divisible by 6:   R = R XOR 181            (181 = 0b10110101)",
      "  - else:                             R = (R + step) mod 256",
      "Then, within the SAME step and after the main operation, apply a CORRECTION:",
      "  - if the number of 1-bits in R's 8-bit binary representation (its popcount) is odd, set R = (R + 7) mod 256; otherwise leave R unchanged.",
      "",
      "Write a program that runs all 1000 steps in order and reports the final value of R (an integer in 0..255).",
      "",
      "Reason briefly (a few sentences at most) so your output is not cut off, then put ONLY the final value of R inside <solution></solution> tags. The <solution> block must be the last thing you output.",
    ].join("\n"),
    scorer: "exact",
    expected: "171",
  },
  {
    id: "coding-hard-digit-count",
    name: "编程硬核：数位约束计数",
    category: "coding",
    difficulty: "complex",
    maxTokens: 8192,
    prompt: [
      "Write a program (in any language) that counts how many integers n in the range 1 to 2000000 (inclusive) satisfy ALL of the following conditions:",
      "  1. n is divisible by 7.",
      "  2. The sum of the decimal digits of n is a prime number.",
      "  3. No two adjacent digits of n are equal (in n's ordinary base-10 representation, written with no leading zeros).",
      "Compute the exact count over the whole range.",
      "",
      "Reason briefly (a few sentences at most) so your output is not cut off, then put ONLY the final integer count inside <solution></solution> tags. The <solution> block must be the last thing you output.",
    ].join("\n"),
    scorer: "exact",
    expected: "39416",
  },
  {
    id: "coding-hard-shortest-path-count",
    name: "编程硬核：最短路计数",
    category: "coding",
    difficulty: "complex",
    maxTokens: 8192,
    prompt: [
      "You are given a directed weighted graph with 10 nodes labeled 0..9 and the following 18 directed edges, each written as (from -> to : weight):",
      "  (0->1:2) (0->2:3) (0->3:5) (1->4:4) (2->4:3) (3->4:1) (1->5:5) (2->5:4) (4->6:2) (5->6:1) (4->7:5) (6->7:1) (5->8:3) (6->8:2) (7->9:2) (8->9:3) (4->9:10) (3->6:20)",
      "A shortest path is a directed path from node 0 to node 9 whose total edge-weight is minimum among all such paths. Two paths are distinct if their sequences of edges differ.",
      "Write a program that computes the number of DISTINCT shortest paths from node 0 to node 9. Report that count.",
      "",
      "Reason briefly (a few sentences at most) so your output is not cut off, then put ONLY the integer number of distinct shortest paths inside <solution></solution> tags. The <solution> block must be the last thing you output.",
    ].join("\n"),
    scorer: "exact",
    expected: "5",
  },
  {
    id: "coding-hard-domino-tiling",
    name: "编程硬核：多米诺平铺计数",
    category: "coding",
    difficulty: "complex",
    maxTokens: 8192,
    prompt: [
      "Consider a grid board with 6 rows and 7 columns (rows indexed 0..5 top to bottom, columns indexed 0..6 left to right). Two cells are removed as holes: the cell at (row 2, column 3) and the cell at (row 3, column 3). The remaining 40 cells must be tiled completely by 1x2 dominoes.",
      "A valid tiling: every domino covers exactly two orthogonally adjacent non-hole cells; dominoes do not overlap; no domino covers a hole; and every non-hole cell is covered by exactly one domino.",
      "Write a program that counts the number of distinct valid tilings of this holed board. Report the exact count.",
      "",
      "Reason briefly (a few sentences at most) so your output is not cut off, then put ONLY the final integer count inside <solution></solution> tags. The <solution> block must be the last thing you output.",
    ].join("\n"),
    scorer: "exact",
    expected: "8733",
  },
  {
    id: "coding-hard-mod-recurrence",
    name: "编程硬核：模递推求值",
    category: "coding",
    difficulty: "complex",
    maxTokens: 8192,
    prompt: [
      "Define an integer sequence by f(0) = 3, f(1) = 7, and for every n >= 2:",
      "  f(n) = (5 * f(n-1) - 6 * f(n-2) + n*n) mod 1000000007",
      "Here `mod` denotes the NON-NEGATIVE remainder modulo 1000000007, so each f(n) lies in 0 .. 1000000006 even when the intermediate value 5*f(n-1) - 6*f(n-2) + n*n is negative.",
      "Write a program that computes f(100000) exactly. Report that value.",
      "",
      "Reason briefly (a few sentences at most) so your output is not cut off, then put ONLY the integer value of f(100000) inside <solution></solution> tags. The <solution> block must be the last thing you output.",
    ].join("\n"),
    scorer: "exact",
    expected: "656898202",
  },
];
