// scripts/newapi-tag-writer-live.mjs
//
// 对【真实 new-api】跑「推送标签」写入实测（有副作用，默认可逆：跑完还原）。
// 不属于 tests/*.test.mjs，npm test 永不触发；需手动运行：
//
//   node --env-file=.env.evaluator scripts/newapi-tag-writer-live.mjs
//   node --env-file=.env.evaluator scripts/newapi-tag-writer-live.mjs --model gpt-4o
//   node --env-file=.env.evaluator scripts/newapi-tag-writer-live.mjs --no-cleanup   # 保留写入，不还原
//   node --env-file=.env.evaluator scripts/newapi-tag-writer-live.mjs --push-real    # 跑真实聚合推送(本平台已授标签)，仅报告不还原
//
// 默认流程（可逆）：快照靶模型原始 tags → 实写唯一中文标记标签 → 校验合并/UTF-8 → 幂等复跑 → 还原原值。

import {
  isNewapiTagWriterConfigured,
  readConfig,
  fetchAllModels,
  pushModelTagsToNewapi,
} from "../server/newapi-tag-writer.mjs";
import { loadModelTargets } from "../server/model-target-store.mjs";

function parseArgs(argv) {
  const args = { model: "", cleanup: true, pushReal: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") args.model = argv[++i] || "";
    else if (a === "--no-cleanup") args.cleanup = false;
    else if (a === "--push-real") args.pushReal = true;
  }
  return args;
}

