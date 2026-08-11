## 静态资源与 API 响应压缩（含缓存头）

**问题诊断**（2026-08-10，用户自测）

1. **静态资源零压缩**：首屏三件套原始传输 426 KB（`/` 103502 B、`/assets/index-*.js` 265403 B、`/assets/index-*.css` 67244 B）。gzip 后 123 KB（省 71%），brotli 后 98 KB（省 77%）。本地环回（1.6 ms）看不出来，线上跨公网 / 移动网络 / 跨境是几百毫秒到几秒的差别——最符合"线上慢、本地不慢"的症状。

2. **静态资源零缓存头**：同样这三个响应没有 `cache-control`、`etag`、`last-modified`，每次刷新完整重传 426 KB。而 Vite 产物文件名本身带内容 hash（`index-BzlLiOBH.js`），可以安全地长期强缓存。

3. **API 响应无压缩**：`sendJson` 用 `JSON.stringify(data, null, 2)`。实测报告 payload：pretty 988 KB、compact 984 KB（**去掉缩进只省 0%**）、pretty + gzip 29 KB（省 97%）。数据以长字符串为主，所以该做的是压缩而不是改缩进。

**解决方案**

新增 `server/compression.mjs`。

### 1. 静态资源（`sendCompressedStatic`）

- **内容协商**：按 `accept-encoding` 选 brotli > gzip > identity，不支持的客户端拿未压缩原文。
- **内存缓存**：压缩结果按 `${encoding}:${etag}` 缓存，最多 200 条，超限按 timestamp 淘汰最老 20 条。
- **缓存头**：
  - 带内容 hash 的资源 → `cache-control: public, max-age=31536000, immutable`
  - `index.html` → `cache-control: no-cache` + `etag`（HTML 不能强缓存，否则发版后拿不到新的 asset 引用）
  - 其他（favicon 等）→ `cache-control: public, max-age=3600` + `etag`
- **条件请求**：带 `etag` 的响应处理 `if-none-match`，命中回 304 空 body。不做这步 etag 就只是装饰，刷新照样整包重传。
- **`vary: accept-encoding`**：所有压缩响应都带。不声明的话共享缓存 / CDN 可能把 brotli 的 body 喂给只支持 gzip 的客户端。

### 2. API 响应（`sendCompressedJson`）

- 超过 1 KB 才压缩（小响应压了反而亏），压缩失败降级为未压缩，不会让请求失败。
- 保留 `null, 2` 缩进：实测去掉只省 0%，而调试时可读性有价值。
- 已接入的三个端点：`POST /api/reports/compare`、`POST /api/reports/compare/multi`、`GET /api/support-bundle`。其余 128 个 `sendJson` 调用点未动，`sendJson` 本身保持原样。

**判断文件名是否带 hash**

`isHashedAssetPath()` 的判据是：扩展名前最后一个 `-` 之后的片段长度 ≥ 8，且含数字或混合大小写。

两个方向都不能错：
- 只匹配 `[a-f0-9]{8,}` 会漏掉 Vite 默认的 base64url 风格 hash（`index-BzlLiOBH.js`），导致 `immutable` 实际没生效——初版就是这个 bug。
- 放宽到"任何带连字符的名字"又会把 `vendor-legacy.js` 误判成带 hash，改了内容却没改名的文件会被浏览器强缓存一年。

**关于 HTTP 连接池（已回滚，勿重开）**

初版还加了 `server/http-pool.mjs`，用 undici 的 `setGlobalDispatcher` 配连接池。已删除，两个原因：

1. `undici` 不是本项目依赖（生产依赖只有 gpt-tokenizer / mysql2 / nodemailer，`pnpm-lock.yaml` 里只有 `@types/node` 带的纯类型包 `undici-types`）。它被 `server.mjs` 第 5 行 import，直接 `ERR_MODULE_NOT_FOUND`，**服务器起不来**，端点测试全红（99 fail）。这也推翻了 2026-07-16 为 egress-guard 做的既有决定：DNS rebinding 缺口就是因为"必须新增 undici 依赖"才刻意不修的。
2. 它的立论不成立。实测 Node 内置 fetch 的默认 dispatcher **本来就有连接池**：20 次串行 POST 只开了 2 个 TCP 连接。它真正的作用只是把空闲超时从默认 4 秒拉到 60 秒——对请求间隔超过 4 秒的稳定性测试有一点价值，但远不是"最大的一笔收益"。

**验证**

```bash
node --test tests/compression.test.mjs   # 17 项，覆盖协商 / hash 判定 / 缓存头 / 304
node --env-file=.env.evaluator server.mjs
node scripts/verify-compression.mjs
```

浏览器 DevTools Network 面板复核：响应头有 `content-encoding: br|gzip`，`/assets/*.js` 的 `cache-control` 含 `immutable`，二次刷新 `index.html` 是 304。

**实测效果**（端到端往返 + 裸 socket 确认线路字节）

- 113408 B 的 JSON → 线路上 1609 B，压缩率 98.6%，gzip 魔数正确、可手动 gunzip 解回原文。
- 带 hash 的资源拿到 `max-age=31536000, immutable`；`index.html` 拿到 `no-cache` + etag，复访 304 且 body 为 0 字节。
- 客户端不发 `accept-encoding` 时原样返回，不带 `content-encoding`。

**兼容性**

Brotli：Chrome 50+ / Firefox 44+ / Safari 11+ / Edge 15+。Gzip：全部浏览器。都不支持则回落 identity。
