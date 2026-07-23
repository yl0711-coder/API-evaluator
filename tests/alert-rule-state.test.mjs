// tests/alert-rule-state.test.mjs
// 报警规则冷却状态：getLastFiredAt/markFired 的 key 拼接、原子读改写、独立文件不受规则定义影响。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getLastFiredAt, markFired, __setRuleStateFileForTest, __resetRuleStateWriteChainForTest } from "../server/alert-rule-state.mjs";

test.afterEach(() => {
  __resetRuleStateWriteChainForTest();
});

function withTempFile(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ar-state-"));
  __setRuleStateFileForTest(join(dir, "alert-rule-state.json"));
  return Promise.resolve(fn()).finally(() => {
    __setRuleStateFileForTest(null);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
}

test("getLastFiredAt：无记录 → null", async () => {
  await withTempFile(async () => {
    assert.equal(await getLastFiredAt("alr_x", "all"), null);
  });
});

test("markFired 后 getLastFiredAt 能读回一个合法 ISO 时间", async () => {
  await withTempFile(async () => {
    await markFired("alr_x", "all");
    const firedAt = await getLastFiredAt("alr_x", "all");
    assert.ok(firedAt);
    assert.ok(!Number.isNaN(new Date(firedAt).getTime()));
  });
});

test("不同 targetKey 各自独立记账，互不干扰", async () => {
  await withTempFile(async () => {
    await markFired("alr_x", "p1");
    assert.equal(await getLastFiredAt("alr_x", "p2"), null, "p2 未触发过");
    assert.ok(await getLastFiredAt("alr_x", "p1"));
  });
});

test("不同 ruleId 相同 targetKey 各自独立记账", async () => {
  await withTempFile(async () => {
    await markFired("alr_a", "all");
    assert.equal(await getLastFiredAt("alr_b", "all"), null);
  });
});

test("targetKey 缺省/空值时归一化为 all", async () => {
  await withTempFile(async () => {
    await markFired("alr_x", undefined);
    assert.ok(await getLastFiredAt("alr_x", "all"), "缺省 targetKey 应等价于 'all'");
    assert.ok(await getLastFiredAt("alr_x", undefined), "反过来查也应命中同一 key");
  });
});

test("重复 markFired 更新为最新时间", async () => {
  await withTempFile(async () => {
    await markFired("alr_x", "all");
    const first = await getLastFiredAt("alr_x", "all");
    await new Promise((r) => setTimeout(r, 5));
    await markFired("alr_x", "all");
    const second = await getLastFiredAt("alr_x", "all");
    assert.ok(new Date(second).getTime() >= new Date(first).getTime());
  });
});

test("并发 markFired 多个 key 串行化，互不覆盖丢失", async () => {
  await withTempFile(async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => markFired(`alr_${i}`, "all")));
    for (let i = 0; i < 20; i += 1) {
      assert.ok(await getLastFiredAt(`alr_${i}`, "all"), `alr_${i} 应已记账`);
    }
  });
});
