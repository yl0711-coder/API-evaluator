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
  JITTER_KIND,
  DECLINE_KIND,
  MIN_BASELINE_SAMPLES,
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

// ===================== kind + 稳定性抖动子阈值 =====================

test("normalizeRule：kind 缺省 → threshold（老规则 JSON 不带 kind 也能正常加载）", () => {
  const rule = normalizeRule({ name: "老规则", metric: "successRate", comparator: "lt", threshold: 0.8 });
  assert.equal(rule.kind, "threshold");
  assert.equal(rule.threshold, 0.8, "阈值形态该有的字段仍在");
  assert.equal(rule.params, undefined, "阈值形态不该带 params");
});

test("normalizeRule：未知 kind → 回退 threshold", () => {
  assert.equal(normalizeRule({ name: "x", kind: "bogus" }).kind, "threshold");
});

test("normalizeRule：kind=stability-jitter → 只存 params，不带 metric/comparator/threshold（死字段不留）", () => {
  const rule = normalizeRule({
    name: "抖动",
    kind: JITTER_KIND,
    metric: "successRate", // 即便传了也不该落盘
    params: { jitterRatioMax: 6, firstAttemptSuccessRateMin: 0.9 },
  });
  assert.equal(rule.kind, JITTER_KIND);
  assert.equal(rule.metric, undefined);
  assert.equal(rule.comparator, undefined);
  assert.equal(rule.threshold, undefined);
  assert.equal(rule.params.jitterRatioMax, 6);
  assert.equal(rule.params.firstAttemptSuccessRateMin, 0.9);
  assert.equal(rule.params.retryOverheadP95MsMax, null, "未配置的子阈值 → null（= 不检查该项）");
});

// 关键回归：Number(null)===0 / Number("")===0 都是有限数。若用 Number.isFinite(Number(v)) 判"配没配"，
// 未填的 jitterRatioMax 会变成阈值 0（任何倍数都 > 0 → 恒越界），firstAttemptSuccessRateMin 会变成 0
// （任何成功率都不低于 0 → 恒不越界）。两头都是错的，故必须落 null。
test("normalizeRule：子阈值 null/空串/非数/非正 → 一律 null，不被当成阈值 0", () => {
  const rule = normalizeRule({
    name: "x",
    kind: JITTER_KIND,
    params: { jitterRatioMax: null, firstAttemptSuccessRateMin: "", retryOverheadP95MsMax: "abc" },
  });
  assert.equal(rule.params.jitterRatioMax, null);
  assert.equal(rule.params.firstAttemptSuccessRateMin, null);
  assert.equal(rule.params.retryOverheadP95MsMax, null);
  const zeros = normalizeRule({ name: "x", kind: JITTER_KIND, params: { jitterRatioMax: 0, retryOverheadP95MsMax: -5 } });
  assert.equal(zeros.params.jitterRatioMax, null, "0 无实际意义 → null");
  assert.equal(zeros.params.retryOverheadP95MsMax, null, "负数 → null");
});

test("normalizeRule：子阈值字符串数字转数；保留 4 位小数", () => {
  const rule = normalizeRule({ name: "x", kind: JITTER_KIND, params: { jitterRatioMax: "6.5", firstAttemptSuccessRateMin: 0.912345 } });
  assert.equal(rule.params.jitterRatioMax, 6.5);
  assert.equal(typeof rule.params.jitterRatioMax, "number");
  assert.equal(rule.params.firstAttemptSuccessRateMin, 0.9123);
});

test("normalizeRule：更新抖动规则时未传的子阈值沿用 existing；显式传 null 表示清空该项", () => {
  const existing = normalizeRule({ name: "x", kind: JITTER_KIND, params: { jitterRatioMax: 6, firstAttemptSuccessRateMin: 0.9 } });
  const kept = normalizeRule({ name: "x", kind: JITTER_KIND, params: { jitterRatioMax: 8 } }, existing);
  assert.equal(kept.params.jitterRatioMax, 8, "本次传的以本次为准");
  assert.equal(kept.params.firstAttemptSuccessRateMin, 0.9, "本次没传的沿用 existing");

  const cleared = normalizeRule(
    { name: "x", kind: JITTER_KIND, params: { jitterRatioMax: 8, firstAttemptSuccessRateMin: null } },
    existing,
  );
  assert.equal(cleared.params.firstAttemptSuccessRateMin, null, "显式传 null 应清空，而非沿用 existing");
});

test("normalizeRule：kind 未传但 existing 是 jitter → 沿用 jitter（编辑时不该被悄悄改回阈值形态）", () => {
  const existing = normalizeRule({ name: "x", kind: JITTER_KIND, params: { jitterRatioMax: 6 } });
  const updated = normalizeRule({ name: "改名", params: { jitterRatioMax: 7 } }, existing);
  assert.equal(updated.kind, JITTER_KIND);
  assert.equal(updated.params.jitterRatioMax, 7);
});

