import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("compose does not give application containers Docker socket access", async () => {
  const compose = await readFile(join(root, "deploy", "docker-compose.evaluator.yml"), "utf8");
  const manifest = compose
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(manifest, /docker\.sock/i);
  assert.doesNotMatch(manifest, /\bautoheal\b/i);
});

test("host recovery is a fixed-target systemd timer", async () => {
  const deploy = join(root, "deploy");
  const [script, service, timer] = await Promise.all([
    readFile(join(deploy, "api-evaluator-health-recovery.sh"), "utf8"),
    readFile(join(deploy, "api-evaluator-health-recovery.service"), "utf8"),
    readFile(join(deploy, "api-evaluator-health-recovery.timer"), "utf8"),
  ]);

  assert.match(script, /container_name="api-evaluator"/);
  assert.match(script, /health_status=.*docker inspect/);
  assert.match(script, /\[ "\$health_status" = "unhealthy" \] \|\| exit 0/);
  assert.match(script, /docker restart --time 30 "\$container_name"/);
  assert.match(service, /ExecStart=\/usr\/local\/lib\/api-evaluator\/api-evaluator-health-recovery\.sh/);
  assert.match(service, /ProtectSystem=strict/);
  assert.match(timer, /OnUnitActiveSec=30s/);
  assert.match(timer, /Unit=api-evaluator-health-recovery\.service/);
});
