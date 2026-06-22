// scripts/livebench-import.mjs
//
// 从 HuggingFace 拉取 LiveBench 题目，生成「内置精选子集」 server/scenarios/livebench.mjs。
// LiveBench：客观 ground-truth 判分、不用 LLM 裁判、按月刷新、污染受限（contamination-limited）。
// 仅开发期一次性运行（刷新子集时再跑），不接入运行时服务器。
//
// 用法：
//   node scripts/livebench-import.mjs --proxy http://127.0.0.1:7897
//   node scripts/livebench-import.mjs                      # 直连（海外网络可用时）
//   node scripts/livebench-import.mjs --count 8            # 每类题数（默认 6）
//   node scripts/livebench-import.mjs --offset 0           # 起始行（换一批题）
// 代理也可用 EVALUATOR_LIVEBENCH_PROXY / HTTPS_PROXY 环境变量。
//
// 许可与边界：题目来自 HuggingFace `livebench/*` 数据集（代码 Apache-2.0）。落库前请自行
//   核对各数据集 HF dataset card 的再分发条款（部分任务源自 NYT Connections / arXiv 等）。
//   仅纳入可客观判分的类别；**不含 coding**（需隔离代码沙箱）。language(connections 分组语义)
//   与 instruction_following(需约束规格而非纯 ground_truth) 暂不自动导入，留待按需定制判分。

import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT_PATH = fileURLToPath(new URL("../server/scenarios/livebench.mjs", import.meta.url));

// 导入的类别 → 中文名 / 判分器 / 难度档 / 输出窗口下限。
// maxTokens：LiveBench 是难题，需要足够输出预算（推理过程 + 最终答案），否则会被 max_tokens
//   截断成空/半截答案；data_analysis 要整张表转 JSON，预算更大。运行时只抬高、不压低渠道配置。
// maxTokens：场景运行器对所有场景测试统一强制 4096（见 test-runner SCENARIO_MAX_OUTPUT_TOKENS），
// 故此字段仅作记录、与运行时一致即可。answerOnly：追加"直接给答案、不输出推理"后缀，把输出压到
// 几百 token。data_analysis 的 maxAnswerChars 是答案体量上限（≈ chars/3.2 token），超过的题任何
// 窗口都装不下、必被截断，导入阶段直接跳过；jsonOnly：强化"只输出 JSON 表格本身、不要推理"。
const CATEGORIES = [
  { name: "math", cn: "数学", scorer: "exact", difficulty: "hard", maxTokens: 4096, answerOnly: true },
  { name: "reasoning", cn: "推理", scorer: "exact", difficulty: "complex", maxTokens: 4096, answerOnly: true },
  { name: "data_analysis", cn: "数据分析", scorer: "structured", difficulty: "normal", maxTokens: 4096, maxAnswerChars: 4800, jsonOnly: true },
];

// 输出纪律后缀（英文，匹配 LiveBench 题面语言）。目的：压住推理，避免输出撞 max_tokens 被截。
// answerOnly = 直接给答案、不输出任何推理（用户明确要求）；仍用 <solution> 包裹以便稳定抽取。
const ANSWER_ONLY_SUFFIX =
  "\n\n---\nDo NOT show any reasoning, explanation, or working steps. " +
  "Output ONLY the final answer, inside <solution></solution> tags, and nothing else.";
const JSON_ONLY_SUFFIX =
  "\n\n---\nOutput ONLY the resulting JSON table. No reasoning, no explanation, no markdown code fences, no extra text.";
const promptSuffix = (cat) => (cat.answerOnly ? ANSWER_ONLY_SUFFIX : cat.jsonOnly ? JSON_ONLY_SUFFIX : "");

// 子任务（task 字段）→ 中文。未收录的回退为去下划线的原名，保证场景选项可读。
const TASK_CN = {
  olympiad: "奥赛填空",
  zebra_puzzle: "斑马逻辑谜题",
  web_of_lies_v2: "真假谜题",
  web_of_lies: "真假谜题",
  spatial: "空间推理",
  tablereformat: "表格重排",
  tablejoin: "表格连接",
  cta: "列类型标注",
  AMC: "AMC 竞赛",
  amc: "AMC 竞赛",
  math_comp: "数学竞赛",
  connections: "词语归类",
  typos: "拼写纠错",
  plot_unscrambling: "情节重排",
};
const taskCn = (t) => TASK_CN[t] || String(t || "").replace(/_/g, " ");

function parseArgs(argv) {
  const args = { proxy: "", count: 6, offset: 0 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--proxy") args.proxy = argv[++i];
    else if (a === "--count") args.count = Number(argv[++i]) || 6;
    else if (a === "--offset") args.offset = Number(argv[++i]) || 0;
  }
  args.proxy = args.proxy || process.env.EVALUATOR_LIVEBENCH_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || "";
  return args;
}

// GET JSON，可选经 HTTP 代理 CONNECT 隧道（与 scripts/claude-token-baseline.mjs 同款代理逻辑）。
function getJson(url, proxy) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = { "user-agent": "livebench-import/1", accept: "application/json" };
    const onResponse = (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`JSON 解析失败：${e.message}`));
        }
      });
    };
    if (!proxy) {
      const req = https.request({ host: u.hostname, path: u.pathname + u.search, method: "GET", headers }, onResponse);
      req.on("error", reject);
      req.end();
      return;
    }
    const p = new URL(proxy);
    const connReq = http.request({ host: p.hostname, port: p.port, method: "CONNECT", path: `${u.hostname}:443` });
    connReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error(`代理 CONNECT 失败: HTTP ${res.statusCode}（检查代理 ${proxy}）`));
      const tlsSock = tls.connect({ socket, servername: u.hostname }, () => {
        const req = https.request(
          { createConnection: () => tlsSock, host: u.hostname, path: u.pathname + u.search, method: "GET", headers },
          onResponse,
        );
        req.on("error", reject);
        req.end();
      });
      tlsSock.on("error", reject);
    });
    connReq.on("error", (err) => reject(new Error(`代理连接错误: ${err.message}（${proxy}）`)));
    connReq.end();
  });
}

