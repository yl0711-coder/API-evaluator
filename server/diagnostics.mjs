export const ERROR_DIAGNOSTICS = {
  auth_failed: {
    title: "认证失败",
    cause: "API Key 错误、Key 无权限、账户欠费、鉴权头不符合上游要求。",
    action: "先检查 Key、余额、模型权限和协议类型；如果是中转站，再对照平台请求日志确认鉴权是否被正确转发。",
  },
  model_not_found: {
    title: "模型不可用",
    cause: "模型名填写错误、渠道未开通该模型、协议转换后模型名不被上游识别。",
    action: "复制平台后台展示的模型名重新填写；必要时用最小 Prompt 跑快速测试确认。",
  },
  rate_limited: {
    title: "触发限流",
    cause: "并发过高、单位时间请求过多、套餐额度或渠道限流。",
    action: "降低并发和轮数，间隔一段时间复测；如果仍然限流，需要检查平台套餐、分组倍率和渠道限制。",
  },
  upstream_5xx: {
    title: "上游服务错误",
    cause: "上游模型服务、中转网关或协议转换链路异常。",
    action: "对照平台 Request ID 和上游日志；换时间复测，如果集中出现则暂不建议作为稳定候选。",
  },
  timeout: {
    title: "请求超时",
    cause: "模型响应慢、排队严重、长上下文耗时过长、本地网络或代理链路不稳定。",
    action: "先把超时调大到 120000ms 复测；同时观察 P95，如果 P95 长期偏高，不适合低延迟场景。",
  },
  network_error: {
    title: "本地网络错误",
    cause: "DNS、代理、VPN、本地网络或 TLS 连接异常。",
    action: "先确认浏览器和 VPN 正常；再用快速测试复测。如果只有本工具异常，检查 Base URL 和本地代理环境变量。",
  },
  empty_response: {
    title: "空响应",
    cause: "HTTP 成功但没有提取到文本，常见于协议选择错误、上游返回结构变化或中转格式转换问题。",
    action: "检查协议类型是否匹配；Claude 原生接口用 Claude Messages，OpenAI 兼容接口用 OpenAI Compatible。",
  },
  content_block_not_found: {
    title: "内容块缺失",
    cause: "上游或中转返回了客户端无法识别的内容结构，常见于 Claude/OpenAI 协议转换不完整。",
    action: "优先检查协议选择、模型兼容性和中转站转换日志；如果平台日志显示上游 done，但客户端报错，应重点排查响应结构转换。",
  },
  invalid_response: {
    title: "响应格式异常",
    cause: "上游返回了非预期 JSON、错误页面、代理报错文本或协议不匹配结果。",
    action: "检查 Base URL 是否只填到域名或网关根路径；确认协议和模型接口是否匹配。",
  },
  response_too_large: {
    title: "响应过大",
    cause: "上游返回内容超过工具的单次响应保护限制，可能是网关错误页、异常流量或模型输出失控。",
    action: "先用短 Prompt 快速复测；如果仍然出现，检查上游日志、模型最大输出和网关返回内容。",
  },
  unknown_error: {
    title: "未知错误",
    cause: "当前工具无法明确归类的失败。",
    action: "查看单轮明细里的原始错误摘要，并结合平台 Request ID 排查。",
  },
};
