// shared/thresholds.mjs
// 判定阈值的单一来源（修 ADM-011：阈值口径不一致）。
//
// 背景：这些数字曾经有两份。server/constants.mjs 一份（15s / 45s，被 admission-policy、
// reporting、test-runner、model-fingerprint 共 20 多处引用），src/operator-guidance.js
// 又自带一份（硬编码 30s 共 4 处、成功率 0.95 / 0.9）。于是同一份稳定性数据，在准入报告里
// 按 15s 判成「有条件通过」，在标准评测页的「人话结论」里按 30s 判成「初筛通过」——
// 用户看到两个互相矛盾的结论，而两边都自称权威。
//
// 放 shared/ 而非 server/ 的理由同 shared/escape.mjs：后端【不得】import 前端源目录 src/
// （生产镜像不打包 src/，0.5.7 升级事故），而前端也不该反向依赖 server/。
// 前后端共用的纯值只有 shared/ 一个合法住处。server/constants.mjs 现在从这里再导出，
// 后端既有引用点一处都不用动。
//
// 改这里的数字会同时改变准入硬门槛、稳定性报告推荐、标准评测的人话结论与按钮。
// 这正是要的效果——一处改，全局一致。

// P95 总延迟三档（ms）：≤15s 好 / 15~45s 有条件 / >45s 慢到不建议。
export const P95_LATENCY_OK_MS = 15000;
export const P95_LATENCY_SLOW_MS = 45000;

// 初筛成功率阶梯：≥0.95 可进下一轮 / <0.9 不建议 / 中间带需人工看。
//
// 这两个数【不是】准入硬门槛，别拿来当门槛用。准入口径严得多：
// server/admission-policy.mjs 的 evaluateStability 要求 9 轮冒烟 9/9 全成功才 passed，
// 少一轮就是 not_passed。分工不同——初筛回答「值不值得继续花钱测」，
// 准入回答「能不能开放给业务」，后者理应更严。
//
// 0.95 与 0.9 之间刻意留了一条带：落在里面既不够好也不够差，前端会给「需人工复核」，
// 而不是硬掰成通过或失败。合并成一个数会让这条带消失。
export const PRESCREEN_SUCCESS_RATE_OK = 0.95;
export const PRESCREEN_SUCCESS_RATE_FAIL = 0.9;

// 准入等级中视为「可交付」的档位（完整 A-F/X 等级定义见 server/admission-policy.mjs）。
export const DELIVERABLE_GRADES = ["A", "B"];

export function isDeliverableGrade(grade) {
  return DELIVERABLE_GRADES.includes(grade);
}
