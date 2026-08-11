# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **独立「任务中心」页（新增 `src/task-center.js`，PRD FR-004 / 修 ADM-002、ADM-024）** — 任务状态此前藏在
  报告中心的「最近任务状态」折叠区里，每个任务只有一行聚合状态，**看不出「哪一步没通过」**——而排查时
  用户想知道的恰恰只有这个。PRD 要求的独立任务中心页一直没落地，现补上：
  - 列表可按状态 / 类型筛选，点开任意任务看「模型 × 步骤」网格（复用标准评测那套
    `.flow-model-group` / `.flow-step` 类名，两处观感一致）。运行中的任务自己轮询刷新，切走页面即停。
  - **前端不自算准入结论**：只如实展示 `executionStatus` × `verdict` 两个正交字段，聚合判定仍归服务端
    `aggregateSuite` 独有。
  - `api-client` 新增**只读**的 `observeRemoteTask`（不 POST、不写 `state.activeTasks`，不会新建任务或
    误取消别人的任务）与 `cancelTaskById`；顺手修掉 `src/api-client.js` 里指向不存在页面「任务管理」的文案。
  - 「再测一次」只回填表单并跳到标准评测页，**不直接开跑**——任务花钱，最后一下留给用户；模型目标也
    可能已删除或改名，先核对再填。回填靠 `batch-target-picker` 新增的 `selectMany`，锚点是单值的、跨渠道
    的一组填不全，故如实返回真正勾上的 id，提示里说清「另有 N 个未回填」。
  - **能力边界**：任务只在事件流最后 300 行内查得到，更早的查不到。要彻底解决需 SQLite 落库
    （`evaluation_tasks` 表，ADM-017），属刻意未做的取舍。

### Removed
- **报告中心的「最近任务状态」折叠区**（连同 `renderTaskEventList`）— 已被上面的任务中心取代，不再并存，
  避免两处展示同一批数据而口径不一致。`loadTaskEvents` 保留：交付视图仍靠 `state.taskEvents` 识别
  「因程序关闭而中断」的任务。

### Added
- **任务状态落 SQLite，记录不再随进程消失（ADM-017，新增 `evaluation_tasks` 表）** — 任务此前只活在
  内存 `Map` 里：落定 1 小时被逐出、重启即清空，唯一持久痕迹是 `task-events.jsonl` 且**只读最后 300 行**。
  「上周那次准入到底跑没跑」查不到 —— 这正是上一轮做任务中心时留下的那条能力边界。
  - 按 `task_id` **upsert** 而非 insert（任务一生要写多次：queued → 终态）。`payload_json` /
    `result_json` / `steps_json` 用 `COALESCE` 保护：payload 只在建任务时写一次，终态 upsert 若直接
    覆盖会把「再测一次」的参数摘要抹成 `null`。
  - **两个来源合并读取**，刻意不写成「有库就只读库」：升级那一刻表是空的而 JSONL 有历史，一跑第一个
    新任务库里有了 1 行，只读库就会让**全部历史任务凭空消失**。这个坑在实现中真的踩到了，由既有用例
    抓出。同一 taskId 两边都有时以库为准。
  - 启动时把残留的 `running` / `queued` 改判 `interrupted`。事件流路径早有等价的**读时**推断，但落库后
    状态是持久的，必须真写回去，否则重启后列表永远挂着一批「运行中」、前端还会对它们无限轮询。
  - **进度推进不落库**：一个 27 用例的任务会推进几十次，每次 upsert 是无谓写放大。只在状态跃迁时写，
    进度靠内存态 + 轮询；读取时内存态覆盖库里的过时进度。
  - `owner_user_id` 列先建好但仍不做隔离（见下条 ADM-016），将来真要隔离不必再迁一次表。
  - 未做：列表仍只显示最近 30 条（分页 / 检索是另一档 UI 工作）；幂等键仍是进程内内存态，未落库加
    `UNIQUE(owner_user_id, idempotency_key)`（ADM-015 的剩余敞口）。
- **任务记录发起人与取消人（ADM-016 的记录部分）** — 多人共用一台工具时最常问的是「这轮谁跑的、
  这笔钱谁花的」，而任务对象此前不记创建者。请求级早有 `run_by`（`run-context.mjs` 的
  `AsyncLocalStorage` → `recordRequest`），任务级一直是空白。现在 `createTask` / `cancelTask` 各接一个
  可选 `actor`，任务带 `createdBy` / `cancelledBy`，落进事件流（任务落定 1 小时就被逐出内存，只有事件流
  能跨重启回答）并进 `publicTask`；任务中心列表行显示发起人，明细显示发起 / 取消人。
  - `actor` 刻意**不走 payload**：payload 要过 `summarizeTaskPayload` 的形状摘要，身份混进去早晚被当
    敏感字段摘掉、或反过来摘漏。用户名不是敏感字段（不同于 key / baseUrl），泄漏锁定用例照旧通过。
  - **刻意不做强制隔离**：取消仍对所有登录者放行，不校验 `actor === createdBy`。取消是**止损**操作，
    五人协作里「A 下班后他卡住的任务能被 B 掐掉」是协作而非漏洞，限权反而放大损失——role 10 正是日常
    跑测试的人，他连自己刚发起的任务都取消不了就只能看着额度烧完。取消提示语带上操作者，出问题靠
    事件流追溯。真要加隔离得先有 SQLite 落库（ADM-017），届时数据已经在了，加 `WHERE owner = ?` 即可；
    先加墙再拆墙要难得多。已加用例锁死「不校验身份」，防后人顺手补上校验。
  - 空串归一成 `null`：「未记录」（无会话的内部调用、历史任务）与「某个空名用户」必须可区分。

### Fixed
- **多模型比对的基准列会随勾选的 peer 及其顺序漂移** — 「多模型比对」声称并写了测试守护的核心不变量是
  「基准列必须不随勾选了哪些 peer 而变」，但「平均质量分」与「P50 首 Token 延迟」这两行实际会漂：
  `buildMultiComparisonView` 拿 `views[0]`（即 `pairs[0]`）的 A 侧当基准列，而这两行在两列视图里做的是
  **两方**过滤（「双方共有**且双方都有该指标**」），于是基准的分母变成「基准 ∩ pairs[0]」，跟着
  `pairs[0]` 是谁走。实测：基准 S1=90 / S2=80、某 peer 的 S2 缺质量分时，**仅调换勾选顺序**基准列就从
  60 变成 80，高亮列一起跳；P50 首 Token 同样（500 → 100）。用户会看到同一个基准在不同组合下给出不同的
  分，且无从判断哪个才对。
  - 新增 `multiSharedScenarioMetrics()`：这两行改用 **N 方口径** —— 在共享场景里取「**所有列都有该
    指标**」的场景做分母，基准与各 peer 都在同一批场景上聚合。基准只算一次、与 peer 传入顺序无关，
    各列同分母因而可比。
  - 分母**确实**随勾选的 peer 集合变化，这是固有的（N 方共享场景集本身就由 peer 集合定义），不是缺陷；
    故 `detail` 文案改成显式写出参与的场景个数，不让用户把「换了一批 peer 后数字变了」误读成算错。
  - 首 Token 沿用两列视图的双轨口径：优先「各列都有原始样本」的场景池化取精确 P50，一个都没有才退回
    「各列都有场景级 P50」的中位数（分位数不可分解，只作展示、不进综合分）。
  - **原有用例为何全绿**：`tests/multi-comparison-view.test.mjs` 确有一条断言该不变量的用例，但它的三个
    夹具在每个共享场景上都有质量分，走不到「两方过滤」与「N 方过滤」分母不同的那条路。现补一个
    **在某场景上缺质量分**的 peer 夹具，并加 2 例回归（换序不变 / 各列同分母）。
