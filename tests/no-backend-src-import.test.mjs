// tests/no-backend-src-import.test.mjs
// 结构守卫：后端（server.mjs + server/**）不得 import 前端源目录 src/。
// 背景：生产 Dockerfile 的 runtime 阶段不打包 src/（前端经 vite build 成 dist/）。后端一旦
// import "../src/xxx"，线上镜像里该文件不存在 → 启动即 ERR_MODULE_NOT_FOUND 崩溃（0.5.7 升级事故）。
// 共享纯函数应放 shared/（随镜像打包）。此测试静态扫描后端源码，命中即失败，防止复发。
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function collectMjs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collectMjs(p, out);
    else if (name.endsWith(".mjs") || name.endsWith(".js")) out.push(p);
  }
  return out;
}

// 匹配 `from "../src/..."` / `"./src/..."`（一或多个 ./ 或 ../ 后接 src/）。
const SRC_IMPORT = /from\s+["'](?:\.\.?\/)+src\//;

test("后端不得 import 前端源目录 src/（生产镜像不打包 src/，引用会启动崩溃）", () => {
  const files = [join(root, "server.mjs"), ...collectMjs(join(root, "server"))];
  const offenders = [];
  for (const f of files) {
    readFileSync(f, "utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return; // 跳过注释
        if (SRC_IMPORT.test(line)) {
          offenders.push(`${f.replace(root, "").replace(/\\/g, "/")}:${i + 1}  ${trimmed}`);
        }
      });
  }
  assert.deepEqual(offenders, [], `后端文件不得引用前端 src/（应改用 shared/）：\n${offenders.join("\n")}`);
});
