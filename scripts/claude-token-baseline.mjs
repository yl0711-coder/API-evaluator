// scripts/claude-token-baseline.mjs
//
// 第一步:用 Claude 官方 count_tokens 端点,为 server/tokenizer-probes.mjs 里的固定探针
//   建立「精确 token 数基线」,落盘成 JSON。这是分词器指纹判定的 ground-truth。
//
// 它做什么:
//   - 对每条探针调 POST /v1/messages/count_tokens(官方端点,免费、不产出、不计费),拿到 input_tokens。
//   - 写出 baseline JSON:{ model, anthropicVersion, probeVersion, createdAt, probes:[{id, inputTokens, ...}] }。
//
// 为什么用官方端点:这是唯一可信的 Claude 分词器真值。将来把同一批探针发给「被测渠道」,
//   读它返回的 usage.input_tokens,与本基线做线性拟合(slope≈1 且 R²≈1 ⇒ 后端确为 Claude 家族)。
//   注意:被测模型不可能「自己调 count_tokens 数 token」——指纹只能来自端点返回的 usage 字段。
//
// ⚠️ Claude 有多代分词器:Opus 4.7/4.8/Fable5 共用同一分词器;Opus 4.6、Sonnet、Haiku、更老的
//   则各不相同。被测渠道声称是哪个 model,就要拿「那个 model 的基线」去比,否则张冠李戴。所以本脚本
//   一次性为「一组模型」分别建基线,并自动检测哪些模型的探针向量完全一致(= 同一代分词器)。
//
// 运行(key 已配进 .env.evaluator 时):
//   node --env-file=.env.evaluator scripts/claude-token-baseline.mjs
//   或 npm:  pnpm fingerprint:baseline
// 不写盘、仅看探针 + 离线 GPT(o200k) 对照(无需 key,验证探针区分度):
//   node scripts/claude-token-baseline.mjs --dry-run
// 选项:
//   --models <a,b,c> 逗号分隔的模型列表;默认覆盖各代分词器的代表模型(见 DEFAULT_MODELS)
//   --model <id>     单模型快捷写法(等价于 --models <id>)
//   --out <path>     默认 scripts/claude-token-baseline.json
//   --base-url <url> 默认 https://api.anthropic.com(基线走官方=ground-truth;走中转=只和该中转一样可信)
//   --mode <m>       count_tokens(默认,官方端点) | chat(OpenAI 兼容 /v1/chat/completions,
//                    发探针 max_tokens=1 读 usage.prompt_tokens——中转不实现 count_tokens 时用这个;
//                    这也是审计被测渠道时的同一机制,模板固定开销被线性拟合的 intercept 吸收)
//   --proxy <url>    HTTP 代理(中国大陆直连 api.anthropic.com 会 403,需走代理)。
//                    也可用 EVALUATOR_ANTHROPIC_PROXY / HTTPS_PROXY 环境变量。例:http://127.0.0.1:7897
//   --dry-run        不调 API,仅打印探针与离线 o200k 估算
//
// 某个模型 404/403(不可用/无权限)只跳过该模型并记错,不影响其它模型。
// key 读取顺序:EVALUATOR_ANTHROPIC_API_KEY → ANTHROPIC_API_KEY。绝不硬编码、绝不打印 key。

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import https from "node:https";
import http from "node:http";
import { TOKENIZER_PROBES, TOKENIZER_PROBE_VERSION } from "../server/tokenizer-probes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ANTHROPIC_VERSION = "2023-06-01";

// 各代分词器的代表模型(被测渠道最可能冒充的几代)。可用 --models 覆盖。
// 注:Opus 4.7/4.8/Fable5 同一代,这里只放 4.8 一个代表;其余各放一个。
const DEFAULT_MODELS = ["claude-opus-4-8", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-sonnet-4-5"];

function parseArgs(argv) {
  const args = { models: DEFAULT_MODELS.slice(), out: resolve(HERE, "claude-token-baseline.json"), baseUrl: "https://api.anthropic.com", proxy: "", mode: "count_tokens", dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--models") args.models = String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--model") args.models = [argv[++i]];
    else if (a === "--out") args.out = resolve(process.cwd(), argv[++i]);
    else if (a === "--base-url") args.baseUrl = argv[++i];
    else if (a === "--proxy") args.proxy = argv[++i];
    else if (a === "--mode") args.mode = argv[++i];
    else {
      console.error(`未知参数: ${a}`);
      process.exit(2);
    }
  }
  if (args.mode !== "count_tokens" && args.mode !== "chat") {
    console.error(`--mode 只能是 count_tokens 或 chat,收到: ${args.mode}`);
    process.exit(2);
  }
  if (!args.models.length) {
    console.error("--models 为空");
    process.exit(2);
  }
  return args;
}

