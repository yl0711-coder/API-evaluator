import { extname } from "node:path";
import { envCompat } from "./env-compat.mjs";

const SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

// 部署适配：本地始终允许；额外的部署域名通过 env 配置（逗号分隔主机名）
const ALLOWED_HOSTS = [
  "127.0.0.1",
  "localhost",
  "[::1]",
  ...String(envCompat("ALLOWED_HOSTS") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
];

export function isAllowedBrowserOrigin(origin) {
  if (!origin) {
    return true;
  }
  try {
    const url = new URL(origin);
    return ALLOWED_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

export function staticSecurityHeaders(filePath) {
  if (extname(filePath) === ".html") {
    return SECURITY_HEADERS;
  }
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}
