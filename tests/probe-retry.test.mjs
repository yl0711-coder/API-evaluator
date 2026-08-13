import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { buildApiKeyRef, saveProfileApiKey } from "../server/secret-store.mjs";
import { executeTestRequest } from "../server/test-runner.mjs";

// runUpstreamProbe 的退避重试骨架：429 / 5xx / 瞬时网络错误重试，超时与用户取消止损不重试。
// 限流型中转最常见的失败就是 429——重试是它唯一的补救，却此前只有 normalizeHttpError(429) 这类
// 纯函数单测在守，整条「发出去→被拒→退避→再发」的链路无人锁定。这里用本地 mock 上游端到端测。
// 全程 127.0.0.1：关掉私网出站拦截即可放行本地，无 DNS、无外网，保持确定性。
process.env.EVALUATOR_SECRET_STORE = "memory";
process.env.EVALUATOR_EGRESS_DENY_PRIVATE = "false";

// 与产品代码保持同源的常量（server/test-runner.mjs 内未导出，此处按契约固化）：
// 最多 3 次尝试（含首次），退避基数 600ms。
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 600;

async function withMockUpstream(responder, run) {
  const server = createServer(responder);
  // 被中止/超时的请求会留下半开连接，close() 会一直等它们；显式记账并在收尾时销毁，
  // 否则测试进程在 Windows 上会挂住不退出。
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function probeProfile(baseUrl, over = {}) {
  await saveProfileApiKey("retry-test", "sk-mock");
  return {
    id: "retry-test",
    name: "Mock",
    protocol: "openai",
    baseUrl,
    apiKeyRef: buildApiKeyRef("retry-test"),
    defaultModel: "gpt-4o-mini",
    timeoutMs: 5000,
    ...over,
  };
}

const sendJson = (res, code, obj, headers = {}) => {
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
};

const okBody = { choices: [{ message: { content: "工作正常。" } }], usage: { prompt_tokens: 4, completion_tokens: 2 } };

test("429 → 退避重试后成功：只发一次就判失败会把限流型中转整轮误判为 F", async () => {
  let hits = 0;
  await withMockUpstream(
    (req, res) => {
      hits += 1;
      if (hits === 1) return sendJson(res, 429, { error: { message: "too many requests" } });
      return sendJson(res, 200, okBody);
    },
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { writeLog: false });
      assert.equal(r.success, true, "429 后应重试并最终成功");
      assert.equal(r.statusCode, 200, "记录应反映最后一次尝试的状态码");
      assert.equal(r.responseText, "工作正常。");
      assert.equal(r.normalizedError, "", "成功轮不应残留上一次 429 的错误归类");
      assert.equal(r.attempts, 2, "attempts 应如实记录实发次数");
      assert.equal(hits, 2);
    },
  );
});

test("429 持续不退 → 耗尽重试上限后放弃，如实记 rate_limited 与尝试次数", async () => {
  let hits = 0;
  await withMockUpstream(
    (req, res) => {
      hits += 1;
      sendJson(res, 429, { error: { message: "too many requests" } });
    },
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { writeLog: false });
      assert.equal(r.success, false);
      assert.equal(r.statusCode, 429);
      assert.equal(r.normalizedError, "rate_limited");
      assert.equal(r.attempts, RETRY_MAX_ATTEMPTS, "应止于上限，不无限重试");
      assert.equal(hits, RETRY_MAX_ATTEMPTS, "实发次数与记录一致");
    },
  );
});

test("Retry-After 被遵守：上游要求等 1s → 重试间隔明显长于默认 600ms 退避", async () => {
  const arrivals = [];
  await withMockUpstream(
    (req, res) => {
      arrivals.push(Date.now());
      if (arrivals.length === 1) return sendJson(res, 429, { error: { message: "slow down" } }, { "retry-after": "1" });
      return sendJson(res, 200, okBody);
    },
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { writeLog: false });
      assert.equal(r.success, true);
      assert.equal(arrivals.length, 2, "应重试一次");
      const gap = arrivals[1] - arrivals[0];
      // 只断言下界：慢机器只会让间隔更长，不会让测试变红（上界断言才是 flaky 之源）。
      // 900ms 已足以把「遵守 Retry-After(1s)」与「默认指数退避(600ms)」区分开。
      assert.ok(gap >= 900, `应等满 Retry-After 指定的 1s，实际间隔 ${gap}ms`);
      assert.ok(gap < RETRY_BASE_DELAY_MS * 10, `不应把 Retry-After 误读成秒以外的单位，实际间隔 ${gap}ms`);
    },
  );
});

