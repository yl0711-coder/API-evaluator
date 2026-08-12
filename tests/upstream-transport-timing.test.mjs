import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 全程 127.0.0.1，关掉私网出站拦截保持确定性。
process.env.EVALUATOR_DATA_DIR = mkdtempSync(join(tmpdir(), "transport-timing-test-"));
process.env.EVALUATOR_SECRET_STORE = "memory";
process.env.EVALUATOR_EGRESS_DENY_PRIVATE = "false";

const { executeUpstreamRequest } = await import("../server/upstream-transport.mjs");

// 回归：被 abort 的请求必须记【真实耗时】，不能拿 timeoutMs 顶替。
// 真超时场景两者本来就≈相等，问题出在「用户取消」——请求是提前中断的，实际可能只跑了 1-2 秒，
// 却被写成 total_ms = timeoutMs（默认 300000）。这些行会进 test_requests，喂给趋势图 / 回归判定的
// 延迟序列（server/db.mjs 按 total_ms IS NOT NULL 取点），一条假的 5 分钟足以把 P95 拉飞。
// 真实渠道上复现过：取消准入任务后落库的那条 abort 记录 ms=300000，实际耗时约 1-2 秒。
test("executeUpstreamRequest：被取消的请求记真实耗时，不是 timeoutMs", async () => {
  // 永不响应的上游：唯一的终止途径就是外部 abort。
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);

    const profile = {
      id: "p-timing-1",
      baseUrl,
      apiKey: "sk-mock",
      protocol: "openai_chat",
      defaultModel: "m",
      timeoutMs: 300000, // 5 分钟：远大于本用例的实际耗时，修复前会被原样记进 totalMs
    };

    const record = await executeUpstreamRequest(
      profile,
      { abortSignal: controller.signal },
      {
        buildRequest: (p) => ({
          url: `${p.baseUrl}/v1/chat/completions`,
          headers: { "content-type": "application/json" },
          body: { model: p.defaultModel, messages: [{ role: "user", content: "hi" }] },
        }),
        interpret: () => {},
        computeSuccess: () => false,
        finalizeRecord: (x) => x,
      },
    );

    assert.equal(record.normalizedError, "timeout", "外部取消归一化为 timeout（止损不重试）");
    // 300ms 后取消，宽松给到 30s 也远低于 timeoutMs；修复前这里恰好等于 300000。
    assert.ok(record.totalMs < 30000, `取消应记真实耗时，实际记了 ${record.totalMs}ms（timeoutMs=${profile.timeoutMs}）`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
  }
});

