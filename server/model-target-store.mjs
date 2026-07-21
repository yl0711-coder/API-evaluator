// server/model-target-store.mjs
// 测试模型目标存储：SQLite(model_targets 表) 为主，JSON 仅在【SQLite 不可用时】兜底（saveModelTargets
// 见下：DB 写成功就 return，健康时 model-targets.json 不写、不是实时镜像）。DB 损坏时读到的是旧 JSON，
// 非恢复来源——与 channel-store 同理。model-target 只是 {channelId, model, note}，不含密钥，浏览器可直接见。
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { MODEL_TARGETS_FILE } from "./paths.mjs";
import { loadModelTargets as dbLoad, saveModelTargets as dbSave } from "./db.mjs";
import { writeJsonAtomic } from "./utils.mjs";

export async function loadModelTargets() {
  const fromDb = await dbLoad();
  if (fromDb !== null) return fromDb;
  if (!existsSync(MODEL_TARGETS_FILE)) return [];
  return JSON.parse((await readFile(MODEL_TARGETS_FILE, "utf8")) || "[]");
}

export async function saveModelTargets(targets) {
  if (await dbSave(targets)) return;
  await writeJsonAtomic(MODEL_TARGETS_FILE, targets);
}
