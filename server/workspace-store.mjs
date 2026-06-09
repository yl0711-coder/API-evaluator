import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACES_DIR } from "./paths.mjs";
import { redactSensitiveText } from "./utils.mjs";

export async function saveRunArtifacts(runId, artifacts, options = {}) {
  const rootDir = options.rootDir || WORKSPACES_DIR;
  const workspaceDir = join(rootDir, sanitizeWorkspaceSegment(runId));
  await mkdir(workspaceDir, { recursive: true });

  const rawJsonPath = join(workspaceDir, "result.json");
  const json = redactSensitiveText(JSON.stringify(artifacts || {}, null, 2));
  await writeFile(rawJsonPath, `${json}\n`, "utf8");

  return {
    workspaceDir,
    rawJsonPath,
  };
}

export function sanitizeWorkspaceSegment(value) {
  const safe = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[._-]+/, "")
    .slice(0, 120);
  return safe || "run";
}
