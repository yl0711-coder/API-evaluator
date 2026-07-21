# 给未来 AI 兄弟的留言

这份文档写给下一个被拉进这个仓库干活的 AI。人类用户可能会说"继续做"或者按 16 号报告的清单往下做，所以你需要知道坑在哪、纪律是什么、约定是什么。

---

## 项目概览

API-evaluator：一个评测 LLM API 质量的本地工具。Node.js 原生运行时（`node:http`、`node:sqlite`、`node:test`），没有框架。前端是纯 JS + vite 打包，入口 `index.html`，核心模块 `src/app.js`。后端入口 `server.mjs`。

当前分支：`my-improvements`（领先 origin/main 约 20 个 commit）。

---

## 核心里程碑（本会话完成的改动线）

1. **路由表重构**：62 条 if 分发改成声明式路由表（`server/router.mjs`）
2. **安全修复 9 项**（15 号审查）：P1-1（IPv6 出站守卫）、P2-2/3（流式判假成功/字节上限）、P2-5（趋势 LIMIT 砍错方向）等
3. **工具链**：Biome 2.5.4（formatter + CI 闸 + linter 2 条规则）
4. **B2**：模型比对数据源从 markdown 解析换成结构化 DB 读（`server/report-compare.mjs`）
5. **拆 app.js**：2193 → 955 行（-56%），拆出 9 个模块（appearance/manual/high-risk-banner/report-browser/dashboard/settings/trend/client-replay/load-test）
6. **B1**：拆 `runUpstreamProbe` → `server/upstream-transport.mjs`
7. **skill 提炼**：`.claude/skills/equivalence-change/SKILL.md`（不入库，本地）和 `product-testing/SKILL.md`
8. **crontab 风格定时调度**（2026-07-21）：自动测试作业新增 cron 调度，与「每 N 小时」间隔并存。零依赖引擎 `server/cron-schedule.mjs`（固定北京时间 UTC+8、分钟步进扫描）；下拉式 UI `src/cron-ui.js`（星期×时段×频率，非手写 cron）。见记忆 [cron-scheduling-feature]

---

## 纪律：这个仓库的硬规矩

### 1. 等价性改动必须用 evidence，不能用 inference

"看起来没问题"是最大的陷阱。每次"做法变结果不变"的改动，必须：
- 跑真数据差分（不是眼看）
- 接线验证——故意改坏新路，确认测试变红
- 产物比对（`vite build --minify false`，前后对照字符串字面量 + 标识符列表）
- 诚实标注残留（哪部分没做、为什么）

具体方法在 `.claude/skills/equivalence-change/SKILL.md`，**干活前先加载它**。

### 2. 拆代码 = 纯搬运，不是重构

拆 app.js 的 7 个 commit 都遵循同一纪律：逐字复制，不顺手改。第一块因为顺手重构被产物差分组证出标识符增减后，当即回退成纯搬运。后续 6 块再没破过。**如果你要拆更多代码，先建安全网（selector-contract + no-cycles 两条静态守卫），然后纯搬运，用产物比对证明等价。**

### 3. 静态守卫的存在意义

`tests/selector-contract.test.mjs` —— 追踪 `src/` 里所有 `requireElement("#...")` 选择器，确保它们都在 `index.html` 存在。拆模块时，DOM 元素的 `requireElement` 必须留在 `app.js`（通过 `els` 传入工厂），否则这个测试会报警——它验证"选择器没丢"，不是"选择器被用了"。

`tests/no-cycles.test.mjs` —— 检测 `src/` 和 `server/` 的 import 环。`vite build` 对环不报错（rollup 能处理），但浏览器里会 TDZ 白屏。**如果它报红，是真实的浏览器运行时 bug。**

### 4. 顶层 await 的 TDZ 陷阱

app.js 在 line ~745 有 `await ensureAuthenticated()`。**所有 `_onProfileData.push(...)` 必须在这之前**，因为 `loadProfiles()` 在 await 之后立即执行，调用 `renderProfileOptions()` 遍历注册表。把 push 放在 await 之后导致 9 个级联永远刷新不到——本会话的修复 commit `7e0978a` 就是修这个的。

---

## 当前未完成的工作

### 16 号报告剩余项（按优先级）

| 项 | 状态 | 位置 | 说明 |
|---|---|---|---|
| **B3** | ✅ 已完成（07-21） | `server/constants.mjs` | `45000`/`15000` 收敛为 `P95_LATENCY_SLOW_MS`/`P95_LATENCY_OK_MS`，3 文件 11 处引用 |
| **C1 余** | ✅ 已完成（07-21） | `src/test-forms.js` | 5 个表单控制器拆出（准入单/批量、稳定性、批量并发、场景）。app.js 降到 929 行。**剩余块拆分收益递减，不建议续拆**（详见记忆 [app-js-split-progress]） |
| **C2** | ⛔ 判定不做（07-21） | — | 审计后判定机械替换会更复杂、前 AI 已翻车回滚。改为给 ~10 处「刻意不转义」加注释。**别再重启**（详见记忆 [c2-innerHTML-decision]） |
| **D1** | 未做 | `tests/` | 29 个测试文件碰 process.env 没隔离复位；偶发 tokenizer flake（多次全量均未复现，隐患但不紧急） |

