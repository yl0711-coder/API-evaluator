// scripts/verify-fingerprint.mjs
//
// 只读验收工具:向一个 OpenAI 兼容渠道发同一批探针,读 usage.prompt_tokens,
// 与 claude-token-baseline.json 里某个模型的基线向量做线性拟合(reported ≈ slope·base + intercept),
// 看 slope/R² 是否成立 —— 验证「token 指纹能否区分同代 Claude 与冒牌后端」。
//
// 不写盘、不碰主流程。key 从环境变量取(默认 EVALUATOR_VERIFY_KEY),绝不硬编码/打印。
//
// 例(DeepSeek 官方当冒牌对照,拟合 opus-4-8 基线):
//   EVALUATOR_VERIFY_KEY=sk-... node scripts/verify-fingerprint.mjs \
//     --base-url https://api.deepseek.com --model deepseek-chat --baseline-model claude-opus-4-8
// 选项:--baseline <path>(默认 scripts/claude-token-baseline.json) --proxy <url> --key-env <name>

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import https from "node:https";
import http from "node:http";
import { TOKENIZER_PROBES } from "../server/tokenizer-probes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const a = { baseUrl: "", model: "", baselineModel: "", baseline: resolve(HERE, "claude-token-baseline.json"), proxy: "", keyEnv: "EVALUATOR_VERIFY_KEY" };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === "--base-url") a.baseUrl = argv[++i];
    else if (k === "--model") a.model = argv[++i];
    else if (k === "--baseline-model") a.baselineModel = argv[++i];
    else if (k === "--baseline") a.baseline = resolve(process.cwd(), argv[++i]);
    else if (k === "--proxy") a.proxy = argv[++i];
    else if (k === "--key-env") a.keyEnv = argv[++i];
    else { console.error(`未知参数: ${k}`); process.exit(2); }
  }
  if (!a.baseUrl || !a.model) { console.error("需要 --base-url 和 --model"); process.exit(2); }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function postJson({ url, headers, body, proxy }) {
  return new Promise((resolve2, reject) => {
    const t = new URL(url);
    const port = t.port || 443;
    const payload = Buffer.from(body);
    const h = { ...headers, "content-length": String(payload.length) };
    const fire = (socket) => {
      const req = https.request(
        { method: "POST", hostname: t.hostname, port, path: `${t.pathname}${t.search}`, headers: h, ...(socket ? { socket, agent: false } : {}) },
        (res) => { let d = ""; res.setEncoding("utf8"); res.on("data", (c) => (d += c)); res.on("end", () => resolve2({ status: res.statusCode, text: d })); },
      );
      req.on("error", reject); req.write(payload); req.end();
    };
    if (!proxy) return fire(null);
    const p = new URL(proxy);
    const c = http.request({ host: p.hostname, port: p.port || 80, method: "CONNECT", path: `${t.hostname}:${port}` });
    c.on("connect", (res, socket) => { if (res.statusCode !== 200) { reject(new Error(`代理 CONNECT ${res.statusCode}`)); socket.destroy(); return; } fire(socket); });
    c.on("error", reject); c.end();
  });
}

async function promptTokens({ baseUrl, key, model, text, proxy }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
  const body = JSON.stringify({ model, messages: [{ role: "user", content: text }], max_tokens: 1, stream: false });
  for (let attempt = 1; ; attempt += 1) {
    let res;
    try { res = await postJson({ url, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body, proxy }); }
    catch (e) { if (attempt < 3) { await sleep(500 * attempt); continue; } throw new Error(`网络错误: ${e.message}`); }
    if (res.status >= 200 && res.status < 300) {
      const j = JSON.parse(res.text);
      const n = Number(j.usage?.prompt_tokens ?? j.usage?.input_tokens);
      if (!Number.isFinite(n)) throw new Error(`缺 prompt_tokens: ${res.text.slice(0, 140)}`);
      return n;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(attempt * 1000); continue; }
    throw new Error(`HTTP ${res.status} — ${res.text.replace(/\s+/g, " ").slice(0, 160)}`);
  }
}

