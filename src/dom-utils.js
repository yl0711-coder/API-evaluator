export function requireElement(selector, root = document) {
  const element = root.querySelector(selector);
  if (!element) {
    throw new Error(`页面缺少必要元素：${selector}`);
  }
  return element;
}

export function requireElements(selector, root = document) {
  const elements = Array.from(root.querySelectorAll(selector));
  if (elements.length === 0) {
    throw new Error(`页面缺少必要元素集合：${selector}`);
  }
  return elements;
}
