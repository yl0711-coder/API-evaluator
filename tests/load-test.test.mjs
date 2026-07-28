// tests/load-test.test.mjs
// 压力测试 runner：aggregate 纯逻辑（warmup 排除 / 分位 / QPS / 错误分桶含 gen_saturated）+ 闭环 worker 池 +
// 开环固定速率（coordinated omission 纠正、发生器受限）+ 负载扫描找拐点。注入假 executeTestRequest/
// saveReportFiles，绝不真打网络、不写盘。
import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregate,
  classifyNetwork,
  classifyPointStatus,
  deriveOutputTokens,
  findKnee,
  formatSinglePointReport,
  formatSweepReport,
  runLoadTest,
} from "../server/load-test.mjs";

const fakeSave = async (runId) => ({ markdownPath: `/x/${runId}.md`, htmlPath: `/x/${runId}.html` });
const target = { baseUrl: "http://x", model: "m1" };

// ===================== aggregate 纯逻辑 =====================
test("aggregate：warmup 排除；成功率/QPS/分位/错误分桶（含 gen_saturated）正确", () => {
  const samples = [
    { ms: 100, ok: true, status: 200, err: "", warmup: true }, // 预热，不计
    { ms: 100, ok: true, status: 200, err: "", warmup: true }, // 预热，不计
    { ms: 100, ok: true, status: 200, err: "", warmup: false },
    { ms: 200, ok: true, status: 200, err: "", warmup: false },
    { ms: 300, ok: true, status: 200, err: "", warmup: false },
    { ms: 400, ok: true, status: 200, err: "", warmup: false },
    { ms: null, ok: false, status: 429, err: "rate_limited", warmup: false },
    { ms: null, ok: false, status: 503, err: "server_error", warmup: false },
    { ms: null, ok: false, status: null, err: "timeout", warmup: false },
    { ms: null, ok: false, status: null, err: "network_error", warmup: false },
    { ms: null, ok: false, status: null, err: "gen_saturated", warmup: false }, // 发生器受限：不计入 sent
  ];
  const s = aggregate({ samples, mode: "open", offered: 50, durationSec: 10 });

  assert.equal(s.mode, "open");
  assert.equal(s.offered, 50);
  assert.equal(s.warmupRequests, 2);
  assert.equal(s.steadyRequests, 9, "稳态 = 总数 - 预热");
  assert.equal(s.sentRequests, 8, "真正打到上游的（不含 gen_saturated）");
  assert.equal(s.genSaturated, 1);
  assert.equal(s.successCount, 4);
  assert.equal(s.successRate, 4 / 8, "成功率分母是 sent，不含发生器丢弃");
  assert.equal(s.qps, 0.8, "8 完成请求 / 10s");
  assert.equal(s.latency.p50, 200);
  assert.equal(s.latency.p95, 400);
  assert.equal(s.latency.max, 400);
  assert.equal(s.latency.avg, 250);
  assert.deepEqual({ ...s.errors }, { ok: 4, http_429: 1, http_5xx: 1, timeout: 1, network_error: 1, gen_saturated: 1, other: 0 });
  // 逐状态码明细：每个失败的 HTTP 状态码单独计数；无状态码的其它失败计入 noStatusOther。
  assert.deepEqual({ ...s.statusCounts }, { 429: 1, 503: 1 }, "429 与 503 各自成项");
  assert.equal(s.noStatusOther, 0, "timeout/network 有专门桶，noStatusOther 为 0");
  // 网络错误按侧别细分：本例的 network 样本无 netSide → 归 unknown。
  assert.deepEqual({ ...s.network }, { local: 0, upstream: 0, unknown: 1 });
});

