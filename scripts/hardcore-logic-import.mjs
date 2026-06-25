// scripts/hardcore-logic-import.mjs
//
// 从 HuggingFace 拉取 HardcoreLogic（长尾逻辑谜题）题目，生成「内置精选子集」server/scenarios/hardcore-logic.mjs。
// HardcoreLogic（论文 arXiv:2510.12563，代码 github.com/ljcleo/hardcore-logic）：把 10 类经典逻辑谜题做
//   长尾变换（增复杂度 / 罕见元素 / 无解），专测大模型「靠记忆/捷径而非真推理」——正服务本项目「档位降级判别
//   （声称高档却在硬题崩）」。仅开发期一次性运行（刷新子集时再跑），不接入运行时服务器。
//
// 数据源：HuggingFace 数据集 `xhWu-fd/HardcoreLogic`，三个 config 即三档难度，均 split=test：
//   - baseline   ：原版谜题（相对好做）
//   - hardcore   ：长尾变体硬题（高档才扛得住）
//   - unsolvable ：无解谜题（正解是判定「无解」，须答 {"solvable": false, "solution": null}）
//   行字段：id / Puzzle_name(游戏名) / prompt(完整官方题面，已含 JSON 输出指令) / puzzle / solution(解的 JSON 字符串)。
//   注：截至导入时数据集卡未声明许可（上游代码仓库为 MIT）；此处仅内置少量样题作研究评测，许可以上游为准。
//
// 判分：复用 server/benchmark-scorers.mjs 的 scoreStructuredMatch（scorer=structured，JSON 拍平逐叶深比对）。
//   expected 取 {solvable, solution} 整体对象，与官方题面要求的输出格式一致。不引入 LLM 裁判，保持客观判分。
//
// 用法：
//   node scripts/hardcore-logic-import.mjs --proxy http://127.0.0.1:7897
//   node scripts/hardcore-logic-import.mjs                  # 直连（海外网络可用时）
//   node scripts/hardcore-logic-import.mjs --per-config 4   # 每档目标题数（默认 4 → 三档约 12 题）
//   node scripts/hardcore-logic-import.mjs --probes 8       # 每档探测采样点数（覆盖更多游戏）
// 代理也可用 EVALUATOR_LIVEBENCH_PROXY / HTTPS_PROXY 环境变量。

import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT_PATH = fileURLToPath(new URL("../server/scenarios/hardcore-logic.mjs", import.meta.url));
const DATASET = "xhWu-fd/HardcoreLogic";

// 三档难度（HF config）。slug 用于拼 id，cn 用于场景名。
const CONFIGS = [
  { name: "baseline", cn: "原版", slug: "base" },
  { name: "hardcore", cn: "长尾", slug: "hard" },
  { name: "unsolvable", cn: "无解", slug: "unsolv" },
];

// 10 类游戏 → 中文名（键统一小写，吸收 Zebralogic/ZebraLogic 之类大小写差）。未知回退原名。
const GAME_CN = {
  binario: "二进制",
  sudoku: "数独",
  skyscraper: "摩天楼",
  kakurasu: "卡库拉苏",
  crypto: "密码算式",
  navigation: "寻路",
  zebralogic: "斑马逻辑",
  minesweeper: "扫雷",
  hanoi: "汉诺塔",
  hitori: "数墙",
};
const gameKey = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const gameCn = (name) => GAME_CN[gameKey(name)] || String(name || "未知");
const gameSlug = (name) => gameKey(name) || "game";

const PROBE_LEN = 60; // 每个采样点抓多少行（凑游戏种类，不必整档拉全）

function parseArgs(argv) {
  const args = { proxy: "", perConfig: 4, probes: 8 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--proxy") args.proxy = argv[++i];
    else if (a === "--per-config") args.perConfig = Number(argv[++i]) || 4;
    else if (a === "--probes") args.probes = Number(argv[++i]) || 8;
  }
  args.proxy = args.proxy || process.env.EVALUATOR_LIVEBENCH_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || "";
  return args;
}

// GET JSON，可选经 HTTP 代理 CONNECT 隧道（与 scripts/hle-import.mjs 同款代理逻辑）。
function getJson(url, proxy) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = { "user-agent": "hardcore-logic-import/1", accept: "application/json" };
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

