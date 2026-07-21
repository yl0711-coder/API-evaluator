# 模型准入评测报告

生成时间：2026-07-07T06:21:46.228Z

## 1. 准入结论

- 结论：可进入稳定性和复杂场景测试
- 准入等级：A
- 综合分：100/100
- 原因：基础协议、结构和任务行为表现正常，可以继续做更高轮数稳定性、编程场景和成本测算。
- 下一步：进入稳定性测试和编程场景测试。

## 2. 被测对象

- 测试 ID：Claude-1.3x_claude-opus-4-8_admission_20260707_141705_1d79
- 配置名称：Claude-1.3x / claude-opus-4-8
- 配置角色：被测 API
- 供应商：
- 模型：claude-opus-4-8
- 协议：openai_compatible
- 渠道标识：-
- 测试包：quick
- 开始时间：2026-07-07T06:17:05.713Z
- 结束时间：2026-07-07T06:17:55.422Z
- 总耗时：49709 ms
- 工作区目录：D:\__MACOSX\API-evaluator-main\评测数据\工作区\Claude-1.3x_claude-opus-4-8_admission_20260707_141705_1d79
- JSON 原始结果：D:\__MACOSX\API-evaluator-main\评测数据\工作区\Claude-1.3x_claude-opus-4-8_admission_20260707_141705_1d79\result.json

## 3. 关键指标

- 请求数：5（逻辑测试用例数）
- 实际上游请求数（计费口径）：19（含 指纹探针 14）
- 成功率：100% (5/5)
- 平均耗时：9900 ms
- 慢请求参考 P95：18569 ms
- 输入 tokens 合计：26796（仅逻辑用例）
- 输出 tokens 合计：140（仅逻辑用例）
- 本次上游真实消耗 token（含探针+重试，不含流式）：输入 123501 / 输出 2135
- **本次真实消耗**：输入 26796 + 输出 140 = 26936 token，4 条计费请求，缓存写 0/读 25456；未配单价，仅统计 token
- **基线回归**：首次记录，已建立趋势基线
- 估算成本：0（基于 API 配置里的上游成本单价）
- 估算收入：0（基于 API 配置里的对外售卖单价）
- 估算毛利：0，毛利率 0%
- 工具调用：通过
- 流式结构：通过
- JSON 结构：通过
- 标称一致性：无法确认（标称 claude，自述 unknown）
- 模型纯度初判：高可信候选（92/100，置信度 medium）
- 指纹探针：未测试
- Token 审计覆盖率：80%
- 分词器指纹核验：⚠️ 疑似冒牌（分词比≠1），slope=6.3461 / R²=0.4874（基线 claude-opus-4-8，n=14）

## 4. 分项结果

| # | 测试项 | 结果 | HTTP 状态 | 总耗时 ms | 输入 tokens | 输出 tokens | 模型返回 | 说明 |
|---|---|---|---:|---:|---:|---:|---|---|
1 | 连通与模型响应 | 通过 | 200 | 7649 | 6485 | 3 | admission ok | 请求正常返回。
2 | 结构化输出 | 通过 | 200 | 18569 | 6657 | 24 | {"channelReady": true, "modelType": "Kiro AI assistant", "risk": "low"} | 结构化 JSON 字段完整。
3 | 模型标称一致性 | 通过 | 200 | 3223 | 6736 | 103 | {"modelFamily":"unknown","modelGeneration":"unknown","confidence":"low","evidence":"I am Kiro, an AI-powered development environment. My system prompt does not specify the underlying model family or generation, and I have no visible model identifier that would allow me to confirm which foundation model powers me. Per my instructions, I cannot fabricate this information, so I report unknown."} | 模型没有明确自述家族，标称 claude，需结合后续测试判断。
4 | 工具调用结构 | 通过 | 200 | 11510 | 6918 | 10 | tool_call:get_weather | 工具调用结构正常。
5 | 流式响应结构 | 通过 | 200 | 8550 | - | - | stream_events:6; issues:none | 流式响应结构完整。

## 5. 错误分布

- 无

## 6. 请求证据