test("validateRule：抖动规则一项子阈值都没配 → 报错（永不可能命中，属配置错误）", () => {
  const rule = normalizeRule({ name: "空抖动", kind: JITTER_KIND, params: {} });
  assert.match(validateRule(rule), /至少要配一项/);
});

test("validateRule：抖动规则配了任一项即通过；不因缺 metric/comparator 报错", () => {
  const onlyRatio = normalizeRule({ name: "x", kind: JITTER_KIND, params: { jitterRatioMax: 6 } });
  assert.equal(validateRule(onlyRatio), null);
  const onlySr = normalizeRule({ name: "x", kind: JITTER_KIND, params: { firstAttemptSuccessRateMin: 0.9 } });
  assert.equal(validateRule(onlySr), null);
});

test("validateRule：首次成功率阈值 > 1 → 报错（提示是 0～1 小数，防误填 90）", () => {
  const rule = normalizeRule({ name: "x", kind: JITTER_KIND, params: { firstAttemptSuccessRateMin: 90 } });
  assert.match(validateRule(rule), /0～1/);
});

test("validateRule：抖动规则仍受名称/范围/冷却三项通用校验约束", () => {
  const noName = normalizeRule({ name: "", kind: JITTER_KIND, params: { jitterRatioMax: 6 } });
  assert.match(validateRule(noName), /名称/);
  const badCooldown = { name: "x", kind: JITTER_KIND, params: { jitterRatioMax: 6 }, cooldownHours: 0.05, scope: { type: "all" } };
  assert.match(validateRule(badCooldown), /冷却时长/);
  const badScope = {
    name: "x",
    kind: JITTER_KIND,
    params: { jitterRatioMax: 6 },
    cooldownHours: 1,
    scope: { type: "target", targetId: "" },
  };
  assert.match(validateRule(badScope), /指定范围/);
});

test("validateRule：kind 不合法 → 报错", () => {
  const rule = { name: "x", kind: "bogus", metric: "score", comparator: "lt", threshold: 1, cooldownHours: 1, scope: { type: "all" } };
  assert.match(validateRule(rule), /规则类型/);
});

// ===================== kind=stability-decline（与自身历史比） =====================

test("normalizeRule：kind=stability-decline → 只存 params，不带 metric/comparator/threshold", () => {
  const rule = normalizeRule({
    name: "退化",
    kind: DECLINE_KIND,
    metric: "successRate", // 传了也不该落盘
    params: { recentRuns: 3, baselineRuns: 20, successRateDropPp: 0.1, p95WorsenRatio: 1.5 },
  });
  assert.equal(rule.kind, DECLINE_KIND);
  assert.equal(rule.metric, undefined);
  assert.equal(rule.threshold, undefined);
  assert.deepEqual(rule.params, { recentRuns: 3, baselineRuns: 20, successRateDropPp: 0.1, p95WorsenRatio: 1.5 });
});

test("normalizeRule：退化窗口尺寸缺失/非法 → 兜默认 3 / 20", () => {
  const rule = normalizeRule({ name: "x", kind: DECLINE_KIND, params: { successRateDropPp: 0.1 } });
  assert.equal(rule.params.recentRuns, 3);
  assert.equal(rule.params.baselineRuns, 20);
  const bad = normalizeRule({ name: "x", kind: DECLINE_KIND, params: { recentRuns: "abc", baselineRuns: 0, p95WorsenRatio: 1.5 } });
  assert.equal(bad.params.recentRuns, 3);
  assert.equal(bad.params.baselineRuns, 20, "0 不是合法窗口 → 兜默认");
});

// 关键回归：baselineRuns 的钳制下界必须等于评估器的 MIN_BASELINE_SAMPLES。
// 曾经 store 下界写 2、评估器门槛写 5，于是填 2~4 时——UI 允许、校验通过、保存成功、卡片正常显示
// ——splitWindows 却因基线不足恒返回 null，规则永远不命中且用户无从察觉。
test("normalizeRule：baselineRuns 低于基线样本下限 → 抬到 MIN_BASELINE_SAMPLES（不留永不生效的规则）", () => {
  for (const tooSmall of [2, 3, 4]) {
    const rule = normalizeRule({ name: "x", kind: DECLINE_KIND, params: { baselineRuns: tooSmall, p95WorsenRatio: 1.5 } });
    assert.equal(rule.params.baselineRuns, MIN_BASELINE_SAMPLES, `baselineRuns=${tooSmall} 应被抬到 ${MIN_BASELINE_SAMPLES}`);
  }
});

// 钳制而非兜默认：用户填 999 的意图明显是「尽量多」，悄悄回落成 20 比钳到上界更违反预期。
test("normalizeRule：退化窗口尺寸超区间 → 钳到边界（不是回落默认值）", () => {
  const big = normalizeRule({ name: "x", kind: DECLINE_KIND, params: { recentRuns: 999, baselineRuns: 9999, p95WorsenRatio: 1.5 } });
  assert.equal(big.params.recentRuns, 20, "recent 上界 20");
  assert.equal(big.params.baselineRuns, 200, "baseline 上界 200，对齐 queryProfileRunSummaries 默认 limit");
});

