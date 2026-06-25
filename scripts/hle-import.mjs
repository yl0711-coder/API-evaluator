// scripts/hle-import.mjs
//
// 从 HuggingFace 拉取 HLE（Humanity's Last Exam）题目，生成「内置精选子集」server/scenarios/hle.mjs。
// HLE：跨百余学科的专家级客观判分题，主要服务档位降级判别（声称高档却在硬题崩）。
// 仅开发期一次性运行（刷新子集时再跑），不接入运行时服务器。
//
// 数据源：官方 cais/hle 是 gated 数据集（需 HF token + 接受条款），这里改用 ungated 文本镜像
//   `macabdul9/hle_text_only`（已预过滤为纯文本题，保留 HLE 完整 schema 与 canary 串）。镜像为
//   社区再上传，非官方，时效/完整性以镜像为准。
//
// 用法：
//   node scripts/hle-import.mjs --proxy http://127.0.0.1:7897
//   node scripts/hle-import.mjs                      # 直连（海外网络可用时）
//   node scripts/hle-import.mjs --count 2            # 每类目标题数（默认 2）
//   node scripts/hle-import.mjs --offset 0           # 起始行（换一批题）
// 代理也可用 EVALUATOR_LIVEBENCH_PROXY / HTTPS_PROXY 环境变量。
//
// 判分：复用 server/benchmark-scorers.mjs 的 scoreExactAnswer（scorer=exact，答案抽取 <solution> + 归一化精确匹配）。
//   仅纳入「单选（multipleChoice，答案为单字母）」与「短答（exactMatch，答案 ≤ MAX_ANSWER_CHARS）」，
//   规避开放式长答案在归一化匹配下的漏判（HLE 官方用 LLM 裁判，本项目刻意不引入裁判、保持客观判分一致性）。

import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT_PATH = fileURLToPath(new URL("../server/scenarios/hle.mjs", import.meta.url));
const DATASET = "macabdul9/hle_text_only";

// 只取答案可被 exact 判分器稳定匹配的题：短答案上限（字符），超过的多为开放式表述，跳过。
const MAX_ANSWER_CHARS = 24;
// 每页 100 行（HF datasets-server 上限），最多翻这么多页凑齐各类配额，避免无止境翻页。
const MAX_PAGES = 8;
const PAGE_SIZE = 100;

// HLE category → 中文名 / id 短码。覆盖镜像里出现的 8 类；未知类回退 other。
const CATEGORY_META = {
  "Math": { cn: "数学", slug: "math" },
  "Physics": { cn: "物理", slug: "physics" },
  "Chemistry": { cn: "化学", slug: "chemistry" },
  "Biology/Medicine": { cn: "生物医学", slug: "biology" },
  "Computer Science/AI": { cn: "计算机", slug: "cs" },
  "Engineering": { cn: "工程", slug: "engineering" },
  "Humanities/Social Science": { cn: "人文社科", slug: "humanities" },
  "Other": { cn: "其他", slug: "other" },
};
const catMeta = (c) => CATEGORY_META[c] || { cn: String(c || "其他"), slug: "other" };

// 输出纪律后缀（英文，匹配 HLE 题面语言）。要求简短推理（避免硬题长思考把答案撑爆/截断），
// 但强制最终答案进 <solution>，便于稳定抽取。
const MC_SUFFIX =
  "\n\n---\nReason briefly (a few sentences at most) so your output is not cut off, then put ONLY " +
  "the letter of the correct choice (e.g. A) inside <solution></solution> tags. " +
  "The <solution> block must be the last thing you output.";
const ANSWER_DISCIPLINE =
  "Reason briefly (a few sentences at most) so your output is not cut off, then put ONLY " +
  "your final answer (no extra words) inside <solution></solution> tags. " +
  "The <solution> block must be the last thing you output.";
const ANSWER_SUFFIX = "\n\n---\n" + ANSWER_DISCIPLINE;