- **终态任务的结束时间从未落库，重启后任务时长算不出来（P1-03）** — `runTask` 的 `completed` /
  `failed` / `cancelled` 三个分支都是「先 `appendTaskEvent` 写事件与 SQLite、后在 `finally` 里赋
  `task.endedAt`」，于是落库那一刻 `endedAt` 还是 `undefined`。而 `recordEvaluationTask` 的 upsert 里
  `ended_at` 走 `COALESCE`、此后再无写入——**这个 null 是永久的**：任务被逐出内存（落定 1 小时即逐出）
  或进程重启后，任务中心只能显示「结束：—」，任务时长、审计与运营统计全部拿不到数。
  - 修在 `appendTaskEvent` 这个**唯一的事件写入口**，而不是在三个分支各补一次赋值：将来新增终态分支
    不会再漏这一笔。事件流与 SQLite 两条落盘路径共用同一个时间戳，天然不会打架。
  - `finally` 里改成 `if (!task.endedAt)` 兜底，只覆盖「一个终态事件都没写成」的情况（如落盘异常逃逸
    到 `runWithSlot` 的 catch）。**绝不能无条件重赋**：那会让内存里的时间与已落库的那笔差出几毫秒到
    几百毫秒，同一个任务在「内存态」与「重启后读库」两条路径上显示不同的结束时间。
  - 顺带修正了一处排序偏斜：`taskSortTime` 对库里的行此前永远拿不到 `endedAt`、只能退到 `createdAt`,
    与内存态的排序口径不一致；现在两个来源对齐。
  - 新增 completed / failed / cancelled 三类任务的落库断言，以及跨进程重启后 `endedAt` 仍在的断言。
- **非法环境变量会让并发闸、熔断与留存清理静默失效（P1-04，新增 `server/env-config.mjs`）** — 全库散着
  七八处 `Math.max(1, Number(process.env.X || d))`。`Number("abc")` 得到 `NaN`，而**`Math.max(1, NaN)`
  仍是 `NaN`**，NaN 参与的任何比较恒为 false，于是阀门不是回落默认值而是彻底不工作：
  - `runningSlots < NaN` 永不成立 → 新任务**永久 queued**，队列提示显示「最多同时跑 NaN 个」；
  - `maxConsecutiveFailures > 0` 永不成立 → 自动测试的连续失败熔断被静默关掉，**配了熔断却不熔断，
    比压根没配更危险**；
  - 更隐蔽的一条：`NaN` 天数传进 `new Date(NaN).toISOString()` 会抛 `RangeError`，被
    `runReportMaintenance` 最外层的空 catch 吞掉，**整段维护（报告清理 + 历史清理 + 老化压缩）一次都
    不执行**，磁盘只增不减；
  - 另一半是 `Infinity`：`Number("Infinity")` 是合法 Number 且 `> 0`，能通过 `> 0 ?:` 那种旧写法的校验，
    等于把上限直接取消——流式响应字节硬顶、客户端报错限流、裁判调用额度、new-api 导入超时全在其中。
  - 统一到 `envInt(name, fallback, {min, max})`：**刻意不用 `Number()`**（它把 `""` / `"0x10"` /
    `"1e3"` / `"Infinity"` 都收下，语义太宽），改为正则卡住纯十进制整数再过 `Number.isSafeInteger`，
    一次挡掉 NaN、±Infinity、小数与超过 2^53-1 的值。越界**拒绝并回落**而非 clamp——既有的
    `utils.mjs:clampNumber` 是静默夹取，会把 `10000` 悄悄变成 64，运维看不出自己配错了。
  - **选择安全默认值而非阻止启动**：这些全是可选调优项，为一个拼错的留存天数把服务拒起（评测平台常年
    跑在单机 docker 上，起不来就没有任何界面能告诉运维原因）损失更大。原始缺陷的要害是**误配无处可见**，
    所以关键是新增的明账而非终止进程。凭据类配置不走这里，`EVALUATOR_SESSION_SECRET` 未配置或过弱
    仍在 `server/auth.mjs` 直接抛错拒启动。
  - `/api/health` 新增 `limits`（`maxConcurrentTasks` / `runningSlots` / `autoTestConcurrency`）、
    `autoTest.maxConcurrent` / `autoTest.maxConsecutiveFailures`，以及 `invalidEnvVars`——非空即说明有人
    配错了值、系统正跑在默认值上。只报变量名与原始值，**不含任何凭据**。修正配置后无需重启，下次读取
    即从清单消失。
  - `EVALUATOR_AUTO_TEST_MAX_FAILURES` 用 `min: 0`，因为 0 的语义是「关闭熔断」，必须继续被尊重；
    字节数与毫秒数两处 `min` 保持 1，只拒绝无意义的值，**不替运维决定「多短算太短」**（`newapi-source`
    的超时用例就靠 300ms 跑得快，抬高下限会把它打挂）。
  - 刻意未改 `server/auth.mjs`：那三处已是正确的 `Number.isFinite(n) && n > 0 ? n : d`，且会话 TTL
    合法地接受小数小时，硬套整数解析器反而是回退。
- **延迟统计不含重试与退避等待，报告比用户真实体感乐观（ADM-010，新增 `endToEndMs`）** — 一个「首次
  503、退避 2 秒、二次 800ms 成功」的请求，此前只落 `total_ms = 800`：`performance.now()` 在每次 attempt
  内重开，最终只留最后一次尝试的耗时。**用户实际等了 2.8 秒，而报告里的 P95 系统性优于真实体感**，
  准入决策看的正是这个数。ADM-009 已修掉成功率的同类失真（重试掩盖首次失败），这条是它的延迟部分。
  - **`total_ms` 语义刻意不变**，新增 `endToEndMs` 并存：趋势图与回归判定的延迟序列按
    `total_ms IS NOT NULL` 取点（`server/db.mjs`），改它的含义会让历史数据不可比。`total_ms` 答「上游
    一次请求有多快」，`endToEndMs` 答「用户等了多久」，报告并列展示、并说明两者的差就是重试等待。
  - **确定性重配刻意不计入**：`temperature` / `stream_options` 被拒后就地删参重试是修我方请求体、
    零退避、且同模型只发生一次（`TEMPERATURE_UNSUPPORTED_MODELS` 记住后首发就不带）。计进去只会让
    每个模型的**第一条**记录凭空变慢，制造 ADM-010 本想消除的那类失真。已加用例锁死，防后人「顺手统一」。
  - SQLite 新增 `end_to_end_ms` 列并走 `migrateSchema` 补列 —— 线上都是旧库，漏了迁移就是**写入静默
    失败**（`recordRequest` 是 best-effort 吞异常的，表现为「新字段永远是空」而非报错）。
  - 新增 `toIntOrNull`：既有 `toInt` 把 `null` 变成 `0`（`Number(null) === 0`），对可空耗时列是错的
    ——落 0 之后统计无法区分「从未测到」与「真的零耗时」。既有列沿用 `toInt` 不动（改它会连带影响
    token 各列，那里 null/0 另有含义）。
  - 汇总侧覆盖率不足（部分记录缺字段）整体给 `null`，**绝不用 0 填缺失**——那会把 P95 洗低，比不给
    数字更糟。
  - **判定门槛仍走 `p95TotalMs`**，准入结论不因新口径改变：否则此前判过的渠道会被重新判一遍。
  - 未做：`firstByteMs` / `firstTokenMs` 仍是最后一次尝试的口径；压测路径 `noRetry` 本就不重试，
    无需此口径。
