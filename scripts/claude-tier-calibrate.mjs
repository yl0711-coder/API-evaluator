// scripts/claude-tier-calibrate.mjs
//
// Claude 档位判别题「离线校准」。对官方 Opus / Sonnet / Haiku 各跑 K 次能力悬崖电池，
//   算出**每题每档的通过率**，据此筛判别度、产出**参考分布 JSON**——这份 JSON 就是下一步
//   似然比分类器（tier-discrimination）判定"声称档 vs 实际最像档"的 ground-truth。
//
// 核心设计：
//   - K 次 = K 个**不同随机实例**（同一 seed 生成，三档共用同一批输入 → 公平对比、又能平均实例难度）。
//   - 默认**不发 temperature**：Opus 4.7+ 拒绝采样参数，中转转发会 400；变异来自实例随机化而非采样。
//   - 判别度 = 相邻档通过率差（opus−sonnet、sonnet−haiku）。差大且稳的题/参数才该留，供线上分类。
//
// 诚实边界：通过率来自可信端点，是相对基线，不是模型身份认证；量化/蒸馏高仿测不出；
//   成熟中转可识别探针。结论永远"疑似降级 / 需上游解释"。
//
// 运行（key 配进 .env.evaluator 的 EVALUATOR_ANTHROPIC_API_KEY）：
//   node --env-file=.env.evaluator scripts/claude-tier-calibrate.mjs --battery both --repeats 8
// 仅看题与请求计划（不调 API、无需 key）：
//   node scripts/claude-tier-calibrate.mjs --dry-run --battery both
// 选项：
//   --battery <base|hard|both>  默认 base。base 主打 Sonnet/Haiku，hard(level3) 主打 Opus/Sonnet。
//   --repeats <K>               每题随机实例数，默认 8（越大越准、越贵）。
//   --opus/--sonnet/--haiku <id> 覆盖各档模型 id；缺省见 DEFAULT_TIERS。
//   --tiers <a=id,b=id>         一次性指定（如 opus=claude-opus-4-8,haiku=claude-haiku-4-5）。
//   --only <tiers>             只校准这些档（如 sonnet,haiku）——中转只有部分模型时用，不浪费请求。
//   --key-opus/--key-sonnet/--key-haiku <ENV_VAR>  指定该档从哪个环境变量名读 key（中转按模型授权、
//                              不同档要用不同 key 时用）。只传变量名、不传明文。缺省回退 EVALUATOR_ANTHROPIC_API_KEY。
//
// ⚠️ 用中转站当参考：只和该中转一样可信，非 ground-truth。看输出的「锚点健康度」——
//    各档通过率单调正确(Opus>Sonnet>Haiku)且拉得开 ⇒ 中转确在区分真模型，参考可用(标 sourceOfficial:false)；
//    若塌缩(各档分不开) ⇒ 中转可能本身在降级，或题判别度不足，参考不可信。最稳是再换一个独立可信源做双源共识。
//   --base-url <url>            默认 https://api.anthropic.com（校准必须用官方=ground-truth）。
//   --proxy <url>               HTTP 代理（大陆直连 api.anthropic.com 会 403）。也读 EVALUATOR_ANTHROPIC_PROXY/HTTPS_PROXY。
//   --max-tokens <n>            默认 512。 --temperature <t> 默认不发（Claude 安全）。
//   --concurrency <n>           并发请求数，默认 3（控速避免限流）。 --seed <n> 默认 20260617。
//   --out <path>               默认 scripts/claude-tier-reference.json。 --dry-run 不调 API。
//
// key 读取：EVALUATOR_ANTHROPIC_API_KEY → ANTHROPIC_API_KEY。绝不硬编码、绝不打印 key。

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import https from "node:https";
import http from "node:http";
import {
  buildClaudeTierProbes,
  gradeTierProbe,
  CLAUDE_TIER_BATTERY,
  CLAUDE_TIER_BATTERY_HARD,
  TIER_PROBE_RUNTIME,
  TIER_PROBE_VERSION,
} from "../server/tier-probes-claude.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// 同代际三档代表模型（被冒充/降级最常见的组合）。可用 --opus/--sonnet/--haiku 覆盖。
const DEFAULT_TIERS = {
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
};
const TIER_ORDER = ["opus", "sonnet", "haiku"]; // 由强到弱，用于相邻档判别度
const KEEP_GAP = 0.3; // 相邻档通过率差 ≥ 此值才建议保留该题（判别度足够）

