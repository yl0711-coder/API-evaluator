// server/model-target-store.mjs
// 测试模型目标存储：SQLite(model_targets 表) + JSON 兜底。
// model-target 只是 {channelId, model, note}，不含任何密钥，浏览器可直接见。
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MODEL_TARGETS_FILE } from "./paths.mjs";
import { loadModelTargets as dbLoad, saveModelTargets as dbSave } from "./db.mjs";

export async function loadModelTargets() {
  const fromDb = await dbLoad();
  if (fromDb !== null) return fromDb;
  if (!existsSync(MODEL_TARGETS_FILE)) return [];
  return JSON.parse((await readFile(MODEL_TARGETS_FILE, "utf8")) || "[]");
}

export async function saveModelTargets(targets) {
  if (await dbSave(targets)) return;
  await mkdir(dirname(MODEL_TARGETS_FILE), { recursive: true });
  await writeFile(MODEL_TARGETS_FILE, JSON.stringify(targets, null, 2), "utf8");
}