test("5xx → 重试后成功：上游抖一下不该让整轮判失败", async () => {
  let hits = 0;
  await withMockUpstream(
    (req, res) => {
      hits += 1;
      if (hits === 1) return sendJson(res, 503, { error: { message: "upstream down" } });
      return sendJson(res, 200, okBody);
    },
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { writeLog: false });
      assert.equal(r.success, true);
      assert.equal(r.statusCode, 200);
      assert.equal(r.attempts, 2);
    },
  );
});

test("400 → 不重试：确定性失败重试只是白烧钱和时间", async () => {
  let hits = 0;
  await withMockUpstream(
    (req, res) => {
      hits += 1;
      sendJson(res, 400, { error: { message: "bad request" } });
    },
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { writeLog: false });
      assert.equal(r.success, false);
      assert.equal(r.attempts, 1, "确定性 4xx 应只发一次");
      assert.equal(hits, 1);
    },
  );
});

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });

// 「拒收自定义 temperature」是上一条（400 不重试）的唯一例外：摘掉该参数后重发是有意义的，
// 因为失败原因已被就地消除。这里连带钉住给用户看的那条留痕 temperatureStripped——
// 传输层的摘参名单是进程级的、无声生效（见 server/upstream-transport.mjs 的
// TEMPERATURE_UNSUPPORTED_MODELS），用户在高级设置里手填的温度被摘掉却不留痕，
// 报告数字就会被读成「我设的那个温度下的表现」，而它其实跑在模型默认温度上。
test("400 拒收自定义 temperature → 摘掉该参数重试，并如实标记「手填温度未生效」", async () => {
  const bodies = [];
  await withMockUpstream(
    async (req, res) => {
      bodies.push(JSON.parse(await readBody(req)));
      if (bodies.length === 1) {
        return sendJson(res, 400, {
          error: { message: "Unsupported value: 'temperature' does not support 1 with this model." },
        });
      }
      return sendJson(res, 200, okBody);
    },
    async (baseUrl) => {
      const profile = await probeProfile(baseUrl, { temperatureOverride: 1 });
      const r = await executeTestRequest(profile, "hi", { writeLog: false });
      assert.equal(r.success, true, "摘掉 temperature 后应重试并最终成功");
      assert.equal(r.attempts, 2, "这类 400 应恰好重试一次");
      assert.equal(bodies[0].temperature, 1, "首发应带用户手填的温度");
      assert.ok(!("temperature" in bodies[1]), "重发应彻底不带 temperature，而不是悄悄换成别的值");
      assert.equal(r.temperatureStripped, true, "手填温度被摘必须留痕，界面据此出提示卡");
    },
  );
});

// 反面：没手填温度时摘掉的是工具自己的默认 0.2，属内部自愈。若这也置位，
// 每个此类模型的每份报告都会挂一条「温度未生效」——提示会退化成人人忽略的噪音。
test("400 拒收 temperature 但用户没手填 → 摘掉工具默认值属内部自愈，不报「温度未生效」", async () => {
  const bodies = [];
  await withMockUpstream(
    async (req, res) => {
      bodies.push(JSON.parse(await readBody(req)));
      if (bodies.length === 1) {
        return sendJson(res, 400, {
          error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model." },
        });
      }
      return sendJson(res, 200, okBody);
    },
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { writeLog: false });
      assert.equal(r.success, true);
      assert.equal(bodies[0].temperature, 0.2, "未手填时发的是工具默认 0.2");
      assert.ok(!("temperature" in bodies[1]), "同样应摘干净");
      assert.equal(r.temperatureStripped, false, "摘默认值不该出提示");
    },
  );
});