| # | 测试项 | 结果 | HTTP 状态 | 首包 ms | 总耗时 ms | 摘要 |
|---|---|---|---:|---:|---:|---|
1 | 连通与模型响应 | 成功 | 200 | 7649 | 7649 | admission ok
2 | 结构化输出 | 成功 | 200 | 18569 | 18569 | {"channelReady": true, "modelType": "Kiro AI assistant", "risk": "low"}
3 | 模型标称一致性 | 成功 | 200 | 3221 | 3223 | {"modelFamily":"unknown","modelGeneration":"unknown","confidence":"low","evidence":"I am Kiro, an AI-powered development environment. My system prompt does not specify the underlying model family or generation, and I have no visible model identifier that would allow me to confirm which foundation model powers me. Per my instructions, I cannot fabricate this information, so I report unknown."}
4 | 工具调用结构 | 成功 | 200 | 11510 | 11510 | tool_call:get_weather
5 | 流式响应结构 | 成功 | 200 | 8506 | 8550 | stream_events:6; issues:none

## 7. 模型纯度与渠道风险初判

- 初判：高可信候选
- 纯度分：92/100
- 标称家族：Claude
- 证据置信度：medium
- 下一步：进入稳定性、复杂编程场景和成本审计复测。

### 7.1 正向证据

- 标称模型家族：模型名推断为 Claude。
- 结构化输出：JSON 结构化输出通过。
- 工具调用：工具调用结构通过。
- 流式结构：流式事件结构通过。
- 基础可用性：准入成功率为 100%。
- Token 审计：usage 覆盖率 80%，可作为成本参考。

### 7.2 风险信号

- 模型身份无法确认（medium）：模型没有明确给出可验证家族信息，需要后续指纹题复测。

### 7.3 Token 审计

- usage 覆盖率：80%
- 输入 tokens 合计：26796
- 输出 tokens 合计：140
- 平均输入 tokens：6699
- 平均输出 tokens：35
- 成功请求输出 tokens 为 0（medium）：1 条成功请求的输出 tokens 为 0，需要确认上游 usage 是否可信。

### 7.4 模型指纹探针

- 题库版本：2026.06.01
- 通过率：未测试
- 未执行模型指纹探针。

## 8. 模型指纹追踪（持续复测 + 横向对照）

- 标称家族：claude；模型自述家族：unknown
- tokenizer 信号探针数：0（固定文本探针的 prompt_tokens 差分）
- 持续复测（本次 vs 上次）：与上次一致（未见替换证据） —— 与上次指纹一致，未见替换证据（不等于证明同一模型）。
- 横向对照（同模型多渠道）：⚠️ 与同模型其它渠道显著不同 —— 本渠道与同模型其它渠道存在显著差异，疑似挂羊头卖狗肉（需上游解释）。
  - 同模型多数渠道自述家族：claude（对照渠道 7 个）
  - [high] 本渠道自述 unknown，但同模型多数渠道自述 claude
- 横向 token 诚实度：基线不足 —— 同模型横向基线不足（需 ≥2 个同模型渠道且本次 ≥2 个 token 探针），暂无法量化虚报率。
- 注：结论均为黑盒概率判断，仅「疑似 / 需上游解释」，不等于证明同一或不同模型。

## 9. 计费精度与维度审计

### 精确 token 审计（OpenAI 系，官方分词器绝对判定）
- 不适用：模型「claude-opus-4-8」无可用官方离线分词器（目前仅 OpenAI 系支持绝对判定），已回退横向对照/估算法。

- 推理 token 合计：0（0 条请求计了推理 token；模型不像推理类）
- 缓存写入 token：0；缓存读取 token：25456
- 未见 reasoning / cache 维度计费异常。

## 10. 分词器指纹核验（Claude 身份）

- 判定：与「claude-opus-4-8」分词不一致(slope=6.3461, R²=0.4874),疑似非该代 Claude(挂羊头/换代)。
- 对照基线：claude-opus-4-8（可信源（非官方分词，仅取线性关系））
- 拟合：slope=6.3461，intercept=6235.3，R²=0.4874，样本 14，置信度 high
- 方法：对固定探针的输入 token 数做线性拟合 reported≈slope·base+intercept；同一代分词器 slope≈1、R²≈1，
  模板固定开销只改 intercept。判据以 |slope−1| 为主、R² 为辅。只判“代/家族”，不区分同代具体型号。

## 11. 说明

- 本报告用于接入前初筛，不等同于官方模型身份鉴定。
- 准入等级由连通性、协议结构、工具调用、任务行为、耗时和 token 返回情况综合判断。
- 如果分数低或出现结构失败，需要先复核协议、模型名、渠道类型和上游转换逻辑，再进入稳定性测试。
- 报告不包含 API Key。
