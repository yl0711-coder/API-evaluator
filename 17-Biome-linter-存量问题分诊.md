---
状态: 已落地（9 条已修，linter 闸已开）
时间: 2026-07-17
审查对象: my-improvements 分支（46bcd8f 时扫描）
工具: Biome 2.5.4，扫描时用 `linter.rules.recommended: true`（只读）；最终配置只启用 2 条规则
关联: 16-代码规范与可维护性检查-v0.6.2.md（A1 建议的来源）
---

# Biome linter 存量问题分诊（223 条）

## 0. 结论：223 条里只有 1 个真 bug——但它是个用户能看见的 bug

扫描 241 个文件，`recommended` 规则集报出 **223 条**。逐条分诊后：

| 分类 | 条数 | 处置 |
|---|---|---|
| **真 bug（用户可见）** | **1** | **已修**：自动测试配置页的「刷新」按钮点了没反应 |
| **真死代码，值得清理** | **8** | **已清**（`noUnusedVariables` + `noUnusedImports`） |
| **需人工逐个判断** | **21** | CSS 特异性倒序，可能是真渲染 bug，也可能无害。未处理 |
| **纯口味 / 结构性必需 / 误报** | **193** | 关掉规则并写明理由，不为了让闸变绿去改代码 |

**那个真 bug 值得单独说**：`src/auto-test-config.js:48` 把 `#atc-reload` 按钮取进 `reloadBtn` 后**从未绑事件**——
而 `index.html:1171` 那个 `<button>刷新</button>` 确实在页面上。用户点它，什么也不会发生。
紧挨着的上一行 `resetBtn` 则正常绑了处理器，说明这是漏写而非设计。

**这条的意义**：它不是被任何「bug 规则」抓到的，而是被 `noUnusedVariables` 抓到的——
**死变量是「漏绑事件」的症状**。这正是 linter 的价值所在：它不理解业务，但它能发现「你取了个东西却没用」这种结构异常。

除此之外**零真逻辑 bug**，这仍是个有信息量的结果：一个从没跑过 linter 的 2.9 万行代码库，
`recommended` 全量扫描下来只有一处漏绑事件，工程纪律确实在同类自研工具水平之上，佐证了 16 号报告「不是屎山」的判断。

> **一道天天报 223 条的闸，比没有闸更糟**——它会让人对红灯脱敏。所以本文档的目的不是「把 223 条改成 0」，而是「只留下值得亮红灯的那几条」。

---

## 1. 逐规则分诊（附证据）

### 已修（9 条）

这 9 条**逐条查过来源**，结论各不相同——不可批量删，这里记录每条的依据。

**① 真 bug：`src/auto-test-config.js:48` `reloadBtn`**

`#atc-reload` 取到后从未绑事件；`index.html:1171` 的 `<button>刷新</button>` 却在页面上。
排除了事件委托（该文件无 `closest(` / `target.id` / `matches(`，全局无人监听 `#atc-reload`）。
对照 `developer.js:131+488` 的同款模式——那边 `reloadBtn.addEventListener("click", load)` 是有的。
**修法**：绑 `loadJobs` 而非 `load`。按钮位于作业列表标题栏，作用域就是这张列表；
`load()` 还会 `cascade.refresh(...)` 重渲染渠道/模型下拉，会清掉用户正在填的表单选择。

**② 曾有按钮、后被有意删除：`src/app.js:2070` `copyReportText`**

看似与 ① 同类（函数在、无人调），实则相反。翻历史：`d845677`（feat(ui): 稳定性页报告摘要折叠精简）
**同时删掉了按钮和 handler**：

```
- <button id="copy-stability-report">复制摘要和路径</button>
- requireElement("#copy-stability-report").addEventListener("click", () => copyReportText("stability"));
```

却把函数留下了。UI 里现已无任何「复制报告」类按钮 → **是死代码，删。**
**教训**：「函数无人调用」既可能是漏绑（bug），也可能是遗留（死代码）。必须查历史 + 查 UI 才能区分。

**③ 重复定义：`server/scenarios/store.mjs:61` `DEFAULT_SCENARIO_GROUPS`**

`store.mjs` 与 `settings-store.mjs:10` **各有一份完全相同的定义**，只有后者在用。
删前需注意：`server/regression.mjs:12` 的注释指向的恰是死的那份（「见 server/scenarios/store.mjs」）——
删掉会留下断链。**已同步把该注释改指 `settings-store.mjs`。**

**④ 有副作用的 import：`tests/profile-store.test.mjs:13` `paths`**

`await import('../server/paths.mjs?case=' + Date.now())` —— `?case=` 是**故意破模块缓存**，
逼 `paths.mjs` 重读刚设好的 `EVALUATOR_DATA_DIR`。**import 必须留，只去掉赋值。**

**⑤ 连锁死代码：`tests/task-manager.test.mjs:23` `execFileAsync`**

删它会让 `execFile`（第 2 行）与 `promisify`（第 7 行）两个 import 一并变死。**三处一起删。**

**⑥ 遗留的存在性断言：`src/app.js:869` `loadTestLoadsInput`**

