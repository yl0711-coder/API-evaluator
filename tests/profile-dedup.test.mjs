import assert from "node:assert/strict";
import test from "node:test";

import { hashApiKey, findDuplicateProfile } from "../server/profile-store.mjs";

test("hashApiKey：相同 key 同指纹，不同 key 不同指纹，空为 null", () => {
  assert.equal(hashApiKey("sk-abc"), hashApiKey("sk-abc"));
  assert.notEqual(hashApiKey("sk-abc"), hashApiKey("sk-xyz"));
  assert.equal(hashApiKey(""), null);
  assert.match(hashApiKey("sk-abc"), /^[0-9a-f]{64}$/);
});

const H1 = hashApiKey("key-1");
const H2 = hashApiKey("key-2");
const profiles = [
  { id: "a", name: "渠道A", baseUrl: "https://api.example.com", defaultModel: "gpt-4o", keyHash: H1 },
];

test("findDuplicateProfile：URL+模型+Key 全一致 → 判重(忽略末尾斜杠)", async () => {
  const dup = await findDuplicateProfile(profiles, { id: "", baseUrl: "https://api.example.com/", defaultModel: "gpt-4o", keyHash: H1 });
  assert.ok(dup);
  assert.equal(dup.id, "a");
});

test("findDuplicateProfile：Key 不同 → 不算重复", async () => {
  const dup = await findDuplicateProfile(profiles, { id: "", baseUrl: "https://api.example.com", defaultModel: "gpt-4o", keyHash: H2 });
  assert.equal(dup, null);
});

test("findDuplicateProfile：模型不同 → 不算重复", async () => {
  const dup = await findDuplicateProfile(profiles, { id: "", baseUrl: "https://api.example.com", defaultModel: "gpt-4o-mini", keyHash: H1 });
  assert.equal(dup, null);
});

test("findDuplicateProfile：URL 不同 → 不算重复", async () => {
  const dup = await findDuplicateProfile(profiles, { id: "", baseUrl: "https://other.example.com", defaultModel: "gpt-4o", keyHash: H1 });
  assert.equal(dup, null);
});

test("findDuplicateProfile：编辑自身(同 id) → 不判自己重复", async () => {
  const dup = await findDuplicateProfile(profiles, { id: "a", baseUrl: "https://api.example.com", defaultModel: "gpt-4o", keyHash: H1 });
  assert.equal(dup, null);
});

test("findDuplicateProfile：候选无 keyHash → 不判重(无法确认 key 一致)", async () => {
  const dup = await findDuplicateProfile(profiles, { id: "", baseUrl: "https://api.example.com", defaultModel: "gpt-4o", keyHash: null });
  assert.equal(dup, null);
});
