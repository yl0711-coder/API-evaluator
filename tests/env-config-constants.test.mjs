// tests/env-config-constants.test.mjs
// P1-04 的两个「模块级常量」调用点的回归锁。
//
// 为什么要单独一个文件：既有的两个 P1-04 测试都覆盖不到这两处——
//   · tests/env-config.test.mjs         测 envInt 函数本身（证明它返回 4 而不是 NaN）；
//   · tests/env-config-quota-effect.test.mjs 测 task-manager / auto-test-scheduler 两个【运行期】读取点。
// 而 MAX_UPSTREAM_STREAM_RESPONSE_BYTES 与 JUDGE_AUDIT_MAX_CALLS 是在【模块加载时】求值的顶层
// const，一旦被人（或一次不完整的合并）退回 `Number(env) > 0 ? ... : d` 那种旧写法，上面两个文件
// 一个都不会红。这确实发生过：一批未提交改动把这两处退回旧写法，而 1209 个用例全绿。
//
// 模块级常量只能靠「设好 env 再首次 import」来测，故每个用例用带 query 的动态 import 绕开模块缓存。
import assert from "node:assert/strict";
import test from "node:test";

// 旧写法 `Number(env) > 0 ? Number(env) : 24MB` 会放行的值，以及它们放行后的后果：
//   "Infinity" → 硬顶消失（这个上限存在的唯一目的就是防坏上游把评测机内存吃干）
//   "0x10"     → 16 字节上限，健康渠道的正常响应全被误判 response_too_large → 判 F
//   "3.5"      → 3.5 字节，同上
//   "1e9"      → 绕过 512MB 形式上限
const ILLEGAL = ["abc", "Infinity", "-Infinity", "-1", "0", "1e9", "0x10", "3.5", "", "   ", "NaN"];
const DEFAULT_STREAM_BYTES = 24 * 1024 * 1024;

async function importStreamCapWith(value, tag) {
  const prev = process.env.EVALUATOR_MAX_STREAM_RESPONSE_BYTES;
  if (value === null) delete process.env.EVALUATOR_MAX_STREAM_RESPONSE_BYTES;
  else process.env.EVALUATOR_MAX_STREAM_RESPONSE_BYTES = value;
  try {
    // query 参数使每次 import 都是新的模块实例——模块级 const 因此会重新求值。
    const mod = await import(`../server/upstream-transport.mjs?constants=${encodeURIComponent(tag)}`);
    return mod.MAX_UPSTREAM_STREAM_RESPONSE_BYTES;
  } finally {
    if (prev === undefined) delete process.env.EVALUATOR_MAX_STREAM_RESPONSE_BYTES;
    else process.env.EVALUATOR_MAX_STREAM_RESPONSE_BYTES = prev;
  }
}

test("P1-04: 流式字节硬顶——非法 env 一律回落默认值，不接受 Infinity / 十六进制 / 小数", async () => {
  for (const [i, raw] of ILLEGAL.entries()) {
    const got = await importStreamCapWith(raw, `illegal-${i}`);
    assert.equal(got, DEFAULT_STREAM_BYTES, `EVALUATOR_MAX_STREAM_RESPONSE_BYTES=${JSON.stringify(raw)} 应回落到 24MB，实际 ${got}`);
  }
});

test("P1-04: 流式字节硬顶必须是有限正整数，Infinity 等于取消硬顶", async () => {
  const got = await importStreamCapWith("Infinity", "inf-shape");
  assert.ok(Number.isSafeInteger(got), `必须是安全整数，实际 ${got}`);
  assert.notEqual(got, Number.POSITIVE_INFINITY, "Infinity 会让坏上游一路吐流把评测机内存吃干");
  assert.ok(got > 0, "必须为正");
});

test("P1-04: 流式字节硬顶——合法值仍然生效（别把校验写成永远取默认值）", async () => {
  assert.equal(await importStreamCapWith("1048576", "legal-1m"), 1048576, "合法整数必须被采纳");
  assert.equal(await importStreamCapWith(null, "unset"), DEFAULT_STREAM_BYTES, "未设置时取默认值");
});

test("P1-04: 流式字节硬顶——超过 512MB 形式上限的值应拒绝并回落，而不是静默夹取", async () => {
  const tooBig = String(1024 * 1024 * 1024); // 1GB > 512MB 上限
  const got = await importStreamCapWith(tooBig, "too-big");
  assert.equal(got, DEFAULT_STREAM_BYTES, "越界应【拒绝并回落】而非 clamp 成 512MB——静默夹取会让运维看不出自己配错了");
});

// —— 裁判额度 JUDGE_AUDIT_MAX_CALLS ——
//
// 它是 test-runner.mjs 的模块私有 const，无法直接读取，故从它真正的作用点验证：
// runLiveJudgeAudit({ maxCalls }) 是唯一消费者，额度直接决定「对上游发多少次真实请求」。
// 这条路径花钱，是 P1-04 里后果最实在的一处。
async function importJudgeCapWith(value, tag) {
  const prev = process.env.EVALUATOR_JUDGE_MAX_CALLS;
  if (value === null) delete process.env.EVALUATOR_JUDGE_MAX_CALLS;
  else process.env.EVALUATOR_JUDGE_MAX_CALLS = value;
  try {
    const mod = await import(`../server/test-runner.mjs?constants=${encodeURIComponent(tag)}`);
    return mod.JUDGE_AUDIT_MAX_CALLS;
  } finally {
    if (prev === undefined) delete process.env.EVALUATOR_JUDGE_MAX_CALLS;
    else process.env.EVALUATOR_JUDGE_MAX_CALLS = prev;
  }
}

