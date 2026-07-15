// 复制到剪贴板：优先用 Clipboard API，失败则降级到 execCommand。
// 两个坑都必须防：
//  1) navigator.clipboard「存在」≠ 调用会成功——嵌 iframe、Permissions-Policy 未授权、
//     document 失焦（Chrome 抛 "Document is not focused"）都会让 writeText 拒绝。
//     故必须 try/catch 兜到降级路径，而不是只做存在性判断。
//  2) document.execCommand("copy") 失败时不抛错、只返回 false——必须接返回值，
//     否则会静默 resolve，调用方照样弹「已复制」，用户粘贴时才发现剪贴板是空的。
// 失败时统一抛错，由调用方 catch 出错误提示（绝不能让「没复制成功」看起来像成功）。
export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 被拒 → 继续走下面的降级路径
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", ""); // iOS 上非只读会拉起键盘
  textarea.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length); // iOS Safari 下 select() 不足以选中
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    textarea.remove();
  }
  if (!ok) throw new Error("浏览器拒绝了复制操作，请手动选中文本复制。");
}
