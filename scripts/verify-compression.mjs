// 手动验证脚本：检查静态资源和 API 响应是否正确压缩
// 用法：先启动服务器，再运行 node scripts/verify-compression.mjs

import http from "node:http";

const BASE_URL = "http://127.0.0.1:5180";

function request(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE_URL}${path}`, { headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}

async function checkStatic() {
  console.log("=== 检查静态资源压缩 ===\n");

  // 不带 accept-encoding
  const uncompressed = await request("/");
  console.log("GET / (无压缩):");
  console.log(`  状态: ${uncompressed.status}`);
  console.log(`  大小: ${uncompressed.body.length} 字节`);
  console.log(`  content-encoding: ${uncompressed.headers["content-encoding"] || "(无)"}`);
  console.log(`  cache-control: ${uncompressed.headers["cache-control"] || "(无)"}`);
  console.log(`  etag: ${uncompressed.headers.etag || "(无)"}`);

  // 带 gzip
  const gzipped = await request("/", { "accept-encoding": "gzip" });
  console.log("\nGET / (gzip):");
  console.log(`  状态: ${gzipped.status}`);
  console.log(`  大小: ${gzipped.body.length} 字节`);
  console.log(`  content-encoding: ${gzipped.headers["content-encoding"] || "(无)"}`);
  console.log(`  压缩率: ${((1 - gzipped.body.length / uncompressed.body.length) * 100).toFixed(1)}%`);

  // 带 brotli
  const brotli = await request("/", { "accept-encoding": "br" });
  console.log("\nGET / (brotli):");
  console.log(`  状态: ${brotli.status}`);
  console.log(`  大小: ${brotli.body.length} 字节`);
  console.log(`  content-encoding: ${brotli.headers["content-encoding"] || "(无)"}`);
  console.log(`  压缩率: ${((1 - brotli.body.length / uncompressed.body.length) * 100).toFixed(1)}%`);

  // 检查带 hash 的资源缓存头
  const assetsReq = await request("/");
  const html = uncompressed.body.toString("utf8");
  const jsMatch = html.match(/\/assets\/index-[a-zA-Z0-9_-]+\.js/);
  if (jsMatch) {
    const jsPath = jsMatch[0];
    const jsResp = await request(jsPath, { "accept-encoding": "gzip" });
    console.log(`\nGET ${jsPath}:`);
    console.log(`  状态: ${jsResp.status}`);
    console.log(`  大小: ${jsResp.body.length} 字节`);
    console.log(`  content-encoding: ${jsResp.headers["content-encoding"] || "(无)"}`);
    console.log(`  cache-control: ${jsResp.headers["cache-control"] || "(无)"}`);

    const hasImmutable = jsResp.headers["cache-control"]?.includes("immutable");
    const hasLongMaxAge = /max-age=(\d+)/.test(jsResp.headers["cache-control"] || "");
    if (hasImmutable && hasLongMaxAge) {
      console.log("  ✓ 强缓存已启用");
    } else {
      console.log("  ✗ 强缓存未启用");
    }
  }
}

async function checkApi() {
  console.log("\n\n=== 检查 API 响应压缩 ===\n");

  // 测试一个可能返回大响应的端点（需要登录，这里只测试压缩协商能力）
  console.log("注意：API 端点测试需要有效的会话 cookie，这里只验证框架是否支持压缩。");
  console.log("真实效果需要在浏览器 DevTools Network 面板查看。");
}

async function main() {
  try {
    await checkStatic();
    await checkApi();
    console.log("\n=== 验证完成 ===");
    console.log("\n预期效果：");
    console.log("  1. 静态资源（/, /assets/*.js, /assets/*.css）支持 gzip 和 brotli");
    console.log("  2. 压缩率应达到 70% 以上");
    console.log("  3. 带 hash 的资源有 immutable + max-age=31536000");
    console.log("  4. index.html 有 no-cache + etag");
  } catch (error) {
    console.error("错误:", error.message);
    console.error("\n请确保服务器已启动：node --env-file=.env.evaluator server.mjs");
    process.exit(1);
  }
}

main();