function parseArgs(argv) {
  const args = {
    battery: "base",
    repeats: 8,
    tiers: { ...DEFAULT_TIERS },
    baseUrl: "https://api.anthropic.com",
    proxy: "",
    maxTokens: 512,
    temperature: null,
    concurrency: 3,
    seed: 20260617,
    only: null,
    keyEnv: { opus: null, sonnet: null, haiku: null }, // 各档从哪个环境变量名读 key
    out: resolve(HERE, "claude-tier-reference.json"),
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--battery") args.battery = String(argv[++i] || "").trim();
    else if (a === "--repeats") args.repeats = Math.max(1, parseInt(argv[++i], 10) || 8);
    else if (a === "--opus") args.tiers.opus = argv[++i];
    else if (a === "--sonnet") args.tiers.sonnet = argv[++i];
    else if (a === "--haiku") args.tiers.haiku = argv[++i];
    else if (a === "--tiers") {
      for (const kv of String(argv[++i] || "").split(",")) {
        const [k, v] = kv.split("=").map((s) => s.trim());
        if (k && v && k in args.tiers) args.tiers[k] = v;
      }
    } else if (a === "--base-url") args.baseUrl = argv[++i];
    else if (a === "--proxy") args.proxy = argv[++i];
    else if (a === "--max-tokens") args.maxTokens = Math.max(1, parseInt(argv[++i], 10) || 512);
    else if (a === "--temperature") args.temperature = Number(argv[++i]);
    else if (a === "--concurrency") args.concurrency = Math.max(1, parseInt(argv[++i], 10) || 3);
    else if (a === "--only") args.only = String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--key-opus") args.keyEnv.opus = argv[++i];
    else if (a === "--key-sonnet") args.keyEnv.sonnet = argv[++i];
    else if (a === "--key-haiku") args.keyEnv.haiku = argv[++i];
    else if (a === "--seed") args.seed = parseInt(argv[++i], 10) || 20260617;
    else if (a === "--out") args.out = resolve(process.cwd(), argv[++i]);
    else {
      console.error(`未知参数: ${a}`);
      process.exit(2);
    }
  }
  if (!["base", "hard", "both"].includes(args.battery)) {
    console.error(`--battery 只能是 base | hard | both，收到: ${args.battery}`);
    process.exit(2);
  }
  if (args.only) {
    const bad = args.only.filter((t) => !TIER_ORDER.includes(t));
    if (bad.length) {
      console.error(`--only 只能取 ${TIER_ORDER.join("/")}，未知: ${bad.join(",")}`);
      process.exit(2);
    }
  }
  return args;
}

// 选电池：base / hard / both，并把每题的 samples 设为 repeats（K 个随机实例）。
function selectProbeSet(battery, repeats, seed) {
  const withK = (b) => b.map((it) => ({ ...it, samples: repeats }));
  let probes = [];
  if (battery === "base" || battery === "both") probes = probes.concat(buildClaudeTierProbes(seed, withK(CLAUDE_TIER_BATTERY)));
  if (battery === "hard" || battery === "both") probes = probes.concat(buildClaudeTierProbes(seed + 1, withK(CLAUDE_TIER_BATTERY_HARD)));
  return probes;
}
// 参考库键：itemId + level（both 模式下同 itemId 不同 level 要分开存，线上按同键匹配）。
const refKey = (p) => `${p.itemId}@L${p.level}`;

