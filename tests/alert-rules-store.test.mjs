// tests/alert-rules-store.test.mjs
// 报警规则存储：normalizeRule 字段规范化 + validateRule 校验口径 + load/save/update 的原子读改写往返。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  normalizeRule,
  validateRule,
  loadRules,
  saveRules,
  updateRules,
  RuleValidationError,
  __setRulesFileForTest,
  __resetWriteChainForTest,
} from "../server/alert-rules-store.mjs";

test.afterEach(() => {
  __resetWriteChainForTest();
});

// ===================== normalizeRule =====================

test("normalizeRule：无 id → 自动生成 alr_ 前缀；数值指标阈值转数字；名称裁剪 trim", () => {
  const rule = normalizeRule({ name: "  成功率过低  ", metric: "successRate", comparator: "lt", threshold: "0.8" });
  assert.match(rule.id, /^alr_[a-f0-9]{16}$/);
  assert.equal(rule.name, "成功率过低");
  assert.equal(rule.threshold, 0.8);
  assert.equal(typeof rule.threshold, "number");
  assert.equal(rule.cooldownHours, 1, "未给冷却时长 → 默认 1");
  assert.deepEqual(rule.scope, { type: "all" });
});

test("normalizeRule：grade/recommendationLevel/verdictLevel → 阈值保持字符串，不转数字", () => {
  const rule = normalizeRule({ name: "等级过低", metric: "grade", comparator: "eq", threshold: "D" });
  assert.equal(rule.threshold, "D");
  assert.equal(typeof rule.threshold, "string");
});

test("normalizeRule：未知 metric/comparator → 回退默认值，不接受脏数据", () => {
  const rule = normalizeRule({ name: "x", metric: "not-a-metric", comparator: "bogus", threshold: 1 });
  assert.equal(rule.metric, "successRate");
  assert.equal(rule.comparator, "lt");
});

test("normalizeRule：scope.type=target 但 targetId 为空 → 回退为 all", () => {
  const rule = normalizeRule({ name: "x", scope: { type: "target", targetId: "  " } });
  assert.deepEqual(rule.scope, { type: "all" });
});

test("normalizeRule：scope.type=target 且 targetId 有效 → 保留", () => {
  const rule = normalizeRule({ name: "x", scope: { type: "target", targetId: "p1" } });
  assert.deepEqual(rule.scope, { type: "target", targetId: "p1" });
});

test("normalizeRule：cooldownHours 非正/非法 → 兜底 1；合法值四舍五入到 2 位小数，且不低于 0.1", () => {
  assert.equal(normalizeRule({ name: "x", cooldownHours: -5 }).cooldownHours, 1);
  assert.equal(normalizeRule({ name: "x", cooldownHours: "abc" }).cooldownHours, 1);
  assert.equal(normalizeRule({ name: "x", cooldownHours: 0.123456 }).cooldownHours, 0.12);
  assert.equal(normalizeRule({ name: "x", cooldownHours: 0.01 }).cooldownHours, 0.1, "正数但低于 0.1 时钳制到 0.1，不是回退默认 1");
});