- **判定阈值有两份，前端与服务端给出互相矛盾的结论（ADM-011，新增 `shared/thresholds.mjs`）** — 同一份
  稳定性数据，准入报告按服务端的 15s / 45s 三档判「有条件通过」，标准评测页的「人话结论」却按前端
  硬编码的 30s 判「初筛通过」。**两边都自称权威，用户无从知道该信哪个。** 根因是阈值有两份、且前端
  那份被抄了两遍：`server/constants.mjs` 的 `15000` / `45000` 被 `admission-policy`、`reporting`、
  `test-runner`、`model-fingerprint` 共 20 多处正确引用，而 `src/operator-guidance.js` 自带 4 处硬编码
  `30000` 加各自的 `0.95` / `0.9` / `["A","B"]`，分散在 `buildStandardNextStepAdvice` 与
  `buildStandardOperatorSummary` 两个函数里——**它们的 if-else 阶梯逐条相同，改一处必须同步改另一处，
  实际上从来没同步过**。
  - 新增 `shared/thresholds.mjs` 作为单一来源。放 `shared/` 而非 `server/` 是硬约束：后端**不得**
    import `src/`（生产镜像不打包 `src/`，0.5.7 升级事故），前端也不该反向依赖 `server/`，前后端共用的
    纯值只有 `shared/` 一个合法住处。`server/constants.mjs` 改为再导出，后端 20 多处既有引用一处未动。
  - 两个前端函数抽出共用的 `classifyStandardOutcome`，只负责措辞、不再各自判定。
  - **顺带修掉一档误导**：p95 超过 45s 时服务端 `evaluateStability` 判 `NOT_PASSED`，而前端旧代码一律
    只降级到「能用，但速度偏慢」——**一条服务端判不通过的渠道，在人话面板上仍显示能用**。现对齐为
    失败，并把 15~45s 之间单列为「有条件」。
  - **刻意保留的口径差异**（已在代码注释写明，别当成新漂移去"修"）：初筛口径**宽于**准入门槛——准入
    要 9 轮冒烟 9/9 全成功，初筛只要 ≥0.95。分工不同：初筛答「值不值得继续花钱测」，准入答「能不能
    开放给业务」。`0.9~0.95` 之间那条「需人工复核」的带同样是刻意的，合并阈值会让它消失。
  - 原有 6 条测试为何没抓到：**它们的 p95 一律取 1000~1200ms，全落在「怎么算都算快」的区间，永远碰不到
    边界**。新增 3 例专打边界，均已变异验证。
- **任务详情落定满 1 小时即 404，不需要重启（任务中心的前置缺陷）** — 任务对象落定 1 小时后被逐出内存
  `Map`（重启则立即消失），而事件日志**既不落 `steps`**，折叠时又只留最后一个事件、**把唯一带 `payload`
  的首个事件丢掉**。于是「点开一个昨天的任务看明细」根本做不到——比原先记录的「重启后丢失」更糟。
  - `task-manager`：终态事件（`completed` / `failed` / `cancelled`）额外落一份 `steps` 快照，仍走
    `publicTaskStep` 轻量摘要（无原始响应体、无 key）。**只在终态落一次**：running 期间每次进度更新都写
    会把事件日志撑爆。
  - `task-manager`：`admission-suite` 的 payload 摘要补 `profileIds` / `modelNames`，供「再测一次」回填。
    **仍不落 key / base URL**，泄漏锁定用例照旧通过。
  - `data-store`：折叠事件时同时留住首尾两端（first 带 payload、latest 带状态），新增 `readTaskDetail`
    单任务回退查询；列表**刻意剥掉 `steps`**（30 任务 × 20 步够把列表响应撑到几百 KB）；事件流停在
    `running` 的僵尸任务显式改判 `interrupted`，否则前端会对着永不推进的「运行中」无限轮询。
  - `server.mjs`：`handleTaskGet` 内存查不到时回退事件流，不再直接 404。
- **两处端点测试端口撞车，`npm test` 间歇性失败** — `scenario-persistence-restart` 与 `auto-test-digest`
  同占 5388、`settings-token-migration` 与 `dev-scenarios-endpoint` 同占 5393（两处注释还写着「避开」它
  自己所在的区间）。`node --test` 并发跑多个文件时后起的 server 子进程 `EADDRINUSE` 起不来，撞车双方
  一起失败；**单跑任一文件都是绿的**，所以一直没被发现。改到 5397 / 5398 并修正注释。