// —— POST JSON（可选经 HTTP 代理 CONNECT 隧道；大陆直连 api.anthropic.com 会 403）。复用 baseline 脚本同款实现。——
function postJson({ url, headers, body, proxy }) {
  return new Promise((resolveP, reject) => {
    const target = new URL(url);
    const port = target.port || 443;
    const payload = Buffer.from(body);
    const reqHeaders = { ...headers, "content-length": String(payload.length) };
    const fire = (socket) => {
      const opts = {
        method: "POST",
        hostname: target.hostname,
        port,
        path: `${target.pathname}${target.search}`,
        headers: reqHeaders,
        ...(socket ? { socket, agent: false } : {}),
      };
      const req = https.request(opts, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolveP({ status: res.statusCode, headers: res.headers, text: data }));
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    };
    if (!proxy) return fire(null);
    const p = new URL(proxy);
    const connectHeaders = {};
    if (p.username) {
      connectHeaders["Proxy-Authorization"] =
        "Basic " + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString("base64");
    }
    const connReq = http.request({
      host: p.hostname,
      port: p.port || 80,
      method: "CONNECT",
      path: `${target.hostname}:${port}`,
      headers: connectHeaders,
    });
    connReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        reject(new Error(`代理 CONNECT 失败: HTTP ${res.statusCode}（检查代理 ${proxy}）`));
        socket.destroy();
        return;
      }
      fire(socket);
    });
    connReq.on("error", (err) => reject(new Error(`代理连接错误: ${err.message}（${proxy}）`)));
    connReq.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 发一条 prompt，取模型文本输出。OpenAI 兼容 /v1/chat/completions（Bearer）。429/5xx 退避重试。
async function chatComplete({ baseUrl, apiKey, model, prompt, proxy, maxTokens, temperature }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
  const payload = { model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, stream: false };
  if (temperature !== null && Number.isFinite(temperature)) payload.temperature = temperature;
  const body = JSON.stringify(payload);
  for (let attempt = 1; ; attempt += 1) {
    let res;
    try {
      res = await postJson({ url, headers, body, proxy });
    } catch (err) {
      if (attempt < 3) {
        await sleep(500 * attempt);
        continue;
      }
      throw new Error(`网络错误: ${err.message}`);
    }
    if (res.status >= 200 && res.status < 300) {
      let json;
      try {
        json = JSON.parse(res.text);
      } catch {
        throw new Error(`响应非 JSON: ${res.text.slice(0, 120)}`);
      }
      const c = json.choices?.[0]?.message?.content ?? json.choices?.[0]?.text ?? "";
      return Array.isArray(c) ? c.map((part) => part?.text || "").join("") : String(c || "");
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const retryAfter = Number(res.headers["retry-after"]) || attempt;
      await sleep(retryAfter * 1000);
      continue;
    }
    const hint =
      res.status === 401 ? "key 无效或缺失" :
      res.status === 403 ? "被拒（大陆直连地域封锁→配代理；或 key 无该模型权限）" :
      res.status === 404 ? `模型 id 可能有误: ${model}` :
      res.status === 400 ? "请求被拒（模型 id / 参数；试着去掉 --temperature）" : "上游错误";
    throw new Error(`HTTP ${res.status} ${hint}${res.text ? ` — ${res.text.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
  }
}

// 简单并发池：固定并发数跑完所有任务，保序返回。
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  let done = 0;
  const total = items.length;
  const runners = Array.from({ length: Math.min(limit, total) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= total) break;
      results[i] = await worker(items[i], i);
      done += 1;
      if (done % 10 === 0 || done === total) process.stdout.write(`\r  进度 ${done}/${total}   `);
    }
  });
  await Promise.all(runners);
  process.stdout.write("\n");
  return results;
}

