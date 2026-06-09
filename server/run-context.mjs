// 评测记账上下文
// 用 AsyncLocalStorage 把「谁在跑」(run_by) 透传到底层记账写入，
// 避免给整条评测调用链逐层加参数。server.mjs 在请求处理外层 withRunBy 包裹。
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

export function withRunBy(runBy, fn) {
  return storage.run({ runBy: runBy || null }, fn);
}

export function currentRunBy() {
  return storage.getStore()?.runBy ?? null;
}
