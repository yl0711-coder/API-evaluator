// 共享执行并发闸：所有会真实调用上游的「高层测试执行」共用同一组槽位。
//
// 任务中心、自动测试调度器和同步测试接口此前各自有信号量，三个入口叠加时会突破
// EVALUATOR_MAX_CONCURRENT_TASKS，既压垮宿主，也会让上游看到与运维配置不一致的并发。
// 本模块只管理执行槽位，不关心调用者、测试类型或内部单请求并发；调用方需要保证每次
// acquire 都恰好配对一次 release。

function normalizeLimit(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 1;
}

export function createExecutionLimiter({ getLimit = () => 1 } = {}) {
  let active = 0;
  const waiters = [];

  function limit() {
    return normalizeLimit(getLimit());
  }

  // 释放后按 FIFO 唤醒。先把 active 加回去再 resolve，保证同一轮微任务里不会出现
  // 「两个等待者都以为有空槽」的竞态。
  function drain() {
    const max = limit();
    while (waiters.length && active < max) {
      const resolve = waiters.shift();
      active += 1;
      resolve();
    }
  }

  function hasCapacity() {
    return active < limit();
  }

  // 同步预占槽位，供任务中心在落事件前就可靠决定 queued/running 状态。
  function tryAcquire() {
    if (!hasCapacity()) return false;
    active += 1;
    return true;
  }

  function acquire() {
    if (tryAcquire()) return Promise.resolve();
    return new Promise((resolve) => waiters.push(resolve));
  }

  function release() {
    // 重复 release 属于调用方 bug；这里至少防止计数跌到负数而反向放大并发。
    // 限流器无法识别某一张具体的「槽票」，因此调用方仍必须严格一 acquire 一 release。
    if (active <= 0) return false;
    active -= 1;
    drain();
    return true;
  }

  function getStatus() {
    return { maxConcurrent: limit(), active, queued: waiters.length };
  }

  return { hasCapacity, tryAcquire, acquire, release, getStatus };
}