- **`exact` 判分器把 LaTeX 定界符「一边带一边不带」判成答错** — `normalizeAnswer`
  （`server/benchmark-scorers.mjs`）剥引号/括号的字符类含裸 `(` 与 `)`，却不认 `\(` 与 `\)`：
  对 `\(…\)` 只会剥掉结尾的 `)` 留下孤零零一个 `\`，而开头的 `\(` 因 `\` 不在类里被完整保留。
  实测 `\(-((d - 2k)^2) + d\)` 归一化后变成 `\(-((d - 2k)^2) + d\` —— 于是同一个答案的「带定界符」
  与「不带定界符」两种写法被归一成两个不同的串，期望值带、模型输出不带（或反之）时**哪怕写法一字不差
  也判错**。新增 `stripMathDelimiters`，在剥引号/括号**之前**整对剥掉 `\(…\)`／`\[…\]`／`$$…$$`／`$…$`；
  只剥整对（单边残留一律不动，宁可不剥也不制造新的不对称），`$…$` 要求内部无 `$`（避免把「$5 到 $10」
  这类首尾恰好是 `$` 的普通文本当数学式吃掉中间）。该归一化函数为 `exact`/`structured`/`table`/`set`
  四个判分器共用，改动对期望值与模型输出同等施加，故只可能把原本因定界符差异误判的 fail 翻成 pass。
- **HLE 物理 #16：代数等价但形式不同的正确答案被判 0 分** — 期望 `\(-((d - 2k)^2) + d\)`、模型答
  `\(d - (d - 2k)^2\)`，两者只差一次加法交换，`exact` 是字符串归一化匹配、看不见数学等价。方向是
  **假阴性**，而 HLE 的用途正是档位降级判别（声称高档却在硬题崩）——判分器把答对的判成答错，等于凭空
  制造「崩」的证据、污染判别信号。该题 `expected` 改为「可接受形式」数组（镜像原答案保留首位），覆盖
  LaTeX 定界符有无、`^2` 与 `^{2}` 两种指数写法、`(d-2k)` 与 `(2k-d)` 两种等价平方底数。
  `server/scenarios/hle.mjs` 标注「自动生成勿手改」且脚本恒生成字符串（`String(row.answer).trim()`），
  直接手改会被下一次 `--offset` 换批静默抹掉，故在 `scripts/hle-import.mjs` 内建 `ANSWER_ALIASES`
  覆盖表，键用 HLE 源 id（`row.id`，不随 `--offset`/`--count` 变动，比含跨类别序号的场景 id 稳定），
  重新生成的产物与手改结果经逐字节比对一致。放宽 `tests/scenarios.test.mjs` 对 HLE `expected` 的
  类型断言为「非空字符串 或 全非空字符串的数组」（保留原非空校验强度）。

### 已知限制（刻意未做）
- 上述 HLE #16 的可接受形式是**人工枚举，不是等价性判定，枚举不完**：把平方展开成
  `-d^2 + 4dk - 4k^2 + d` 之类的写法仍会判错。治本方案是数值抽样等价判定（解析成表达式 → 自由变量
  代入多组随机值 → 全部相等才算等价），需自写小解析器（LaTeX 剥壳、`^`→幂、隐式乘法 `2k`→`2*k`，
  **不能用 `eval`**，模型输出是不可信输入）。本次刻意未做：当前受影响的仅此一题（HLE 15 题里 14 题
  是单字母单选），先修方向为假阴性的定界符 bug、用枚举兜住已知个例；若数学类短答题占比上升再实施。

## [0.7.5] - 2026-08-04

### Fixed
- **发布版本信息统一** — 应用版本、Docker Compose 默认镜像与 README 构建示例统一为 `0.7.5`，
  避免健康检查和测试报告显示旧版本，或按 Compose 部署时误用旧镜像。

## [0.7.4] - 2026-08-04

### Fixed
- **一键标准准入没有服务端幂等，创建请求丢响应时重试会双花（ADM-015 的一部分）** — `POST /api/tasks`
  可能已经到达后端、任务建好并开始**真实计费**，而响应在回程丢了（网络抖动 / 代理 502 / 后端重启瞬间）。
  前端只能报「失败」，用户再点一次 → 第二个任务照跑一遍，钱花两遍。轮询路径早有抗抖动
  （`MAX_CONSECUTIVE_POLL_ERRORS`），**创建路径一直是裸的**。现在前端对「同一次提交」沿用同一个
  `idempotencyKey`（`src/standard-eval-controller.js` 的 `nextSubmitNonce`，创建成功即作废、表单一改
  就换新），服务端据此返回原任务。顺带修掉去重闸门里的 `type !== "scenario"`：该机制此前只有
  「模型比对·补齐单方场景」能用，准入任务哪怕显式带了键也被原样忽略；键改为按 type 分桶，
  跨类型不会误合并。
  **刻意不覆盖**（已在两处代码注释写明取舍）：刷新页面后重新提交、多标签页各自提交、任务跑完后再点、
  多后端副本——这几种仍会建新任务。要全堵上得把幂等键落库并加 `UNIQUE(owner_user_id, idempotency_key)`，
  属于另一档改动。
- **取消准入任务不中断用例循环（真实渠道验收发现）** — `runAdmissionTest` 的用例循环是唯一没在每轮开头
  `assertTaskNotCancelled` 的 runner（此前它是同步端点、根本没有取消按钮，异步化才让这个潜伏问题可达）。
  点「取消」只 abort 掉在飞的那一个请求，循环照样往下走：剩余用例的 `fetch` 因 signal 已 abort 而瞬间
  reject，几秒内刷完全部用例。实测 standard 档 Claude 模型（27 条用例）取消后 **2 秒内多写了 24 行**
  `status=0` 的垃圾请求记录，任务最终还显示"27/27 99%"却标着"已取消"。修复后同样操作只多 1 行，进度
  正确冻结在 4/27。**未产生额外计费**（这些记录 status=0、0 token，请求并未真正发出），影响是数据污染
  与进度误导。已加计数式 mock 上游的回归测试锁死"取消后不再发请求"。
- **被取消的请求把耗时记成超时配置值** — `upstream-transport.mjs` 的 catch 分支用
  `r.totalMs ?? timeoutMs` 兜底。真超时场景两者本来就≈相等，但**用户取消是提前中断的**，一条实际
  1~2 秒的记录会被写成 `total_ms = 300000` 落进 `test_requests`，而趋势图与回归判定的延迟序列正是按
  `total_ms IS NOT NULL` 取点（`server/db.mjs`），一条假的 5 分钟足以把 P95 拉飞。改为记真实耗时
  （计时起点提到 try 外）；真超时的取值不受影响。
- **准入报告只有一个成功率口径（真实渠道验收发现）** — 稳定性/压测路径一直是双口径
  （`server/summaries.mjs` 的 `firstAttemptSuccessRate` / `recoveredCount`），但单 API 准入的
  `buildAdmissionSummary` 只把 `attempts` 用于计费求和，从不算首次成功率。结果是**一个靠重试才
  成功的渠道，在准入报告里和一次就成的长得一模一样**——而准入决策关心的恰恰是这个差。现补齐
  `firstAttemptSuccessCount` / `firstAttemptSuccessRate` / `recoveredCount`，报告新增
  「首次成功率（不含重试救回）」一行。记录缺 `attempts` 时给 `null` 并标注「未能统计」，
  **不默认按首次即成功计**——那会把不稳定渠道洗成干净的。
- **准入判定假通过（新增 `server/admission-policy.mjs`，口径版本 `admission-policy-v1`）** — 判定逻辑从
  `test-runner.mjs` 抽出为纯函数模块（无 fetch / fs / Date.now），可离线对固定反例做确定性断言：
  - **空数组赠分**：quick 包不含编程题时，`[].every()` 返回 `true`，白送 10 分。现改为三态
    `passed / failed / not_applicable`，不适用维度直接退出权重池。
  - **综合分覆盖硬门槛**：工具调用完全不可用但综合分 ≥80 的渠道曾被判为可交付。新增 `verdict`
    字段（`grade` 语义不变，历史可比性不受影响）：`json_structure` / `tool_call` / `stream_structure`
    任一失败即 `not_passed`，综合分不得翻案。
  - **严重错误取值受用例顺序影响**：`Object.keys(errorCounts).find(...)` 的键序等于错误首次出现顺序，
    同时出现 `auth_failed` 和 `upstream_5xx` 时定级会随执行顺序漂移。改为显式优先级表。
  - **验证器只查字段存在**：`{"channelReady":"false","modelType":123,"risk":"critical"}` 曾能通过结构化
    输出硬门槛；工具名正确但 `arguments` 为 `{}` 曾算通过。现按题面校验类型与取值，并拒绝 Markdown 包裹。
  - **启发式判分参与准入**：编程 / 行为解释 / 长上下文三题靠"关键词 + 长度"判分，现降为观察项
    （照常执行与展示，不进综合分和硬门槛）；指纹与档位探针同样按 `admission.probe` 排除，避免与
    `purityAssessment` 重复扣分。
  - **多模型只看第一个模型**：新增 `aggregateSuite`（`rejected > indeterminate > accepted_with_conditions
    > accepted`），已由下方 `admission-suite` 复合任务接线到前端。

### Changed
- **单 API 准入评测改为后台异步任务（新增 `admission` 任务类型）** — 高级测试栏的「准入测试」是最后一条
  还走同步 `/api/tests/admission` 的长任务：standard 档 11~12 条用例串行、每条最长 300s，一个 HTTP 请求
  能挂十几分钟。线上反代（nginx 默认 `proxy_read_timeout` 60s）会先掐断连接，前端只看到"准入评测失败：
  工具暂时连接不上本地服务。请关闭本工具后重新打开一次。"，而后端仍在跑、额度照扣——用户照提示重开
  再点一次就是双花。改造后与其它测试同构：
  - 前端换用 `createTaskFormController` 创建任务并轮询（900ms 一次、容忍 5 次连续轮询错误），表单下方
    新增进度面板与「取消当前任务」按钮；**刷新或关掉页面再回来仍能取到结果**。
  - 纳入全局并发闸 `EVALUATOR_MAX_CONCURRENT_TASKS`，满槽时排队而不是直接压满宿主与目标渠道。
  - `runAdmissionTest` 在用例循环里上报进度（`准入评测进行中：N/M 项用例`）。建任务时的单元数只是
    **下限估算**——真实条数还取决于模型家族指纹探针与 Claude 档位探针，那些在建任务时尚未解析出来，
    由 runner 跑起来后上报修正（刻意估低不估高：估高了进度条会卡在中途永远走不满）。
  - 桌面端自动打开报告的行为不变：`summarizeTaskResult` 的 `admission` 分支同时返回
    `reportHtmlPath` 与 `aiAnalysisHtmlPath`，与原同步端点的两次 `openReportInBrowser` 一一对应。
  - 同步端点 `/api/tests/admission` 暂予保留（已无前端调用方），避免影响可能直接调用 HTTP 接口的脚本。

- **修复：复合任务的进度被内层 runner 覆盖（新增 `nestedTaskContext`）** — `admission-suite` 把外层
  `taskContext` 原样递给被嵌套调用的 runner，而它们按**自己的**单元空间上报（稳定性说"3/9 轮"、准入说
  "5/12 用例"）；`updateTaskProgress` 对 `completedUnits` 与 `totalUnits` 都取 `Math.max`，于是 6 个步骤的
  套件跑完显示 9/9、99%，进度条与「模型 × 步骤」网格当场互相矛盾（已复现）。现在嵌套步骤拿到的是
  只借用取消信号、不许写计数器的子上下文：计数器由外层编排器独占，`message` 照常透出（长步骤里
  "稳定性测试进行中：3/9 轮"对用户有用），取消与 abort 不受影响（`task` 仍是同一个对象引用）。

- **标准评测改回后台异步任务（新增 `server/admission-suite.mjs` + `admission-suite` 任务类型）** —
  v0.7.3 曾把「快速测试 → 稳定性 → 标准准入」改成前端顺序 `await` 三个同步接口，带来三个问题：
  - **关页面 / 刷新 / 断线 = 结果全丢**，但请求已经发出、额度已经扣了；
  - **绕过全局并发闸**——`EVALUATOR_MAX_CONCURRENT_TASKS` 只管 `/api/tasks` 那条路，同步端点不占槽、
    不排队，多人同时点会直接压满宿主与目标渠道；
  - **9 轮稳定性 + 11~12 次准入塞在一个 HTTP 请求里**，中间任何代理超时都会让前端报失败而后端仍在跑、
    仍在计费，诱发用户重跑 = 双花（异步路径的 5 次轮询容错正是为此写的，同步路径享受不到）。

  现在前端只提交"测哪些模型"，执行顺序、跳过策略与达标判定全部由服务端决定：
  - 步骤计划归服务端所有（`server/admission-suite-plan.mjs`），前端按轮询到的 `task.steps` 重绘
    「模型 × 步骤」网格；刷新页面、换台机器打开，看到的进度一致。
  - **`executionStatus`（跑没跑完）与 `verdict`（达没达标）拆成两个正交字段**：前者
    `pending/running/completed/failed/skipped/cancelled`，后者复用 `admission-policy` 的四态裁决。
    "跑完了但没通过"不再画成绿勾；"平台自己出错"（`failed + indeterminate`）也不再和"渠道不达标"
    （`completed + not_passed`）混成同一种失败，避免误导用户去改一个本来没问题的配置。
  - **硬门槛未通过即停止后续请求**，剩余步骤标 `skipped` 并写明跳过原因（PRD 12.1）；单个模型失败
    不阻断其它模型继续测；Claude 新档位探测为非阻断观察项，失败不改主结论。
  - **整体结论接上 `aggregateSuite`**：不再用"第一个模型的结论"冒充整体结论——2 个模型只要第一个过
    就整体显示通过的问题（ADM-006）到此闭环。

- **稳定性新增首次成功率双口径** — `buildStabilitySummary` 从 `record.attempts` 派生
  `firstAttemptSuccessRate` / `recoveredCount`：`successRate` 是重试后的最终成功率，新字段描述"没有
  重试兜底时"的表现。记录缺 `attempts` 时返回 `null` 而非按首次成功计，报告中如实标注未能统计。

### 注意
- 上述计分修正会让 **quick 测试包的综合分较旧版本下降约 10 分**（此前的分数含空数组赠分）。历史报告
  按原口径解释、不重算（PRD §7.1），因此**新旧分数不可直接比较**；跨版本对比请以 `policyVersion` 区分。

## [0.7.3] - 2026-07-31

### Fixed
- **发布版本一致性** — 同步 `package.json`、运行时健康检查、Compose 默认镜像名和 README 部署示例到
  `0.7.3`，避免 Git tag、容器镜像和 `/api/health` 报告的版本不一致。

## [0.7.2] - 2026-07-31

### Added
- **稳定性测试分组与缓存命中率** — 同一次稳定性测试可组合多组文案、分别设置重复次数；报告同时给出
  总体与分组维度的缓存命中率，无缓存信号时明确显示为未提供而非误报为 0%。
- **模型比对补齐与内联对照** — 对比页可展示关键指标和逐场景对照，并可为仅单方已测的场景创建补齐任务；
  高级设置、费用预估、幂等和取消行为与场景测试口径一致。

### Fixed
- **模型比对综合评分的无效数据污染** — 压测点的 QPS 或成功率解析失败时不再被当作测得的零容量；任一
  维度出现 `NaN` 时不再污染综合分和权重。

## [0.7.1] - 2026-07-30

### Security
- **运行镜像升级并最小化** — Node 从 24.11.0 升级到 24.18.0，基础系统切换为仍在支持期内的
  Alpine 3.24，并固定官方多架构镜像 digest；pnpm 升级到 11.18.0 且只存在于构建阶段。运行镜像
  直接复制经 frozen lockfile 安装、裁剪后的生产依赖，移除 npm/Corepack/Yarn，改用非 root
  `node` 用户。最终运行镜像的 OS 与 Node 生产依赖经 Trivy High/Critical 扫描均为 0；Docker
  发布工作流新增最终运行镜像扫描闸，Trivy Action 固定到不可变提交，扫描不通过不会登录或推送镜像。
- **旧数据卷权限安全迁移** — 旧镜像以 root 写入 `/data`，直接切换非 root 会让 SQLite 变为只读。
  Compose 新增无网络、不挂 Docker Socket 的一次性 `data-permissions` 服务，只修正
  `evaluator-data` 卷为 UID/GID 1000，成功后主服务才启动，避免静默降级或数据无法落盘。
- **autoheal 更新并收窄运行权限** — 从存在已知漏洞的 `1.2.0` 更新到已扫描的不可变 digest，
  禁用网络、只读根文件系统、禁止提权并移除全部 Linux capabilities；仍只认领
  `autoheal=true` 的 API-evaluator 容器。

## [0.7.0] - 2026-07-30

### Fixed
- **模型比对压测维度：一方从未压测被误判为满值劣势** — `loadGoodputEffect`（`server/report-compare.mjs`）
  曾把「从未做压测」（`loadPoints` 为空）与「压测过但最低负载点即不健康」都记成 goodput=0，
  导致压根没跑过压测的一方在综合评分里被判定为 -1 满值劣势——这是把"没数据"冒充成了"测量到 0% 成功率"。
  现改为：仅一方有压测数据时，数据不对等，load 维度不参与综合评分合成（`effect: null`，权重归一化到
  可用性 + 质量维度），双方都测过时逻辑不变。补齐回归测试（`tests/report-compare.test.mjs`）。

## [0.6.10] - 2026-07-28

### Security
- **升级 Nodemailer 至 9.0.3** — 修复旧版邮件依赖已披露的 `raw` 内容访问绕过及地址解析拒绝服务风险；
  邮件报警与 SMTP 测试流程保持不变。
- **CI 增加生产依赖安全闸** — CI 与镜像构建测试阶段均执行
  `pnpm audit --prod --audit-level=high`，阻止带 high/critical 生产依赖漏洞的提交或发布标签产出镜像。

### Fixed / Hardened（上线前就绪检查）
- **健康检查的「调度器活性」判定是死配置** — `deploy/docker-compose.evaluator.yml` 的健康检查断言
  `!(j.autoTest && j.autoTest.stale)` 以感知「进程活着但定时器僵死」，但 7月7日 `80624fc` 把调度器的
  活性心跳（`lastTickAt`/`stale`/`getStatus`）连同其测试一起**静默删除**，`/api/health` 此后不再返回
  `autoTest` 字段 → 表达式恒真、健康检查退化成纯 HTTP ping，autoheal 对「自动测试停摆」永不触发。
  复原心跳：`getStatus()` 回归调度器、`/api/health` 重新暴露 `autoTest`（compose 无需改动即恢复生效），
  并补回被删的 stale 判定回归测试（`server/auto-test-scheduler.mjs`、`server.mjs`、
  `tests/auto-test-scheduler.test.mjs`）。
- **容器无 SIGTERM 处理 + node 以 PID 1 运行 → 每次 `docker stop` 白等 10s 再被 SIGKILL** —
  `CMD` 是 exec 形式、无 init/tini，内核不对 PID 1 上无处理器的信号执行默认终止动作。新增
  `SIGTERM`/`SIGINT` 处理器：停调度器 → `server.close()` → `closeDatabase()` 干净收尾，带 8s 兜底
  超时防卡死（`server.mjs`）。关键细节：`server.close()` 只等在途请求，反向代理握着的【空闲 keep-alive】
  长连接会让回调永不触发、被兜底超时拖住，故补 `closeIdleConnections()`（立即断空闲连接）+ 5s 宽限后
  `closeAllConnections()`（放剩余连接），在途请求先排空、空闲连接即时断。已用 `process.emit("SIGTERM")`
  驱动真实处理器 + 持有 keep-alive 连接验证：真实处理器 5ms 内走完优雅收尾退出。注：OS 信号投递本身
  （docker SIGTERM → 处理器）在 Windows Git Bash 下不投递，只能在 Linux/Docker 目标上验证；处理器体逻辑
  已在本机真实驱动过。
- **new-api 导入出站无超时 → 上游挂起会无限期吊住导入请求** — `newapi-source.mjs` 的分页 `fetch`
  是全站唯一没带 `AbortSignal` 的出站点（undici 无默认响应超时），new-api 主机挂起会逐页累加吊死。
  补每页超时（默认 15s，`EVALUATOR_NEWAPI_IMPORT_TIMEOUT_MS` 可覆盖），与 test-runner / client-replay
  的守卫 + redirect + 超时三项对齐（`server/newapi-source.mjs` + 回归测试）。
- **全局兜底：`unhandledRejection` / `uncaughtException`** — 此前未注册，任何逃逸的拒绝在 Node 默认
  语义下静默杀进程、连日志都没有。新增兜底处理器：先落一条可诊断日志再按默认语义处理（rejection
  仅告警保活、uncaughtException 记录后退出），把「静默猝死」变「可诊断」（`server.mjs`）。
- **修正三处会误导排查的失效 / 虚假注释** —
  (1) `egress-guard.mjs` 的 P1-2 安全决策记录称「newapi-source 的导入 fetch 没走本守卫」，该论据自
  P2-1 起已失效（现已走守卫），改写为不依赖失效事实的表述；
  (2) `channel-store.mjs` / `model-target-store.mjs` 的「SQLite + JSON 兜底」易被读成实时镜像——实为
  仅在 SQLite 不可用时的降级路径，DB 损坏时读到的是旧 JSON、非恢复来源，注释据实澄清；
  (3) `utils.mjs` 的原子写注释声称抗「断电」，实际不 fsync、只抗进程崩溃，据实收窄承诺。

### Fixed（评测正确性）
- **流式「半截流 / 中途 error 帧」被判成功（P2-2）** — 场景/压测的流式路成功判定只看「2xx + 拼得出
  文本」，而 `coalesceSseResponse` 会把「吐一半就断」或「中途 `{"error":...}` 帧」的流照样拼出文本
  → 成功率系统性高估、半截答案还进 LLM 裁判打分。改为流式路复用准入路已有的
  `summarizeStreamStructure`，并新增 `streamCompletenessError`：仅在**确定的**不完整信号
  （无 `[DONE]`/`message_stop` 终止帧、`content_block` 损坏、error 帧）上判失败，刻意不采纳
  `invalid_json_chunk` 等软信号以免误杀健康怪癖中转。`finish_reason=length` 这类正常截断不受影响
  （`server/test-runner.mjs`；接线经 `tests/probe-requests.test.mjs` 端到端验证）。
- **2MB 响应上限没随流式放大 → 长流式被误判失败（P2-3）** — SSE 每 token 独立成帧、体积是纯文本的
  50–100 倍，长输出流式轻松 5–7MB，会在 2MB 处被截断误判 `response_too_large` → 判 F（好渠道判成
  坏渠道）。流式单独用放大上限（默认 24MB，`EVALUATOR_MAX_STREAM_RESPONSE_BYTES` 可覆盖），非流式
  仍 2MB（`server/test-runner.mjs`）。
- **趋势数据超 4000 行时砍掉的是「最新」轮次（P2-5）** — `queryRoundSeriesByRunIds` 用
  `ORDER BY id ASC LIMIT`，历史轮数 >4000 时被砍的恰是最新轮，而回归判定以最新点为准 → 静默漂移。
  改为 `ORDER BY id DESC LIMIT` 取最新再 `.reverse()` 回升序（`server/db.mjs`）。

### Fixed / Hardened（安全）
- **new-api 导入的出站漏在守卫之外、且跟随重定向（P2-1）** — `fetchViaApi` 的 `fetch` 未过
  `assertPublicTarget`、未设 `redirect:"error"`，是全站第三个出站点。base 填内网/元数据、或上游 302
  到内网都会打过去。补上守卫（host 跨页不变，校验一次）+ `redirect:"error"`，与另两个出站点对齐
  （`server/newapi-source.mjs`）。
- **`EVALUATOR_SESSION_SECRET` 无强度校验（P3-2）** — 会话 Cookie 用 HMAC-SHA256(secret) 自签，密钥
  太短可被离线爆破后伪造超管会话。新增 `assertSessionSecretStrength`（≥32 字节，README 的
  `openssl rand -hex 32`=64 字符远超门槛），由 server.mjs 在 listen 前调用，弱密钥变「启动即拒」而非
  「线上默默可被伪造」（`server/auth.mjs` + `server.mjs`）。
- **`/api/client-errors` 匿名可写、无限流（P3-8）** — 免登录白名单端点，任何人可无限灌错误日志。
  新增极简固定窗口限流 `server/rate-limit.mjs`，按客户端 IP 限流（默认 60/分钟，
  `EVALUATOR_CLIENT_ERROR_RATE_MAX` 可覆盖），超限返回 429。

### Security decisions
- **DNS rebinding（原审查 P1-2）定为「已知接受的缺口」，不在代码里修** — 出站守卫校验 DNS 解析
  结果但不 pin 已验证 IP，fetch 会独立再解析一次，存在 TOCTOU 窗口。评估后不修，理由：
  (1) 成本——Node 不公开导出 undici，保留 `fetch` 又要传自定义 `lookup` 就必须新增 undici 依赖；
  不加依赖则须把三个出站点改写成 `node:https.request` 并重新实现流式读取/中止/重定向语义，
  而这是本产品的核心链路；(2) 收益端封堵（摘 IAM 角色 / 强制 IMDSv2 / 网络层封 169.254.169.254）
  比 pin IP 更硬——它同时覆盖没走守卫的出站点（如 `newapi-source` 的导入 fetch，即 P2-1），
  且不依赖「守卫代码写得对」，而本次正好发现该守卫的 IPv6 判定已死了两个版本；
  (3) 触发链需攻击者自建 rebinding DNS + 社工超管，而现实误用（超管填错内网地址）守卫已能挡住。
  **此决策的前提是补偿控制真的落地**，故新增 `pnpm check:egress`
  （`scripts/check-egress-mitigation.mjs`）在评测机本机核实元数据端点是否已封堵，未封堵则退出码 1。
  完整决策记录（含「什么时候必须回来修」）写在 `server/egress-guard.mjs` 的 `assertPublicTarget` 上方。
- **删除 `egress-guard.mjs` 顶部「防 DNS rebinding（校验实连 IP）」的错误注释** — 该模块既不校验
  实连 IP 也不防 rebinding，文件内的函数注释其实自认了这点，两处自相矛盾。这类注释比缺口本身更
  危险：它让读代码的人以为已处理，从而不去看。

### Fixed / Hardened
- **出站守卫的 IPv6 内网判定此前完全失效（P1-1，安全）** — `isPrivateV6` 用正则
  `/::ffff:(\d+\.\d+\.\d+\.\d+)$/` 认 IPv4-mapped，要求点分十进制书写；但 WHATWG `URL` 会先把
  `[::ffff:127.0.0.1]` 归一化成十六进制 `[::ffff:7f00:1]` 再交给守卫，正则**永不命中**——
  这段判定自 0.5.3 起是死代码。实测 `http://[::ffff:a9fe:a9fe]/`（=169.254.169.254 云元数据）
  与 `http://[::ffff:7f00:1]/`（=127.0.0.1）可直接过守卫，而评测机带 IAM 角色、响应体还会进报告。
  改为把 IPv6 解析成 16 字节按位段判定：IPv4-mapped 还原内嵌 v4 走 v4 规则，并补上 `::/96`、
  NAT64 `64:ff9b::/96`、`fe80::/10`（旧的 "fe80" 前缀只覆盖 `fe80::/16`）、`ff00::/8`、
  2002::/16 6to4 内嵌 v4；解析失败一律 fail-closed（`server/egress-guard.mjs`）。
  注：老用例 `isPrivateOrReservedIp("::ffff:10.0.0.1")` 测的是点分写法、直接调用，绕过了 URL
  归一化，所以一直是绿的——新回归用例改测归一化后的真实形态。
- **畸形 Cookie 触发 500，匿名可刷（P2-6）** — `parseCookies` 对每个值做 `decodeURIComponent`，
  遇非法转义（`%zz`、裸 `%`）抛 `URIError`；该函数在鉴权前对每个请求都跑，任何人带一个坏
  cookie 即可让请求 500 并写一条错误日志。改为逐值 try/catch，解不开按原文保留（会话 cookie
  是签名令牌，原文自然验签失败 → 正常 401）（`server/auth.mjs`）。
- **自动测试调度器盘写失败会杀掉整个进程（P2-4）** — `fireJob` 有两处状态回写不在既有 catch
  覆盖内（占位 `lastStatus="running"`、失败分支的回写）；`updateJobs` 落盘失败（盘满 / EACCES）
  时异常会冒到三个「拒绝无人接管」的调用点 —— `tick` 的 `Promise.all`、`start` 的
  `void reconcileThenTick()`、以及 **`runJobNow` 的 `void fireJob(job)`（HTTP「立即运行」端点，
  原审查未列出）** —— 成为 unhandledRejection，Node 默认直接杀进程：一次盘写失败打死整个评测
  平台。改为在 `fireJob` 外层兜底（一处覆盖三个调用点），错误照常上报，内存占位照常解除以便下轮
  重试；盘上残留的 `running` 由启动时的 `reconcileInterruptedJobs` 归位
  （`server/auto-test-scheduler.mjs`）。

### Changed
- **API 路由表（route table）** — `handleApi` 的 62 条 `if (method && pathname)` 顺序匹配（约 1100 行）
  换成文件顶部一张声明式路由表 + 5 行分发，`handleApi` 缩到 35 行。65 条接口现在有唯一清单，
  handler 拆成命名函数（签名 `(req, res, { url, params })`），不依赖 `handleApi` 闭包。零新增依赖，
  未引入 Express 等框架：本服务替用户保管中转站 API key，不宜在请求路径上增加供应链面，
  而鉴权（`api-access.mjs`）与业务逻辑（`server/*.mjs`）本就已抽离，剩下的只是薄分发
  (`server/router.mjs`)。鉴权位置不变，仍在分发之前，门禁判定与路由表无耦合。
  `createRouter` 在建表时做重复规则与顺序体检（被前面的宽规则完全遮蔽的后置规则永不命中，
  是原 if 链最难查的坑：不报错、只是安静走错分支），排错直接启动失败。
- **畸形路径由「静默成功」收紧为 404**（上条的行为变化，仅影响手工构造的请求）——
  原 `startsWith` 匹配会把多段 / 空 id 也吞进 handler，例如 `DELETE /api/profiles/export/`、
  `DELETE /api/auto-test-jobs/a/b` 旧版返回 `200 {"ok":true}`（对一个根本不存在的资源报告删除成功），
  `PUT /api/dev/scenarios/` 返回 400、`POST /api/auto-test-jobs//run` 返回 409。新版路由表要求
  `:id` 为单个非空段，这些一律 404。前端不受影响：`src/` 内 13 处 URL 拼接全部经
  `encodeURIComponent`，id 里的 `/` 编码为 `%2F`，始终是单段（`%2F` 解码后与旧写法等价）。
  另：`:id` 含非法百分号编码（如 `%ZZ`）时旧版 `decodeURIComponent` 抛错被兜成 500，现为 404。

### Added
- **自动测试配置（Auto-test scheduler）** — new page under 高级测试 to configure
  recurring tests for a channel's model: pick model + test kind (快速/准入/稳定性/场景) + period
  (hours); a new in-process scheduler runs each job on its cadence and produces a report. Config
  persisted to `配置/auto-test-jobs.json`; CRUD via `/api/auto-test-jobs` — login-required and
  usable by ordinary admins (role 10), same tier as running tests manually (not `/api/dev/*`)
  (`server/auto-test-store.mjs`, `server/auto-test-scheduler.mjs`). Scheduler is in-process:
  effective only while the server runs, catches up overdue jobs on restart via persisted
  `nextRunAt`, does not resume a run interrupted mid-flight. Hardened: all job-file writes go
  through a serialized `updateJobs` (no read-modify-write races between scheduler and CRUD
  endpoints), and concurrent runs are capped by a semaphore (`EVALUATOR_AUTO_TEST_CONCURRENCY`,
  default 2) so simultaneously-due jobs can't burst the upstream API.

### Fixed / Hardened
- **Atomic JSON writes** — settings, channels, model-targets, profiles, scenario-overrides and the
  encrypted key-vault now write via a shared `writeJsonAtomic` (temp file + rename), so a crash
  mid-write can no longer truncate a config into silent data loss (key-vault corruption would have
  made all channel keys unreadable).
- **`ensureDataDir` startup guard** — a read-only/permission-denied/full `/data` volume now exits
  with an actionable operator message instead of an uncaught stack in a restart loop.
- **SQLite history retention** — `test_requests`/`test_runs`/`regression_alerts`/`model_fingerprints`
  now get the same retention (days + max-rows) as reports, so `evaluator.db` no longer grows
  unbounded (`pruneHistory`, env `EVALUATOR_HISTORY_RETENTION_DAYS`).
- **Scenario group rename no longer pins built-in scenarios** — renaming a group now records a
  field-level group patch for built-in题 instead of freezing the whole scenario into the override
  layer, so future image updates to those scenarios' prompt/scorer are no longer silently masked.

## [0.4.9] - 2026-07-02

### Fixed
- **CI Docker build failed since 0.4.5** — the frontend imports `src/docs/*.md` via Vite's
  `?raw`, but the `.gitignore` rule `docs/` also matched `src/docs/`, so those Markdown files
  were never committed. Local builds passed (files on disk); the CI build (fresh checkout) had
  no such files and `vite build` exited 1. Anchored the ignore to `/docs/` and committed
  `src/docs/category-field.md` and `src/docs/scorer-mechanism.md`.

## [0.4.8] - 2026-07-02

### Changed
- Maintenance re-release of 0.4.6 to publish a versioned container image. The earlier
  `v0.4.7` tag did not trigger CI (pushed as a lightweight tag inside a multi-tag batch,
  which GitHub suppresses); this release re-triggers the image build via a single
  annotated `v0.4.8` tag. No functional changes beyond 0.4.6.

## [0.4.6] - 2026-07-02

### Removed
- **new-api write operations** — removed pushing channels/models to new-api and delete-sync
  (including the `enableDeleteSync` setting and its UI). The only external write features were
  these; new-api integration is now read-only (import + sync-models). Deleted
  `server/newapi-channel-sync.mjs` and its live script/tests; delete of a channel/model is now
  local-only.

## [0.4.3] - 2026-06-29

### Added
- **Push channels & models to new-api** — sync configured channels and their test models
  back to a new-api gateway, with a live channel-sync endpoint and tests
  (`server/newapi-channel-sync.mjs`, import scripts under `scripts/`).
- **New scenario packs** — hardcore-logic and HLE (harder objective probes) added alongside
  the existing livebench pack (`server/scenarios/hardcore-logic.mjs`, `server/scenarios/hle.mjs`).

### Changed
- Benchmark scorers, scenario evaluator, new-api import/source handling, and the
  confirm-dialog refined; accompanying test updates.

## [0.4.2] - 2026-06-24

### Added
- **In-app report popup** — when a long task (stability / scenario / batch) finishes, the
  report now opens automatically in an in-app overlay (iframe), so it works on headless
  Docker / remote deployments where the desktop browser auto-open (`EVALUATOR_OPEN_REPORT`)
  cannot. Toolbar link to open in a new tab; a client toggle (default on) disables it.
- New auth-gated route `GET /api/reports/:id/view` serves a report's HTML over HTTP
  (filename sanitized via `sanitizeReportBaseName`; `nosniff` + script-free CSP). Public
  task results now carry `reportId` / `aiAnalysisId` for the frontend to build the URL.

## [0.4.1] - 2026-06-24

### Added
- **Push model tags to new-api** — aggregate the capability tags granted to model
  targets and write them back to the new-api model marketplace (read-modify-write the
  `tags` field). New endpoint `POST /api/model-targets/push-tags`
  (`server/newapi-tag-writer.mjs`) and a "推送标签到 new-api" button on the model page.
- **LiveBench-style anti-contamination probe pack** for scenario tests (objective
  capability probes resistant to benchmark leakage).
- **Claude tokenizer fingerprint** baseline tool (probe + `count_tokens` / chat dual
  mode); admission tests now cross-check the tokenizer fingerprint.
- **Two-dimension batch target picker** (channel health-check / channel selection) and
  a cascading channel→model picker for single-target run pages.
- Report-center conclusion cards reworked; reports gained a "model return" column; AI
  analysis split into its own HTML; AI summary can read an API from the environment.

### Fixed
- `styles.css`: resolve the undefined `--border` custom property (use `--line`).
- Channel / model-target / profile validation failures now return HTTP 400 with a
  user-facing message instead of being swallowed as a 500.

### Changed
- Removed internal codenames from code comments and report output (neutral wording).
- Single source of truth for runnable test targets (`resolveRunnableTargets`), shared
  by the dashboard count, the run selectors and the workflow guide.
- Unified the protocol-label helper; the new-api `api` import now warns when it hits
  the pagination cap (possible truncation).
- In-app manual and per-page help updated for the channel / model two-layer flow.

### CI
- Tests and image build now also run on the `dev` branch and publish a `:dev` test image.

## [0.3.1] - 2026-06-10

### Added
- Per-channel "sync models" — re-pull a single new-api channel's model list and
  upsert its test models.

### Changed
- Dashboard health card counts runnable test targets (channels + models) so a fresh
  install no longer shows zero.
- Consistent onboarding and flow: nav step numbers, dashboard progress rail, and
  wording aligned to the channel → model → admission → standard flow.

### Fixed
- Readable contrast for secondary / hint text on the dark theme.
- Backend de-duplication of runnable targets after migration (single source of truth).
- Protocol-inference note on import; sanitized A2 (db) import errors (no DSN echo);
  finite-number guards for max tokens / timeout.

## [0.3.0] - 2026-06-10

### Added
- Two-layer configuration: **channels** (super-admin: base URL + key + protocol, holds
  the key) and **test models** (admin: pick a channel + model name, never sees the key).
- One-click import of channels and models from a [new-api](https://github.com/QuantumNous/new-api)
  gateway. Pluggable source: `api` (metadata only, via admin token) or `db` (full incl.
  keys, via a read-only DSN; `mysql2` is an optional, lazy-loaded dependency).
- One-time migration of existing profiles into channels + test models on startup
  (idempotent; reuses ids so the encrypted key survives).

### Changed
- Two-section UI (channels / models) with role-based visibility; the legacy single
  API-config page is retired.

## [0.2.0] - 2026-06-10

Initial open-source release.

### Added
- Built-in presets for common models and expanded model-family fingerprinting.

### Security
- Client-log import is restricted to an allow-list of roots (fail-closed,
  `EVALUATOR_LOG_IMPORT_ROOTS`).
- Replay actions are written to an audit record.
- Login throttling trusts `X-Forwarded-For` only when `EVALUATOR_TRUST_PROXY=true`
  (defaults to the socket address otherwise).

### Fixed
- Concurrency-queue slot leak on the task-manager cancel path.

[Unreleased]: https://github.com/yl0711-coder/API-evaluator/compare/v0.7.5...dev
[0.7.5]: https://github.com/yl0711-coder/API-evaluator/compare/v0.7.4...v0.7.5
[0.4.6]: https://github.com/yl0711-coder/API-evaluator/compare/v0.4.3...v0.4.6
[0.3.1]: https://github.com/yl0711-coder/API-evaluator/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/yl0711-coder/API-evaluator/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/yl0711-coder/API-evaluator/releases/tag/v0.2.0
