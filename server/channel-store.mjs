// server/channel-store.mjs
// 渠道存储：SQLite(channels 表) + JSON 兜底。明文 key 经 secret-store 加密落库，
// 渠道记录只存 apiKeyRef + keyHash（单向指纹，判重用），明文绝不落库 / 不下发浏览器。
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { CHANNELS_FILE } from "./paths.mjs";
import { writeJsonAtomic } from "./utils.mjs";
import { loadChannels as dbLoadChannels, saveChannels as dbSaveChannels } from "./db.mjs";
import { deleteProfileApiKey, readProfileApiKey, saveProfileApiKey } from "./secret-store.mjs";
import { hashApiKey, loadProfiles } from "./profile-store.mjs";
import { channelDedupKey, migrateProfileToChannelAndTarget } from "./channel-model.mjs";
import { loadModelTargets, saveModelTargets } from "./model-target-store.mjs";

export async function loadChannels() {
  const fromDb = await dbLoadChannels();
  if (fromDb !== null) return fromDb;
  if (!existsSync(CHANNELS_FILE)) return [];
  return JSON.parse((await readFile(CHANNELS_FILE, "utf8")) || "[]");
}

export async function saveChannels(channels) {
  if (await dbSaveChannels(channels)) return;
  await writeJsonAtomic(CHANNELS_FILE, channels);
}

// 把明文 key 存进加密库，返回带 apiKeyRef/keyStorage/hasKey/keyHash 的渠道（明文不落库）。
export async function attachChannelKey(channel, apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) return channel;
  const info = await saveProfileApiKey(channel.id, key);
  return { ...channel, apiKeyRef: info.ref, keyStorage: info.storage, hasKey: true, keyHash: hashApiKey(key) };
}

export const readChannelApiKey = (channel) => readProfileApiKey(channel);
export const deleteChannelApiKey = (channel) => deleteProfileApiKey(channel);

// 查重：同 baseUrl + 同 keyHash 视为同一渠道（模型不参与，模型在 model-target 层）。
export async function findDuplicateChannel(channels, candidate) {
  if (!candidate?.keyHash) return null;
  const key = channelDedupKey(candidate);
  return (channels || []).find((c) => c.id !== candidate.id && c.keyHash && channelDedupKey(c) === key) || null;
}

// 浏览器安全视图：抹掉 apiKeyRef/keyStorage/keyHash，只给 hasKey + 占位。
export function maskChannel(channel) {
  const { apiKeyRef, keyStorage, keyHash, ...rest } = channel;
  const hasKey = Boolean(channel.hasKey || channel.apiKeyRef);
  return { ...rest, hasKey, apiKey: hasKey ? "已安全保存" : "" };
}

// 一次性迁移：渠道为空且有老 profile → 拆成 channel + model-target 落库。
// 不删 profiles（保留兜底，迁移有误可重来）；deterministic id 让重复执行不产生重复。
export async function migrateProfilesToChannelsIfEmpty() {
  const channels = await loadChannels();
  if (channels.length) return { migrated: 0, reason: "channels-exist" };
  const profiles = await loadProfiles();
  if (!profiles.length) return { migrated: 0, reason: "no-profiles" };

  const newChannels = [];
  const newTargets = [];
  for (const profile of profiles) {
    const { channel, target } = migrateProfileToChannelAndTarget(profile);
    newChannels.push(channel);
    if (target.model) newTargets.push(target);
  }
  await saveChannels(newChannels);

  const existingTargets = await loadModelTargets();
  const merged = [...existingTargets];
  for (const target of newTargets) {
    if (!merged.some((item) => item.id === target.id)) merged.push(target);
  }
  await saveModelTargets(merged);
  return { migrated: newChannels.length, targets: newTargets.length };
}