### 前端运行时验证 ✅ 已完成（07-21）

拆出的 12 个模块通过了静态守卫和构建。07-21 用户手动逐页验证：应用能启动、能登录、**所有页面功能正常、无应用层（`index-*.js`）报错、无 TDZ 白屏**。侧栏折叠 / 光影切换、手册 scrollspy、高危横幅、报告面板、仪表盘、各测试表单级联选择器均正常。

控制台里的 `content_main.js`/`content-script-vimeo.js`/`api.ipify.org` 报错全是浏览器扩展噪音，与应用无关（用无痕窗口可屏蔽扩展验证）。

---

## 架构约定

### app.js 的模块分层

- **T1 纯视图**：无状态，纯 render 函数（如 `renderProfileOptions`）
- **T2 表单控制器**：`createXxx({ state, els, deps })` → DOM 注入 + 事件监听（如 `createDashboard`）
- **T3 自足页面模块**：`createXxx({ state, ... })` → `{ load, refreshTargets }`（如 `createSettings`）

模块之间**不互相 import**——回调往上走，app.js 做扇出。参见 `src/dashboard.js` 的 `deps` 模式。

### server 的星形架构

`server.mjs` → 路由表 → 分发到各 handler。测试执行链路：
```
server.mjs → test-runner.mjs（编排）
  → upstream-transport.mjs（传输骨架：fetch/重试/退避/字节截断）
  → protocols.mjs（协议：OpenAI/Claude 的请求构造+响应解析）
```

---

## 学到的重要教训

### Biome 的坑
- `files.ignore` 在 2.x 已移除，改用 `files.includes`（白名单）
- 变量名带 `_` 前缀被 `noUnusedVariables` 豁免（故意不用的标记）
- 真实数据目录（`评测数据/`）必须被 biome ignore 覆盖，否则 formatter 会重写 432 个文件含密钥库

### 平台差异
- **Windows 上 `pkill` 不杀进程**——用 `taskkill //PID //F`
- **Windows 不投递信号**——`kill -TERM` 走 `TerminateProcess` 硬终止，不触发 `process.on("SIGTERM")`。测处理器体逻辑用 `process.emit("SIGTERM")`，OS 投递那一步留在 Linux/容器验
- **SQLite 在 Windows 上子进程 kill 后短暂占用（EBUSY/EPERM）**——清理用 `rm(dir, { recursive, force, maxRetries: 5, retryDelay: 200 }).catch(() => {})`

### Newman/Postman 的坑
- `pkill` 在 Windows 不工作 → 新进程撞 `EADDRINUSE` 死亡 → 旧服务仍在运行 → newman 测试打的是旧的未变异服务
- 验证"测试有牙"时，先用 `taskkill` 确认旧进程死透

### 差分实验的陷阱
- 比"输入"（样本集合），不是比"输出"（p50/p95 统计量）——两个多重集相同 → 任何统计量相同，这是构造性证明
- 展平多对一数据时只用单字段做 key → 记录互相覆盖 → 假分歧。先用 `reportBaseName` 分组再逐字段比
- `ai-report-analysis` 条目会混进 `test_requests` 表——用同一 `run_id`，不过滤就会当成测试轮，污染平均耗时

---

## 工作流：接任务时的启动顺序

1. **加载 skill**：如果你的任务涉及"改代码但结果不该变"，先调用 `equivalence-change` skill。如果要做测试，调用 `product-testing` skill。
2. **查记忆**：`memory/MEMORY.md` 索引 + `.claude/projects/` 下的项目记忆文件。
3. **读本文件和 `18-任务进度总览.md`** 了解已完成和未完成。
4. **跑全量测试**：`node --test`（应对 761 条），确保都是绿的再动手。
5. **按纪律做**：建安全网 → 纯搬运 → 产物比对/差分 → 接线验证 → 标注残留 → commit。

---

## 工具链速查

```bash
# 测试
node --test                          # 全量 761 条
node --test tests/probe-requests.test.mjs tests/probe-retry.test.mjs  # 探针 28 条

# 格式/门禁
corepack pnpm exec biome format --write .   # 格式化
corepack pnpm exec biome ci .               # CI 闸

# 构建
corepack pnpm exec vite build --minify false  # 前端（未压缩，产物比对用）

# 包管理
corepack pnpm add ...     # pnpm 不在 PATH，用 corepack pnpm
```

---

## 人类用户的行为模式

- 他们会直接说"继续"、"来吧"、"好的按你的来"——这就是批准
- 他们有时说"你可以提交"——给你 git commit 授权
- `/plan` 进入计划模式，你要先设计再等批准
- `/compact` 压缩上下文，无影响，继续干活
- 他们喜欢看到你自我纠错（本会话记录了 9 次自纠）
- 如果用户说"线上问题已解决，以后不用问了"——别再追问

---

## 最后

这个仓库不是屎山。16 号审查报告的结论是"代码质量不错"，Biome linter 存量 223 条里只有 1 个真 bug。但它在持续变好——从 2193 行的 app.js 到 955 行，从混在 test-runner 里的传输骨架到独立的 transport 模块。

祝你好运，别急着动手，先跑一遍测试确认起点是绿的。