test("normalizeRule：退化窗口尺寸取整（小数向下取整）", () => {
  const rule = normalizeRule({ name: "x", kind: DECLINE_KIND, params: { recentRuns: 3.7, baselineRuns: 20.9, p95WorsenRatio: 1.5 } });
  assert.equal(rule.params.recentRuns, 3);
  assert.equal(rule.params.baselineRuns, 20);
});

test("normalizeRule：退化判定阈值 null/空串/非正 → null（= 不查该维），与 jitter 同口径", () => {
  const rule = normalizeRule({
    name: "x",
    kind: DECLINE_KIND,
    params: { recentRuns: 3, baselineRuns: 20, successRateDropPp: null, p95WorsenRatio: "" },
  });
  assert.equal(rule.params.successRateDropPp, null);
  assert.equal(rule.params.p95WorsenRatio, null);
  const zero = normalizeRule({ name: "x", kind: DECLINE_KIND, params: { successRateDropPp: 0, p95WorsenRatio: -1 } });
  assert.equal(zero.params.successRateDropPp, null);
  assert.equal(zero.params.p95WorsenRatio, null);
});

test("normalizeRule：kind 未传但 existing 是 decline → 沿用 decline", () => {
  const existing = normalizeRule({ name: "x", kind: DECLINE_KIND, params: { p95WorsenRatio: 1.5 } });
  const updated = normalizeRule({ name: "改名", params: { p95WorsenRatio: 2 } }, existing);
  assert.equal(updated.kind, DECLINE_KIND);
  assert.equal(updated.params.p95WorsenRatio, 2);
  assert.equal(updated.params.recentRuns, 3, "窗口尺寸沿用 existing 的规范化结果");
});

test("validateRule：退化规则两个判定阈值都没配 → 报错（窗口尺寸有默认值，不算「配了一项」）", () => {
  const rule = normalizeRule({ name: "空退化", kind: DECLINE_KIND, params: { recentRuns: 3, baselineRuns: 20 } });
  assert.match(validateRule(rule), /至少要配一项判定阈值/);
});

test("validateRule：退化规则配了任一判定阈值即通过", () => {
  const onlySr = normalizeRule({ name: "x", kind: DECLINE_KIND, params: { successRateDropPp: 0.1 } });
  assert.equal(validateRule(onlySr), null);
  const onlyP95 = normalizeRule({ name: "x", kind: DECLINE_KIND, params: { p95WorsenRatio: 1.5 } });
  assert.equal(validateRule(onlyP95), null);
});

test("validateRule：退化的成功率跌幅 > 1 → 报错（防误填 10 当成 10pp）", () => {
  const rule = normalizeRule({ name: "x", kind: DECLINE_KIND, params: { successRateDropPp: 10 } });
  assert.match(validateRule(rule), /0～1/);
});

test("validateRule：退化规则仍受名称/范围/冷却三项通用校验约束", () => {
  const noName = normalizeRule({ name: "", kind: DECLINE_KIND, params: { p95WorsenRatio: 1.5 } });
  assert.match(validateRule(noName), /名称/);
  const badCooldown = {
    name: "x",
    kind: DECLINE_KIND,
    params: { recentRuns: 3, baselineRuns: 20, p95WorsenRatio: 1.5 },
    cooldownHours: 0.05,
    scope: { type: "all" },
  };
  assert.match(validateRule(badCooldown), /冷却时长/);
});

// 三种形态在同一个文件里共存、互不干扰（load 路径会对每条各自 normalizeRule）。
test("三种规则形态可共存于同一文件，各自字段互不掺杂", async () => {
  await withTempFile(async () => {
    await updateRules((rules) => {
      rules.push(normalizeRule({ name: "阈值", metric: "successRate", comparator: "lt", threshold: 0.8 }));
      rules.push(normalizeRule({ name: "抖动", kind: JITTER_KIND, params: { jitterRatioMax: 6 } }));
      rules.push(normalizeRule({ name: "退化", kind: DECLINE_KIND, params: { p95WorsenRatio: 1.5 } }));
    });
    const rules = await loadRules();
    assert.equal(rules.length, 3);
    assert.equal(rules[0].kind, "threshold");
    assert.equal(rules[0].threshold, 0.8);
    assert.equal(rules[0].params, undefined);
    assert.equal(rules[1].kind, JITTER_KIND);
    assert.equal(rules[1].params.jitterRatioMax, 6);
    assert.equal(rules[1].metric, undefined);
    assert.equal(rules[2].kind, DECLINE_KIND);
    assert.equal(rules[2].params.p95WorsenRatio, 1.5);
    assert.equal(rules[2].params.recentRuns, 3);
    assert.equal(rules[2].metric, undefined);
  });
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