function rowsUrl(config, offset, length) {
  const ds = encodeURIComponent(DATASET);
  return `https://datasets-server.huggingface.co/rows?dataset=${ds}&config=${config}&split=test&offset=${offset}&length=${length}`;
}
function sizeUrl() {
  return `https://datasets-server.huggingface.co/size?dataset=${encodeURIComponent(DATASET)}`;
}

// 取题面「Otherwise」分支里 "solution": 后第一个非空字符判定其要求的 JSON 类型（array/object/scalar）。
// 数据集个别游戏（Navigation/Crypto/Hanoi）的 solution 字段是「摘要值」（距离/拼接串/步数），与题面要求的
// 路径/数组/步序列结构不符；用类型一致性把这些剔除，避免 expected 与正确模型输出对不上。
function promptSolutionType(prompt) {
  const s = String(prompt || "");
  const oi = s.indexOf("Otherwise");
  const region = oi >= 0 ? s.slice(oi) : s;
  const mi = region.search(/"solution"\s*:/);
  if (mi < 0) return "unknown";
  const ch = region.slice(mi).replace(/"solution"\s*:/, "").replace(/^\s+/, "")[0];
  if (ch === "[") return "array";
  if (ch === "{") return "object";
  return "scalar";
}
function jsonTypeOf(v) {
  if (Array.isArray(v)) return "array";
  if (v !== null && typeof v === "object") return "object";
  return "scalar";
}

// 某档某行能否纳入：
//   - 无解档：恒可纳入（正解一律 {solvable:false,solution:null}，与游戏类型无关）。
//   - 其余档：solution 须能 JSON.parse，且其 JSON 类型与题面要求的 solution 模板类型一致（保证 expected 对得上）。
function pickable(config, row) {
  if (!row || !String(row.prompt || "").trim()) return false;
  if (config === "unsolvable") return true;
  let parsed;
  try {
    parsed = JSON.parse(String(row.solution));
  } catch {
    return false;
  }
  const want = promptSolutionType(row.prompt);
  return want !== "unknown" && want === jsonTypeOf(parsed);
}

// expected = 官方题面要求的整体 JSON：无解档恒为 {solvable:false,solution:null}；其余为 {solvable:true,solution:<解>}。
function buildExpected(config, solutionStr) {
  if (config === "unsolvable") return { solvable: false, solution: null };
  return { solvable: true, solution: JSON.parse(String(solutionStr)) };
}

// 探测采样：在 [0,total) 均匀取 probes 个点，每点抓 PROBE_LEN 行，按游戏分桶，每游戏留题面最短的一题（小网格、省额度）。
async function probeConfig(config, total, probes, proxy) {
  const byGame = new Map(); // gameKey -> { name, row, plen }
  for (let i = 0; i < probes; i++) {
    const offset = Math.min(total - 1, Math.floor((i * total) / probes));
    let doc;
    try {
      doc = await getJsonRetry(rowsUrl(config.name, offset, PROBE_LEN), proxy);
    } catch (e) {
      console.warn(`  采样 ${config.name}@${offset} 失败：${e.message}`);
      continue;
    }
    for (const entry of doc.rows || []) {
      const row = entry.row || {};
      if (!pickable(config.name, row)) continue;
      const key = gameKey(row.Puzzle_name);
      const plen = String(row.prompt || "").length;
      const cur = byGame.get(key);
      if (!cur || plen < cur.plen) byGame.set(key, { name: row.Puzzle_name, row, plen });
    }
    await new Promise((r) => setTimeout(r, 500)); // 采样点间隔，避开代理对突发 CONNECT 限流
  }
  return byGame; // Map(gameKey -> {name,row,plen})
}