function pct(x) {
  return x === null ? "—" : `${Math.round(x * 100)}%`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const probeSet = selectProbeSet(args.battery, args.repeats, args.seed);
  const keys = [...new Set(probeSet.map(refKey))];
  // 有效档位（保持由强到弱的顺序，用于相邻判别度与锚点单调性检查）。
  const order = args.only ? TIER_ORDER.filter((t) => args.only.includes(t)) : TIER_ORDER.slice();
  if (order.length < 2) console.warn(`⚠️ 只校准了 ${order.length} 个档位，无法算判别度/降级，至少需要 2 个。`);

  console.log(
    `档位校准 | 探针版本 ${TIER_PROBE_VERSION} | 电池 ${args.battery} | 每题 ${args.repeats} 实例 | ` +
      `题目 ${keys.length} | 档位 ${order.map((t) => `${t}=${args.tiers[t]}`).join(", ")}`,
  );

  if (args.dryRun) {
    const reqs = probeSet.length * order.length;
    console.log(`\n[dry-run] 不调 API。将发 ${probeSet.length} 题 × ${order.length} 档 = ${reqs} 次请求。每题首个实例示例：\n`);
    for (const key of keys) {
      const p = probeSet.find((x) => refKey(x) === key);
      console.log(`===== ${key} =====`);
      console.log(p.prompt);
      console.log(`--- 标准答案: ${JSON.stringify(p.expected)}\n`);
    }
    return;
  }

  // 按档解析 key：优先 --key-<tier> 指定的环境变量名，回退 EVALUATOR_ANTHROPIC_API_KEY/ANTHROPIC_API_KEY。
  const fallbackKey = process.env.EVALUATOR_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || "";
  const keyFor = (tier) => (args.keyEnv[tier] ? process.env[args.keyEnv[tier]] : "") || fallbackKey;
  const missingKey = order.filter((t) => !keyFor(t));
  if (missingKey.length) {
    console.error(
      `以下档位没解析到 key: ${missingKey.join(", ")}。\n` +
        `请把 key 写进 .env.evaluator，并用 --key-<档> <环境变量名> 指定（或设 EVALUATOR_ANTHROPIC_API_KEY 作通用回退）。`,
    );
    process.exit(1);
  }
  if (!/^https:\/\/api\.anthropic\.com/.test(args.baseUrl)) {
    console.warn(`⚠️ base-url 非官方（${args.baseUrl}）。校准必须用官方端点，否则参考分布就不是 ground-truth。`);
  }
  const proxy = args.proxy || process.env.EVALUATOR_ANTHROPIC_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || "";
  if (proxy) console.log(`经代理: ${proxy}`);

  // 任务 = 每档 × 每题实例。统计按 (档, refKey) 累计通过/尝试。
  const tasks = [];
  for (const tier of order) {
    for (const p of probeSet) tasks.push({ tier, model: args.tiers[tier], key: keyFor(tier), p });
  }
  const stat = {}; // tier -> key -> { pass, attempts }
  const errors = [];
  for (const tier of TIER_ORDER) {
    stat[tier] = {};
    for (const key of keys) stat[tier][key] = { pass: 0, attempts: 0 };
  }

  console.log(`\n开始校准（并发 ${args.concurrency}，共 ${tasks.length} 次请求）…`);
  await pool(tasks, args.concurrency, async (t) => {
    const key = refKey(t.p);
    try {
      const text = await chatComplete({
        baseUrl: args.baseUrl,
        apiKey: t.key,
        model: t.model,
        prompt: t.p.prompt,
        proxy,
        maxTokens: args.maxTokens,
        temperature: args.temperature,
      });
      const passed = gradeTierProbe(t.p.itemId, text, t.p.expected);
      stat[t.tier][key].attempts += 1;
      if (passed) stat[t.tier][key].pass += 1;
    } catch (err) {
      // 硬失败（key/模型/网络）不计入能力分母，单列错误，避免把基建问题误判成"能力不足"。
      errors.push({ tier: t.tier, model: t.model, key, message: err.message });
    }
    return null;
  });

  // 通过率 + 相邻档判别度
  const references = {};
  const discrimination = [];
  for (const key of keys) {
    const rates = {};
    const attempts = {};
    for (const tier of TIER_ORDER) {
      const s = stat[tier][key];
      attempts[tier] = s.attempts;
      rates[tier] = s.attempts > 0 ? s.pass / s.attempts : null;
    }
    references[key] = { ...rates, attempts };
    const ovs = rates.opus !== null && rates.sonnet !== null ? Math.abs(rates.opus - rates.sonnet) : null;
    const svh = rates.sonnet !== null && rates.haiku !== null ? Math.abs(rates.sonnet - rates.haiku) : null;
    const keep = (ovs !== null && ovs >= KEEP_GAP) || (svh !== null && svh >= KEEP_GAP);
    discrimination.push({ item: key, opusVsSonnet: ovs, sonnetVsHaiku: svh, keep });
  }

  // 锚点健康度：各档是否「单调正确(强档≥弱档)且拉得开」。塌缩=参考源可能没真区分各档→不可信。
  let monoOk = 0;
  let monoTotal = 0;
  let sepSum = 0;
  let sepN = 0;
  for (const key of keys) {
    const vals = order.map((t) => references[key][t]).filter((v) => v !== null);
    if (vals.length < 2) continue;
    monoTotal += 1;
    let ok = true;
    for (let i = 1; i < vals.length; i++) if (vals[i] > vals[i - 1] + 0.001) ok = false; // 允许极小噪声
    if (ok) monoOk += 1;
    sepSum += vals[0] - vals[vals.length - 1];
    sepN += 1;
  }
  const monotonicRate = monoTotal ? monoOk / monoTotal : null;
  const avgSeparation = sepN ? sepSum / sepN : null;
  const healthy = monotonicRate !== null && monotonicRate >= 0.6 && avgSeparation !== null && avgSeparation >= 0.15;
  const anchorHealth = {
    availableTiers: order,
    monotonicRate,
    avgSeparation,
    healthy,
    note: healthy
      ? "档位阶梯正常（单调且拉得开），参考源确在区分各档；但仍非官方 ground-truth，线上分类应降一档置信。"
      : "⚠️ 档位塌缩或顺序异常：参考源可能未真正区分各档（本身在降级，或题判别度不足）→ 此参考不可信，建议换源/加题/官方校准。",
  };

  const out = {
    schema: "claude-tier-reference/v1",
    _generated: "本文件由 scripts/claude-tier-calibrate.mjs 生成，请勿手工编辑；改题或换源后重跑覆盖。",
    _disclaimer:
      "通过率来自可信端点，是档位的相对参考基线，非模型身份认证。线上分类用每题每档通过率做似然比，" +
      "判定『声称档 vs 行为最像档』，结论为概率性『疑似降级/需上游解释』，量化/蒸馏高仿与探针规避属盲区。",
    probeVersion: TIER_PROBE_VERSION,
    battery: args.battery,
    repeats: args.repeats,
    seed: args.seed,
    sourceOfficial: /^https:\/\/api\.anthropic\.com/.test(args.baseUrl),
    runtime: { maxTokens: args.maxTokens, temperature: args.temperature, defaults: TIER_PROBE_RUNTIME },
    tiers: args.tiers,
    calibratedTiers: order,
    anchorHealth,
    references,
    discrimination,
    errors,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(args.out, JSON.stringify(out, null, 2) + "\n", "utf8");

  // 控制台速览
  console.log(`\n各题各档通过率（与相邻档判别度）：`);
  console.log("题目".padEnd(20), "opus".padStart(6), "sonnet".padStart(8), "haiku".padStart(7), "  O−S   S−H  保留");
  for (const d of discrimination) {
    const r = references[d.item];
    console.log(
      d.item.padEnd(20),
      pct(r.opus).padStart(6),
      pct(r.sonnet).padStart(8),
      pct(r.haiku).padStart(7),
      pct(d.opusVsSonnet).padStart(6),
      pct(d.sonnetVsHaiku).padStart(6),
      d.keep ? " ✅" : " ✗",
    );
  }
  console.log(
    `\n锚点健康度: 单调正确 ${monoOk}/${monoTotal} 题 | 强弱档平均分离 ${pct(avgSeparation)} | ` +
      (healthy ? "✅ 阶梯正常，参考可用（非官方，降一档置信）" : "⚠️ 塌缩/异常，参考不可信"),
  );
  if (!healthy) console.log(`   ${anchorHealth.note}`);

  console.log(`\n✅ 参考分布已写入: ${args.out}`);
  const kept = discrimination.filter((d) => d.keep).length;
  console.log(`   判别度达标（相邻档差 ≥ ${KEEP_GAP}）的题: ${kept}/${discrimination.length}`);
  if (errors.length) {
    console.log(`   ⚠️ ${errors.length} 次请求失败（不计入通过率）。样例: ${errors[0].tier}/${errors[0].model} — ${errors[0].message}`);
  }
}

main().catch((err) => {
  console.error(`\n❌ 失败: ${err.message}`);
  process.exit(1);
});