`requireElement` 在元素缺失时会抛错，故此行是一道存在性校验。但 `#load-test-loads` 的值实际
经 FormData 以 `raw.loads` 读取（`app.js:967/991`），不需要 JS 引用。**是遗留，删。**

**⑦⑧⑨ 直接可删**：`scripts/hle-import.mjs:60` `ANSWER_SUFFIX`（被 :87 的函数取代，
`ANSWER_DISCIPLINE` 仍在用）、`scripts/compare-eval-reports.mjs:9` 的 `basename`、
`server.mjs:86` 的 `safeJson`（均确认全项目仅出现在 import 行）。

> **残留**：删掉 `copyReportText` 后，`state.latestReportCopies`（`app.js:70/853/857/1072/1076`）
> 成了「只写不读」。linter 不会报（赋值算「使用」）。未处理——那片代码属 16 号报告 C1
> （拆 `app.js`）的范围，留待那轮一并清理。

### 需人工逐个判断（21 条）

**`style/noDescendingSpecificity` —— 21 条｜可能是真 CSS bug**

特异性倒序：低特异性选择器写在高特异性之后，可能导致规则**静默不生效**。例：`src/styles.css:1934 .manual-content h3`（特异性 0,1,1）。多数情况无害，但确实存在「样式没生效且没人发现」的可能。低优先级，但值得抽查。

### 建议关掉（193 条）

**`correctness/noUnusedFunctionParameters` —— 64 条｜结构性必需，非问题**

证据：`server.mjs:985 handleAutoTestJobDelete(req, res, { params })` —— `req` 未用。但**路由表要求所有 handler 统一签名 `(req, res, { url, params })`**，这是路由表重构确立的调用约定。删参数就破坏约定。可用 `_req` 前缀消音，但那是 64 处纯机械改动、零行为收益。**典型的「linter 不理解架构」误报。**

**`style/useTemplate` —— 40 条｜纯口味**（字符串拼接 vs 模板字面量）。

**`suspicious/useIterableCallbackReturn` —— 25 条｜无害**

证据：`groups.forEach((g, i) => console.log(...))` —— 箭头函数隐式返回了 `console.log` 的返回值（undefined）。规则想要的只是加对花括号。真正危险的场景（`.map()` 漏 return）**一条都没出现**。

**`complexity/useOptionalChain` —— 22 条｜纯口味**。

**`complexity/noImportantStyles` —— 10 条｜纯口味**（CSS `!important`）。

**`suspicious/noPrototypeBuiltins` —— 9 条｜代码已经是对的**

证据：`server/secret-store.mjs:124` 写的是 `Object.prototype.hasOwnProperty.call(vault, ref)`——**这正是防原型污染的安全写法**（也正是该规则通常建议的「修法」）。Biome 只是想让你换成更新的 `Object.hasOwn()`。纯 API 现代化偏好，零风险。顺带说明：16 号报告 P3-4 关注的那类问题，这里代码本来就做对了。

**`suspicious/noAssignInExpressions` —— 5 条｜惯用写法**

证据：`scenarios.reduce((m, s) => ((m[s.config] = ...), m), {})` —— reduce 的逗号运算符惯用法，故意的。

**`correctness/noPrecisionLoss` —— 2 条｜技术成立、实践无害**

证据：`server/stats.mjs:35` 的 Lanczos ln Γ(x) 系数表，`-86.50532032941677` 运行时变 `...78`。**差 1 个 ULP（相对误差约 1e-16），而 Lanczos 近似自身的误差量级是 1e-15。** 所谓「修复」就是把字面量写成 JS 本来就会产生的那个值，行为一字节不变。

**`suspicious/noControlCharactersInRegex` —— 2 条｜误报**

证据：`server/report-files.mjs:109` 那个剥离控制字符的正则——**这是文件名消毒代码，故意匹配控制字符以剥离它们**（注释写着「控制字符 → _」）。规则的理由是「控制字符是不寻常的输入」，但这段代码的职责恰恰就是处理不寻常输入。应加注释豁免，不是「修」。

**其余零星｜纯口味**：`useConst` 3、`noUselessEscapeInRegex` 2、`noCommaOperator` 2、`useArrowFunction` 2、`useExponentiationOperator` 1、`useLiteralKeys` 1、`useBiomeIgnoreFolder` 1、`a11y/useValidAnchor` 1。

---

## 2. 两处必须纠正的既往说法

### ① 「Biome 能抓漏 `await`」——这是错的，而它曾是推荐 A1 的主要论据之一

- `noFloatingPromises` 属 **nursery（实验）组，不在 `recommended` 里**，默认根本不查。上面 223 条里**没有任何漏 await**。
- 显式开启后更糟：它**误报已经 await 的调用**。

  证据：`server.mjs:1053` 源码是 `await deleteProfileApiKey(profile);`（已经 await 了），规则却报 floating promise，并给出修复建议 `await await deleteProfileApiKey(profile)`——**双重 await，纯属胡来**。同类误报共 16 条。

- **结论：绝不启用 nursery 组；绝不使用 `--write --unsafe`。** Biome 自己把这类修复标为 "Unsafe fix"，每条都得人看。

A1 的价值仍然成立（格式统一、CI 有闸、新代码有网），但「抓漏 await」这条收益要划掉。