function renderFile(scenarios, meta) {
  const header = [
    "// server/scenarios/hardcore-logic.mjs",
    "//",
    "// 【自动生成 —— 勿手改】由 scripts/hardcore-logic-import.mjs 从 HuggingFace 生成。",
    `// 生成时间：${meta.generatedAt}`,
    `// 来源：${DATASET}（HardcoreLogic 长尾逻辑谜题；论文 arXiv:2510.12563 / github.com/ljcleo/hardcore-logic）。`,
    "// 三档（HF config）即三档难度：baseline 原版 / hardcore 长尾变体硬题 / unsolvable 无解题（须答 solvable:false）。",
    `// 覆盖游戏：${meta.games}。`,
    "// 判分：scorer=structured（scoreStructuredMatch，JSON 拍平逐叶深比对；expected 为 {solvable,solution} 整体对象）。不引入 LLM 裁判。",
    "// 用途：长尾逻辑谜题客观探针，主攻档位降级判别（声称高档却在长尾变体/无解题上崩）。默认关闭，",
    "//      由 设置→场景测试题库「加入 HardcoreLogic」(settings.enableHardcoreLogic) 开启（见 server/scenarios/index.mjs）。",
    "// 许可：导入时数据集卡未声明许可（上游代码仓库 MIT）；仅内置少量样题作研究评测，许可以上游为准。",
    "// 刷新：重跑 scripts/hardcore-logic-import.mjs（--per-config 调量 / --probes 调采样广度）。",
    "",
    "export const HARDCORE_LOGIC_SCENARIOS = ",
  ].join("\n");
  return `${header}${JSON.stringify(scenarios, null, 2)};\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`HardcoreLogic 导入：proxy=${args.proxy || "（直连）"} per-config=${args.perConfig} probes=${args.probes} 源=${DATASET}`);

  // 各档总行数（用于均匀采样）。
  const sizeDoc = await getJsonRetry(sizeUrl(), args.proxy);
  const sizeByConfig = new Map((sizeDoc?.size?.configs || []).map((c) => [c.config, Number(c.num_rows) || 0]));

  // 逐档采样，得到「游戏 → 候选题」。
  const probed = new Map(); // configName -> Map(gameKey -> {name,row,plen})
  for (const cfg of CONFIGS) {
    const total = sizeByConfig.get(cfg.name) || 1000;
    console.log(`采样 ${cfg.name}（${cfg.cn}，total≈${total}）…`);
    probed.set(cfg.name, await probeConfig(cfg, total, args.probes, args.proxy));
  }

  // 跨档选题：每档取 perConfig 题；优先「全局尚未用过的游戏」以最大化品类并集，再按题面短优先。
  const usedGames = new Set();
  const selected = []; // { cfg, row }
  for (const cfg of CONFIGS) {
    const cands = [...(probed.get(cfg.name)?.values() || [])].sort((a, b) => a.plen - b.plen);
    const fresh = cands.filter((c) => !usedGames.has(gameKey(c.name)));
    const rest = cands.filter((c) => usedGames.has(gameKey(c.name)));
    const take = [...fresh, ...rest].slice(0, args.perConfig);
    for (const c of take) {
      usedGames.add(gameKey(c.name));
      selected.push({ cfg, row: c.row });
    }
  }
  if (!selected.length) {
    console.error("未选到任何题目（检查代理/网络或数据集可用性）。未写文件。");
    process.exit(1);
  }

  // 跨档统一编号 → id 全局唯一。
  const scenarios = selected.map(({ cfg, row }, i) => {
    const ord = i + 1;
    return {
      id: `hardcore-logic-${cfg.slug}-${gameSlug(row.Puzzle_name)}-${ord}`,
      name: `HardcoreLogic ${gameCn(row.Puzzle_name)}·${cfg.cn} #${ord}`,
      category: "hardcore-logic",
      game: row.Puzzle_name,
      config: cfg.name,
      difficulty: "hard",
      maxTokens: 8192,
      prompt: String(row.prompt),
      scorer: "structured",
      expected: buildExpected(cfg.name, row.solution),
      source: `${DATASET} · ${cfg.name} · ${row.id || "-"}`,
    };
  });

  const games = [...new Set(scenarios.map((s) => gameCn(s.game)))].join("/");
  const content = renderFile(scenarios, { generatedAt: new Date().toISOString(), games });
  writeFileSync(OUT_PATH, content, "utf8");
  const byCfg = scenarios.reduce((m, s) => ((m[s.config] = (m[s.config] || 0) + 1), m), {});
  console.log(`已写入 ${OUT_PATH}（共 ${scenarios.length} 题）。`);
  console.log(`档位分布：`, byCfg);
  console.log(`游戏并集：`, games);
}

main().catch((e) => {
  console.error("导入异常：", e);
  process.exit(1);
});
