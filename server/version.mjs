import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 单一版本来源：读 package.json，避免多处硬编码版本号不一致。
let version = "0.0.0";
try {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  if (pkg && pkg.version) version = pkg.version;
} catch {
  // 读不到 package.json（极少见）时回退占位版本，不影响运行。
}

export const APP_VERSION = version;
