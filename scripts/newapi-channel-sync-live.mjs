// scripts/newapi-channel-sync-live.mjs
//
// 对【真实 new-api】跑「渠道/模型推送」实测（可逆：跑完删除新建的测试渠道还原）。
// 不属于 tests/*.test.mjs。手动运行：
//   node --env-file=.env.evaluator scripts/newapi-channel-sync-live.mjs
//
// 流程：用唯一名新建一个测试渠道 → 校验已建 → 给它加一个模型（addModel）→ 校验 models 增加
//       → 删除该测试渠道还原。全程不碰任何已有渠道。
import { readConfig, authHeaders, isNewapiTagWriterConfigured } from "../server/newapi-tag-writer.mjs";
import { pushChannelToNewapi, addModelToNewapiChannel } from "../server/newapi-channel-sync.mjs";

async function callNewapi(cfg, method, path, bodyObj) {
  const init = { method, headers: { ...authHeaders(cfg) } };
  if (bodyObj !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = Buffer.from(JSON.stringify(bodyObj), "utf8");
  }
  const res = await fetch(`${cfg.base}${path}`, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  return body;
}

async function getChannel(cfg, id) {
  const body = await callNewapi(cfg, "GET", `/api/channel/${id}`);
  return body?.data || null;
}

async function main() {
  if (!isNewapiTagWriterConfigured()) {
    console.error("未配置 new-api。用：node --env-file=.env.evaluator scripts/newapi-channel-sync-live.mjs");
    process.exitCode = 1;
    return;
  }
  const cfg = readConfig();
  console.log(`目标 new-api：${cfg.base}（New-Api-User=${cfg.userId}）`);

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "");
  const testChannel = {
    name: `评测推送测试-${stamp}`,
    provider: "OpenAI",
    baseUrl: "https://api.example-eval-test.com",
    protocol: "openai_compatible",
    models: ["eval-probe-a"],
    newapiChannelId: null,
  };

  let newId = null;
  try {
    console.log(`\n[1/4] 推送新建测试渠道「${testChannel.name}」…`);
    const r1 = await pushChannelToNewapi(testChannel, "sk-eval-test-key");
    newId = r1.newapiChannelId;
    console.log(`  action=${r1.action} newapiChannelId=${newId}`);
    if (!newId) throw new Error("未拿到新渠道 id，无法继续/清理。");

    console.log("\n[2/4] 校验渠道已建…");
    const got = await getChannel(cfg, newId);
    console.log(`  new-api 渠道：name=「${got?.name}」 type=${got?.type} models=「${got?.models}」`);
    const okCreate = got && got.name === testChannel.name && String(got.models || "").includes("eval-probe-a");
    console.log(`  新建校验：${okCreate ? "✓" : "✗"}`);

    console.log("\n[3/4] 给该渠道加模型 eval-probe-b…");
    const r2 = await addModelToNewapiChannel(newId, "eval-probe-b");
    const got2 = await getChannel(cfg, newId);
    const okAdd = r2.added && String(got2.models || "").split(",").includes("eval-probe-b");
    console.log(`  added=${r2.added} models=「${got2?.models}」 → 加模型校验：${okAdd ? "✓" : "✗"}`);
    // 幂等：再加一次应 unchanged
    const r3 = await addModelToNewapiChannel(newId, "eval-probe-b");
    console.log(`  幂等复跑 added=${r3.added}（应 false）→ ${r3.added === false ? "✓" : "✗"}`);

    const allOk = okCreate && okAdd && r3.added === false;
    console.log(`\n=== 实测${allOk ? "通过 ✓" : "存在问题 ✗"} ===`);
    process.exitCode = allOk ? 0 : 1;
  } catch (e) {
    console.error("实测异常：", e.message);
    process.exitCode = 1;
  } finally {
    if (newId) {
      console.log(`\n[4/4] 清理：删除测试渠道 id=${newId} …`);
      try {
        await callNewapi(cfg, "DELETE", `/api/channel/${newId}`);
        const gone = await getChannel(cfg, newId).catch(() => null);
        console.log(`  ${gone ? "✗ 仍存在(请人工删除)" : "✓ 已删除，环境还原"}`);
      } catch (e) {
        console.error(`  删除失败（请人工删除 id=${newId}）：`, e.message);
      }
    }
  }
}

main();
