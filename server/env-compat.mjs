// 环境变量统一前缀 EVALUATOR_，集中在此读取（避免散落的 process.env 直读，前缀一处可改）。
export function envCompat(name) {
  return process.env[`EVALUATOR_${name}`];
}