test("normalizeRule：existing 传入时保留 id/createdAt，其余字段可被覆盖", () => {
  const existing = { id: "alr_fixed0000000000", createdAt: "2026-01-01T00:00:00.000Z", name: "旧名", metric: "score", threshold: 50 };
  const rule = normalizeRule({ name: "新名", metric: "score", threshold: 80 }, existing);
  assert.equal(rule.id, "alr_fixed0000000000");
  assert.equal(rule.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(rule.name, "新名");
  assert.equal(rule.threshold, 80);
});

test("normalizeRule：enabled 缺省时新建默认 true，更新时保留 existing.enabled", () => {
  assert.equal(normalizeRule({ name: "x" }).enabled, true);
  assert.equal(normalizeRule({ name: "x" }, { enabled: false }).enabled, false);
  assert.equal(normalizeRule({ name: "x", enabled: false }, { enabled: true }).enabled, false, "显式传入 false 应生效");
});

test("normalizeRule：raw 非对象 → null", () => {
  assert.equal(normalizeRule(null), null);
  assert.equal(normalizeRule("x"), null);
});

// ===================== validateRule =====================

test("validateRule：名称为空 → 报错", () => {
  assert.match(validateRule(normalizeRule({ name: "" })), /名称/);
});

test("validateRule：数值指标阈值非数字 → 报错；等级指标阈值为空 → 报错", () => {
  const numeric = normalizeRule({ name: "x", metric: "score", threshold: "abc" });
  assert.match(validateRule(numeric), /数值/);
  const level = normalizeRule({ name: "x", metric: "grade", threshold: "" });
  assert.match(validateRule(level), /等级阈值/);
});

test("validateRule：scope=target 但 targetId 为空 → 报错（normalizeRule 已回退 all，故这里直接构造原始对象验证该分支）", () => {
  const rule = { name: "x", metric: "score", comparator: "lt", threshold: 10, cooldownHours: 1, scope: { type: "target", targetId: "" } };
  assert.match(validateRule(rule), /指定范围/);
});

test("validateRule：cooldownHours 小于 0.1 → 报错", () => {
  const rule = { name: "x", metric: "score", comparator: "lt", threshold: 10, cooldownHours: 0.05, scope: { type: "all" } };
  assert.match(validateRule(rule), /冷却时长/);
});

test("validateRule：合法规则 → 返回 null", () => {
  const rule = normalizeRule({ name: "成功率过低", metric: "successRate", comparator: "lt", threshold: 0.8, cooldownHours: 2 });
  assert.equal(validateRule(rule), null);
});

// ===================== load/save/update 原子读改写 =====================

function withTempFile(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ars-"));
  __setRulesFileForTest(join(dir, "alert-rules.json"));
  return Promise.resolve(fn()).finally(() => {
    __setRulesFileForTest(null);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
}

test("loadRules：文件不存在 → 空数组；saveRules/loadRules 往返一致", async () => {
  await withTempFile(async () => {
    assert.deepEqual(await loadRules(), []);
    const rule = normalizeRule({ name: "x", metric: "score", threshold: 10 });
    await saveRules([rule]);
    const reloaded = await loadRules();
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0].id, rule.id);
    assert.equal(reloaded[0].name, "x");
  });
});

test("loadRules：非数组内容 → 空数组（不抛错，容错脏文件）", async () => {
  await withTempFile(async () => {
    await saveRules({ not: "an array" });
    // saveRules 本身会把非数组值兜底为 []，所以先直接验证这一层兜底：
    assert.deepEqual(await loadRules(), []);
  });
});

test("updateRules：新增规则 → upsert 追加；重复 id → 就地替换而非追加", async () => {
  await withTempFile(async () => {
    const created = await updateRules((rules) => {
      const rule = normalizeRule({ name: "规则A", metric: "score", threshold: 10 });
      rules.push(rule);
      return rule;
    });
    assert.equal((await loadRules()).length, 1);

    await updateRules((rules) => {
      const idx = rules.findIndex((r) => r.id === created.id);
      rules[idx] = normalizeRule({ name: "规则A改名", metric: "score", threshold: 20 }, rules[idx]);
    });
    const rules = await loadRules();
    assert.equal(rules.length, 1, "同 id 应替换而非追加");
    assert.equal(rules[0].name, "规则A改名");
    assert.equal(rules[0].id, created.id, "id 保持不变");
  });
});

test("updateRules：mutator 抛出 RuleValidationError → 不落盘", async () => {
  await withTempFile(async () => {
    await updateRules((rules) => {
      rules.push(normalizeRule({ name: "先有一条", metric: "score", threshold: 10 }));
    });
    await assert.rejects(
      updateRules((rules) => {
        const bad = normalizeRule({ name: "", metric: "score", threshold: 10 });
        const err = validateRule(bad);
        if (err) throw new RuleValidationError(err);
        rules.push(bad);
      }),
      RuleValidationError,
    );
    assert.equal((await loadRules()).length, 1, "校验失败不应新增落盘");
  });
});

test("updateRules：并发多次调用串行化，互不覆盖丢失更新", async () => {
  await withTempFile(async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        updateRules((rules) => {
          rules.push(normalizeRule({ name: `规则${i}`, metric: "score", threshold: i }));
        }),
      ),
    );
    const rules = await loadRules();
    assert.equal(rules.length, 20, "20 次并发追加应全部持久化，不因竞态互相覆盖");
  });
});