test("classifyNetwork：按底层 errno 区分本机侧 / 服务器端 / 未判明", () => {
  assert.equal(classifyNetwork("fetch failed ECONNRESET"), "upstream", "对端重置 → 服务器端");
  assert.equal(classifyNetwork("socket hang up"), "upstream", "挂断 → 服务器端");
  assert.equal(classifyNetwork("fetch failed ETIMEDOUT"), "local", "连接超时 → 本机/链路侧");
  assert.equal(classifyNetwork("getaddrinfo ENOTFOUND api.x.com"), "local", "DNS → 本机侧");
  assert.equal(classifyNetwork("connect EMFILE"), "local", "文件描述符耗尽 → 本机侧");
  assert.equal(classifyNetwork("fetch failed"), "unknown", "无 errno → 未判明");
});

// ===================== 输出 token 吞吐(tokens/s) =====================
test("deriveOutputTokens：优先上游 usage，缺失用本地估算兜底，都无则 null", () => {
  assert.deepEqual(deriveOutputTokens({ outputTokens: 42 }), { tok: 42, est: false }, "上游 usage 精确");
  const est = deriveOutputTokens({ outputTokens: 0, responseText: "hello world, this is a code snippet" });
  assert.equal(est.est, true, "无 usage → 本地估算");
  assert.ok(est.tok > 0, "估算 token 数 > 0");
  assert.deepEqual(deriveOutputTokens({ responseText: "" }), { tok: null, est: false }, "无 usage 无文本 → null");
});

test("aggregate：输出 token 吞吐（宏观 tok/s、单请求均速、usage 覆盖率）", () => {
  const samples = [
    { ms: 1000, ok: true, status: 200, err: "", outTok: 100, outTokEst: false, warmup: false },
    { ms: 1000, ok: true, status: 200, err: "", outTok: 200, outTokEst: false, warmup: false },
    { ms: 2000, ok: true, status: 200, err: "", outTok: 300, outTokEst: false, warmup: false },
    { ms: 1000, ok: true, status: 200, err: "", outTok: 60, outTokEst: true, warmup: false }, // 本地估算
    { ms: null, ok: false, status: 500, err: "upstream_5xx", warmup: false }, // 失败无 token
    { ms: 999, ok: true, status: 200, err: "", outTok: 50, outTokEst: false, warmup: true }, // 预热不计
  ];
  const s = aggregate({ samples, mode: "closed", offered: 4, durationSec: 10 });
  assert.equal(s.outputTokens, 660, "稳态成功输出 token 总和 100+200+300+60");
  assert.equal(s.tokensPerSecond, 66, "宏观吞吐 660/10s");
  assert.equal(s.perReqTokensPerSec, 127.5, "单请求均速 mean(100,200,150,60)");
  assert.equal(s.tokenUsageCoverage, 0.75, "4 条里 1 条估算 → 覆盖率 75%");
  const md = formatSinglePointReport({ mode: "closed", timeoutSec: 30, durationSec: 10, warmupSec: 0, maxTokens: 64 }, s);
  assert.match(md, /- 输出吞吐：66 tok\/s（总输出 660 tokens · 单请求均速 127\.5 tok\/s/);
  assert.match(md, /其中 25% 为本地分词估算/, "覆盖率<100% 应标注估算占比");
});