### ② `noPrecisionLoss` 一度被称作「最吓人的一条」——喊早了

查完是虚惊，见第 1 节。教训：报警时先取证再下结论。

---

## 3. 最终配置（已落地）

不用 `recommended: true`，只开真正会亮红灯的两条：

```json
"linter": {
  "enabled": true,
  "rules": {
    "recommended": false,
    "correctness": {
      "noUnusedVariables": "error",
      "noUnusedImports": "error"
    }
  }
}
```

其余 `recommended` 规则在本代码库均为口味 / 结构性必需 / 误报，逐条依据见第 1 节。日后可按需单条加回。

**已验证闸有牙**（否则等于装饰）：注入 `const deadVar = 1;` → `biome ci .` 退出码 1 并报 `noUnusedVariables`；
注入未用 import → 退出码 1 并报 `noUnusedImports`；还原后回绿。

> 首次验证时我用了 `const __deadVar = 1;`，闸没拦——**那是测试写错了**：
> Biome 的 `noUnusedVariables` 按惯例豁免 `_` 开头的变量（那正是「故意不用」的标记）。
> 换正常命名后立刻拦下。教训：闸不响时先怀疑自己的测试。

**为什么不「先全开、慢慢修」**：那意味着 CI 长期红着，等于没有闸；而为了 193 条口味问题去动 145 个文件的逻辑，
风险远大于收益。宁可要一道**窄而可信**的闸——一道天天报 223 条的闸会让人对红灯脱敏，比没有闸更糟。

**未纳入**：CSS 那 21 条特异性倒序需人工逐个判断，不进闸，另行抽查。

---

## 4. 完整清单（全部 223 条）

> 按规则分组，附 `文件:行` 与源码片段，供逐条核对。

### `correctness/noUnusedFunctionParameters` —— 64 条

| 文件 | 行 | 代码 |
|---|---|---|
| `server.mjs` | 985 | `async function handleAutoTestJobDelete(req, res, { params }) {` |
| `server.mjs` | 1692 | `async function handleAlerts(req, res, { url }) {` |
| `server.mjs` | 563 | `function handleAuthLogout(req, res) {` |
| `server.mjs` | 578 | `function handleHealth(req, res) {` |
| `server.mjs` | 592 | `async function handleProfilesList(req, res) {` |
| `server.mjs` | 597 | `async function handleProfilesExport(req, res) {` |
| `server.mjs` | 606 | `function handleScenariosList(req, res) {` |
| `server.mjs` | 1711 | `async function handleSupportBundle(req, res) {` |
| `server.mjs` | 633 | `async function handleDevScenarioDelete(req, res, { params }) {` |
| `server.mjs` | 928 | `async function handleAutoTestJobsList(req, res) {` |
| `server.mjs` | 978 | `async function handleAutoTestJobRunNow(req, res, { params }) {` |
| `server.mjs` | 1048 | `async function handleProfileDelete(req, res, { params }) {` |
| `server.mjs` | 1084 | `async function handleChannelsList(req, res) {` |
| `server.mjs` | 1119 | `async function handleChannelsImport(req, res) {` |
| `server.mjs` | 1141 | `async function handleChannelSyncModels(req, res, { params }) {` |
| `server.mjs` | 1182 | `async function handleChannelDelete(req, res, { params }) {` |
| `server.mjs` | 1200 | `function handleSettingsGet(req, res) {` |
| `server.mjs` | 1223 | `async function handleModelTargetsList(req, res) {` |
| `server.mjs` | 1288 | `async function handleModelTargetDelete(req, res, { params }) {` |
| `server.mjs` | 1361 | `async function handleTasksRecent(req, res) {` |
| `server.mjs` | 1366 | `function handleTaskGet(req, res, { params }) {` |
| `server.mjs` | 1377 | `async function handleTaskCancel(req, res, { params }) {` |
| `server.mjs` | 1389 | `async function handleRequestsRecent(req, res) {` |
| `server.mjs` | 1394 | `async function handleTestRunsRecent(req, res) {` |
| `server.mjs` | 1400 | `async function handleReportsList(req, res) {` |
| `server.mjs` | 1406 | `async function handleHighRiskAlertsList(req, res) {` |
| `server.mjs` | 1422 | `async function handleReportFilesList(req, res) {` |
| `server.mjs` | 1449 | `async function handleReportFileDelete(req, res, { params }) {` |
| `server.mjs` | 1660 | `async function handleReportView(req, res, { params }) {` |
| `server.mjs` | 1678 | `async function handleTrend(req, res, { url }) {` |
| `server.mjs` | 610 | `function handleDevScenariosList(req, res) {` |
| `src/standard-eval-controller.js` | 246 | `scenarioProfileSelect,` |
| `src/standard-eval-controller.js` | 247 | `updateEstimates,` |
| `tests/auto-test-scheduler.test.mjs` | 446 | `const scheduler = build(store, runners, { logError: (err, job) => logged.push(job?.id) });` |
| `tests/auto-test-scheduler.test.mjs` | 460 | `const scheduler = build(store, runners, { logError: (err, job) => logged.push(job?.id) });` |
| `tests/newapi-source.test.mjs` | 121 | `const server = createServer((req, res) => {` |
| `tests/probe-requests.test.mjs` | 417 | `(req, res) => sendSse(res, joinSse([oaDelta("你"), oaDelta("好"), "data: [DONE]\n"])),` |
| `tests/probe-requests.test.mjs` | 455 | `(req, res) => sendJson(res, 200, { choices: [{ message: { content: bigText } }] }),` |
| `tests/probe-requests.test.mjs` | 46 | `(req, res) =>` |
| `tests/probe-requests.test.mjs` | 465 | `(req, res) => {` |
| `tests/probe-requests.test.mjs` | 215 | `(req, res) => {` |
| `tests/probe-requests.test.mjs` | 230 | `(req, res) => sendJson(res, 200, { choices: [{ message: { content: "" } }] }),` |
| `tests/probe-requests.test.mjs` | 242 | `(req, res) =>` |
| `tests/probe-requests.test.mjs` | 257 | `(req, res) => sendJson(res, 200, { choices: [{ message: { content: "no tool" } }] }),` |
| `tests/probe-requests.test.mjs` | 277 | `(req, res) => {` |
| `tests/probe-requests.test.mjs` | 305 | `(req, res) => {` |
| `tests/probe-requests.test.mjs` | 329 | `(req, res) => sendJson(res, 200, { choices: [{ message: { content: "答案是 121626。" } }] }),` |
| `tests/probe-requests.test.mjs` | 347 | `(req, res) => sendJson(res, 200, { choices: [{ message: { content: "ok" } }] }),` |
| `tests/probe-requests.test.mjs` | 357 | `(req, res) => {` |
| `tests/probe-requests.test.mjs` | 373 | `(req, res) => {` |
| `tests/probe-requests.test.mjs` | 430 | `(req, res) => sendSse(res, joinSse([oaDelta("你"), oaDelta("好")])), // 干净断流，缺终止帧` |
| `tests/probe-requests.test.mjs` | 441 | `(req, res) => sendSse(res, joinSse([oaDelta("你"), oaFrame({ error: { message: "上游中途报错" } }` |
| `tests/probe-requests.test.mjs` | 66 | `(req, res) => sendJson(res, 503, { error: { message: "upstream down" } }),` |
| `tests/probe-retry.test.mjs` | 121 | `(req, res) => {` |
| `tests/probe-retry.test.mjs` | 138 | `(req, res) => {` |
| `tests/probe-retry.test.mjs` | 154 | `(req, res) => {` |
| `tests/probe-retry.test.mjs` | 154 | `(req, res) => {` |
| `tests/probe-retry.test.mjs` | 186 | `(req, res) => {` |
| `tests/probe-retry.test.mjs` | 207 | `(req, res) => {` |
| `tests/probe-retry.test.mjs` | 227 | `(req, res) => {` |
| `tests/probe-retry.test.mjs` | 233 | `(req, res) => {` |
| `tests/probe-retry.test.mjs` | 62 | `(req, res) => {` |
| `tests/probe-retry.test.mjs` | 82 | `(req, res) => {` |
| `tests/probe-retry.test.mjs` | 100 | `(req, res) => {` |