// 有效数字位数：去符号/小数点/前导零后剩余数字位数（对本题库的数值答案足够）。
function countSigFigs(mantissa) {
  const d = String(mantissa).replace(/[+\-.]/g, "").replace(/^0+/, "");
  return Math.max(1, d.length);
}

// 数值短答：从期望答案推导「保留位数 + 回答格式」提示，写进题面，避免模型因精度/写法不同被判错。
// 用中性示例（不泄露真实答案数值）。非数值答案（LaTeX/文本等）返回空串、不加提示。
function numericFormatHint(expected) {
  const s = String(expected).trim();
  const sci = s.match(/^[+-]?(\d+(?:\.\d+)?)\s*[*x×]\s*10\s*\^?\s*\(?[-+]?\d+\)?$/i);
  if (sci) {
    return `Give your final answer to ${countSigFigs(sci[1])} significant figures, in plain-ASCII scientific notation written as "mantissa * 10^exponent" (for example 1.23 * 10^-5). Do not include units, words, or unicode — use * and ^, not × or superscripts.`;
  }
  if (/^[+-]?\d+(?:\.\d+)?$/.test(s)) {
    return `Give your final answer as a plain number to ${countSigFigs(s)} significant figures (for example 1.23). Do not include units, words, or commas.`;
  }
  return "";
}

// 短答后缀：数值答案先加保留位数/格式提示，再接通用输出纪律。
function answerSuffix(expected) {
  const hint = numericFormatHint(expected);
  return "\n\n---\n" + (hint ? hint + "\n" : "") + ANSWER_DISCIPLINE;
}

function parseArgs(argv) {
  const args = { proxy: "", count: 2, offset: 0 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--proxy") args.proxy = argv[++i];
    else if (a === "--count") args.count = Number(argv[++i]) || 2;
    else if (a === "--offset") args.offset = Number(argv[++i]) || 0;
  }
  args.proxy = args.proxy || process.env.EVALUATOR_LIVEBENCH_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || "";
  return args;
}

// GET JSON，可选经 HTTP 代理 CONNECT 隧道（与 scripts/livebench-import.mjs 同款代理逻辑）。
function getJson(url, proxy) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = { "user-agent": "hle-import/1", accept: "application/json" };
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