test("aggregate + 报告：流式给出 TTFT 分位数；非流式无 TTFT → 整节省略", () => {
  const ok = (ms, ttft) => ({ ms, ttft, ok: true, status: 200, err: "", outTok: 10, outTokEst: false, warmup: false });
  // 流式：ttft 有值（且失败样本不计入）
  const streamed = aggregate({
    samples: [
      ok(1000, 100),
      ok(1000, 200),
      ok(1000, 300),
      ok(1000, 400),
      { ms: null, ttft: null, ok: false, status: 500, err: "upstream_5xx", warmup: false },
    ],
    mode: "closed",
    offered: 4,
    durationSec: 10,
  });
  assert.equal(streamed.ttftCount, 4, "只统计有 TTFT 的成功样本");
  assert.equal(streamed.ttft.p50, 200);
  assert.equal(streamed.ttft.max, 400);
  assert.equal(streamed.ttft.avg, 250);

  // 非流式：执行器不采 TTFT → 全 null
  const plain = aggregate({ samples: [ok(1000, null), ok(1000, null)], mode: "closed", offered: 2, durationSec: 10 });
  assert.equal(plain.ttftCount, 0);
  assert.equal(plain.ttft.p50, null, "无样本时为 null，不能是 0（0 会被误读成极快）");

  const meta = { mode: "closed", timeoutSec: 30, durationSec: 10, warmupSec: 0, maxTokens: 64 };
  const mdStream = formatSinglePointReport({ ...meta, stream: true }, streamed);
  assert.match(mdStream, /## 首 token 延迟（TTFT · 仅流式）/, "流式应出 TTFT 小节");
  assert.match(mdStream, /基于 4 条成功请求/);
  assert.match(mdStream, /请求方式 流式 SSE/, "报告头标明请求方式");

  const mdPlain = formatSinglePointReport({ ...meta, stream: false }, plain);
  assert.doesNotMatch(mdPlain, /首 token 延迟/, "非流式不应出现 TTFT 小节（不留空表误导）");
  assert.match(mdPlain, /请求方式 非流式/);
});

// ===================== 闭环 worker 池 =====================
test("闭环：持续并发（在飞可达 N，非串行）、writeLog:false + noRetry:true 透传、产出单点报告", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const seenOptions = [];
  const fakeExecute = async (_t, _p, options) => {
    seenOptions.push(options);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return { success: true, statusCode: 200, totalMs: 5, normalizedError: "" };
  };
  const result = await runLoadTest(
    { target, mode: "closed", loads: [5], durationSec: 5, warmupSec: 0, promptProfile: "simple", timeoutSec: 30 },
    { task: { abortController: new AbortController() } },
    { executeTestRequest: fakeExecute, saveReportFiles: fakeSave },
  );
  assert.equal(result.mode, "closed");
  assert.equal(result.offered, 5);
  assert.ok(maxInFlight >= 2 && maxInFlight <= 5, `在飞应在(2..5]，实测 ${maxInFlight}`);
  assert.ok(result.sentRequests > 0);
  assert.equal(result.sweep, undefined, "单点不带 sweep");
  assert.match(result.reportHtmlPath, /\.html$/);
  assert.ok(
    seenOptions.every((o) => o.noRetry === true),
    "noRetry 透传",
  );
  assert.ok(
    seenOptions.every((o) => o.writeLog === false),
    "writeLog:false 透传",
  );
});

// ===================== 闭环思考时间(think time) =====================
test("闭环思考时间：intervalSec 让每个用户收到响应后停顿再发 → 请求数被显著节流；超时 120 透传", async () => {
  let calls = 0;
  let seenTarget = null;
  const fakeExecute = async (probeTarget) => {
    calls += 1;
    seenTarget = probeTarget;
    await new Promise((r) => setTimeout(r, 5)); // 极快响应；若无 think time，5s 会发出成百上千条
    return { success: true, statusCode: 200, totalMs: 5, normalizedError: "" };
  };
  const result = await runLoadTest(
    { target, mode: "closed", loads: [2], durationSec: 5, warmupSec: 0, intervalSec: 1, timeoutSec: 120, promptProfile: "simple" },
    { task: { abortController: new AbortController() } },
    { executeTestRequest: fakeExecute, saveReportFiles: fakeSave },
  );
  // 2 个用户、每次响应后停顿 1s、稳态 5s → 每人约 5~6 条 → 总数约 10~14，远少于无间隔的成百上千。
  assert.ok(calls <= 20, `思考时间应把请求数节流到很小，实测 ${calls}`);
  assert.ok(result.sentRequests >= 4, `仍应发出若干请求，实测 ${result.sentRequests}`);
  assert.equal(seenTarget.timeoutMs, 120000, "每请求超时 120s 透传为 timeoutMs=120000");
});

