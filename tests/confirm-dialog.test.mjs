import assert from "node:assert/strict";
import test from "node:test";

import { createConfirmDialog } from "../src/confirm-dialog.js";

// 轻量 DOM 桩
function mockEl() {
  const handlers = {};
  return {
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    textContent: "",
    innerHTML: "",
    className: "",
    focus() {},
    addEventListener(ev, fn) { handlers[ev] = fn; },
    _fire(ev, arg) { if (handlers[ev]) handlers[ev](arg); },
  };
}

test("confirm-dialog：第二次弹出会把上一个未决的 Promise 按“取消”决议（不卡死）", async () => {
  const prevDoc = globalThis.document;
  globalThis.document = { addEventListener() {} };
  try {
    const modal = mockEl();
    const ok = mockEl();
    const cancel = mockEl();
    const confirmAction = createConfirmDialog({
      modal,
      titleElement: mockEl(),
      messageElement: mockEl(),
      confirmButton: ok,
      cancelButton: cancel,
    });

    const p1 = confirmAction({ title: "A", message: "a" }); // 第一个确认框，未点
    const p2 = confirmAction({ title: "B", message: "b" }); // 还没决议就又弹第二个

    // 修复前：p1 永久挂起（调用方 finally 不执行 → 按钮/slot 卡死）
    // 修复后：p1 被按“取消”决议为 false
    assert.equal(await p1, false);

    // 第二个仍能正常决议
    ok._fire("click");
    assert.equal(await p2, true);
  } finally {
    globalThis.document = prevDoc;
  }
});

test("confirm-dialog：正常单次确认 / 取消", async () => {
  const prevDoc = globalThis.document;
  globalThis.document = { addEventListener() {} };
  try {
    const ok = mockEl();
    const cancel = mockEl();
    const confirmAction = createConfirmDialog({
      modal: mockEl(),
      titleElement: mockEl(),
      messageElement: mockEl(),
      confirmButton: ok,
      cancelButton: cancel,
    });
    const p = confirmAction({ title: "X", message: "x" });
    cancel._fire("click");
    assert.equal(await p, false);
  } finally {
    globalThis.document = prevDoc;
  }
});