function rowsUrl(offset, length) {
  const ds = encodeURIComponent(DATASET);
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

// 一道题是否可纳入（纯文本 + 答案可客观匹配）。
function pickable(row) {
  if (!row || row.image) return false; // 防御性：镜像应已纯文本，仍剔除带图题
  const q = String(row.question || "").trim();
  const ans = String(row.answer ?? "").trim();
  if (!q || !ans) return false;
  if (row.answer_type === "multipleChoice") return /^[A-Za-z]$/.test(ans); // 答案须为单字母选项
  if (row.answer_type === "exactMatch") return ans.length <= MAX_ANSWER_CHARS;
  return false;
}

function toScenario(row, ordinal, canaryRef) {
  const mc = row.answer_type === "multipleChoice";
  const meta = catMeta(row.category);
  return {
    _slug: meta.slug, // 临时：用于跨类别统一编号，写文件前删除
    name: `HLE ${meta.cn}·${mc ? "单选" : "短答"} #${ordinal}`,
    category: "hle",
    hleCategory: row.category, // 原始 HLE 类别，供 index.mjs 解析 UI 标签
    difficulty: "hard",
    maxTokens: 4096, // 运行时统一强制 4096，仅作记录
    prompt: String(row.question).trim() + (mc ? MC_SUFFIX : answerSuffix(row.answer)),
    scorer: "exact",
    expected: String(row.answer).trim(),
    source: `${DATASET} · ${row.raw_subject || row.category || "-"} · ${row.id || "-"}`,
    canaryRef,
  };
}

function renderFile(scenarios, meta) {
  const header = [
    "// server/scenarios/hle.mjs",
    "//",
    "// 【自动生成 —— 勿手改】由 scripts/hle-import.mjs 从 HuggingFace 文本镜像生成。",
    `// 生成时间：${meta.generatedAt}`,
    `// 来源：${DATASET}（HLE 文本镜像，社区再上传、非官方；时效/完整性以镜像为准）。`,
    `// 覆盖类别：${meta.categories}。仅纳入单选(multipleChoice)与短答(exactMatch ≤${MAX_ANSWER_CHARS}字符)。`,
    "// 判分：scorer=exact（答案抽取 <solution> + 归一化精确匹配，复用 benchmark-scorers）。不引入 LLM 裁判。",
    "// 用途：跨学科专家级客观能力探针，主攻档位降级判别（声称高档却在硬题崩）。默认关闭，",
    "//      由 设置→场景测试题库「加入 HLE」(settings.enableHle) 开启（见 server/scenarios/index.mjs）。",
    "// 刷新：重跑 scripts/hle-import.mjs（可 --offset 换批 / --count 调量）。HLE 镜像 MIT 许可。",
    `// 污染过滤 canary（BIG-bench 超集）：${meta.canary || "（未取到）"}`,
    "",
    "export const HLE_SCENARIOS = ",
  ].join("\n");
  return `${header}${JSON.stringify(scenarios, null, 2)};\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`HLE 导入：proxy=${args.proxy || "（直连）"} count=${args.count}/类 offset=${args.offset} 源=${DATASET}`);

  // 翻页拉取，按 category 分桶；每类先收单选、再收短答，凑够 count 即停。
  const buckets = new Map(); // slug -> { cn, items: [] }
  let canary = "";
  let offset = args.offset;
  for (let page = 0; page < MAX_PAGES; page++) {
    const doc = await getJsonRetry(rowsUrl(offset, PAGE_SIZE), args.proxy);
    const rows = (doc.rows || []).map((e) => e.row || {});
    if (!rows.length) break;
    for (const row of rows) {
      if (!canary && row.canary) canary = String(row.canary);
      if (!pickable(row)) continue;
      const meta = catMeta(row.category);
      if (!buckets.has(meta.slug)) buckets.set(meta.slug, { cn: meta.cn, mc: [], ex: [] });
      const b = buckets.get(meta.slug);
      (row.answer_type === "multipleChoice" ? b.mc : b.ex).push(row);
    }
    // 各类是否都已凑够（已知类全部达标即可停）。
    const enough = [...buckets.values()].length >= 6 && [...buckets.values()].every((b) => b.mc.length + b.ex.length >= args.count);
    offset += rows.length;
    if (enough || rows.length < PAGE_SIZE) break;
    await new Promise((r) => setTimeout(r, 600)); // 翻页间隔，避开代理对突发 CONNECT 的限流
  }

  // 每类取 count 题：优先单选（对 exact 最稳），不足再补短答。
  const selected = [];
  for (const [, b] of [...buckets.entries()].sort()) {
    const take = [...b.mc, ...b.ex].slice(0, args.count);
    selected.push(...take);
  }
  if (!selected.length) {
    console.error("未选到任何题目（检查代理/网络或镜像可用性）。未写文件。");
    process.exit(1);
  }

  // 跨类别统一编号 → id 全局唯一；id 放对象首位；剥掉临时字段。
  const numbered = selected.map((row, i) => {
    const s = toScenario(row, i + 1, undefined);
    const { _slug, canaryRef, ...rest } = s;
    return { id: `hle-${_slug}-${i + 1}`, ...rest };
  });

  const cats = [...new Set(numbered.map((s) => catMeta(s.hleCategory).cn))].join("/");
  const content = renderFile(numbered, {
    generatedAt: new Date().toISOString(),
    categories: cats,
    canary,
  });
  writeFileSync(OUT_PATH, content, "utf8");
  const byCat = numbered.reduce((m, s) => ((m[s.hleCategory] = (m[s.hleCategory] || 0) + 1), m), {});
  console.log(`已写入 ${OUT_PATH}（共 ${numbered.length} 题）。`);
  console.log(`类别分布：`, byCat);
}

main().catch((e) => {
  console.error("导入异常：", e);
  process.exit(1);
});