// POST JSON,可选经 HTTP 代理 CONNECT 隧道(中国大陆直连 api.anthropic.com 会被 403 地域封锁,
//   需走代理)。无依赖,仅用 node:https / node:http。返回 { status, headers, text }。
function postJson({ url, headers, body, proxy }) {
  return new Promise((resolve, reject) => {
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
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    };

    if (!proxy) {
      fire(null);
      return;
    }
    // 经代理:先 CONNECT 建隧道,再在隧道 socket 上跑 TLS。
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
        reject(new Error(`代理 CONNECT 失败: HTTP ${res.statusCode}(检查代理地址 ${proxy})`));
        socket.destroy();
        return;
      }
      fire(socket);
    });
    connReq.on("error", (err) => reject(new Error(`代理连接错误: ${err.message}(${proxy})`)));
    connReq.end();
  });
}

// 测一条文本的输入 token 数。两种机制:
//   count_tokens: 官方 POST /v1/messages/count_tokens(x-api-key + anthropic-version),读 input_tokens。
//   chat:         OpenAI 兼容 POST /v1/chat/completions(Bearer),max_tokens=1,读 usage.prompt_tokens。
// 失败抛带状态码的 Error。
async function countTokens({ baseUrl, apiKey, model, text, proxy, mode }) {
  const root = baseUrl.replace(/\/+$/, "");
  const isChat = mode === "chat";
  const url = isChat ? `${root}/v1/chat/completions` : `${root}/v1/messages/count_tokens`;
  const headers = isChat
    ? { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }
    : { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" };
  // chat 模式 max_tokens=1 把产出压到最小;不发 temperature(Opus 4.7+ 拒绝采样参数,中转转发会 400)。
  const body = isChat
    ? JSON.stringify({ model, messages: [{ role: "user", content: text }], max_tokens: 1, stream: false })
    : JSON.stringify({ model, messages: [{ role: "user", content: text }] });

  // 429 / 5xx 简单退避重试(最多 3 次)。
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
      // count_tokens → input_tokens;chat → usage.prompt_tokens(兼容个别中转回 input_tokens)。
      const n = isChat
        ? Number(json.usage?.prompt_tokens ?? json.usage?.input_tokens)
        : Number(json.input_tokens);
      if (!Number.isFinite(n)) throw new Error(`响应缺少 token 计数: ${res.text.slice(0, 160)}`);
      return n;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const retryAfter = Number(res.headers["retry-after"]) || attempt;
      await sleep(retryAfter * 1000);
      continue;
    }
    const hint =
      res.status === 401
        ? "key 无效或缺失(检查 EVALUATOR_ANTHROPIC_API_KEY)"
        : res.status === 403
          ? "被拒(常见于中国大陆直连被地域封锁——配置代理 EVALUATOR_ANTHROPIC_PROXY;或 key 无该模型权限)"
          : res.status === 404
            ? `模型 id 可能有误: ${model}`
            : res.status === 400
              ? "请求被拒(模型 id / 请求体)"
              : "上游错误";
    throw new Error(`HTTP ${res.status} ${hint}${res.text ? ` — ${res.text.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 离线 o200k(OpenAI 系)估算,仅 --dry-run 用来直观对照分词差异。失败则返回 null(不阻断)。
async function offlineO200k(text) {
  try {
    const mod = await import("gpt-tokenizer/encoding/o200k_base");
    const encode = mod.encode || mod.default?.encode;
    return typeof encode === "function" ? encode(text).length : null;
  } catch {
    return null;
  }
}

// 同一代分词器的模型,探针向量会逐项完全相同。把基线按「token 向量」分组,直观看出有几代。
function groupByTokenVector(baselines) {
  const groups = new Map(); // key(向量) -> [model,...]
  for (const b of baselines) {
    if (b.error) continue;
    const key = b.probes.map((p) => p.inputTokens).join(",");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b.model);
  }
  return [...groups.values()];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log(`探针版本: ${TOKENIZER_PROBE_VERSION} | 探针数: ${TOKENIZER_PROBES.length} | 模式: ${args.mode} | 模型: ${args.models.join(", ")}`);

  if (args.dryRun) {
    console.log("\n[dry-run] 不调用 API。下表为各探针的字符数与离线 o200k(GPT 系)估算,用于直观感受分词差异:\n");
    console.log("id".padEnd(18), "category".padEnd(12), "chars".padStart(7), "o200k".padStart(7));
    for (const p of TOKENIZER_PROBES) {
      const o = await offlineO200k(p.text);
      console.log(
        p.id.padEnd(18),
        p.category.padEnd(12),
        String([...p.text].length).padStart(7),
        String(o ?? "—").padStart(7),
      );
    }
    console.log(
      "\n说明:o200k 是 OpenAI 的分词器,Claude 的真实 token 数会与之系统性不同。" +
        "拿到官方 key 后去掉 --dry-run 即可写出 Claude 基线。",
    );
    return;
  }

  const apiKey = process.env.EVALUATOR_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(
      "缺少官方 Anthropic key。把它配进 .env.evaluator 的 EVALUATOR_ANTHROPIC_API_KEY,\n" +
        "然后:  node --env-file=.env.evaluator scripts/claude-token-baseline.mjs\n" +
        "(或先用 --dry-run 看探针,无需 key。)",
    );
    process.exit(1);
  }
  if (!/^https:\/\/api\.anthropic\.com/.test(args.baseUrl)) {
    console.warn(`⚠️ base-url 非官方(${args.baseUrl})。基线必须用官方端点建立,否则就不是 ground-truth。`);
  }
  // 代理:--proxy > EVALUATOR_ANTHROPIC_PROXY > HTTPS_PROXY/https_proxy。中国大陆直连会被 403。
  const proxy = args.proxy || process.env.EVALUATOR_ANTHROPIC_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || "";
  if (proxy) console.log(`经代理: ${proxy}`);

  const baselines = [];
  for (const model of args.models) {
    console.log(`\n模型 ${model}:`);
    const probes = [];
    let failed = null;
    for (const p of TOKENIZER_PROBES) {
      process.stdout.write(`  ${p.id} … `);
      try {
        const inputTokens = await countTokens({ baseUrl: args.baseUrl, apiKey, model, text: p.text, proxy, mode: args.mode });
        console.log(`${inputTokens} tokens`);
        probes.push({ id: p.id, category: p.category, charLength: [...p.text].length, inputTokens });
      } catch (err) {
        console.log(`✗ ${err.message}`);
        failed = err.message;
        break; // 该模型不可用(404/403/key)就整模型跳过
      }
    }
    if (failed) baselines.push({ model, error: failed });
    else baselines.push({ model, probes });
  }

  const ok = baselines.filter((b) => !b.error);
  const groups = groupByTokenVector(ok);

  const out = {
    schema: "claude-token-baseline/v2",
    // —— 声明(JSON 无注释,用字段承载)——
    _generated: "本文件由 scripts/claude-token-baseline.mjs 生成,请勿手工编辑;改探针或换源后重跑覆盖。",
    _disclaimer:
      "这里的 token 数不保证等于 Claude 官方分词器的精确值——基线可能建立在某个可信上游通道之上。" +
      "指纹判定依赖的是『被测渠道的 token 数与本基线成线性关系(slope≈1 且 R²≈1)』,而非绝对相等;" +
      "线性关系若成立即说明二者同一分词器家族。",
    mode: args.mode,
    sourceOfficial: /^https:\/\/api\.anthropic\.com/.test(args.baseUrl), // 是否官方端点(不记录具体来源地址)
    anthropicVersion: ANTHROPIC_VERSION,
    probeVersion: TOKENIZER_PROBE_VERSION,
    createdAt: new Date().toISOString(),
    probeCount: TOKENIZER_PROBES.length,
    // 同向量分组 = 同一代分词器,审计时同组模型可共用一份基线。
    tokenizerGroups: groups,
    baselines,
  };
  writeFileSync(args.out, JSON.stringify(out, null, 2) + "\n", "utf8");

  console.log(`\n✅ 基线已写入: ${args.out}`);
  console.log(`   成功 ${ok.length}/${baselines.length} 个模型,探针版本 ${TOKENIZER_PROBE_VERSION}。`);
  if (groups.length) {
    console.log(`   检测到 ${groups.length} 代分词器(同组探针向量完全一致,可共用基线):`);
    groups.forEach((g, i) => console.log(`     [${i + 1}] ${g.join(", ")}`));
  }
  const errs = baselines.filter((b) => b.error);
  if (errs.length) {
    console.log(`   跳过 ${errs.length} 个模型:`);
    errs.forEach((b) => console.log(`     ${b.model} — ${b.error}`));
  }
}

main().catch((err) => {
  console.error(`\n❌ 失败: ${err.message}`);
  process.exit(1);
});