// 最小二乘 reported ≈ slope·base + intercept,外加 R²。
function linfit(points) {
  const n = points.length;
  const sx = points.reduce((a, p) => a + p.base, 0);
  const sy = points.reduce((a, p) => a + p.rep, 0);
  const sxx = points.reduce((a, p) => a + p.base * p.base, 0);
  const sxy = points.reduce((a, p) => a + p.base * p.rep, 0);
  const denom = n * sxx - sx * sx;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const meanY = sy / n;
  const ssTot = points.reduce((a, p) => a + (p.rep - meanY) ** 2, 0);
  const ssRes = points.reduce((a, p) => a + (p.rep - (slope * p.base + intercept)) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : null;
  return { slope, intercept, r2 };
}

const round = (x, d = 4) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const key = process.env[args.keyEnv];
  if (!key) { console.error(`环境变量 ${args.keyEnv} 未设(用它传 key,勿写进文件)`); process.exit(1); }

  const baselineDoc = JSON.parse(readFileSync(args.baseline, "utf8"));
  const ok = (baselineDoc.baselines || []).filter((b) => !b.error);
  const wanted = args.baselineModel || ok[0]?.model;
  const baseEntry = ok.find((b) => b.model === wanted);
  if (!baseEntry) { console.error(`基线里没有模型 ${wanted}。可选: ${ok.map((b) => b.model).join(", ")}`); process.exit(1); }
  const baseById = new Map(baseEntry.probes.map((p) => [p.id, p.inputTokens]));

  console.log(`被测: ${args.model} @ ${args.baseUrl}`);
  console.log(`基线: ${baseEntry.model}(探针版本 ${baselineDoc.probeVersion}, mode=${baselineDoc.mode})`);
  if (baselineDoc.probeVersion !== undefined) console.log("");

  const points = [];
  const rows = [];
  for (const p of TOKENIZER_PROBES) {
    if (!baseById.has(p.id)) continue;
    process.stdout.write(`  ${p.id} … `);
    let rep;
    try { rep = await promptTokens({ baseUrl: args.baseUrl, key, model: args.model, text: p.text, proxy: args.proxy }); }
    catch (e) { console.log(`✗ ${e.message}`); continue; }
    const base = baseById.get(p.id);
    console.log(`base=${base} reported=${rep}`);
    points.push({ id: p.id, base, rep });
    rows.push({ id: p.id, category: p.category, base, rep });
  }
  if (points.length < 3) { console.error("可用点不足 3 个,无法拟合。"); process.exit(1); }

  const { slope, intercept, r2 } = linfit(points);
  // 残差:被测点偏离拟合线多少(同分词器应几乎为 0;冒牌的发散探针残差大)。
  rows.forEach((r) => (r.resid = Math.round(r.rep - (slope * r.base + intercept))));
  rows.sort((a, b) => Math.abs(b.resid) - Math.abs(a.resid));

  console.log("\n拟合 reported ≈ slope·base + intercept:");
  console.log(`  slope=${round(slope)}  intercept=${round(intercept, 1)}  R²=${round(r2, 5)}  (n=${points.length})`);
  console.log("\n残差最大的几条(同一分词器应都接近 0):");
  console.log("  " + "id".padEnd(18) + "category".padEnd(12) + "base".padStart(6) + "rep".padStart(6) + "resid".padStart(7));
  rows.slice(0, 6).forEach((r) =>
    console.log("  " + r.id.padEnd(18) + r.category.padEnd(12) + String(r.base).padStart(6) + String(r.rep).padStart(6) + String(r.resid).padStart(7)),
  );

  const consistent = slope >= 0.97 && slope <= 1.03 && r2 != null && r2 >= 0.999;
  console.log("\n判定:");
  if (consistent) {
    console.log(`  ✅ 与 ${baseEntry.model} 高度线性一致(slope≈1, R²≈1)→ 同一分词器家族。`);
  } else {
    console.log(`  ❌ 与 ${baseEntry.model} 不一致(slope=${round(slope)}, R²=${round(r2, 5)})→ 非该代 Claude 分词器(冒牌/换代信号)。`);
  }
}

main().catch((e) => { console.error(`\n失败: ${e.message}`); process.exit(1); });