// ===================== 详细错误构成表(③) =====================
test("详细错误构成表：每个状态码一行、含上游原因短语；无状态码/无短语填「—」", () => {
  const mk = (n, s) => Array.from({ length: n }, () => s);
  const samples = [
    ...mk(10, { ms: 100, ok: true, status: 200, statusText: "OK", err: "", warmup: false }),
    // 429 带自定义原因短语（HTTP/1.1 上游可自定义），应原样展示。
    ...mk(3, { ms: null, ok: false, status: 429, statusText: "Slow Down Please", err: "rate_limited", warmup: false }),
    // 500 无原因短语（如 HTTP/2），短语列应填「—」。
    ...mk(2, { ms: null, ok: false, status: 500, statusText: "", err: "upstream_5xx", warmup: false }),
    ...mk(4, { ms: null, ok: false, status: null, err: "timeout", warmup: false }),
    ...mk(1, { ms: null, ok: false, status: null, err: "network_error", netSide: "upstream", warmup: false }),
  ];
  const p = aggregate({ samples, mode: "closed", offered: 5, durationSec: 10 });
  assert.equal(p.statusPhrases[429], "Slow Down Please", "429 的原因短语被聚合");
  assert.equal(p.statusPhrases[500], undefined, "无短语则不记入");
  const md = formatSinglePointReport({ mode: "closed", timeoutSec: 30, durationSec: 10, warmupSec: 0, maxTokens: 64 }, p);
  assert.match(md, /## 详细错误构成/);
  assert.match(md, /\| 错误类型 \| 错误码 \| 原因短语 \| 数量 \|/);
  assert.match(md, /\| 上游限流 \| 429 \| Slow Down Please \| 3 \|/, "429 一行带上游自定义原因短语");
  assert.match(md, /\| 上游服务错误 \| 500 \| — \| 2 \|/, "500 无短语：短语列填「—」");
  assert.match(md, /\| 超时 \| — \| — \| 4 \|/, "无状态码的超时：错误码与短语列均填「—」");
  assert.match(md, /\| 网络·服务器端 \| — \| — \| 1 \|/, "网络侧别行：错误码与短语列均填「—」");
  // 错误构成列表与说明栏也应带上「状态码 + 原因短语」。
  assert.match(md, /- HTTP 429 Slow Down Please（上游限流）：3/, "错误构成列表含原因短语");
});

// 成功判定是「2xx 且有输出」，故 200 也可能算失败——此时状态码本身毫无信息量，报告必须说出
// 真实原因（normalizedError）。旧实现按状态码分桶、把 err 丢掉，200 落进兜底文案「非常规状态码」，
// 既是错的（200 最常规）又把排查方向带偏。
test("2xx 判失败：报告给出真实原因而非「非常规状态码」；同码多因取占比最高者", () => {
  const mk = (n, s) => Array.from({ length: n }, () => s);
  const samples = [
    ...mk(10, { ms: 100, ok: true, status: 200, statusText: "OK", err: "", warmup: false }),
    // 200 但响应体没有可提取文本 → 对用户等同于没有回答
    ...mk(8, { ms: null, ok: false, status: 200, statusText: "OK", err: "empty_response", warmup: false }),
  ];
  const p = aggregate({ samples, mode: "closed", offered: 5, durationSec: 10 });
  assert.equal(p.statusCounts[200], 8, "只有失败的 200 进错误分桶，成功的不算");
  assert.deepEqual(p.statusReasons[200], { empty_response: 8 }, "真实原因必须留存——压测不写请求日志，报告是唯一产物");

  const meta = { mode: "closed", timeoutSec: 30, durationSec: 10, warmupSec: 0, maxTokens: 64 };
  const md = formatSinglePointReport(meta, p);
  assert.match(md, /\| 无输出 \| 200 \| OK \| 8 \|/, "详细表按真实原因给标签");
  assert.match(md, /- HTTP 200 OK（无输出）：8/);
  assert.doesNotMatch(md, /非常规状态码/, "200 是最常规的状态码，这句话会把排查带偏");
  assert.match(md, /没有可提取的文本/, "说明栏要讲清为什么 2xx 也算失败");

  // 中转用 200 包错误的情形：限流原因不能被「无输出」盖掉
  const throttled = aggregate({
    samples: [
      ...mk(2, { ms: 100, ok: true, status: 200, statusText: "OK", err: "", warmup: false }),
      ...mk(5, { ms: null, ok: false, status: 200, statusText: "OK", err: "rate_limited", warmup: false }),
      ...mk(2, { ms: null, ok: false, status: 200, statusText: "OK", err: "empty_response", warmup: false }),
    ],
    mode: "closed",
    offered: 5,
    durationSec: 10,
  });
  const md2 = formatSinglePointReport(meta, throttled);
  assert.match(md2, /\| 上游限流（2xx 包错误） \| 200 \| OK \| 7 \|/, "同码多因：取占比最高的 rate_limited");
});

// ===================== 开环固定速率 + CO 纠正 + 发生器受限 =====================
test("开环：按目标速率发包、在飞打满记 gen_saturated（客户端饱和信号）；延迟按计划时刻计(CO 纠正)", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const fakeExecute = async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 60)); // 慢响应：在飞需求 ≈ 速率×0.06
    inFlight -= 1;
    return { success: true, statusCode: 200, totalMs: 60, normalizedError: "" };
  };
  // 速率 50/s、在飞上限 2 → 需求(≈3) > 上限 → 必然出现 gen_saturated。
  const result = await runLoadTest(
    { target, mode: "open", loads: [50], durationSec: 5, warmupSec: 0, maxInFlight: 2, promptProfile: "simple" },
    { task: { abortController: new AbortController() } },
    { executeTestRequest: fakeExecute, saveReportFiles: fakeSave },
  );
  assert.equal(result.mode, "open");
  assert.equal(result.offered, 50);
  assert.ok(maxInFlight <= 2, "开环在飞不超过 maxInFlight 上限");
  assert.ok(result.genSaturated > 0, "速率超过在飞上限承载 → 记录发生器受限");
  assert.ok(result.errors.gen_saturated > 0);
  // CO 纠正：延迟按计划发起时刻计，含发生器排队等待，故明显大于单请求 60ms 响应。
  assert.ok(result.latency.p95 === null || result.latency.p95 >= 60, "尾延迟含排队，不被低报");
});

