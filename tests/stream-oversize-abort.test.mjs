import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { readBoundedResponseText } from "../server/upstream-transport.mjs";

test("流式累积超限：读到一半超限时 abort + reader.cancel", async () => {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      // 第 1 帧 10 字节
      controller.enqueue(enc.encode("a".repeat(10)));
      // 第 2 帧 10 字节，累积 20 > 限额 15
      controller.enqueue(enc.encode("b".repeat(10)));
      controller.close();
    },
  });
  const ctrl = new AbortController();
  const result = await readBoundedResponseText(new Response(body), 15, ctrl);

  assert.equal(result.truncated, true, "累积超限必须标记 truncated");
  assert.equal(ctrl.signal.aborted, true, "累积超限必须 abort（readBoundedResponseText 的累积超限分支）");
  assert.ok(result.text.length > 0, "已读到的部分要保留");
});

// —— P2 回归：abort 监听器数不得随分片数增长 ——
// 初版把 `new Promise + signal.addEventListener("abort")` 写在读取循环【内】，每轮挂一个从不移除的
// 监听器（各持一个 reject 闭包）。实测 500 次读取 = 501 个监听器；按流式上限 24MB、每次 read 约 2KB
// 估算，单个满额流式请求可累积上万个。AbortSignal 是 EventTarget、默认不设监听器上限，
// 所以线上【不会】有 MaxListenersExceededWarning，只表现为容器内存偏高（mem_limit 768m 下是实际风险）。
// 故必须由测试直接钉住监听器数，而不是指望运行时告警。
// 变异验证：把监听器注册挪回 while 循环内即变红（listeners 随分片数线性增长）。
test("P2：abort 监听器不随分片数增长，读取结束后归零", async () => {
  const enc = new TextEncoder();
  const readWithChunks = async (n) => {
    const body = new ReadableStream({
      async start(c) {
        for (let i = 0; i < n; i += 1) {
          c.enqueue(enc.encode("x"));
          // 让出事件循环，确保每个分片各触发一次 reader.read()（否则会被合并成少数几次读取）
          await new Promise((r) => setImmediate(r));
        }
        c.close();
      },
    });
    const ctrl = new AbortController();
    const result = await readBoundedResponseText(new Response(body), 1_000_000, ctrl);
    assert.equal(result.text.length, n, `${n} 个分片应读全`);
    return getEventListeners(ctrl.signal, "abort").length;
  };

  // 关键断言是「不随 n 增长」：20 个分片与 500 个分片的监听器数必须相同。
  const few = await readWithChunks(20);
  const many = await readWithChunks(500);
  assert.equal(many, few, `监听器数不得随分片数增长（20 片 ${few} 个 / 500 片 ${many} 个）`);
  // 正常读完后应当摘干净（finally 里 removeAbortListener）。
  assert.equal(many, 0, "读取结束后不得在 signal 上留下监听器");
});

test("P2：超时中止仍抛 AbortError、保留半截 body，并摘掉监听器", async () => {
  const enc = new TextEncoder();
  // 首块给出可见输出后永久挂起，模拟「上游卡住不发了」
  const body = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"半截"}}]}\n\n'));
    },
  });
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 50);

  await assert.rejects(
    () => readBoundedResponseText(new Response(body), 24 * 1024 * 1024, ctrl),
    (error) => {
      // 错误归类（normalizedError=timeout）依赖 name === "AbortError"，不能变。
      assert.equal(error.name, "AbortError", "中止必须是 AbortError（错误归类依赖它）");
      // 半截 body 是「上游到底发出来没有」的唯一证据，供应商举证要用。
      assert.match(String(error.partialText || ""), /半截/, "已收到的半截 body 必须挂在 error.partialText 上");
      return true;
    },
  );
  assert.equal(getEventListeners(ctrl.signal, "abort").length, 0, "中止路径也要摘掉监听器");
});