### `style/useTemplate` —— 40 条

| 文件 | 行 | 代码 |
|---|---|---|
| `scripts/claude-tier-calibrate.mjs` | 169 | `"Basic " + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)` |
| `scripts/claude-tier-calibrate.mjs` | 407 | `writeFileSync(args.out, JSON.stringify(out, null, 2) + "\n", "utf8");` |
| `scripts/claude-token-baseline.mjs` | 128 | `"Basic " + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)` |
| `scripts/claude-token-baseline.mjs` | 314 | `writeFileSync(args.out, JSON.stringify(out, null, 2) + "\n", "utf8");` |
| `scripts/hle-import.mjs` | 87 | `return "\n\n---\n" + (hint ? hint + "\n" : "") + ANSWER_DISCIPLINE;` |
| `scripts/hle-import.mjs` | 87 | `return "\n\n---\n" + (hint ? hint + "\n" : "") + ANSWER_DISCIPLINE;` |
| `scripts/hle-import.mjs` | 60 | `const ANSWER_SUFFIX = "\n\n---\n" + ANSWER_DISCIPLINE;` |
| `scripts/verify-fingerprint.mjs` | 196 | `console.log("  " + "id".padEnd(18) + "category".padEnd(12) + "base".padStart(6) + "rep".pa` |
| `server.mjs` | 1634 | `const scopeLabel = soloProfileId ? `单个模型 · ${soloInfo.label}${soloInfo.model ? " · " + sol` |
| `server/auto-test-digest.mjs` | 73 | `attention.push(`模型「${t.label}${t.model ? " · " + t.model : ""}」疑似退化：${detail \|\| t.regres` |
| `server/auto-test-digest.mjs` | 93 | ``\| ${cell(j.name \|\| "-")} \| ${cell(KIND_LABELS[j.kind] \|\| j.kind \|\| "-")} \| ${cel` |
| `server/auto-test-digest.mjs` | 112 | ``\| ${cell(`${t.label}${t.model ? " · " + t.model : ""}`)} \| ${cell(t.runsInWindow ?? 0)}` |
| `server/auto-test-digest.mjs` | 128 | `lines.push(`### ${t.label}${t.model ? " · " + t.model : ""}`);` |
| `server/auto-test-digest.mjs` | 134 | `lines.push(`\`\`\`chart-svg${chartNonce ? ":" + chartNonce : ""}`);` |
| `server/auto-test-scheduler.mjs` | 111 | ``${job.lastError ? job.lastError + " " : ""}连续失败 ${job.consecutiveFailures} 次，已自动停用以避免无效重跑` |
| `server/high-risk-store.mjs` | 76 | `out.push({ reportId, testType: type, label: `${typeName}${who ? " · " + who : ""}`, reason` |
| `server/tokenizer-probes.mjs` | 112 | `text: "spam spam spam spam spam lovely spam wonderful spam " + "ha".repeat(40),` |
| `shared/trend-chart.mjs` | 177 | `)} · 成功率 ${Math.round(p.rate * 100)}% · 耗时 ${p.ms != null ? Math.round(p.ms) + "ms" : "—"}` |
| `src/app.js` | 691 | `)} \| ${p.type} \| 成功率 ${p.successRate != null ? Math.round(p.successRate * 100) + "%" : "` |
| `src/app.js` | 691 | `)} \| ${p.type} \| 成功率 ${p.successRate != null ? Math.round(p.successRate * 100) + "%" : "` |
| `src/app.js` | 691 | `)} \| ${p.type} \| 成功率 ${p.successRate != null ? Math.round(p.successRate * 100) + "%" : "` |
| `src/auto-test-config.js` | 288 | `上次运行：${fmtTime(job.lastRunAt)}（${escapeHtml(statusText)}${errNote}）${reportLink ? " " + re` |
| `src/channel-admin.js` | 201 | `<small>${escapeHtml(protocolLabel(target.protocol))}${target.note ? " · " + escapeHtml(tar` |
| `src/developer.js` | 382 | ``<option value="">全部分组</option>` + filterGroups.map((g) => `<option value="${escapeHtml(g)` |
| `src/scenario-case-picker.js` | 45 | ``<option value="">全部分组</option>` + groups.map((g) => `<option value="${escapeHtml(g)}">${e` |
| `tests/data-store-sqlite.test.mjs` | 21 | `await writeFile(paths.REQUEST_LOG_FILE, ["h1", "h2", "h3"].map(line).join("\n") + "\n", "u` |
| `tests/newapi-import.test.mjs` | 110 | `apiKeyRef: "profile:" + localId + ":api-key",` |
| `tests/newapi-import.test.mjs` | 127 | `assert.equal(plan.channels[0].apiKeyRef, "profile:" + localId + ":api-key", "凭证保留");` |
| `tests/newapi-source.test.mjs` | 114 | `assert.equal(normalizeMysqlDsn("  " + uri + "  "), uri); // 仅 trim` |
| `tests/probe-requests.test.mjs` | 413 | `const joinSse = (frames) => frames.join("\n") + "\n\n";` |
| `tests/protocols-stream.test.mjs` | 8 | `return lines.join("\n") + "\n\n";` |
| `tests/protocols-stream.test.mjs` | 109 | `const s = summarizeStreamStructure("openai_compatible", 'data: {"choices":[\n\n' + okDelta` |
| `tests/protocols-stream.test.mjs` | 118 | `const raw = okDelta + 'data: {"error":{"message":"upstream disconnected","type":"server_er` |
| `tests/protocols-stream.test.mjs` | 125 | `const raw = okDelta + 'event: error\ndata: {"message":"boom"}\n\n' + done;` |
| `tests/protocols-stream.test.mjs` | 133 | `const raw = 'data: {"error":null,"choices":[{"delta":{"content":"hi"}}]}\n\n' + done;` |
| `tests/regression.test.mjs` | 18 | `runId: "r" + Math.random().toString(36).slice(2, 8),` |
| `tests/report-html.test.mjs` | 69 | `const md = "```chart-svg:" + NONCE + "\n<svg id='real'></svg>\n```";` |
| `tests/report-html.test.mjs` | 15 | `"```chart-svg:" + NONCE,` |
| `tests/report-html.test.mjs` | 39 | `const md = "# t\n\n```chart-svg:" + NONCE + "\n<svg></svg>\n"; // 少了收口 ```` |
| `tests/stream-completeness.test.mjs` | 14 | `const sse = (frames) => frames.join("\n") + "\n\n";` |

### `suspicious/useIterableCallbackReturn` —— 25 条

| 文件 | 行 | 代码 |
|---|---|---|
| `scripts/claude-token-baseline.mjs` | 320 | `groups.forEach((g, i) => console.log(`     [${i + 1}] ${g.join(", ")}`));` |
| `scripts/claude-token-baseline.mjs` | 325 | `errs.forEach((b) => console.log(`     ${b.model} — ${b.error}`));` |
| `scripts/verify-fingerprint.mjs` | 190 | `rows.forEach((r) => (r.resid = Math.round(r.rep - (slope * r.base + intercept))));` |
| `scripts/verify-fingerprint.mjs` | 199 | `.forEach((r) =>` |
| `server/benchmark-scorers.mjs` | 289 | `val.forEach((v, i) => flattenLeaves(v, `${prefix}[${i}]`, out));` |
| `server/scenario-tag-award.mjs` | 43 | `earned.forEach((x) => cur.add(x));` |
| `server/tier-discrimination.mjs` | 116 | `ranked.forEach((r, i) => (r.posterior = exps[i] / sumExp));` |
| `src/app.js` | 434 | `REPORT_FILTERS.forEach((sel) =>` |
| `src/app.js` | 1375 | `navButtons.forEach((item) => item.classList.toggle("active", item.dataset.page === page));` |
| `src/app.js` | 1376 | `pages.forEach((item) => item.classList.toggle("active", item.id === page));` |
| `src/batch-target-picker.js` | 162 | `currentRows().forEach((r) => selected.add(r.id));` |
| `src/batch-target-picker.js` | 145 | `segBtns.forEach((b) =>` |
| `src/batch-target-picker.js` | 127 | `chips.querySelectorAll(".chip .x").forEach((x) =>` |
| `src/batch-target-picker.js` | 149 | `segBtns.forEach((x) => x.classList.toggle("on", x.dataset.dim === dim));` |
| `src/channel-admin.js` | 141 | `.forEach((b) => b.addEventListener("click", () => removeModelTargetTag(b.dataset.tagTarget` |
| `src/channel-admin.js` | 30 | `.forEach((b) => b.addEventListener("click", () => deleteChannel(b.dataset.delChannel)));` |
| `src/channel-admin.js` | 33 | `.forEach((b) => b.addEventListener("click", () => editChannel(b.dataset.editChannel)));` |
| `src/channel-admin.js` | 144 | `.forEach((b) => b.addEventListener("click", () => editModelTarget(b.dataset.editTarget)));` |
| `src/channel-admin.js` | 138 | `.forEach((b) => b.addEventListener("click", () => deleteModelTarget(b.dataset.delTarget)))` |
| `src/developer.js` | 376 | `.forEach((b) => b.addEventListener("click", () => renameGroup(b.dataset.renameGroup)));` |
| `src/developer.js` | 377 | `groupListBox.querySelectorAll("[data-del-group]").forEach((b) => b.addEventListener("click` |
| `src/developer.js` | 62 | `tagsBox.querySelectorAll("[data-del-tag]").forEach((b) => b.addEventListener("click", () =` |
| `src/model-compare.js` | 154 | `scenariosBox.querySelectorAll('input[type="checkbox"]').forEach((el) => (el.checked = true` |
| `src/model-compare.js` | 158 | `scenariosBox.querySelectorAll('input[type="checkbox"]').forEach((el) => (el.checked = fals` |
| `src/scenario-case-picker.js` | 87 | `chips.querySelectorAll(".chip .x").forEach((x) =>` |

### `complexity/useOptionalChain` —— 22 条

| 文件 | 行 | 代码 |
|---|---|---|
| `server/benchmark-scorers.mjs` | 38 | `if (!expected \|\| !expected.name) {` |
| `server/benchmark-scorers.mjs` | 41 | `if (!actual \|\| !actual.name) {` |
| `server/fingerprint-tracking.mjs` | 178 | `const valid = (peers \|\| []).filter((p) => p && p.model);` |
| `server/fingerprint-tracking.mjs` | 249 | `const valid = (peers \|\| []).filter((p) => p && p.tokenizerSignature && Object.keys(p.tok` |
| `server/load-test.mjs` | 100 | `if (target && target.baseUrl && target.model) {` |
| `server/load-test.mjs` | 488 | `const byReason = (p.statusReasons \|\| {})[code] \|\| {};` |
| `server/load-test.mjs` | 502 | `return (p.statusPhrases && p.statusPhrases[code]) \|\| "";` |
| `server/regression.mjs` | 20 | `if (!s \|\| s.type !== "scenario" \|\| !Array.isArray(s.scenarios) \|\| !s.runId) continue` |
| `server/report-compare.mjs` | 657 | `if (!rounds \|\| !rounds.length) return { ...(fallback \|\| {}), failed: 0, recomputed: fa` |
| `server/reporting.mjs` | 991 | `if (!billingAudit \|\| !billingAudit.requestCount) return "- 未生成计费维度审计。";` |
| `server/task-manager.mjs` | 307 | `.filter((r) => r && r.reportHtmlPath)` |
| `server/task-manager.mjs` | 426 | `if (!task \|\| task.status !== "running") {` |
| `server/test-runner.mjs` | 546 | `.filter((r) => r && r.reportHtmlPath)` |
| `server/version.mjs` | 8 | `if (pkg && pkg.version) version = pkg.version;` |
| `src/admission-view.js` | 212 | `if (abs && abs.applicable) {` |
| `src/model-compare.js` | 68 | `if (loadedScenarios && loadedScenarios.length) {` |
| `src/report-id.js` | 47 | `if (!p \|\| !p.isNew) continue;` |
| `src/report-id.js` | 31 | `if (!parsed \|\| !parsed.isNew) return false;` |
| `src/report-overlay.js` | 124 | `.filter((r) => r && r.id)` |
| `src/report-overlay.js` | 45 | `const list = (tabs \|\| []).filter((t) => t && t.id);` |
| `src/report-overlay.js` | 66 | `.filter((r) => r && r.id)` |
| `src/scenario-view.js` | 35 | `const reports = Array.isArray(result.reports) ? result.reports.filter((r) => r && r.id) : ` |

### `style/noDescendingSpecificity` —— 21 条

| 文件 | 行 | 代码 |
|---|---|---|
| `src/styles.css` | 1934 | `.manual-content h3 {` |
| `src/styles.css` | 4039 | `.dev-group-chip b {` |
| `src/styles.css` | 4157 | `.atc-job-meta a {` |
| `src/styles.css` | 3484 | `.panel > h3,` |
| `src/styles.css` | 3724 | `.anim > *:nth-child(1) {` |
| `src/styles.css` | 3727 | `.anim > *:nth-child(2) {` |
| `src/styles.css` | 3730 | `.anim > *:nth-child(3) {` |
| `src/styles.css` | 3733 | `.anim > *:nth-child(4) {` |
| `src/styles.css` | 3736 | `.anim > *:nth-child(5) {` |
| `src/styles.css` | 167 | `.main {` |
| `src/styles.css` | 175 | `.main,` |
| `src/styles.css` | 3446 | `.form-section-title h3 {` |
| `src/styles.css` | 1608 | `.modal-card h3 {` |
| `src/styles.css` | 1787 | `.result-box {` |
| `src/styles.css` | 1803 | `.trend-chart-head h3 {` |
| `src/styles.css` | 1906 | `.manual-content h3 {` |
| `src/styles.css` | 1997 | `.manual-content h3 {` |
| `src/styles.css` | 2158 | `.main {` |
| `src/styles.css` | 3038 | `.chan-who b {` |
| `src/styles.css` | 3188 | `.model-group-head b {` |
| `src/styles.css` | 702 | `.form-section-title h3 {` |

### `complexity/noImportantStyles` —— 10 条

| 文件 | 行 | 代码 |
|---|---|---|
| `src/styles.css` | 3575 | `background: var(--brand) !important;` |
| `src/styles.css` | 3576 | `color: #1a0f08 !important;` |
| `src/styles.css` | 971 | `animation: none !important;` |
| `src/styles.css` | 972 | `transition: none !important;` |
| `src/styles.css` | 979 | `transition: none !important;` |
| `src/styles.css` | 986 | `transform: none !important;` |
| `src/styles.css` | 1662 | `display: none !important;` |
| `src/styles.css` | 3440 | `border-color: var(--line) !important;` |
| `src/styles.css` | 3433 | `border-color: var(--line) !important;` |
| `src/styles.css` | 3434 | `background: rgba(8, 17, 31, 0.42) !important;` |

### `suspicious/noPrototypeBuiltins` —— 9 条

| 文件 | 行 | 代码 |
|---|---|---|
| `server/secret-store.mjs` | 124 | `if (!Object.prototype.hasOwnProperty.call(vault, ref)) {` |
| `src/report-id.js` | 22 | `return (map && Object.prototype.hasOwnProperty.call(map, name) && map[name]) \|\| name;` |
| `tests/probe-requests.test.mjs` | 90 | `const hasTemperature = json && Object.prototype.hasOwnProperty.call(json, "temperature");` |
| `tests/probe-requests.test.mjs` | 146 | `if (json && Object.prototype.hasOwnProperty.call(json, "stream_options")) {` |
| `tests/probe-requests.test.mjs` | 194 | `if (json && Object.prototype.hasOwnProperty.call(json, "stream_options")) {` |
| `tests/settings-newapi-endpoint.test.mjs` | 107 | `assert.equal(Object.prototype.hasOwnProperty.call(body, "newapiImportToken"), false, "响应不回` |
| `tests/settings-newapi-endpoint.test.mjs` | 93 | `assert.equal(Object.prototype.hasOwnProperty.call(body, "newapiImportToken"), false, "绝不回显` |
| `tests/settings-newapi-endpoint.test.mjs` | 113 | `assert.equal(Object.prototype.hasOwnProperty.call(g.body, "newapiImportToken"), false);` |
| `tests/settings-token-migration.test.mjs` | 89 | `assert.equal(Object.prototype.hasOwnProperty.call(body, "newapiImportToken"), false, "GET ` |

### `correctness/noUnusedVariables` —— 7 条

| 文件 | 行 | 代码 |
|---|---|---|
| `scripts/hle-import.mjs` | 60 | `const ANSWER_SUFFIX = "\n\n---\n" + ANSWER_DISCIPLINE;` |
| `server/scenarios/store.mjs` | 61 | `const DEFAULT_SCENARIO_GROUPS = ["基础", "LiveBench", "安全红线", "HLE", "HardcoreLogic", "编程硬核"` |
| `src/app.js` | 869 | `const loadTestLoadsInput = requireElement("#load-test-loads");` |
| `src/app.js` | 2070 | `async function copyReportText(kind) {` |
| `src/auto-test-config.js` | 48 | `const reloadBtn = requireElement("#atc-reload");` |
| `tests/profile-store.test.mjs` | 13 | `const paths = await import(`../server/paths.mjs?case=${Date.now()}`);` |
| `tests/task-manager.test.mjs` | 23 | `const execFileAsync = promisify(execFile);` |

### `suspicious/noAssignInExpressions` —— 5 条

| 文件 | 行 | 代码 |
|---|---|---|
| `scripts/hardcore-logic-import.mjs` | 290 | `const byCfg = scenarios.reduce((m, s) => ((m[s.config] = (m[s.config] \|\| 0) + 1), m), {}` |
| `scripts/hle-import.mjs` | 263 | `const byCat = numbered.reduce((m, s) => ((m[s.hleCategory] = (m[s.hleCategory] \|\| 0) + 1` |
| `server/fingerprint-tracking.mjs` | 240 | `if (Number.isFinite(v) && v > 0) (byProbe[k] \|\|= []).push(v);` |
| `server/load-test.mjs` | 727 | `const n = (counter += 1);` |
| `server/load-test.mjs` | 297 | `const byReason = (statusReasons[s.status] \|\|= {});` |

### `style/useConst` —— 3 条

| 文件 | 行 | 代码 |
|---|---|---|
| `server/report-compare.mjs` | 190 | `let cells = line.split("\|").map((c) => c.trim());` |
| `tests/rate-limit.test.mjs` | 7 | `let t = 1000;` |
| `tests/rate-limit.test.mjs` | 18 | `let t = 0;` |

### `complexity/noUselessEscapeInRegex` —— 2 条

| 文件 | 行 | 代码 |
|---|---|---|
| `server/benchmark-scorers.mjs` | 211 | `t = t.replace(/^["'`“”‘’（(\[【]+/, "").replace(/["'`“”‘’）)\]】。.!！?？，,;；:：]+$/, "");` |
| `server/client-log-analyzer.mjs` | 504 | `.replace(/\bchannel_id\":\d+/gi, 'channel_id":[redacted]');` |

### `correctness/noUnusedImports` —— 2 条

| 文件 | 行 | 代码 |
|---|---|---|
| `scripts/compare-eval-reports.mjs` | 9 | `import { basename, join } from "node:path";` |
| `server.mjs` | 86 | `import { appendJsonLine, compactDate, hasProxyEnv, requiredString, safeJson, sendJson } fr` |

### `complexity/noCommaOperator` —— 2 条

| 文件 | 行 | 代码 |
|---|---|---|
| `scripts/hardcore-logic-import.mjs` | 290 | `const byCfg = scenarios.reduce((m, s) => ((m[s.config] = (m[s.config] \|\| 0) + 1), m), {}` |
| `scripts/hle-import.mjs` | 263 | `const byCat = numbered.reduce((m, s) => ((m[s.hleCategory] = (m[s.hleCategory] \|\| 0) + 1` |

### `complexity/useArrowFunction` —— 2 条

| 文件 | 行 | 代码 |
|---|---|---|
| `server/report-compare.mjs` | 62 | `return function () {` |
| `server/tier-probes-claude.mjs` | 21 | `return function () {` |

### `suspicious/noControlCharactersInRegex` —— 2 条

| 文件 | 行 | 代码 |
|---|---|---|
| `server/report-files.mjs` | 109 | `.replace(/[\\/:*?"<>\|\u0000-\u001f]+/g, "_") // 路径分隔 / Windows 非法字符 / 控制字符 → _` |
| `server/report-files.mjs` | 109 | `.replace(/[\\/:*?"<>\|\u0000-\u001f]+/g, "_") // 路径分隔 / Windows 非法字符 / 控制字符 → _` |

### `correctness/noPrecisionLoss` —— 2 条

| 文件 | 行 | 代码 |
|---|---|---|
| `server/stats.mjs` | 44 | `return -tmp + Math.log((2.5066282746310005 * ser) / x);` |
| `server/stats.mjs` | 35 | `const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,` |

### `style/useExponentiationOperator` —— 1 条

| 文件 | 行 | 代码 |
|---|---|---|
| `server/stats.mjs` | 240 | `const chi2 = Math.pow(Math.abs(nb - nc) - 1, 2) / n;` |

### `complexity/useLiteralKeys` —— 1 条

| 文件 | 行 | 代码 |
|---|---|---|
| `tests/report-compare.test.mjs` | 224 | `assert.equal(admA.items["工具调用结构"], "通过");` |

### `suspicious/useBiomeIgnoreFolder` —— 1 条

| 文件 | 行 | 代码 |
|---|---|---|
| `biome.json` | 14 | `"!src/docs/**"` |

### `a11y/useValidAnchor` —— 1 条

| 文件 | 行 | 代码 |
|---|---|---|
| `index.html` | 115 | `<div class="sec-head"><h3>最近报告</h3><a data-go-page="reports">全部报告 →</a></div>` |

### `suspicious/noMisleadingCharacterClass` —— 1 条

| 文件 | 行 | 代码 |
|---|---|---|
| `tests/report-compare.test.mjs` | 160 | `assert.ok(/[✅≈⚠️❓ℹ️]/u.test(overview), "结论列应带信号图标（✅/≈/⚠️/❓/ℹ️）");` |