// ===================== 开环发送周期(突发) =====================
test("开环发送周期：每 N 秒只在前 1 秒匀速发满，其余静默 → 发送集中成簇、总量约为连续的 1/N", async () => {
  const callTimes = [];
  const start = performance.now();
  const fakeExecute = async () => {
    callTimes.push(performance.now() - start);
    return { success: true, statusCode: 200, totalMs: 1, normalizedError: "" };
  };
  // 速率 20/s、发送周期 2s、稳态 4s：应在 [0,1)s 和 [2,3)s 两个窗口各发 ~20 个，[1,2)s 与 [3,4)s 静默。
  await runLoadTest(
    { target, mode: "open", loads: [20], durationSec: 4, warmupSec: 0, burstPeriodSec: 2, maxInFlight: 500, promptProfile: "simple" },
    { task: { abortController: new AbortController() } },
    { executeTestRequest: fakeExecute, saveReportFiles: fakeSave },
  );
  const inSilent = callTimes.filter((t) => {
    const pos = t % 2000;
    return pos >= 1100 && pos < 1900; // 静默段中间，留边界容差
  });
  assert.equal(
    inSilent.length,
    0,
    `静默段不应有发送，实测 ${inSilent.length} 个（时刻 ${inSilent.slice(0, 5).map((x) => Math.round(x))}）`,
  );
  // 连续发本应约 20×4=80；每 2s 只发 1s → 约 40。给宽松范围。
  assert.ok(callTimes.length <= 60, `突发应把总量降到约 1/2，实测 ${callTimes.length}`);
  assert.ok(callTimes.length >= 20, `仍应有两簇发送，实测 ${callTimes.length}`);
});