test("P1-04: 裁判额度常量——非法 env 一律回落 50，不接受 Infinity / 十六进制 / 小数", async () => {
  for (const [i, raw] of ILLEGAL.entries()) {
    const got = await importJudgeCapWith(raw, `judge-illegal-${i}`);
    assert.equal(got, 50, `EVALUATOR_JUDGE_MAX_CALLS=${JSON.stringify(raw)} 应回落到 50，实际 ${got}`);
  }
});

test("P1-04: 裁判额度常量必须是有限正整数，且合法值仍生效", async () => {
  const inf = await importJudgeCapWith("Infinity", "judge-inf");
  assert.ok(Number.isSafeInteger(inf), `必须是安全整数，实际 ${inf}`);
  assert.notEqual(inf, Number.POSITIVE_INFINITY, "Infinity 会让额度闸失效，对上游按条数烧钱");
  assert.equal(await importJudgeCapWith("120", "judge-legal"), 120, "合法整数必须被采纳");
  assert.equal(await importJudgeCapWith(null, "judge-unset"), 50, "未设置时取默认 50");
  assert.equal(await importJudgeCapWith("20000", "judge-toobig"), 50, "超过 10000 上限应拒绝并回落，而非静默夹取");
});

test("P1-04: 裁判额度——Infinity 会真的超发请求（额度闸的意义就在这里）", async () => {
  const { runLiveJudgeAudit } = await import("../server/live-adapters.mjs");
  const judgeProfiles = [
    { role: "judge", defaultModel: "judge-a" },
    { role: "judge", defaultModel: "judge-b" },
  ];
  const items = Array.from({ length: 27 }, (_, i) => ({ question: `q${i}`, answer: `a${i}`, rubric: "r" }));
  const run = async (maxCalls) => {
    let calls = 0;
    const result = await runLiveJudgeAudit({
      targetModel: "target-x",
      items,
      judgeProfiles,
      maxCalls,
      runRequest: async () => {
        calls += 1;
        return { success: true, responseText: '{"score":80}', record: {} };
      },
    });
    return { calls, result };
  };

  // 默认额度 50：2 个裁判 × 25 题 = 50 次，多出的 2 题显式丢弃。
  const ok = await run(50);
  assert.equal(ok.calls, 50, "合法额度下真实请求数必须等于额度");
  assert.equal(ok.result.droppedForBudget, 2, "超额题目应显式丢弃而非静默截断");

  // Infinity：额度闸完全失效，27 题全评 → 54 次真实请求，超出上限 4 次。这是真金白银。
  const inf = await run(Number.POSITIVE_INFINITY);
  assert.ok(inf.calls > ok.calls, `Infinity 额度下发了 ${inf.calls} 次请求（合法额度只发 ${ok.calls} 次）——额度闸被绕过`);
  // 正因如此，envInt 必须在【进入这里之前】就把 Infinity 挡掉：
  const { envInt } = await import("../server/env-config.mjs");
  const prev = process.env.EVALUATOR_JUDGE_MAX_CALLS;
  process.env.EVALUATOR_JUDGE_MAX_CALLS = "Infinity";
  try {
    assert.equal(envInt("EVALUATOR_JUDGE_MAX_CALLS", 50, { min: 1, max: 10_000 }), 50, "Infinity 必须在解析层就被挡掉并回落 50");
  } finally {
    if (prev === undefined) delete process.env.EVALUATOR_JUDGE_MAX_CALLS;
    else process.env.EVALUATOR_JUDGE_MAX_CALLS = prev;
  }
});

test("P1-04: 裁判额度——NaN 不是「无上限」而是「一题都不评」，同样必须在解析层挡掉", async () => {
  const { runLiveJudgeAudit } = await import("../server/live-adapters.mjs");
  let calls = 0;
  const result = await runLiveJudgeAudit({
    targetModel: "target-x",
    items: Array.from({ length: 27 }, (_, i) => ({ question: `q${i}`, answer: `a${i}`, rubric: "r" })),
    judgeProfiles: [{ role: "judge", defaultModel: "judge-a" }],
    maxCalls: Number.NaN,
    runRequest: async () => {
      calls += 1;
      return { success: true, responseText: '{"score":80}', record: {} };
    },
  });
  // 实测行为：Math.floor(NaN/1)=NaN → itemsToJudge=NaN → items.slice(0, NaN) 为空 → 0 次请求，
  // 但 ok 仍为 true 且 callsUsed 是 NaN——一次「看起来跑过了、其实什么都没评」的静默空转。
  assert.equal(calls, 0, "NaN 额度下一次请求都发不出（并非无上限，但同样是坏的）");
  assert.ok(!Number.isFinite(result.callsUsed), "callsUsed 会是 NaN——审计报告里出现 NaN 数字");

  // 故解析层必须回落：
  const { envInt } = await import("../server/env-config.mjs");
  const prev = process.env.EVALUATOR_JUDGE_MAX_CALLS;
  process.env.EVALUATOR_JUDGE_MAX_CALLS = "abc";
  try {
    assert.equal(envInt("EVALUATOR_JUDGE_MAX_CALLS", 50, { min: 1, max: 10_000 }), 50, "非法值必须回落 50，裁判才会真的评题");
  } finally {
    if (prev === undefined) delete process.env.EVALUATOR_JUDGE_MAX_CALLS;
    else process.env.EVALUATOR_JUDGE_MAX_CALLS = prev;
  }
});
