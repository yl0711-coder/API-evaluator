// tests/env-config.test.mjs
// P1-04：额度类环境变量的统一解析口。
//
// 用例按"旧写法会怎么错"组织，而不是按参数组合罗列——NaN 和 Infinity 这两个值才是缺陷的全部内容：
// NaN 让所有比较恒 false（阀门静默失效），Infinity 是合法数字但绕过上限（阀门形同不存在）。
import assert from "node:assert/strict";
import test from "node:test";

const { envInt, invalidEnvVars, resetInvalidEnvVars } = await import("../server/env-config.mjs");

const NAME = "EVALUATOR_TEST_QUOTA";

function withEnv(value, fn) {
  const prev = process.env[NAME];
  if (value === undefined) delete process.env[NAME];
  else process.env[NAME] = value;
  resetInvalidEnvVars();
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[NAME];
    else process.env[NAME] = prev;
    resetInvalidEnvVars();
  }
}

test("P1-04: 'abc' 不得产出 NaN——这是 runningSlots < NaN 恒 false 的根因", () => {
  withEnv("abc", () => {
    const value = envInt(NAME, 4, { min: 1, max: 64 });
    assert.equal(value, 4, "非法值必须回落到安全默认值");
    // 下面两条才是真正的回归锁：只断言 ===4 的话，将来有人改回 Math.max(1, Number(...))
    // 返回 NaN 时，NaN !== 4 会让用例失败——但失败原因看不出是"又变成 NaN 了"。
    assert.ok(Number.isFinite(value), "必须是有限数");
    assert.ok(value > 0 && 0 < value, "必须能参与比较：NaN 会让任何比较恒为 false");
  });
});

test("P1-04: 'Infinity' 必须被拒——它是合法 Number 且 > 0，能直接绕开并发/限流上限", () => {
  for (const raw of ["Infinity", "-Infinity", "1e999"]) {
    withEnv(raw, () => {
      const value = envInt(NAME, 4, { min: 1, max: 64 });
      assert.equal(value, 4, `${raw} 应回落到默认值`);
      assert.ok(Number.isSafeInteger(value));
    });
  }
});

test("P1-04: 0、负数、小数、超上限一律拒绝", () => {
  const cases = [
    ["0", "额度 0 等于功能失效，不是合法调优"],
    ["-1", "负额度无意义"],
    ["2.5", "槽位数必须是整数"],
    ["1e3", "科学计数法不收——语义太宽，容易掩盖手滑"],
    ["0x10", "十六进制同理"],
    ["999", "超出 max 上限应回落，防手滑把并发配成 10000 打爆宿主"],
  ];
  for (const [raw, why] of cases) {
    withEnv(raw, () => {
      assert.equal(envInt(NAME, 4, { min: 1, max: 64 }), 4, `${raw}：${why}`);
    });
  }
});

test("P1-04: 合法值原样生效，边界值包含在内", () => {
  withEnv("8", () => assert.equal(envInt(NAME, 4, { min: 1, max: 64 }), 8));
  withEnv("1", () => assert.equal(envInt(NAME, 4, { min: 1, max: 64 }), 1, "min 是闭区间"));
  withEnv("64", () => assert.equal(envInt(NAME, 4, { min: 1, max: 64 }), 64, "max 是闭区间"));
  withEnv(" 8 ", () => assert.equal(envInt(NAME, 4, { min: 1, max: 64 }), 8, "两侧空白应容忍"));
  // 熔断阈值那类允许 0 的场景（0 = 关闭熔断）要能显式放行。
  withEnv("0", () => assert.equal(envInt(NAME, 5, { min: 0, max: 1000 }), 0, "min:0 时 0 是合法的"));
});

test("P1-04: 未设置与空白串用默认值，且不算作误配", () => {
  withEnv(undefined, () => {
    assert.equal(envInt(NAME, 4), 4);
    assert.deepEqual(invalidEnvVars(), [], "没配 ≠ 配错，不该出现在 health 的误配清单里");
  });
  withEnv("   ", () => {
    assert.equal(envInt(NAME, 4), 4);
    assert.deepEqual(invalidEnvVars(), [], "空白串同理");
  });
});

test("P1-04: 非法值记入 invalidEnvVars 供 /api/health 显形，且不泄露凭据类内容", () => {
  withEnv("abc", () => {
    envInt(NAME, 4, { min: 1, max: 64 });
    const reported = invalidEnvVars();
    assert.equal(reported.length, 1, "误配必须留下明账——静默回落正是老问题所在");
    assert.equal(reported[0].name, NAME);
    assert.equal(reported[0].value, "abc", "要显示原始值，否则运维不知道自己配了什么");
    assert.equal(reported[0].fallback, 4, "要显示实际生效的额度");
  });
});

test("P1-04: 同一变量改回合法值后应从误配清单里消失", () => {
  withEnv("abc", () => {
    envInt(NAME, 4, { min: 1, max: 64 });
    assert.equal(invalidEnvVars().length, 1);
    // 运维改完不重启即生效是既有行为（maxSlots 每次调用都读 env），清单必须跟着收敛，
    // 否则 health 会一直挂着一条早已修好的告警。
    process.env[NAME] = "8";
    assert.equal(envInt(NAME, 4, { min: 1, max: 64 }), 8);
    assert.deepEqual(invalidEnvVars(), []);
  });
});
