// server/secret-store.mjs
// 加密密钥库：API Key 经系统钥匙串或本地 AES-GCM 文件库加密存储，按 profile 读写/删除。
// 明文密钥仅在请求时临时取出，绝不返回浏览器、绝不入日志。
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { LOCAL_SECRET_FILE, LOCAL_VAULT_FILE } from "./paths.mjs";
import { envCompat } from "./env-compat.mjs";

const KEYCHAIN_SERVICE = "Model Evaluator";
const execFileAsync = promisify(execFile);
const TEST_SECRETS = new Map();

// Keep the public profile record stable while allowing the storage backend to
// change between macOS Keychain and the encrypted local fallback.
export function buildApiKeyRef(profileId) {
  return `profile:${profileId}:api-key`;
}

export function getSecretStorageName() {
  if (isTestSecretStore()) return "test-memory-vault";
  return process.platform === "darwin" ? "macos-keychain" : "local-encrypted-vault";
}

export async function saveProfileApiKey(profileId, apiKey) {
  const ref = buildApiKeyRef(profileId);
  if (isTestSecretStore()) {
    TEST_SECRETS.set(ref, apiKey);
    return { ref, storage: "test-memory-vault" };
  }
  if (process.platform === "darwin") {
    try {
      await execFileAsync("security", ["add-generic-password", "-a", ref, "-s", KEYCHAIN_SERVICE, "-w", apiKey, "-U"]);
      return { ref, storage: "macos-keychain" };
    } catch {
      // Development shells may not have Keychain access; keep a local encrypted fallback.
    }
  }
  await writeLocalVaultSecret(ref, apiKey);
  return { ref, storage: "local-encrypted-vault" };
}

export async function readProfileApiKey(profile) {
  // 若 profile 直接带明文 key 则优先用它；真实渠道走 apiKeyRef 从密钥库取，不带明文，行为不变。
  if (profile?.apiKey) {
    return profile.apiKey;
  }
  if (!profile?.apiKeyRef) {
    return "";
  }
  if (isTestSecretStore()) {
    return TEST_SECRETS.get(profile.apiKeyRef) || "";
  }
  if (profile.keyStorage === "macos-keychain" || process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-a",
        profile.apiKeyRef,
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ]);
      return String(stdout || "").trim();
    } catch {
      if (profile.keyStorage === "macos-keychain") {
        return "";
      }
    }
  }
  return readLocalVaultSecret(profile.apiKeyRef);
}

export async function deleteProfileApiKey(profile) {
  const ref = profile?.apiKeyRef || buildApiKeyRef(profile?.id || "");
  if (!ref) return;
  if (isTestSecretStore()) {
    TEST_SECRETS.delete(ref);
    return;
  }
  if (profile?.keyStorage === "macos-keychain" || process.platform === "darwin") {
    try {
      await execFileAsync("security", ["delete-generic-password", "-a", ref, "-s", KEYCHAIN_SERVICE]);
    } catch {
      // Missing keychain items are harmless during delete.
    }
  }
  await deleteLocalVaultSecret(ref);
}

async function readLocalVaultSecret(ref) {
  if (!existsSync(LOCAL_SECRET_FILE)) {
    return "";
  }
  const vault = await loadLocalVault();
  const encrypted = vault[ref];
  if (!encrypted) {
    return "";
  }
  try {
    return decryptLocalSecret(encrypted);
  } catch {
    return "";
  }
}

async function writeLocalVaultSecret(ref, value) {
  const vault = await loadLocalVault();
  await ensureLocalSecretKey();
  vault[ref] = encryptLocalSecret(value);
  await mkdir(dirname(LOCAL_VAULT_FILE), { recursive: true });
  await writeFile(LOCAL_VAULT_FILE, JSON.stringify(vault, null, 2), "utf8");
}

async function deleteLocalVaultSecret(ref) {
  if (!existsSync(LOCAL_VAULT_FILE)) {
    return;
  }
  const vault = await loadLocalVault();
  if (!Object.prototype.hasOwnProperty.call(vault, ref)) {
    return;
  }
  delete vault[ref];
  await writeFile(LOCAL_VAULT_FILE, JSON.stringify(vault, null, 2), "utf8");
}

async function loadLocalVault() {
  if (!existsSync(LOCAL_VAULT_FILE)) {
    return {};
  }
  const raw = await readFile(LOCAL_VAULT_FILE, "utf8");
  return JSON.parse(raw || "{}");
}

async function ensureLocalSecretKey() {
  if (existsSync(LOCAL_SECRET_FILE)) return;
  const value = crypto.randomBytes(32).toString("hex");
  await mkdir(dirname(LOCAL_SECRET_FILE), { recursive: true });
  await writeFile(LOCAL_SECRET_FILE, value, { encoding: "utf8", mode: 0o600 });
}

function deriveLocalEncryptionKey(secret, salt) {
  return crypto.scryptSync(secret, salt, 32);
}

function encryptLocalSecret(value) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const secret = existsSync(LOCAL_SECRET_FILE) ? crypto.createHash("sha256").update(readFileSyncText(LOCAL_SECRET_FILE)).digest("hex") : "";
  if (!secret) {
    throw new Error("本地密钥文件不可用。");
  }
  const key = deriveLocalEncryptionKey(secret, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return {
    version: 1,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptLocalSecret(payload) {
  const salt = Buffer.from(payload.salt, "base64");
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");
  const secret = crypto.createHash("sha256").update(readFileSyncText(LOCAL_SECRET_FILE)).digest("hex");
  const key = deriveLocalEncryptionKey(secret, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function readFileSyncText(file) {
  return readFileSync(file, "utf8");
}

function isTestSecretStore() {
  return envCompat("SECRET_STORE") === "memory";
}