// ===================== 上游饱和 vs 客户端受限 分类 =====================
// 合成负载点：只填分类/报告需要的字段（吞吐、p99、成功率、429、发生器受限）。
const mkPoint = (o = {}) => ({
  offered: o.offered ?? 10,
  qps: o.qps ?? 100,
  tokensPerSecond: o.tokensPerSecond ?? 0,
  successRate: o.successRate ?? 1,
  // 真实点必有此字段；sentRequests=0 意味着一个请求都没发出去，此时 successRate 是 0/0 造出来的，
  // 不是测量值（见 classifyPointStatus 的客户端受限判定）。
  sentRequests: o.sentRequests ?? 100,
  genSaturated: o.genSaturated ?? 0,
  errors: { http_429: o.http_429 ?? 0, http_5xx: o.http_5xx ?? 0, timeout: o.timeout ?? 0 },
  latency: { p95: o.p95 ?? o.p99 ?? 1000, p99: o.p99 ?? 1000 },
});

test("classifyPointStatus：限流/出错/客户端受限/上游饱和/健康 五类优先级正确", () => {
  const base = mkPoint({ tokensPerSecond: 100, p99: 1000 });
  assert.equal(classifyPointStatus(null, base).tag, "baseline", "首点无前点 → 基准");
  assert.equal(classifyPointStatus(base, mkPoint({ http_429: 1 })).tag, "throttled", "429 → 上游限流");
  assert.equal(classifyPointStatus(base, mkPoint({ successRate: 0.9 })).tag, "errors", "成功率<99% → 出错");
  assert.equal(classifyPointStatus(base, mkPoint({ genSaturated: 3 })).tag, "client_saturated", "发生器打满 → 客户端受限");
  // 吞吐持平(102 < 100×1.05) 且 p99 由 1000→2000(≥1.3×) → 上游饱和
  assert.equal(
    classifyPointStatus(base, mkPoint({ tokensPerSecond: 102, p99: 2000 })).tag,
    "server_saturated",
    "吞吐持平+ p99 飙 → 上游饱和",
  );
  // 吞吐仍上升 → 健康（即便 p99 抬升）
  assert.equal(classifyPointStatus(base, mkPoint({ tokensPerSecond: 150, p99: 2000 })).tag, "healthy", "吞吐仍上升 → 健康");
});

test("classifyPointStatus：无 token 数据时退回 QPS 斜率判上游饱和", () => {
  const prev = mkPoint({ tokensPerSecond: 0, qps: 100, p99: 1000 });
  const cur = mkPoint({ tokensPerSecond: 0, qps: 101, p99: 1500 }); // QPS 持平 + p99 1.5× → 饱和
  assert.equal(classifyPointStatus(prev, cur).tag, "server_saturated");
});

test("findKnee：上游饱和 vs 客户端受限，措辞区分、推荐点为前一健康点", () => {
  const serverSeq = [
    mkPoint({ offered: 2, tokensPerSecond: 50, p99: 500 }),
    mkPoint({ offered: 4, tokensPerSecond: 100, p99: 800 }),
    mkPoint({ offered: 8, tokensPerSecond: 101, p99: 2000 }), // 吞吐持平 + p99 抬升
  ];
  const k1 = findKnee(serverSeq);
  assert.equal(k1.index, 1, "推荐前一健康点(index1)");
  assert.equal(k1.tag, "server_saturated");
  assert.match(k1.reason, /上游饱和/);

  const clientSeq = [
    mkPoint({ offered: 2, tokensPerSecond: 50, p99: 500 }),
    mkPoint({ offered: 4, tokensPerSecond: 100, p99: 800 }),
    mkPoint({ offered: 8, tokensPerSecond: 200, p99: 900, genSaturated: 5 }), // 吞吐还在涨但发生器打满
  ];
  const k2 = findKnee(clientSeq);
  assert.equal(k2.index, 1);
  assert.equal(k2.tag, "client_saturated");
  assert.match(k2.reason, /客户端受限/);
  assert.match(k2.reason, /未能证明上游是否还有余量/);
});

