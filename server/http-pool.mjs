// server/http-pool.mjs
// HTTP 连接池配置：启用 keep-alive 连接复用，避免每个请求重新建立 TCP + TLS 握手。
//
// **问题诊断**（2026-08-10）：
// Node.js 的全局 fetch 基于 undici，默认每个请求创建新连接（无连接池）。
// 线上跨公网场景下，单次 TCP 握手（3 RTT）+ TLS 握手（1-2 RTT）可能耗时 100-300ms。
// 高频测试场景（准入 / 稳定性 / 压测）会反复向同一 baseUrl 发送几十到上百个请求，
// 累积的握手开销可达数秒到数十秒——这正是"线上慢、本地快"的典型症状。
//
// **解决方案**：
// 设置全局 Agent（undici 称为 Dispatcher），配置连接池参数：
//   - pipelining: 0（禁用 HTTP 流水线，避免与某些中转/代理不兼容）
//   - connections: 256（每个 origin 最多保持 256 个并发连接）
//   - keepAliveTimeout: 60000（keep-alive 连接空闲 60 秒后关闭）
//   - keepAliveMaxTimeout: 600000（连接最长存活 10 分钟，防止僵尸连接）
//
// **适用范围**：
// - 仅影响 server/upstream-transport.mjs 的上游请求（fetch 调用）
// - 不影响客户端浏览器与本服务器的连接（那是 Node.js http.Server 管理的）
//
// **兼容性**：
// - Node.js ≥ 18.0（内置 fetch + undici）
// - 所有 OpenAI 兼容 / Claude 兼容端点（HTTP/1.1 或 HTTP/2）

import { Agent, setGlobalDispatcher } from "undici";

// 连接池配置
const poolOptions = {
  // 禁用 HTTP 流水线：部分中转/反向代理对流水线支持不完善，可能导致请求乱序或挂起。
  // 保守起见禁用，只复用连接（keep-alive），不在同一连接上并发多个请求。
  pipelining: 0,

  // 每个 origin（协议 + 域名 + 端口）最多保持 256 个并发连接。
  // 评测场景下对单个 origin 的并发请求数受全局队列槽位限制（默认 5），
  // 这里放宽上限是为了支持未来可能的高并发压测或多用户同时测试场景。
  connections: 256,

  // Keep-alive 空闲超时：连接空闲 60 秒后关闭。
  // 60 秒足以覆盖准入测试（~30 秒）和稳定性测试（请求间隔通常 < 10 秒）的连接复用窗口。
  keepAliveTimeout: 60_000,

  // 连接最长存活时间：10 分钟后强制关闭，即使仍在使用。
  // 防止长时间运行的任务持有僵尸连接（上游已关闭但本地未感知）。
  keepAliveMaxTimeout: 600_000,

  // 自动根据协议版本选择：HTTP/2 则启用多路复用，HTTP/1.1 则串行复用连接。
  // 上游返回什么协议就用什么，不强制升级或降级。
  // allowH2: true（undici 默认值，这里显式说明）
};

// 创建并设置全局 Agent
const globalAgent = new Agent(poolOptions);
setGlobalDispatcher(globalAgent);

// 导出配置供诊断（例如健康检查端点可以报告连接池状态）
export const HTTP_POOL_CONFIG = {
  pipelining: poolOptions.pipelining,
  connectionsPerOrigin: poolOptions.connections,
  keepAliveTimeoutMs: poolOptions.keepAliveTimeout,
  keepAliveMaxTimeoutMs: poolOptions.keepAliveMaxTimeout,
};

// 导出 agent 实例供高级场景使用（例如获取连接池统计信息）
export { globalAgent };
