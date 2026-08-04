# feat/auto-test 分支交接

写给在新窗口接手的 AI。这份只覆盖 `feat/auto-test` 这条分支的工作（准入测试同步→异步改造 + 阶段 5 真实验收）。
项目全局背景请另读 `HANDOFF.md`、`FOR-FUTURE-AI.md`，以及 `C:\Users\A\.claude\projects\D----MACOSX-API-evaluator-main\memory\MEMORY.md` 索引。

最后更新：2026-08-04

---

## 0. 一分钟速览

| 项 | 值 |
|---|---|
| 分支 | `feat/auto-test`（工作目录 `D:\__MACOSX\API-evaluator-auto-test`） |
| 工作区 | 干净 |
| 未推送 | **4 个提交**（`ed65ccf` `f8e957a` `e7b184f` `edb8ed3`），`origin/feat/auto-test` 还停在 `1b3bfa0` |
| 推不上去的原因 | 本地代理 `127.0.0.1:7897` 没在跑，**不是 git 配置问题，别改 git 配置**（见第 5 节） |
| 测试 | `npm test` → **1017 passed / 0 failed** |
| Lint | `npx biome check` 干净（`biome.json:24` 那条 DEPRECATED info 是历史遗留，与本分支无关） |
| 主分支 | `my-improvements`（`587e505`），本分支领先 8 个提交、37 个文件 |

---

## 1. 这条分支在解决什么

用户的原始问题：

> 之前由于准入测试是同步，在线上测试由于时间过长会提示"准入评测失败：工具暂时连接不上本地服务。
> 请关闭本工具后重新打开一次。"，现在还会有此类问题吗？

根因是准入测试走同步 HTTP 端点，跑几十次真实上游调用远超前端/代理的超时。改造方向：**全部改成后台异步任务 + 轮询**，前端不再长时间挂在一个请求上。

配套文档（都在仓库根目录，按顺序读）：
- `01-一键准入任务中心-产品需求文档-PRD.md` —— 目标形态
- `02-v0.7.3-准入测试问题检查说明.md` —— 问题清单（ADM-001 ~ ADM-015）
- `03-v0.7.3-准入测试修复实施方案.md` —— 实施方案
- `04-阶段5-真实验收方案.md` —— 验收方案**和验收结果**（第 5 节是我这轮填的）

---

## 2. 已经干完的事

### 2.1 异步化改造（提交 `a3af2c3` `95e72d5` `1b3bfa0`，本轮之前完成）

- 准入判定逻辑抽成纯函数模块 `server/admission-policy.mjs`（口径版本 `admission-policy-v1`），无 fetch / fs / Date.now，可对固定反例做确定性断言。修了 6 类假通过。
- 标准评测改为后台异步复合任务 `admission-suite`（`server/admission-suite.mjs` + `server/admission-suite-plan.mjs`）。
- 单 API 准入也改成异步任务；修了复合任务进度被内层 runner 覆盖的问题（`nestedTaskContext`）。

### 2.2 阶段 5 真实验收（本轮）

拿用户的真实渠道跑了完整的一键标准评测，结果记在 `04-阶段5-真实验收方案.md` 第 5 节。
链路项 L-1~L-8、专属项 S-1~S-6、口径项 V-1~V-6 基本都过了。

**为了省钱的做法**：故意在同一渠道下加了一个不存在的模型 `claude-sonnet-5-does-not-exist`，
它在第 1 步就失败、几乎不花钱，却能一次性验证"某模型不通 → 后续步骤 skip → 整体结论 rejected"这条链路。
**那个假模型目标验收后已经删掉了**，别再去找。

### 2.3 本轮修掉的 3 个缺陷

| 提交 | 缺陷 | 要点 |
|---|---|---|
| `f8e957a` | 取消准入任务不中断用例循环 | 用例循环是唯一没在每轮开头 `assertTaskNotCancelled` 的 runner。取消只 abort 在飞的那一个请求，循环照跑，剩余用例秒失败。实测 27 条用例取消后 2 秒内多写 24 行 `status=0` 垃圾记录，还显示"27/27 99%"却标着"已取消"。**未产生额外计费**（记录 status=0、0 token，请求没真发出），影响是数据污染与进度误导。 |
| `f8e957a` | 被取消的请求把耗时记成 `timeoutMs` | `upstream-transport.mjs` catch 分支用 `r.totalMs ?? timeoutMs` 兜底。真超时两者≈相等没问题，但**用户取消是提前中断的**，实际 1~2 秒会被写成 `total_ms = 300000`。而趋势图/回归判定的延迟序列正是按 `total_ms IS NOT NULL` 取点（`server/db.mjs:379`），一条假的 5 分钟足以把 P95 拉飞。修法：计时起点 `performance.now()` 提到 `try` 外（原来在 try 内，catch 根本拿不到）。 |
| `e7b184f` | 准入报告只有一个成功率口径 | 稳定性/压测路径一直是双口径（`server/summaries.mjs`），但 `buildAdmissionSummary` 只把 `attempts` 用于计费求和。结果**一个靠重试才成功的渠道，在准入报告里和一次就成的长得一模一样**——而准入决策关心的恰恰是这个差。补了 `firstAttemptSuccessCount` / `firstAttemptSuccessRate` / `recoveredCount`。记录缺 `attempts` 时给 `null` 并标注「未能统计」，**不默认按首次即成功计**——那会把不稳定渠道洗成干净的。 |