// 回归：发生过重试之后再被取消，totalMs 必须是【最后一次尝试】的真实耗时。
// 上一条只覆盖了「第 1 次尝试就被取消」，于是这条路径漏了：每次尝试开头的字段重置清单里
// 没有 totalMs，而 catch 分支写的是 `r.totalMs ?? 实测值` —— `??` 会保住第 1 次尝试留下的旧值。
// 后果和上一条同源：一条假延迟进 test_requests，喂给 P50/P95、趋势图与回归判定。
// 这里第 1 次尝试慢慢回一个 429（retry-after: 0，不退避），第 2 次挂住不响应、由测试主动取消。
test("executeUpstreamRequest：重试后被取消，totalMs 记最后一次尝试的耗时而非上一次", async () => {
  const SLOW_FIRST_MS = 800;
  const CANCEL_AFTER_MS = 120;
  let hits = 0;
  let notifySecondHit;
  const secondHit = new Promise((resolve) => {
    notifySecondHit = resolve;
  });

  const server = createServer((_req, res) => {
    hits += 1;
    if (hits === 1) {
      setTimeout(() => {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
        res.end(JSON.stringify({ error: { message: "rate limited" } }));
      }, SLOW_FIRST_MS);
      return;
    }
    // 第 2 次尝试：永不响应，等测试 abort（不能用 sleep 等它开始，靠请求落地事件驱动）。
    notifySecondHit();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const controller = new AbortController();
    secondHit.then(() => setTimeout(() => controller.abort(), CANCEL_AFTER_MS));

    const record = await executeUpstreamRequest(
      {
        id: "p-timing-2",
        baseUrl,
        apiKey: "sk-mock",
        protocol: "openai_chat",
        defaultModel: "m",
        timeoutMs: 300000,
      },
      { abortSignal: controller.signal },
      {
        buildRequest: (p) => ({
          url: `${p.baseUrl}/v1/chat/completions`,
          headers: { "content-type": "application/json" },
          body: { model: p.defaultModel, messages: [{ role: "user", content: "hi" }] },
        }),
        interpret: () => {},
        computeSuccess: () => false,
        finalizeRecord: (x) => x,
      },
    );

    assert.equal(hits, 2, "应真的发生了第 2 次尝试，否则本用例没测到重试路径");
    assert.equal(record.normalizedError, "timeout", "外部取消归一化为 timeout");
    // 第 2 次尝试实际只跑了 ~120ms。阈值取第 1 次尝试耗时的一半：修复前这里记的是 ~800ms。
    assert.ok(
      record.totalMs < SLOW_FIRST_MS / 2,
      `totalMs 应≈最后一次尝试的真实耗时(约 ${CANCEL_AFTER_MS}ms)，实际记了 ${record.totalMs}ms（疑似沿用第 1 次尝试的 ${SLOW_FIRST_MS}ms）`,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
  }
});

// —— 以下为 ADM-010（端到端延迟）—— //

const TRANSPORT_HOOKS = {
  buildRequest: (p) => ({
    url: `${p.baseUrl}/v1/chat/completions`,
    headers: { "content-type": "application/json" },
    body: {
      model: p.defaultModel,
      messages: [{ role: "user", content: "hi" }],
      ...(p.temperatureOverride != null ? { temperature: p.temperatureOverride } : {}),
    },
  }),
  interpret: (r, raw) => {
    r.responseText = raw;
  },
  computeSuccess: (r) => Boolean(r.statusCode === 200),
  finalizeRecord: (x) => x,
};

async function withUpstream(responder, run) {
  const server = createServer(responder);
  const sockets = new Set();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

// ADM-010 的核心：一个"首次 429、退避、二次成功"的请求，totalMs 只记最后那次（快），
// 于是报告里的 P95 系统性优于用户真实体感——而准入决策看的正是这个数。endToEndMs 补上这个差。
test("ADM-010: 429 重试后成功，endToEndMs 含失败尝试与退避，totalMs 仍只记最后一次", async () => {
  const RETRY_AFTER_MS = 700;
  let hits = 0;
  const record = await withUpstream(
    (_req, res) => {
      hits += 1;
      if (hits === 1) {
        // retry-after 用秒；给 0.7s 让退避真实可测又不拖慢测试。
        res.writeHead(429, { "content-type": "application/json", "retry-after": "0.7" });
        res.end(JSON.stringify({ error: { message: "rate limited" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    },
    (baseUrl) =>
      executeUpstreamRequest(
        { id: "p-e2e-1", baseUrl, apiKey: "sk-mock", protocol: "openai_chat", defaultModel: "m", timeoutMs: 30000 },
        {},
        TRANSPORT_HOOKS,
      ),
  );

  assert.equal(hits, 2, "应真的重试了一次，否则本用例没测到重试路径");
  assert.equal(record.attempts, 2);
  assert.ok(record.retryWaitMs >= RETRY_AFTER_MS, `retryWaitMs 应记录退避等待，实际 ${record.retryWaitMs}ms`);
  // 最后一次尝试是本地 mock 的即时 200，必然远快于退避时长。
  assert.ok(record.totalMs < RETRY_AFTER_MS, `totalMs 应只含最后一次尝试，实际 ${record.totalMs}ms`);
  // 端到端必须把那 700ms 退避 + 第一次失败请求算进去。这是修复前根本不存在的字段。
  assert.ok(record.endToEndMs >= RETRY_AFTER_MS, `endToEndMs 应含退避等待(≥${RETRY_AFTER_MS}ms)，实际 ${record.endToEndMs}ms`);
  // 两个口径的差就是"重试掩盖掉的那部分等待"，必须真的存在差值，否则等于没修。
  assert.ok(record.endToEndMs > record.totalMs, "端到端必须严格大于单次耗时，否则退避没被计入");
});

// 温度被拒是【确定性重配】：零退避、修我方请求体、同模型只发生一次（后续首发就不带）。
// 把它计进端到端只会让每个模型的第一条记录凭空变慢，制造 ADM-010 本想消除的那类失真。
// 这条用例锁死这个刻意的例外——否则后人"顺手统一"就会把它算进去。
test("ADM-010: temperature 被拒的确定性重配不计入 endToEndMs", async () => {
  const SLOW_REJECT_MS = 600;
  let hits = 0;
  const record = await withUpstream(
    (_req, res) => {
      hits += 1;
      if (hits === 1) {
        // 慢慢地拒：若这次耗时被计入端到端，断言会立刻抓到。
        setTimeout(() => {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Unsupported value: 'temperature' does not support 0.7 with this model" } }));
        }, SLOW_REJECT_MS);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    },
    (baseUrl) =>
      executeUpstreamRequest(
        {
          id: "p-e2e-2",
          baseUrl,
          apiKey: "sk-mock",
          protocol: "openai_chat",
          defaultModel: `m-${Date.now()}`, // 唯一模型名：避开进程级 TEMPERATURE_UNSUPPORTED_MODELS 记忆
          timeoutMs: 30000,
          temperatureOverride: 0.7,
        },
        {},
        TRANSPORT_HOOKS,
      ),
  );

  assert.equal(hits, 2, "应发生一次重配重试");
  assert.equal(record.temperatureStripped, true, "用户手填的温度被摘掉，须如实上报");
  // 端到端起点被重置到重配之后，故不含那 600ms 的被拒往返。
  assert.ok(
    record.endToEndMs < SLOW_REJECT_MS,
    `确定性重配不应计入端到端，实际 ${record.endToEndMs}ms（被拒那次耗时 ${SLOW_REJECT_MS}ms）`,
  );
});

test("ADM-010: 一次就成时两个口径一致，且端到端从不小于单次", async () => {
  const record = await withUpstream(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    },
    (baseUrl) =>
      executeUpstreamRequest(
        { id: "p-e2e-3", baseUrl, apiKey: "sk-mock", protocol: "openai_chat", defaultModel: "m", timeoutMs: 30000 },
        {},
        TRANSPORT_HOOKS,
      ),
  );

  assert.equal(record.attempts, 1);
  assert.ok(record.endToEndMs >= record.totalMs, "端到端不得小于单次耗时（舍入也不行）");
  // 无重试时两者应当贴得很近；给 80ms 容差吸收调度抖动。
  assert.ok(record.endToEndMs - record.totalMs < 80, `无重试时两口径应基本一致，实际差 ${record.endToEndMs - record.totalMs}ms`);
});

test("ADM-010: 一次请求都没发出时 endToEndMs 为 null，不是 0", async () => {
  // Key 读不到 → 在进入重试循环之前就返回，端到端无意义。
  // 记 0 会让"从未测到"和"零耗时"在统计里无法区分。
  const record = await executeUpstreamRequest(
    { id: "p-e2e-4", baseUrl: "http://127.0.0.1:1", apiKey: "", protocol: "openai_chat", defaultModel: "m", timeoutMs: 1000 },
    {},
    TRANSPORT_HOOKS,
  );
  assert.equal(record.normalizedError, "auth_failed");
  assert.equal(record.endToEndMs, null, "没发出过请求时端到端应为 null");
});
