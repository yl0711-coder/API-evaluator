import assert from "node:assert/strict";
import test from "node:test";
import { linkExternalAbort, readBoundedResponseText, stripHeavyRunResult } from "../server/test-runner.mjs";
import { firstTokenPatternFor } from "../server/protocols.mjs";

test("bounded response reader stops reading oversized upstream responses", async () => {
  const controller = new AbortController();
  const response = new Response("x".repeat(128), {
    headers: { "content-length": "128" },
  });

  const result = await readBoundedResponseText(response, 16, controller);

  assert.equal(result.truncated, true);
  assert.equal(controller.signal.aborted, true);
});

test("bounded response reader returns normal small upstream responses", async () => {
  const controller = new AbortController();
  const response = new Response(JSON.stringify({ ok: true }));

  const result = await readBoundedResponseText(response, 1024, controller);

  assert.equal(result.truncated, false);
  assert.match(result.text, /"ok":true/);
});

// TTFT 口径：首帧常常没有内容（Claude 的 message_start、中转的保活帧），
// 用它打点会让 TTFT 系统性偏快且跨协议不可比。断言读取器等到「首个可见输出 token」才打点。
test("bounded reader: firstTokenAt 跳过无内容首帧，只在首个可见 token 到达时打点", async () => {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      // 第 1 帧：Claude 的 message_start —— 无任何文本
      controller.enqueue(enc.encode(`event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n`));
      await new Promise((r) => setTimeout(r, 40)); // 与首帧拉开可测量的间隔
      // 第 2 帧：首个真正的可见 token
      controller.enqueue(
        enc.encode(
          `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}\n\n`,
        ),
      );
      controller.close();
    },
  });
  const response = new Response(body);
  const result = await readBoundedResponseText(response, 1024, new AbortController(), {
    firstTokenPattern: firstTokenPatternFor("claude_messages"),
  });
  assert.equal(typeof result.firstChunkAt, "number");
  assert.equal(typeof result.firstTokenAt, "number");
  assert.ok(
    result.firstTokenAt - result.firstChunkAt >= 30,
    `firstTokenAt 必须晚于无内容的首帧（实测差 ${result.firstTokenAt - result.firstChunkAt}ms）`,
  );
});

test("bounded reader: 流中始终无可见 token → firstTokenAt 为 null（不给假 TTFT）", async () => {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(`: ping\n\n`));
      controller.enqueue(enc.encode(`event: message_start\ndata: {"type":"message_start"}\n\n`));
      controller.close();
    },
  });
  const result = await readBoundedResponseText(new Response(body), 1024, new AbortController(), {
    firstTokenPattern: firstTokenPatternFor("claude_messages"),
  });
  assert.equal(result.firstTokenAt, null, "测不到就留 null，宁可报告省略也不给偏快的假数字");
  assert.equal(typeof result.firstChunkAt, "number", "firstChunkAt 仍照常记录");
});

test("bounded reader: 不传 firstTokenPattern 时行为不变（firstTokenAt 恒为 null）", async () => {
  const response = new Response(new Blob([JSON.stringify({ ok: true })]).stream());
  const result = await readBoundedResponseText(response, 1024, new AbortController());
  assert.equal(result.firstTokenAt, null);
  assert.equal(result.truncated, false);
});

test("bounded reader records first-chunk time for streamed bodies (TTFT 来源)", async () => {
  const controller = new AbortController();
  const response = new Response(JSON.stringify({ ok: true })); // 有 body.getReader
  const result = await readBoundedResponseText(response, 1024, controller);
  assert.equal(typeof result.firstChunkAt, "number");
  assert.ok(result.firstChunkAt > 0);
});

test("linkExternalAbort aborts the request when external (task) signal fires", () => {
  const ext = new AbortController();
  const ctrl = new AbortController();
  const unlink = linkExternalAbort(ctrl, ext.signal);
  assert.equal(ctrl.signal.aborted, false);
  ext.abort();
  assert.equal(ctrl.signal.aborted, true);
  unlink();
});

test("linkExternalAbort aborts immediately if external signal already aborted", () => {
  const ext = new AbortController();
  ext.abort();
  const ctrl = new AbortController();
  linkExternalAbort(ctrl, ext.signal);
  assert.equal(ctrl.signal.aborted, true);
});

test("linkExternalAbort is a no-op without a signal", () => {
  const ctrl = new AbortController();
  const unlink = linkExternalAbort(ctrl, undefined);
  assert.equal(typeof unlink, "function");
  assert.equal(ctrl.signal.aborted, false);
});

test("bounded response reader rejects unknown-size non-stream responses", async () => {
  const controller = new AbortController();
  const response = {
    headers: new Headers(),
    body: null,
    text: async () => "x".repeat(128),
  };

  const result = await readBoundedResponseText(response, 16, controller);

  assert.equal(result.truncated, true);
  assert.equal(controller.signal.aborted, true);
});

test("batch result compaction removes nested heavy report content", () => {
  const result = stripHeavyRunResult({
    runId: "run-demo",
    profileName: "Demo",
    successRateText: "100%",
    reportPath: "/tmp/report.md",
    reportMarkdown: "# long markdown\n".repeat(100),
    records: [{ requestId: "a" }, { requestId: "b" }],
  });

  assert.equal(result.runId, "run-demo");
  assert.equal(result.reportMarkdown, undefined);
  assert.equal(result.recordCount, 2);
});