### 2.4 幂等 / 双花（提交 `edb8ed3`，本轮最后一件）

**用户明确指定了范围**：只防「网络抖动、前端以为没发出去、用户重试」这一种，其他可能触发的场景在注释里写清即可。

问题：`POST /api/tasks` 可能已经到达后端、任务建好并开始**真实计费**，而响应在回程丢了。
前端只能报失败，用户再点一次 → 第二个任务照跑一遍，钱花两遍。
轮询路径早有抗抖动（`MAX_CONSECUTIVE_POLL_ERRORS = 5`），**创建路径一直是裸的**。

改动两处：
- `src/standard-eval-controller.js`：同一次提交沿用同一个 `idempotencyKey`。判定逻辑抽成纯函数
  `nextSubmitNonce` 导出（这文件没有 DOM 测试底座，跟已有的 `normalizeQuickVerifyResult` 一个路子）。
  生命周期刻意收窄：**创建成功即作废**（`onCreated`）、**表单一改就换新 key**（否则改完模型再提交
  会被当成重试、拿回上一次的旧任务）。
- `server/task-manager.mjs`：去重闸门原来写死 `if (type !== "scenario") return null`，准入任务带了键
  也被原样忽略。改成通用 `taskDedupKey`，键按 type 分桶（`` `${type}::${key}` ``）避免跨类型误合并。

**刻意不覆盖**（已在两处代码注释逐条列明"✗ 不覆盖 + 为什么"）：刷新页面后重新提交、多标签页各自提交、
任务跑完后再点、多后端副本。要全堵上得把幂等键落库 + `UNIQUE(owner_user_id, idempotency_key)`，属另一档改动。

---

## 3. 还没干的事（按优先级）

### P0 —— 推送

4 个提交全在本地。等 `127.0.0.1:7897` 代理起来后 `git push origin feat/auto-test`。
**代理没起时不要动 git 配置**（这是项目长期记忆里的既有结论）。

### P1 —— 需要用户环境才能验的两项

| 项 | 状态 | 缺什么 |
|---|---|---|
| **L-7 桌面壳自动拉起报告** | ⚠️ 只验了 `summarizeTaskResult` 的字段契约 | 本机没有桌面端，得在用户那边真点一次 |
| **V-4 判定分差约 10 分** | ✅ 机制成立，绝对值未验 | 需要一个**旧版本基线**做对照，没做 |

### P2 —— 已知偏离，用户尚未表态是否要补

`04-阶段5-真实验收方案.md` 第 3 节列了三项 PRD 偏离：

1. **任务状态持久化**（❌）—— 内存态 Map + JSONL 事件流，重启后任务丢失，只剩事件日志。
   SQLite `evaluation_tasks` 表未建。当初是用户选的"先做内存态编排"。
2. **幂等**（⚠️ 部分）—— 见 2.4，窄范围已补，剩余敞口（刷新/多标签页/多副本）仍在。
3. **owner/role 权限**（❌）—— 服务端无 owner 概念，任何登录用户可查/可取消任何任务。单机自用工具，多用户模型未落地。

**别自作主张去补 1 和 3**，这两条是当时的取舍不是 bug，要先问用户。

### P3 —— 合并

验收和推送都完成后，把 `feat/auto-test` 合回 `my-improvements`。
按项目长期记忆，日常 git 操作（分支/合并/tag/push）用户已授权给 AI 执行，**但高风险动作仍需先确认**。

---

## 4. 怎么验证你没改坏

```bash
cd D:/__MACOSX/API-evaluator-auto-test
npm test                    # 期望 1017 passed / 0 failed，约 130 秒
npx biome check server/ src/ tests/
npm run build               # dist/ 是 gitignore 的，构建产物不入库
```

跟本分支强相关的测试文件：

