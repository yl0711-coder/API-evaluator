// 回归（P3-8）：固定窗口限流。用可注入的 now 精确控制时间，不依赖真实时钟。
import assert from "node:assert/strict";
import test from "node:test";
import { createRateLimiter } from "../server/rate-limit.mjs";

test("同一 key 窗口内超过 max 即拒，其余放行", () => {
  let t = 1000;
  const rl = createRateLimiter({ windowMs: 1000, max: 3, now: () => t });
  assert.equal(rl.check("ip1").allowed, true); // 1
  assert.equal(rl.check("ip1").allowed, true); // 2
  assert.equal(rl.check("ip1").allowed, true); // 3
  const denied = rl.check("ip1"); // 4 → 拒
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 1000);
});

test("不同 key 各自独立计数", () => {
  let t = 0;
  const rl = createRateLimiter({ windowMs: 1000, max: 1, now: () => t });
  assert.equal(rl.check("a").allowed, true);
  assert.equal(rl.check("a").allowed, false);
  assert.equal(rl.check("b").allowed, true, "b 不受 a 的计数影响");
});

test("窗口滚动后计数重置", () => {
  let t = 0;
  const rl = createRateLimiter({ windowMs: 1000, max: 2, now: () => t });
  assert.equal(rl.check("ip").allowed, true);
  assert.equal(rl.check("ip").allowed, true);
  assert.equal(rl.check("ip").allowed, false); // 窗口内第 3 次
  t = 1000; // 进入下一窗口
  assert.equal(rl.check("ip").allowed, true, "新窗口重新计数");
});

test("过期桶会被惰性清理，key 数不无界增长", () => {
  let t = 0;
  const rl = createRateLimiter({ windowMs: 100, max: 1, now: () => t, maxKeys: 5 });
  for (let i = 0; i < 20; i += 1) {
    t = i * 1000; // 每个 key 都在各自独立的时间点、且早已跨窗口
    rl.check(`ip-${i}`);
  }
  assert.ok(rl.size() <= 6, `活跃 key 应被清理到上限附近，实际 ${rl.size()}`);
});