function rowsUrl(dataset, offset, length) {
  const ds = encodeURIComponent(`livebench/${dataset}`);
  return `https://datasets-server.huggingface.co/rows?dataset=${ds}&config=default&split=test&offset=${offset}&length=${length}`;
}

// 网络抖动重试：代理冷启动偶发 TLS 断连，退避重试几次。
async function getJsonRetry(url, proxy, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await getJson(url, proxy);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw lastErr;
}

async function importCategory(cat, { proxy, count, offset }) {
  // 有答案体量上限的类别（data_analysis）多取一些备选，跳过超大题后仍能凑够 count。
  const fetchLen = cat.maxAnswerChars ? Math.min(count * 4, 100) : count;
  const doc = await getJsonRetry(rowsUrl(cat.name, offset, fetchLen), proxy);
  const out = [];
  let skippedOversize = 0;
  for (const entry of doc.rows || []) {
    if (out.length >= count) break;
    const row = entry.row || {};
    const prompt = Array.isArray(row.turns) ? row.turns.join("\n\n") : String(row.turns || "");
    const expected = String(row.ground_truth ?? "");
    if (!prompt || !expected) continue; // 跳过缺题面/缺答案（如答案被官方留存）
    // 答案体量过滤：表格重排等若整表过大，任何窗口都装不下、必被截断 —— 导入阶段直接跳过，
    // 保证内置子集每题都能在窗口内输出完（残余截断再由判分层标记排除兜底）。
    if (cat.maxAnswerChars && expected.length > cat.maxAnswerChars) {
      skippedOversize += 1;
      continue;
    }
    out.push({
      _sub: cat.name, // 临时：用于跨类别统一编号，写文件前删除
      name: `LiveBench ${cat.cn}·${taskCn(row.task)} #${out.length + 1}`,
      category: "livebench",
      difficulty: cat.difficulty,
      maxTokens: cat.maxTokens, // 输出窗口下限，避免难题答案被截断（运行时只抬高）
      prompt: prompt + promptSuffix(cat), // 追加输出纪律后缀，压住冗长推理
      scorer: cat.scorer,
      expected,
      // 溯源：便于按月刷新与许可核对。
      source: `livebench/${cat.name} · ${row.task || "-"} · release ${String(row.livebench_release_date || "-").slice(0, 10)}`,
    });
  }
  if (skippedOversize) console.log(`    （${cat.name} 跳过 ${skippedOversize} 道超大题，超 ${cat.maxAnswerChars} 字符）`);
  return out;
}

function renderFile(scenarios, meta) {
  const header = [
    "// server/scenarios/livebench.mjs",
    "//",
    "// 【自动生成 —— 勿手改】由 scripts/livebench-import.mjs 从 HuggingFace livebench/* 生成。",
    `// 生成时间：${meta.generatedAt}`,
    `// 覆盖类别：${meta.categories}（不含 coding；language/instruction_following 暂未导入）。`,
    "// 判分：scorer=exact（math/reasoning，答案抽取+归一化精确匹配）/ structured（data_analysis，JSON 深比对）。",
    "// 用途：抗污染客观能力探针包，主要服务档位降级判别（声称高档却在硬题崩）。默认关闭，",
    "//      由 EVALUATOR_ENABLE_LIVEBENCH=1 开启（见 server/scenarios/index.mjs）。",
    "// 刷新：重跑 scripts/livebench-import.mjs（可 --offset 换批 / --count 调量）。落库前核对各数据集许可。",
    "",
    "export const LIVEBENCH_SCENARIOS = ",
  ].join("\n");
  return `${header}${JSON.stringify(scenarios, null, 2)};\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`LiveBench 导入：proxy=${args.proxy || "（直连）"} count=${args.count}/类 offset=${args.offset}`);
  const all = [];
  let failed = 0;
  for (const cat of CATEGORIES) {
    try {
      const items = await importCategory(cat, args);
      console.log(`  ${cat.name}: ${items.length} 题`);
      all.push(...items);
    } catch (e) {
      failed += 1;
      console.error(`  ${cat.name} 导入失败：${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 800)); // 类别间隔，避开代理对突发 CONNECT 的限流
  }
  // 任一类别失败就不覆盖旧文件（避免把完整子集退化成残缺子集）。
  if (failed || !all.length) {
    console.error(`有 ${failed} 个类别失败，未写文件（保留既有 livebench.mjs）。请重试。`);
    process.exit(1);
  }
  // 跨类别统一编号 → id 全局唯一；id 放对象首位。
  const numbered = all.map((s, i) => {
    const { _sub, ...rest } = s;
    return { id: `livebench-${_sub}-${i + 1}`, ...rest };
  });
  all.length = 0;
  all.push(...numbered);
  const content = renderFile(all, {
    generatedAt: new Date().toISOString(),
    categories: CATEGORIES.map((c) => c.name).join("/"),
  });
  writeFileSync(OUT_PATH, content, "utf8");
  console.log(`已写入 ${OUT_PATH}（共 ${all.length} 题）。`);
}

main().catch((e) => {
  console.error("导入异常：", e);
  process.exit(1);
});
