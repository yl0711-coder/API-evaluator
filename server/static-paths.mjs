import { isAbsolute, relative, resolve } from "node:path";

export function getRawRequestPathname(requestUrl) {
  const raw = String(requestUrl || "/");
  const absoluteMatch = raw.match(/^[a-z][a-z\d+.-]*:\/\/[^/]*(\/[^?#]*)?/i);
  if (absoluteMatch) {
    return absoluteMatch[1] || "/";
  }
  return raw.split(/[?#]/, 1)[0] || "/";
}

export function resolveRequestPathInside(root, requestPath, fallback = "index.html") {
  const rootPath = resolve(root);
  const decodedPath = safeDecodePath(requestPath || "/");
  const normalizedPath = decodedPath.replace(/\\/g, "/");
  const relativePath = normalizedPath === "/" ? fallback : normalizedPath.replace(/^\/+/, "");
  const targetPath = resolve(rootPath, relativePath || fallback);
  const boundary = relative(rootPath, targetPath);

  if (boundary === "" || (!boundary.startsWith("..") && !isAbsolute(boundary))) {
    return targetPath;
  }

  return "";
}

function safeDecodePath(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}
