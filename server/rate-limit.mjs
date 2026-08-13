// 极简固定窗口限流（进程内内存）。用于给匿名可达端点兜底防灌——当前用于 /api/client-errors（P3-8）：
// 该端点在免登录白名单里，任何人可无限 POST 灌错误日志。本平台单进程部署，进程内计数足够；
// 重启清零可接受（限流是防滥用兜底，不是账务）。
//
// createRateLimiter({ windowMs, max }) → { check(key) }
//   check 返回 { allowed, retryAfterMs }；每次 check 计一次数，同一 key 在窗口内超过 max 即拒。
export function createRateLimiter({ windowMs, max, now = () => Date.now(), maxKeys = 10000 }) {
  const buckets = new Map(); // key -> { count, resetAt }
  const keyLimit = Number.isSafeInteger(maxKeys) && maxKeys > 0 ? maxKeys : 10000;
  let earliestResetAt = Infinity;

  function sweep(t) {
    for (const [k, b] of buckets) if (t >= b.resetAt) buckets.delete(k);
    earliestResetAt = Infinity;
    for (const b of buckets.values()) earliestResetAt = Math.min(earliestResetAt, b.resetAt);
  }

  function retryAfterForCapacity(t) {
    return Number.isFinite(earliestResetAt) ? Math.max(0, earliestResetAt - t) : 0;
  }

  return {
    check(key) {
      const t = now();
      let b = buckets.get(key);
      if (!b || t >= b.resetAt) {
        // 惰性清理：跨窗口时顺手扫掉过期桶，避免被大量一次性 key（如伪造来源）撑爆内存。
        if (buckets.size >= keyLimit && t >= earliestResetAt) sweep(t);
        if (buckets.size >= keyLimit) {
          return { allowed: false, retryAfterMs: retryAfterForCapacity(t) };
        }
        b = { count: 0, resetAt: t + windowMs };
        buckets.set(key, b);
        earliestResetAt = Math.min(earliestResetAt, b.resetAt);
      }
      b.count += 1;
      if (b.count > max) return { allowed: false, retryAfterMs: Math.max(0, b.resetAt - t) };
      return { allowed: true, retryAfterMs: 0 };
    },
    // 供测试/诊断：当前活跃 key 数
    size() {
      return buckets.size;
    },
  };
}
