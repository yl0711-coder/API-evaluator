// scripts/verify-http-pool.mjs
// 验证 HTTP 连接池是否正常工作：对同一 origin 发送多个请求，测量总耗时。
// 启用连接池后，第二个及后续请求应显著快于第一个（无需重复握手）。

import "../server/http-pool.mjs"; // 加载连接池配置

const TEST_URL = "https://httpbin.org/delay/0"; // 响应延迟 0 秒的测试端点
const REQUEST_COUNT = 5;

console.log(`验证 HTTP 连接池（向 ${TEST_URL} 发送 ${REQUEST_COUNT} 个请求）\n`);

async function measureRequest(index) {
  const start = performance.now();
  try {
    const response = await fetch(TEST_URL, {
      method: "GET",
      headers: { "user-agent": "api-evaluator-http-pool-test" },
    });
    const elapsed = Math.round(performance.now() - start);
    const status = response.status;
    return { index, elapsed, status, success: response.ok };
  } catch (error) {
    const elapsed = Math.round(performance.now() - start);
    return { index, elapsed, status: null, success: false, error: error.message };
  }
}

async function main() {
  const results = [];

  // 串行发送请求（便于观察单个请求的耗时）
  for (let i = 1; i <= REQUEST_COUNT; i++) {
    const result = await measureRequest(i);
    results.push(result);
    const statusText = result.success ? `${result.status} OK` : `FAIL (${result.error || result.status})`;
    console.log(`请求 ${i}/${REQUEST_COUNT}: ${result.elapsed} ms - ${statusText}`);
  }

  // 统计分析
  const successful = results.filter((r) => r.success);
  if (successful.length < 2) {
    console.log("\n失败请求过多，无法验证连接池效果。");
    return;
  }

  const firstElapsed = successful[0].elapsed;
  const subsequentElapsed = successful.slice(1).map((r) => r.elapsed);
  const avgSubsequent = Math.round(subsequentElapsed.reduce((a, b) => a + b, 0) / subsequentElapsed.length);
  const speedup = ((firstElapsed - avgSubsequent) / firstElapsed * 100).toFixed(1);

  console.log("\n=== 连接池效果分析 ===");
  console.log(`首次请求耗时: ${firstElapsed} ms（包含 TCP + TLS 握手）`);
  console.log(`后续请求平均: ${avgSubsequent} ms（复用连接，无握手）`);
  console.log(`速度提升: ${speedup}% 更快`);

  if (avgSubsequent < firstElapsed * 0.7) {
    console.log("\n✅ 连接池工作正常：后续请求显著快于首次（预期行为）");
  } else if (avgSubsequent < firstElapsed * 0.9) {
    console.log("\n⚠️  连接池可能工作，但提升不明显（网络抖动或测试端点响应主导延迟）");
  } else {
    console.log("\n❌ 连接池可能未生效：后续请求耗时与首次相近（预期应更快）");
  }

  console.log("\n提示：");
  console.log("- 本地测试对公网端点时，网络抖动可能掩盖连接复用的收益");
  console.log("- 真实收益在生产环境下更明显（稳定性测试向同一渠道发送 100+ 请求）");
  console.log("- 可用 Wireshark 抓包验证：多个 HTTP 请求是否共享同一 TCP 连接");
}

main().catch((err) => {
  console.error("验证失败:", err);
  process.exit(1);
});