// 基准点(points[0])从不被 classifyPointStatus 判定（首点恒返回 baseline），findKnee 又从 i=1 起判、
// 返回 i-1 —— 于是「Key 填错 → 全部点 401」时，一个 0% 成功率的点会被当「最后一个健康点」推荐出去。
test("findKnee：基准点自己就不可用（全 401）→ 不得把它当健康点推荐", () => {
  const allFailing = [
    mkPoint({ offered: 2, qps: 0, successRate: 0, tokensPerSecond: 0 }),
    mkPoint({ offered: 5, qps: 0, successRate: 0, tokensPerSecond: 0 }),
    mkPoint({ offered: 10, qps: 0, successRate: 0, tokensPerSecond: 0 }),
  ];
  const k = findKnee(allFailing);
  assert.equal(k.index, -1, "无任何可用点时不得指向某个负载点");
  assert.equal(k.tag, "unusable_baseline");
  assert.match(k.reason, /基准点/, "须点明是基准点本身就不可用");
  assert.doesNotMatch(k.reason, /最后一个健康点/);
});

test("findKnee：基准点一上来就被限流（429）→ 同样无可推荐容量", () => {
  const k = findKnee([mkPoint({ offered: 2, http_429: 5 }), mkPoint({ offered: 5, http_429: 9 })]);
  assert.equal(k.index, -1);
  assert.equal(k.tag, "unusable_baseline");
});

test("formatSweepReport：无可推荐容量时如实说明，不得崩溃、不得报出不存在的点", () => {
  const allFailing = [
    mkPoint({ offered: 2, qps: 0, successRate: 0, tokensPerSecond: 0 }),
    mkPoint({ offered: 5, qps: 0, successRate: 0, tokensPerSecond: 0 }),
  ];
  const md = formatSweepReport(
    {
      mode: "closed",
      model: "m",
      protocol: "openai",
      promptProfile: "simple",
      durationSec: 60,
      warmupSec: 5,
      timeoutSec: 30,
      maxTokens: 256,
    },
    allFailing,
    findKnee(allFailing),
  );
  const capacityLine = md.split("\n").find((l) => l.includes("推荐可用容量")) || "";
  assert.match(capacityLine, /无可推荐容量/);
  assert.doesNotMatch(capacityLine, /并发 = 2/, "0% 成功率的点绝不能被推荐为容量");
  assert.doesNotMatch(capacityLine, /undefined/, "不得把不存在的点渲染成 undefined");
  assert.match(md, /基准点/, "判定须点明是基准点本身不可用");
});

test("findKnee：基准点健康时行为不变（防回归）", () => {
  const seq = [
    mkPoint({ offered: 2, tokensPerSecond: 50, p99: 500 }),
    mkPoint({ offered: 4, tokensPerSecond: 100, p99: 800 }),
    mkPoint({ offered: 8, tokensPerSecond: 101, p99: 2000 }),
  ];
  assert.equal(findKnee(seq).index, 1);
  assert.equal(findKnee(seq).tag, "server_saturated");
});

// sent=0 时 successRate 是 0/0 造出来的 0（不是测量值）。classifyPointStatus 先判 successRate<0.99
// 再判 genSaturated，于是「发生器打满、一个请求都没发出去」会被判成「出错/失败」甩锅上游——
// 正是本模块注释明令不许的混淆（gen_saturated 证明不了上游到顶）。
test("classifyPointStatus：一个都没发出去 + 发生器打满 → 客户端受限，不得甩锅上游", () => {
  const prev = mkPoint({ offered: 10, tokensPerSecond: 500, p99: 900 });
  const cur = mkPoint({ offered: 100, qps: 0, successRate: 0, tokensPerSecond: 0, genSaturated: 500, sentRequests: 0 });
  const st = classifyPointStatus(prev, cur);
  assert.equal(st.tag, "client_saturated", "没发出去的请求不能算上游失败");
  assert.equal(st.label, "客户端受限");
});

test("classifyPointStatus：真发出去了且成功率低 → 仍判出错/失败（防止修过头）", () => {
  const prev = mkPoint({ offered: 10, tokensPerSecond: 500, p99: 900 });
  const cur = mkPoint({ offered: 20, successRate: 0.5, genSaturated: 3, sentRequests: 100 });
  assert.equal(classifyPointStatus(prev, cur).tag, "errors", "确实发出去并失败了，就该算上游出错——即便同时有发生器受限");
});

