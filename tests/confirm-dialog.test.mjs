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

test("confirm-dialog：三态返回 confirm/cancel/dismiss", async () => {
  const prevDoc = globalThis.document;
  globalThis.document = { addEventListener() {} };
  try {
    const modal = mockEl();
    const ok = mockEl();
    const cancel = mockEl();
    const confirmAction = createConfirmDialog({ modal, titleElement: mockEl(), messageElement: mockEl(), confirmButton: ok, cancelButton: cancel });

    const p1 = confirmAction({ title: "A", message: "a", tristate: true });
    ok._fire("click");
    assert.equal(await p1, "confirm");

    const p2 = confirmAction({ title: "B", message: "b", tristate: true });
    cancel._fire("click");
    assert.equal(await p2, "cancel");

    const p3 = confirmAction({ title: "C", message: "c", tristate: true });
    modal._fire("click", { target: modal }); // 点背景
    assert.equal(await p3, "dismiss");
  } finally {
    globalThis.document = prevDoc;
  }
});

test("confirm-dialog：右上角 ❌(closeButton) 触发 dismiss", async () => {
  const prevDoc = globalThis.document;
  globalThis.document = { addEventListener() {} };
  try {
    const ok = mockEl();
    const cancel = mockEl();
    const closeButton = mockEl();
    const confirmAction = createConfirmDialog({ modal: mockEl(), titleElement: mockEl(), messageElement: mockEl(), confirmButton: ok, cancelButton: cancel, closeButton });
    const p = confirmAction({ title: "X", message: "x", tristate: true });
    closeButton._fire("click");
    assert.equal(await p, "dismiss");
  } finally {
    globalThis.document = prevDoc;
  }
});

test("confirm-dialog：confirmDelayMs 期间确认钮禁用、点击无效", async () => {
  const prevDoc = globalThis.document;
  globalThis.document = { addEventListener() {} };
  try {
    const ok = mockEl();
    const cancel = mockEl();
    const confirmAction = createConfirmDialog({ modal: mockEl(), titleElement: mockEl(), messageElement: mockEl(), confirmButton: ok, cancelButton: cancel });
    const p = confirmAction({ title: "X", message: "x", tristate: true, confirmDelayMs: 2000 });
    assert.equal(ok.disabled, true, "进入即禁用");
    ok._fire("click"); // 禁用期内点击应被忽略
    let settled = false;
    p.then(() => (settled = true));
    await Promise.resolve();
    assert.equal(settled, false, "禁用期内点击不决议");
    cancel._fire("click"); // 用取消收尾，避免悬挂
    assert.equal(await p, "cancel");
  } finally {
    globalThis.document = prevDoc;
  }
});