// 原始整条 PUT（用于还原：写回快照对象，去掉标记标签）。复刻主模块写回契约（双头 + UTF-8 字节）。
async function rawPut(cfg, model) {
  const res = await fetch(`${cfg.base}/api/models/`, {
    method: "PUT",
    headers: { Authorization: cfg.token, "New-Api-User": cfg.userId, "Content-Type": "application/json" },
    body: Buffer.from(JSON.stringify(model), "utf8"),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`还原 PUT 失败 HTTP ${res.status}`);
  if (body && body.success === false) throw new Error(body.message || "还原返回 success=false");
}

const tagsOf = (models, name) => {
  const m = models.find((x) => x.model_name === name);
  return m ? String(m.tags || "") : null;
};

async function pushReal(cfg) {
  console.log("\n=== --push-real：真实聚合推送（本平台已授予标签，等价端点逻辑）===");
  const targets = await loadModelTargets();
  const tagSets = {};
  for (const t of targets) {
    const tags = Array.isArray(t.tags) ? t.tags : [];
    if (!t.model || !tags.length) continue;
    (tagSets[t.model] ||= new Set());
    tags.forEach((x) => tagSets[t.model].add(x));
  }
  const tagMap = Object.fromEntries(Object.entries(tagSets).map(([k, v]) => [k, [...v]]));
  const modelCount = Object.keys(tagMap).length;
  if (!modelCount) {
    console.log("本平台没有已授予标签的模型目标（先跑场景测试得标签）。不推送。");
    return;
  }
  console.log(`聚合得 ${modelCount} 个模型的标签，开始真实写入（不还原）…`);
  const summary = await pushModelTagsToNewapi(tagMap);
  console.log("汇总：", JSON.stringify(summary, null, 2));
}

async function main() {
  const args = parseArgs(process.argv);
  if (!isNewapiTagWriterConfigured()) {
    console.error(
      "未配置 new-api。请用：node --env-file=.env.evaluator scripts/newapi-tag-writer-live.mjs\n" +
        "并确认 .env.evaluator 里 EVALUATOR_NEWAPI_BASE_URL + EVALUATOR_NEWAPI_IMPORT_TOKEN 已填。",
    );
    process.exitCode = 1;
    return;
  }
  const cfg = readConfig();
  console.log(`目标 new-api：${cfg.base}（New-Api-User=${cfg.userId}）`);

  if (args.pushReal) {
    await pushReal(cfg);
    return;
  }

  // 1) 快照
  console.log("\n[1/5] 拉取真实模型列表，建立快照…");
  const before = await fetchAllModels(cfg);
  console.log(`  共 ${before.length} 个模型。`);
  if (!before.length) {
    console.error("new-api 没有任何模型，无法实测。");
    process.exitCode = 1;
    return;
  }
  // 选靶：优先带标签者（顺带验证「合并不覆盖」），否则取第一个。
  const target =
    (args.model && before.find((m) => m.model_name === args.model)) ||
    before.find((m) => String(m.tags || "").length) ||
    before[0];
  if (args.model && target.model_name !== args.model) {
    console.error(`未找到 --model "${args.model}"，可选示例：${before.slice(0, 8).map((m) => m.model_name).join(", ")} …`);
    process.exitCode = 1;
    return;
  }
  const targetName = target.model_name;
  const originalTags = String(target.tags || "");
  const snapshot = { ...target }; // 整条快照，供还原
  const marker = `评测连通-${new Date().toISOString().slice(0, 10)}`; // 含中文，验 UTF-8
  console.log(`  靶模型：「${targetName}」 原始 tags：「${originalTags || "(空)"}」`);
  console.log(`  将写入标记标签：「${marker}」`);

  // 2) 实写
  console.log("\n[2/5] 真实写入（PUT）…");
  const s1 = await pushModelTagsToNewapi({ [targetName]: [marker] });
  console.log(`  汇总：matched=${s1.matched} updated=${s1.updated} unchanged=${s1.unchanged} errors=${s1.errors.length}`);
  if (s1.errors.length) console.log("  错误：", JSON.stringify(s1.errors));

  // 3) 校验
  console.log("\n[3/5] 复查写入结果…");
  const after = await fetchAllModels(cfg);
  const newTags = tagsOf(after, targetName);
  const newList = newTags.split(",");
  const okMarker = newList.includes(marker);
  const okPreserve = originalTags.split(/[，,]/).map((x) => x.trim()).filter(Boolean).every((t) => newList.includes(t));
  console.log(`  写后 tags：「${newTags}」`);
  console.log(`  标记已写入：${okMarker ? "✓" : "✗"}；原标签保留：${okPreserve ? "✓" : "✗"}（合并不覆盖）；UTF-8 无乱码：${okMarker ? "✓" : "✗"}`);

  // 4) 幂等
  console.log("\n[4/5] 幂等复跑（应 unchanged）…");
  const s2 = await pushModelTagsToNewapi({ [targetName]: [marker] });
  const idempotent = s2.unchanged === 1 && s2.updated === 0;
  console.log(`  汇总：updated=${s2.updated} unchanged=${s2.unchanged} → 幂等：${idempotent ? "✓" : "✗"}`);

  // 5) 还原
  if (args.cleanup) {
    console.log("\n[5/5] 还原靶模型 tags 到测试前快照…");
    await rawPut(cfg, snapshot);
    const restored = await fetchAllModels(cfg);
    const restoredTags = tagsOf(restored, targetName);
    const ok = restoredTags === originalTags;
    console.log(`  还原后 tags：「${restoredTags || "(空)"}」 → ${ok ? "✓ 已恢复原样" : "✗ 与原始不一致(请人工核对)"}`);
  } else {
    console.log("\n[5/5] --no-cleanup：保留写入，不还原。");
  }

  const allOk = okMarker && okPreserve && idempotent && !s1.errors.length;
  console.log(`\n=== 实测${allOk ? "通过 ✓" : "存在问题 ✗（见上）"} ===`);
  process.exitCode = allOk ? 0 : 1;
}

// 用 exitCode 而非 process.exit()：避免 Windows 上 fetch keep-alive 套接字关闭中途被强退，
// 触发 libuv 的 UV_HANDLE_CLOSING 断言。让事件循环自然 drain 后退出。
main().catch((e) => {
  console.error("实测异常：", e);
  process.exitCode = 1;
});
