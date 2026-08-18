import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { APP_VERSION } from "../server/version.mjs";

async function readProjectFile(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("发布身份：应用、Compose、README 和 CHANGELOG 必须使用同一版本", async () => {
  const pkg = JSON.parse(await readProjectFile("package.json"));
  const version = pkg.version;
  const [compose, readme, changelog] = await Promise.all([
    readProjectFile("deploy/docker-compose.evaluator.yml"),
    readProjectFile("README.md"),
    readProjectFile("CHANGELOG.md"),
  ]);

  assert.equal(APP_VERSION, version, "/api/health 使用的版本必须来自当前 package.json");
  assert.ok(compose.includes(`api-evaluator:${version}`), "Compose 默认镜像必须是当前发布版本");
  assert.ok(readme.includes(`docker build -t api-evaluator:${version} .`), "README 构建命令必须是当前发布版本");
  assert.ok(changelog.includes(`## [${version}]`), "CHANGELOG 必须有当前发布版本段");
});