- `tests/admission-policy.test.mjs` —— 判定口径（纯函数，最值钱）
- `tests/admission-suite.test.mjs` —— 复合任务编排
- `tests/task-manager.test.mjs` —— 任务调度 + 幂等去重
- `tests/admission-adhoc-target.test.mjs` —— 单 API 准入、双口径成功率
- `tests/upstream-transport-timing.test.mjs` —— 取消记真实耗时
- `tests/standard-eval-controller.test.mjs` —— nonce 生命周期

**本轮所有新测试都做过变异验证**（改坏源码确认测试变红，再还原）。你加新测试时也照做——
本轮就有一条测试第一版是空跑的，靠变异才发现。

### 想跑真实服务端做端到端验证

```bash
API_PORT=39122 \
  EVALUATOR_SESSION_SECRET="$(openssl rand -hex 32)" \
  EVALUATOR_ADMIN_PASSWORD='随便设' \
  node server.mjs
```

- `EVALUATOR_SESSION_SECRET` **至少 32 字节**，短了会被启动守卫拒绝（这个守卫是好的，本轮撞到过一次，它正常工作）。
- 登录端点是 `POST /api/auth/login`（**不是** `/api/login`）。
- 任务列表是 `GET /api/tasks/recent`（**不是** `GET /api/tasks`，那个会 404）。
- 完事记得停进程：PowerShell `Get-NetTCPConnection -LocalPort 39122 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`

---

## 5. 本轮踩的坑（省得你再踩一遍）

1. **`/tmp` 在两个工具里不是同一个目录。** Bash 工具（Git Bash）的 `/tmp` 是
   `C:\Users\A\AppData\Local\Temp`，但用 cwd `D:\...` 启动的 node 进程会把 `/tmp` 解析成 `D:\tmp`。
   curl 写 cookie jar、node 读 cookie jar 就会 `ENOENT`。**这坑我踩了两次**，用项目相对路径（`./xxx`）绕开。

2. **PowerShell 是 5.1。** `&&` 是解析错误，用 `;` 或 `if ($?) { }`。
   另外 Bash 风格的 `taskkill //PID $PID //F` 会被 PowerShell 当成删除系统路径 `//PID` 而拦截。

3. **Git Bash 会折叠传给 `node -e '...'` 的双反斜杠。** `"\\u0000"` 到 JS 手里变成 `"\u0000"`，
   于是"把 NUL 换成转义"的替换等于原地不动、静默无效。要在 shell 里做含反斜杠的替换，
   改用 `String.fromCharCode(92)` 或干脆写成临时脚本文件。

4. **我自己的 Edit 往源码里写进过 2 个裸 NUL 字节**（本想打空格）。
   源码里的不可见控制字符会坑 grep 和 diff。`cat -A` 查出来的（显示为 `^@`），已换成可见的 `::`。
   **教训：Edit 之后如果行为诡异，先 `cat -A` 看有没有不可见字符。**

5. **Edit 的 `old_string` 用注释行的前缀会粘连下一行。** 本轮把两行注释黏成一行造成语法错误。
   `old_string` 要用完整的行。

6. **别把 key / baseUrl 写进任务事件日志。** `summarizeTaskPayload` / `summarizeTaskResult`
   只记形状。有专门的测试锁这个（"records completed tasks without leaking full payloads"），别绕过它。

---

## 6. 几条容易踩错的事实

- 准入任务两种失败语义**完全不同**，别混：
  - runner 抛异常 → `failed` + `indeterminate`（"我们没测成，不等于渠道不行"）
  - 硬门禁不过 → `completed` + `not_passed` + `skipRest(reason)`
- `timeoutMs` 对**真超时**是合理近似，对**用户取消**是伪造数据。代码在 `normalizedError = "timeout"`
  这一层刻意把两者合并（都是"止损不重试"），耗时 bug 就藏在这个合并里。
- 整体结论归服务端 `aggregateSuite` 一处算。前端曾用 `perModelResults.find(...)` 取第一个模型的结论
  冒充整体结论（ADM-006），2 个模型只要第一个过就整体显示通过。**别再在前端算判定。**
- 进度单元用**步骤数**不是请求数，因为前端进度网格按步骤画，两者对齐才不会出现"进度条 60% 但网格只亮 1 格"。

---

## 7. 我在这轮里说错过的话（已更正，但别被旧记录误导）

- 我曾说幂等"最小改动是前端带上 `idempotencyKey`，服务端逻辑已经现成"——**错的**。
  服务端闸门当时写死 `type !== "scenario"`，把非场景类型全挡了，两处都得改。
  更正已写进 `04-阶段5-真实验收方案.md` 第 3 节。
- 我曾说未推送是"2 个提交"——实际是 **4 个**（漏算了 `ed65ccf` 文档提交和后来新增的 `edb8ed3`）。