test("超时 → 止损不重试：重试会让一次卡死的探测拖成 N 倍超时", async () => {
  let hits = 0;
  await withMockUpstream(
    (req, res) => {
      hits += 1;
      // 永不响应：让客户端超时控制器开火。连接由 withMockUpstream 收尾销毁。
    },
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl, { timeoutMs: 300 }), "hi", { writeLog: false });
      assert.equal(r.success, false);
      assert.equal(r.normalizedError, "timeout");
      assert.equal(r.attempts, 1, "超时不得重试");
      assert.equal(hits, 1, "只应发出一次请求");
    },
  );
});

test("瞬时网络错误（连接被拒）→ 重试到上限：区别于超时的止损语义", async () => {
  // 先起再关，拿到一个确定无人监听的端口 → 连接必被拒（ECONNREFUSED），且不依赖外网。
  const probe = createServer(() => {});
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const deadPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const r = await executeTestRequest(await probeProfile(`http://127.0.0.1:${deadPort}`), "hi", { writeLog: false });
  assert.equal(r.success, false);
  assert.equal(r.normalizedError, "network_error", "连接被拒是瞬时网络错误，不该归成超时");
  assert.equal(r.attempts, RETRY_MAX_ATTEMPTS, "瞬时网络错误应重试到上限");
  assert.ok(/ECONNREFUSED/i.test(r.rawError), `rawError 应带上底层 errno 便于定位，实际：${r.rawError}`);
});

test("退避途中被用户取消 → 立即收手，不再发下一次请求（取消要立刻止血、不再计费）", async () => {
  let hits = 0;
  const controller = new AbortController();
  await withMockUpstream(
    (req, res) => {
      hits += 1;
      sendJson(res, 429, { error: { message: "too many requests" } });
      // 首次被拒后立刻取消：此时探测正处在 600ms 退避睡眠里。
      if (hits === 1) setTimeout(() => controller.abort(), 50).unref();
    },
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", {
        writeLog: false,
        abortSignal: controller.signal,
      });
      assert.equal(r.success, false);
      assert.equal(r.attempts, 1, "退避中被取消不得再发下一次");
      assert.equal(hits, 1, "上游只应收到一次请求");
    },
  );
});

test("noRetry（压测）：429 只发一次——重试会吞掉正要测的限流信号", async () => {
  let hits = 0;
  await withMockUpstream(
    (req, res) => {
      hits += 1;
      sendJson(res, 429, { error: { message: "too many requests" } });
    },
    async (baseUrl) => {
      const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { writeLog: false, noRetry: true });
      assert.equal(r.success, false);
      assert.equal(r.normalizedError, "rate_limited");
      assert.equal(r.attempts, 1, "压测每请求只测一次");
      assert.equal(hits, 1, "重试会把 429 吞掉、并把退避 sleep 混进延迟，污染 QPS 与尾延迟");
    },
  );
});

test("上游 302 → 不跟随重定向：Key 只能发往已过出站校验的地址", async () => {
  // 出站校验（assertPublicTarget）只看我方构造的 URL。若 fetch 跟随重定向，
  // 上游一句 302 就能把带 Key 的请求引到未经校验的地址（元数据服务/内网）。
  // redirect:"error" 是这条防线——这里锁定它：重定向目标一个请求都收不到。
  let redirectTargetHits = 0;
  await withMockUpstream(
    (req, res) => {
      redirectTargetHits += 1;
      sendJson(res, 200, okBody);
    },
    async (targetUrl) => {
      await withMockUpstream(
        (req, res) => {
          res.writeHead(302, { location: `${targetUrl}/v1/chat/completions` });
          res.end();
        },
        async (baseUrl) => {
          const r = await executeTestRequest(await probeProfile(baseUrl), "hi", { writeLog: false });
          assert.equal(r.success, false, "跟随重定向就会把 Key 送到未校验的地址");
          assert.equal(redirectTargetHits, 0, "重定向目标不得收到任何请求");
        },
      );
    },
  );
});
