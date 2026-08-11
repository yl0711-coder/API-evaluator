// server/env-config.mjs
// 环境变量里的"额度"类整数配置的统一解析口（P1-04）。
//
// 为什么必须统一：全库原本散着七八处 `Math.max(1, Number(process.env.X || d))`，这个写法有两个
// 都会静默失效的洞——
//   1) Number("abc") = NaN，而 NaN 参与的任何比较恒为 false。`runningSlots < NaN` 永远不成立，
//      于是新任务永久 queued、队列位显示 NaN；`maxConsecutiveFailures > 0` 永远不成立，
//      于是连续失败熔断被静默关掉（配了熔断却不熔断，比压根没配更危险）。
//   2) Number("Infinity") 是合法有限判定之外的值且 > 0，能直接绕过并发上限与限流上限——
//      这两个阀门存在的目的就是保护上游 API 和本机资源。
// 还有更隐蔽的：NaN 天数传进 new Date(NaN).toISOString() 会抛 RangeError，被维护任务外层的
// 空 catch 吞掉，整段留存清理一次都不执行、磁盘只增不减。
//
// 取舍：不阻止启动，改为"回落到安全默认值 + 记账 + 在 /api/health 显形"。
// 理由是这些变量全是可选调优项，为一个拼错的天数把整个服务拒起（评测平台常年跑在单机 docker 上，
// 起不来就没有任何界面能告诉运维原因）损失更大；而静默回落的老问题恰恰出在"无处可见"，
// 所以关键是 invalidEnvVars() 这条明账，而非终止进程。凭据类配置不走这里（那些确实该拒启动，
// 见 server/auth.mjs 对 EVALUATOR_SESSION_SECRET 的未配置/过弱两道抛错）。
const invalid = new Map();

/**
 * 解析环境变量里的整数额度。拒绝 NaN、±Infinity、小数、超出 [min,max] 的值和空白串。
 * 非法或缺失时返回 fallback；非法（而非缺失）会被记入 invalidEnvVars() 供 /api/health 暴露。
 *
 * @param {string} name 变量名
 * @param {number} fallback 合法的安全默认值
 * @param {{min?: number, max?: number}} [bounds] 闭区间边界，默认 min=1（额度为 0 通常等于功能失效）
 * @returns {number}
 */
export function envInt(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  // 未设置或纯空白：用默认值，且【不】记账——没配不是配错，运维不需要看到这条。
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    invalid.delete(name);
    return fallback;
  }
  const text = String(raw).trim();
  // 刻意不用 Number()：它把 "" / "0x10" / "1e3" / "Infinity" 都收下，语义太宽。
  // 这里只接受可选正负号 + 纯十进制数字。
  const parsed = /^[+-]?\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    invalid.set(name, { name, value: text, fallback, min, max });
    return fallback;
  }
  invalid.delete(name);
  return parsed;
}

/**
 * 当前被拒的非法环境变量清单（供 /api/health 暴露）。空数组＝所有额度配置都合法生效。
 * 只含变量名与原始值，不含凭据。
 */
export function invalidEnvVars() {
  return [...invalid.values()];
}

/** 仅供测试：清空记账，避免用例间互相污染。 */
export function resetInvalidEnvVars() {
  invalid.clear();
}
