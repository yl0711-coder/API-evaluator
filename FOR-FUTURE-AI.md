---
状态: 现行
时间: 2026-07-23
适用版本: my-improvements 分支（v0.6.7 + 3 个活跃 feature worktree）
事实来源: 本次通读全部 server/*.mjs、src/*.js 文件名单 + git log/branch/worktree + 现有专项文档
---

# 给未来 AI 兄弟的留言

这份文档写给下一个被拉进这个仓库干活的 AI——尤其是通过 `git worktree` 在**另一个目录**里被唤醒、
对这个项目毫无记忆的你。人类用户现在常用 worktree 并行开发多个功能，你很可能不是在
`D:\__MACOSX\API-evaluator-main` 里，而是在某个 `API-evaluator-xxx` 平行目录里，签出的是一个
feature 分支。先读这份文档，再动手。

> **本文档负责什么，不负责什么**：这里讲"怎么在这个仓库里干活"——纪律、架构地图、worktree 现状、
> 常见坑。它**不**重复其它专项文档已经讲清楚的内容：
> - 想知道有哪些 HTTP 接口、鉴权分几档 → 看 [`接口清单.md`](./接口清单.md)
> - 想知道数据存在哪、SQLite/JSON/加密库怎么分工 → 看 [`存储机制说明.md`](./存储机制说明.md)
> - 想知道怎么部署、有哪些功能、怎么配置环境变量 → 看 [`README.md`](./README.md)
> - 想知道评分标准 → 看 [`评分标准-说明.md`](./评分标准-说明.md)
> - 想知道 changelog → 看 [`CHANGELOG.md`](./CHANGELOG.md)（记录详尽，很多"为什么这么改"的历史决策在这里）
>
> 这些文档标了"状态: 现行"且有维护约定——发现内容和代码不一致，说明它过期了，请更新它而不是绕开它。

---

## 项目是什么

API-evaluator：自托管的 LLM API 评测平台。给任何 OpenAI 兼容 / Claude Messages 协议的网关或中转站做
连通性、稳定性、场景质量、准入评测，产出可交付的报告。核心用户画像：中转站/网关运营者，用它验证
自己代理的模型是否"货真价实"（没有被降级、限流、缺斤短两）。

**技术栈**：Node.js 原生运行时（`node:http`、`node:sqlite`、`node:test`），**零框架**——这是刻意的架构
决策：本服务替用户保管中转站 API key，任何插进请求路径的第三方依赖都是供应链风险面。前端纯 JS +
Vite 打包，无框架（无 React/Vue）。测试用 Node 内置 `node:test`，无 Jest/Mocha。lint/format 用 Biome。

**入口**：前端 `index.html` + `src/app.js`（应用装配层）；后端 `server.mjs` + `server/router.mjs`（路由表）。

---

## 现在最重要的事：你可能不是唯一在干活的 AI

用户现在的工作模式是 **`git worktree` 并行开发多个 feature**——同一份提交历史，多个工作目录，
多个分支同时在跑，各自可能配了独立的 AI 会话在推进。**开工第一件事，把这盘棋看清楚**：

```powershell
git worktree list        # 有哪些工作目录，各自签出什么分支
git branch -vv           # 每个分支相对 origin 的跟踪状态
git branch --show-current  # 你现在到底在哪个分支——不要想当然认为"上次在哪就还在哪"
```

截至本文档最后校准时（2026-08-07），仓库里的真实状态是：

| Worktree 目录 | 分支 | 相对 `my-improvements` | 状态 |
|---|---|---|---|
| `API-evaluator-main`（主目录） | `my-improvements` | — | 主线。**领先 `origin/my-improvements` 21 个提交**（本地未推送） |
| `API-evaluator-scene-maintain` | `feat/scene-maintain` | **1 个独有提交** `601ed88` | 唯一有未合并内容的分支（exact 判分器修 LaTeX 定界符不对称 + HLE #16 等价写法，带测试） |
| `API-evaluator-task-center` | `feat/task-center` | 0（与主线同点 `f451441`） | 已合并回主线 |
| `API-evaluator-for-compare` | `feat/for-compare` | 0 个独有提交 | 已合并回主线 |
| `API-evaluator-report-tidy` | `feat/report-tidy` | 0 个独有提交 | 已合并回主线 |
| `API-evaluator-sent-email` | `feat/sent-email` | 0 个独有提交 | 已合并回主线 |
| `API-evaluator-stability-test` | `feat/stability-test` | 0 个独有提交 | 已合并回主线 |
| `API-evaluator-timer-test` | `feat/timer-test` | 0 个独有提交 | 已合并回主线，工作区有 1 处未提交变更 |
| `API-evaluator-token-stats` | `feat/token-stats` | 0 个独有提交 | 已合并回主线 |
| `API-evaluator-warning-fix` | `feat/warning-fix` | 0 个独有提交 | 已合并回主线 |
| `API-evaluator-web-beautify` | `feat/web-beautify` | 0 个独有提交 | 已合并回主线，工作区有 4 处未提交变更 |

**约定：文件夹名与分支名一一对应**（`API-evaluator-xxx` ↔ `feat/xxx`）。历史上出现过错位——
`API-evaluator-auto-test` 这个目录后来被换去签出 `feat/task-center`，目录名却没跟着改，导致
`git branch -vv` 里 `feat/auto-test` 成了唯一没有路径标记的分支，很容易误判它还有独立工作目录。
2026-08-07 已把目录改名为 `API-evaluator-task-center`（`git worktree move`），并删掉了已完全合并的
`feat/auto-test` 本地分支。**换分支时请连目录名一起改，别留错位。**

**这张表会过期**——它只是"写文档那一刻"的快照。别信这张表，信你自己刚跑的 `git worktree list`。
但它演示了你要问自己的问题：*我这个分支相对主线是超前还是落后？有没有别的分支已经做了我要做的事？
我做完之后谁负责合并？*

### worktree 的操作手册在哪

**不要在这里重新发明轮子**——完整的 worktree 创建/合并/冲突处理/打 tag 流程，包括几次真实踩坑
（合到错误分支、`git worktree remove` 被 WebStorm 占用文件句柄拒绝、分叉合并的预演技巧等），
已经写在 [`git-worktree-并行开发笔记.md`](./git-worktree-并行开发笔记.md) 里，**照着抄命令即可**。
那份笔记的核心心法：

1. **同步要用已提交的东西**——`git merge` 只认 commit，工作区里 `git status` 显示的 `M`/`??`
   不会被同步。先在源分支 `commit`，再到目标分支 `merge`。
2. **合并前先确认自己在哪个分支**（`git branch --show-current`）——这个仓库里已经发生过一次
   "以为在 A 分支，实际在 B 分支，把 A 的东西合到了 B 头上"的真实事故。
3. **跨分支合并前先预演**：`git merge --no-commit --no-ff <目标分支>`，看有没有冲突，
   `git merge --abort` 随时能撤销，不会破坏任何已有代码。
4. **选择器契约测试（见下文）在合并后大概率会报警**——如果冲突解决后新增了页面元素，
   `tests/selector-contract.test.mjs` 的快照会过期，报错信息里直接写了怎么重新生成快照。
   这是**预期行为**，不是合并出了错。

### 多个 worktree 同时用 Docker 跑起来测试

每个 worktree 是独立签出的目录，**不含 `node_modules`**（gitignore 排除），需要各自 `pnpm install`。
如果要同时用 Docker 跑多个 worktree 验证，端口和镜像名都要错开（笔记里有具体命令模板）：

```powershell
docker build -t api-evaluator:<功能名> .
docker run -d --name eval-<功能名> -p <错开的端口>:5180 --env-file .env.evaluator \
  -e EVALUATOR_COOKIE_SECURE=false -v evaluator-data-<功能名>:/data api-evaluator:<功能名>
```

---

## 架构地图

### 前端：三层模块分工（`src/`，53 个文件）

- **T1 纯视图**：无状态，纯 render 函数（如 `renderProfileOptions`）。
- **T2 表单控制器**：`createXxx({ state, els, deps })` → 接管一组 DOM 元素的事件监听 + 渲染
  （如 `createDashboard`、`createTestForms`）。
- **T3 自足页面模块**：`createXxx({ state, ... })` → 返回 `{ load, refreshTargets }` 这类接口，
  由 `app.js` 在页面切换时调用（如 `createSettings`）。

**装配根**是 `src/app.js`——它 import 所有模块工厂、把 `state`/`els`/`deps` 注入进去、做页面路由
（`showPage`）。模块之间**互不 import**，只通过回调往上传给 `app.js`，由它做扇出。这条规则很重要：
如果你发现两个业务模块之间有直接 import，先看是不是该走 `app.js` 转发——直接互相 import 是这几次
拆分重构专门要避免的耦合模式（详见下文 `no-cycles` 守卫）。

app.js 本身已经从 2193 行拆到当前约 944 行（拆出 appearance / manual / high-risk-banner / report-browser /
dashboard / settings / trend / client-replay / load-test / test-forms 等 10 个模块）。**继续拆的收益已经
递减**，不建议不带具体理由地继续拆。

### 后端：星形分发 + 路由表（`server/`，76 个文件）

```
HTTP 请求
  → server.mjs 的 createServer 回调（CORS/Origin 检查 → 鉴权中间件 api-access.mjs）
  → server/router.mjs 的路由表（几十行声明式表，替代了历史上 62 条 if 分发；
     现状：server.mjs 里只剩 2 处手写 method 判断，其余全部走路由表）
  → 具体 handler（大多在 server.mjs 里，部分下沉到专职模块）
```

**测试执行链路**（评测的核心业务逻辑）：
```
server.mjs → server/test-runner.mjs（编排：准入/稳定性/场景/快速验证四种测试类型）
  → server/upstream-transport.mjs（传输骨架：fetch + AbortController 超时 + 重试退避 + 字节截断）
  → server/protocols.mjs（协议适配：OpenAI Chat / OpenAI 兼容 / Claude Messages 的请求构造 + 响应解析 + SSE 拼接）
```

**自动化调度链路**（后台常驱动的部分，容易被忽略但很关键）：
```
server.mjs 启动 → server/auto-test-scheduler.mjs（进程内唯一的周期定时器，每分钟 tick 一次）
  → 读 server/auto-test-store.mjs 存的作业配置（间隔模式 or server/cron-schedule.mjs 的 crontab 模式）
  → 到期就调 test-runner 的对应 runner 跑一次 → 结果记入 server/high-risk-store.mjs（高危报告判定）
  → /api/health 暴露调度器活性心跳（stale 判定），供 docker-compose 的健康检查 + autoheal 看门狗联动
```

这条链路有一段真实的事故史：2026-07-07 的提交 `80624fc` 把调度器的活性心跳连同测试一起删掉了，
`/api/health` 从此不再报 `autoTest` 字段，健康检查的 `!stale` 判断退化成恒真——**表面上什么都没报错，
但"进程活着、调度器僵死"这类静默故障从此不会被 autoheal 感知**。2026-07-16 的上线前就绪检查里发现
并修复，补回了心跳字段和回归测试。
**教训**：改 `auto-test-scheduler.mjs` 时，`getStatus()`/`lastTickAt`/`stale` 这几个字段不是"顺手清理的
死代码"，它们是唯一能感知"定时器还活着吗"的信号，动之前先确认 `/api/health` 的响应体里还有没有
`autoTest` 字段。

---

## 子系统速查（读代码前先知道去哪找）

| 我想找… | 去这个文件 | 一句话 |
|---|---|---|
| 自动测试的定时调度 | `server/auto-test-scheduler.mjs` + `auto-test-store.mjs` | 进程内唯一定时器，支持「每 N 小时」间隔 或 crontab 表达式两种模式并存 |
| crontab 语法解析 | `server/cron-schedule.mjs` | 零依赖自研引擎，固定北京时间 UTC+8（分钟步进扫描，无夏令时坑）；`cronNextAfter` 366 天内扫不到匹配会返回 `null`（如 `dom=31 month=2` 这种永不成立的组合），`auto-test-store.mjs` 的 `computeNextRunAt` 对此有 24h 兜底重试，不会让作业永久停摆 |
| crontab 的下拉式 UI | `src/cron-ui.js` | 纯函数（零 DOM），三维「星期×时段×频率」拼 cron 字符串，供用户不用手写 cron |
| 高危报告判定与横幅 | `server/high-risk-store.mjs` + `src/high-risk-banner.js` | 某次测试结果触发阈值（如成功率骤降）时记入未读集合，前端顶部横幅提示 |
| 自动测试巡检报告 | `server/trend-service.mjs` + `server/auto-test-digest.mjs` | 跨作业周期性汇总：`trend-service` 聚合某个渠道·模型的历史趋势（成功率/P95/回归判定），`auto-test-digest` 把聚合数据渲染成带 SVG 图表的 Markdown 报告 |
| 模型对比报告 | `server/report-compare.mjs` + `src/model-compare.js` | 从报告中心选两个报告做配对统计对比（Miller 2024 方法），可选 AI 生成叙述 |
| 邮件报警发信 | `server/mailer.mjs` + `server/notify-config.mjs` + `src/notify-config.js` | SMTP 配置持久化在 `notify-config.json`，**密码单独走加密库，绝不入配置文件**；`mailer.mjs` 懒加载 `nodemailer`（非请求热路径操作，不排到启动依赖里） |
| 自定义阈值报警规则 | *（尚未合并）* | 提交在 `feat/sent-email` 分支，主线目前只有"发测试邮件"这一个手动触发点，规则触发逻辑不在 `my-improvements` 里 |
| 限流防灌 | `server/rate-limit.mjs` | 极简固定窗口限流，进程内内存，专门保护免登录白名单里的 `/api/client-errors` 端点（P3-8） |
| SSRF / 出站安全 | `server/egress-guard.mjs` | 拦截内网/保留网段（含 IPv4-mapped IPv6 绕过、云元数据地址），所有出站 fetch 都要过这道闸 |
| 密钥加密存储 | `server/secret-store.mjs` | API key / SMTP 密码等敏感字段的加密库，本地密钥文件加密，绝不落明文配置 |
| 路由表 | `server/router.mjs` | 声明式路由，`server.mjs` 现在只剩 2 处手写 if 分发，其余全部走这张表 |
| 分词器/token 审计 | `server/token-auditor.mjs` + `tokenizer-*.mjs` 系列 | 检测中转站是否篡改计费 token 数（"缺斤短两"检测），是这个项目的招牌功能之一 |
| 模型身份/降级检测 | `server/model-fingerprint.mjs` + `tier-*.mjs` 系列 | LLMmap 风格的档位降级判别（"声称是 Sonnet，行为像 Haiku"） |

想要更细的接口级/存储级信息，回到本文档开头引用的 `接口清单.md` / `存储机制说明.md`。

---

## 纪律：这个仓库的硬规矩

### 1. 等价性改动必须用 evidence，不能用 inference

"看起来没问题"是最大的陷阱。每次"做法变结果不变"的改动（重构/拆分/格式化），必须：
- 跑真数据差分（不是眼看 diff）
- 接线验证——故意改坏新路，确认测试变红（证明测试真的在盯着这条路径，不是摆设）
- 产物比对（`vite build --minify false`，前后对照字符串字面量 + 标识符列表）
- 诚实标注残留（哪部分没做、为什么）

具体方法在 `.claude/skills/equivalence-change/SKILL.md`，**涉及"改代码但结果不该变"的任务前先加载它**。

### 2. 拆代码 = 纯搬运，不是重构

拆 app.js 的历次 commit 都遵循同一纪律：逐字复制，不顺手改。早期有一块因为顺手重构，被产物差分
证出标识符增减后当即回退成纯搬运。**如果你要拆更多代码：先确认静态守卫存在（下条），然后纯搬运，
用产物比对证明等价，不要边拆边"顺手改善"。**

### 3. 两条静态守卫的存在意义（没有浏览器测试，这是唯一的安全网）

这个项目里**没有 jsdom/playwright/puppeteer**，前端逻辑靠"人打开页面看一眼"验证。为了在没有浏览器
的情况下也能拦住拆分/重构的两类高频事故，专门建了两条静态守卫：

- `tests/selector-contract.test.mjs` —— 追踪 `src/` 里所有 `requireElement("#...")` 选择器，确保它们都
  在 `index.html` 存在，且选择器全集不因重构意外变化（有快照文件，变化要么是预期新增/删除、要么是
  bug）。拆模块时，DOM 元素的 `requireElement` 必须留在 `app.js`（通过 `els` 传入工厂）。
- `tests/no-cycles.test.mjs` —— 检测 `src/` 和 `server/` 的 import 环。`vite build` 对环不报错
  （rollup 能处理循环依赖），**但浏览器里会 TDZ 白屏**。这条测试报红，就是真实的浏览器运行时 bug，
  不是测试太敏感。

### 4. 顶层 await 之前的注册必须完整

`app.js` 里有一段顶层 `await ensureAuthenticated()`。**任何"注册到某个消费表/回调列表"的语句**
（如历史上的 `_onProfileData.push(...)`）都必须放在这个 await **之前**，因为 await 之后立即执行的
初始加载函数会遍历这些注册表——放晚了，注册的东西永远不会被首次渲染触发。这类 bug 的症状是
"某个联动看起来完全没反应，但代码逻辑读起来又是对的"，回头看是不是卡在了 await 时序上。

### 5. C2（innerHTML 收敛）判定不做，别重启这件事

审计后判定"把所有 innerHTML 手写字符串机械替换成模板函数"这件事**不做**——会让代码更复杂，
且之前有 AI 尝试过、翻车回滚了。当前方案是给"刻意不转义"的 innerHTML 拼接点加清晰注释（可以
`grep -rn "刻意不转义" src/*.js` 找到现有的几处），说明为什么这里不转义是安全的。如果你被要求
"统一 innerHTML 写法"，先看这段历史，别重复踩坑。

---

## 学到的重要教训（分类速查）

### Biome 的坑
- `files.ignore` 在 2.x 已移除，改用 `files.includes`（白名单）。
- 变量名带 `_` 前缀被 `noUnusedVariables` 豁免（故意不用的标记）。
- 真实数据目录（`评测数据/`）必须被 biome ignore 覆盖，否则 formatter 会重写几百个文件，含密钥库。

### 平台差异（这台机器是 Windows，容器目标是 Linux）
- **Windows 上 `pkill` 不杀进程**——用 `taskkill //PID //F`。
- **Windows 不投递 POSIX 信号**——`kill -TERM` 走 `TerminateProcess` 硬终止，不触发
  `process.on("SIGTERM")`。测处理器体逻辑用 `process.emit("SIGTERM")` 手动驱动；OS 信号投递那一步
  （`docker stop` → 容器内 PID 1 收到 SIGTERM）**必须留到 Linux/容器里验证**，本机测不出这一层。
- **SQLite 在 Windows 上子进程 kill 后短暂占用（EBUSY/EPERM）**——清理临时测试目录用
  `rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})`。
- **`git worktree remove` 可能因为编辑器（WebStorm 等）占着索引文件句柄被拒绝**——遇到
  `Permission denied` / `Device or resource busy`，`git branch -d` 通常仍能独立成功（提交历史层面已清理），
  磁盘上残留的空目录不影响任何后续 git 操作，不必强杀进程去抠掉它。

### 差分实验的陷阱（做等价性验证/回归排查时）
- 比"输入"（样本集合），不是比"输出"（p50/p95 统计量）——两个多重集相同 → 任何统计量自然相同，
  这只是构造性证明，证明力不够。
- 展平多对一数据时只用单字段做 key → 记录互相覆盖 → 产生假的"分歧"。先按唯一标识分组再逐字段比。
- 同一个 `run_id` 下，AI 报告分析的调用记录会混进请求日志表——不按类型过滤就会被误当成测试轮，
  污染平均耗时之类的统计。

---

## 工作流：接任务时的启动顺序

1. **看清楚自己在哪**：`git worktree list` + `git branch --show-current` + `git status --short`。
   不确定就先问，别假设。
2. **加载对应 skill**：任务涉及"改代码但结果不该变"→ 加载 `equivalence-change` skill；
   任务是"帮我测试/上线前检查"→ 加载 `product-testing` skill。两个都在 `.claude/skills/` 下。
3. **查记忆**：如果你的 AI 工具带跨会话记忆系统（不是本仓库里的文件，是工具自身维护的项目记忆），
   先查一下有没有关于这个项目的既有记录。这类记忆可能滞后于代码现状——如果记忆和你读到的代码矛盾，
   **相信代码**，然后更新记忆。
4. **读本文件 + 上面提到的专项文档**，了解当前架构和已知限制。
5. **跑全量测试打基线**：`node --test tests/*.test.mjs`（当前 827 条，全绿是起点），
   确认自己接手时是绿的，而不是带着别人的红灯开始。
6. **按纪律做**：涉及拆分/重构 → 建安全网 → 纯搬运 → 产物比对/差分 → 接线验证 → 标注残留 → commit。
7. **改动收尾前**：`biome ci .`（格式+lint 闸门）+ `vite build`（前端构建）+ 全量测试，三者都过才算完。

---

## 工具链速查

```bash
# 测试
node --test tests/*.test.mjs          # 全量（当前 827 条）
node --test tests/some.test.mjs       # 单文件

# 格式/门禁
npx biome format --write .            # 格式化
npx biome ci .                        # CI 闸（格式 + 2 条已启用的 lint 规则）

# 构建
npx vite build                        # 前端生产构建
npx vite build --minify false         # 不压缩，产物比对用（等价性验证时看字面量/标识符）

# 语法检查
node --check server.mjs

# 包管理（pnpm 不在 PATH，用 corepack）
corepack pnpm install
corepack pnpm add <pkg>

# 本地起服务（需要先在 .env.evaluator 配 EVALUATOR_SESSION_SECRET / EVALUATOR_ADMIN_PASSWORD）
node server.mjs
# 或走 vite dev server（前端热更新）：
corepack pnpm run dev        # 前端
corepack pnpm run dev:server # 后端
```

---

## 人类用户的行为模式

- 他们会直接说"继续"、"来吧"、"好的按你的来"——这就是批准，不用再确认一遍。
- 他们有时说"你可以提交"——这是明确的 git commit 授权；没说的时候不要自己 commit。
- `/plan` 会进入计划模式，你要先设计再等批准，不要跳过这一步直接动手。
- `/compact` 是压缩上下文的正常操作，无影响，继续干活。
- 如果用户说"线上问题已解决，以后不用问了"类似的收尾语——记下来，别在后续任务里重复追问同一件事。
- 用户现在明确在用多 worktree 并行推进不同 feature，你被唤醒时**大概率带着一个具体、局部的任务**
  （某个 feature 分支的某个功能），不代表要对整个仓库负责——先搞清楚你这次的任务边界，别越权改动
  其他 worktree 正在推进的东西。

---

## 最后

这个仓库不是屎山。多次代码规范审查的结论都是"代码质量不错"，注释详尽、决策留痕、测试认真。
但它有真实的复杂度——76 个后端模块、53 个前端模块、827 条测试、3 个并行开发的 feature 分支。
你不需要通读全部代码才能干活，但**动手前先确认起点是绿的、自己站在正确的分支上、要改的东西
有没有已知的坑**——这三件事比"读多少代码"更重要。

祝你好运。
