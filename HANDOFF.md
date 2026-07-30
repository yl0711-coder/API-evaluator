# 交接文档

写给接手这个仓库的下一个 AI（或人）。上下文压缩/清空后先看这个。

## 现状（2026-07-30）

- 分支 `my-improvements`，已推到 `origin/my-improvements`，工作区干净。
- 最新 tag `v0.7.0`（commit `21f135c`）已推送。
- 版本号（package.json / docker-compose.evaluator.yml / README 里的 docker build 示例）已同步到 0.7.0。

## v0.7.0 修了什么

**模型比对（`server/report-compare.mjs`）压测维度的 goodput 误判**：

`loadGoodputEffect` 曾经把两种情况混为一谈，都记成 `goodput=0`：
1. 一方**从未做过压测**（`loadPoints` 为空数组）
2. 一方**做了压测但最低负载点就不健康**（测出来的真实结果就是差）

这两者语义完全不同——前者是"没数据"，后者是"测量到了 0% 可用容量"。混在一起的后果：从未跑过压测的一方，会在综合评分里被判定为 `-1` 满值劣势，但这不是测出来的结论。

修复：仅一方有压测数据时视为数据不对等，`load` 维度 `effect: null`、权重归零，不参与综合分合成；双方都测过时逻辑不变。回归测试在 `tests/report-compare.test.mjs`。

## 踩过的坑

- **git push 连不上 github.com** 且报错含 `127.0.0.1:xxxx`：先查 `git config --get https.proxy`，通常是本地代理软件（Clash 等）没启动，不是 git 配置问题，也不用改 remote。详见 memory `git-push-proxy-gotcha`。
- Windows Git Bash 下 `pnpm`/`biome` 走 PATH 可能找不到，用 `node_modules/.bin/biome` 直接调。
- SIGTERM 优雅退出的处理器逻辑在 Windows Git Bash 下**验证不了**信号投递本身（只能验证处理器体逻辑），需要 Linux/Docker 环境才能验证完整链路。

## 项目里的长期记忆

详细的项目历史、决策依据、已知未修问题在 `C:\Users\A\.claude\projects\D----MACOSX-API-evaluator-main\memory\`，索引见该目录下 `MEMORY.md`。里面记录了：

- 模型比对功能的两阶段实现、统计方法选型（配对差值 + McNemar + Cliff's δ）
- 已知未修：`loadBalancedCompareFiles` 的 60 份文件上限会在去重前截断，超限时旧场景文件被物理丢弃（用户决定暂缓，若再报"共有场景偏低"优先查这里）
- 渠道/模型改名的别名归并方案、上线前就绪检查修复记录、C2 innerHTML 收敛决策等

新会话如果要接着做这个项目的活，先读那个 MEMORY.md 索引，比重新翻代码猜历史快。