test("formatSweepReport：表格含「状态」列，首行「基准」，饱和点标注「上游饱和」+ 双峰脚注", () => {
  const points = [
    mkPoint({ offered: 2, qps: 10, tokensPerSecond: 50, p95: 400, p99: 500 }),
    mkPoint({ offered: 4, qps: 20, tokensPerSecond: 100, p95: 700, p99: 800 }),
    mkPoint({ offered: 8, qps: 20, tokensPerSecond: 101, p95: 1800, p99: 2000 }),
  ];
  const knee = findKnee(points);
  const md = formatSweepReport(
    {
      mode: "closed",
      model: "m1",
      protocol: "openai",
      durationSec: 5,
      warmupSec: 0,
      maxTokens: 64,
      timeoutSec: 30,
      promptProfile: "simple",
    },
    points,
    knee,
  );
  // TTFT p95 列：非流式点无数据显示「—」（见下方 mkPoint 未给 ttft）。
  assert.match(
    md,
    /\| 并发 \| QPS \| tok\/s \| 成功率 \| TTFT p95 \| p95 \| p99 \| 429 \| 超时\+5xx \| 发生器受限 \| 状态 \|/,
    "表头含 TTFT p95 与状态列",
  );
  assert.match(md, /\| 2 \| 10 \| 50 \| .* \| 基准 \|/, "首行状态为基准");
  assert.match(md, /上游饱和/, "饱和点标注上游饱和");
  assert.match(md, /双峰/, "脚注含双峰提示");
  assert.match(md, /客户端受限/, "脚注解释客户端受限");
});

// ===================== 负载扫描找拐点(D) =====================
test("扫描：多负载点 → sweep 数组 + 拐点；出错点前一个健康点为推荐容量", async () => {
  // 负载 2、4 成功；负载 8 触发 429（模拟上游在高负载下限流）。
  const fakeExecute = async (target2) => {
    void target2;
    return { success: true, statusCode: 200, totalMs: 10, normalizedError: "" };
  };
  // 用一个按并发计数的假执行器：并发≥8 时返回 429。closed 模式下 load=并发。
  let inFlight = 0;
  const gated = async () => {
    inFlight += 1;
    const cur = inFlight;
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    if (cur >= 8) return { success: false, statusCode: 429, totalMs: 5, normalizedError: "rate_limited" };
    return { success: true, statusCode: 200, totalMs: 5, normalizedError: "" };
  };
  void fakeExecute;
  const result = await runLoadTest(
    { target, mode: "closed", loads: [2, 4, 8], durationSec: 5, warmupSec: 0, promptProfile: "simple" },
    { task: { abortController: new AbortController() } },
    { executeTestRequest: gated, saveReportFiles: fakeSave },
  );
  assert.ok(Array.isArray(result.sweep) && result.sweep.length === 3, "三个负载点");
  assert.deepEqual(
    result.sweep.map((p) => p.offered),
    [2, 4, 8],
    "按负载升序",
  );
  assert.ok(result.knee, "有拐点结论");
  assert.ok(result.knee.offered <= 4, `拐点(推荐容量)应在出错点(8)之前，实测 ${result.knee.offered}`);
  assert.match(result.reportHtmlPath, /\.html$/);
});

// ===================== 取消 =====================
test("取消：任务开始即 cancelRequested → 立即收手不发请求，并抛 TaskCancelledError（供 task-manager 标记为 cancelled）", async () => {
  let calls = 0;
  const fakeExecute = async () => {
    calls += 1;
    return { success: true, statusCode: 200, totalMs: 1, normalizedError: "" };
  };
  await assert.rejects(
    runLoadTest(
      { target, mode: "closed", loads: [4], durationSec: 30, warmupSec: 0, promptProfile: "simple" },
      { task: { cancelRequested: true, abortController: new AbortController() } },
      { executeTestRequest: fakeExecute, saveReportFiles: fakeSave },
    ),
    (err) => err.name === "TaskCancelledError",
  );
  assert.equal(calls, 0, "取消态下 worker 立即退出，不发请求");
});
