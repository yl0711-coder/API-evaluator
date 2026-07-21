// scripts/migrate-timeout-to-300000.mjs
// 一次性数据迁移：把已存渠道 / 模型目标里旧默认超时 timeoutMs===60000 改成 300000（5 分钟）。
// 背景：渠道默认超时由 60s 上调到 5min（见 test-runner.mjs 与渠道表单）。默认值只影响新建/缺省，
// 已存渠道仍保留当初写入的 60000，需要本迁移把它们抬到新默认。
//
// 语义：仅精确匹配 60000 的值才改（保留用户刻意设的其它值，如 120000/90000）；幂等（重复运行无副作用）。
// 数据位置由 server/paths.mjs 决定，遵循 EVALUATOR_DATA_DIR 环境变量——本地跑改本地，容器里跑改 /data。
//
// 用法：
//   node scripts/migrate-timeout-to-300000.mjs          # 执行迁移
//   node scripts/migrate-timeout-to-300000.mjs --dry-run # 只报告将改动多少条，不写盘
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { CHANNELS_FILE, PROFILES_FILE } from "../server/paths.mjs";
import { writeJsonAtomic } from "../server/utils.mjs";

const OLD = 60000;
const NEW = 300000;
const dryRun = process.argv.includes("--dry-run");

async function migrateFile(file, label) {
  if (!existsSync(file)) {
    console.log(`- ${label}: 文件不存在，跳过（${file}）`);
    return { scanned: 0, changed: 0 };
  }
  let list;
  try {
    list = JSON.parse((await readFile(file, "utf8")) || "[]");
  } catch (e) {
    console.log(`- ${label}: 解析失败，跳过（${e.message}）`);
    return { scanned: 0, changed: 0 };
  }
  if (!Array.isArray(list)) {
    console.log(`- ${label}: 非数组，跳过`);
    return { scanned: 0, changed: 0 };
  }
  let changed = 0;
  for (const item of list) {
    if (item && Number(item.timeoutMs) === OLD) {
      item.timeoutMs = NEW;
      changed += 1;
    }
  }
  if (changed && !dryRun) await writeJsonAtomic(file, list);
  console.log(
    `- ${label}: 共 ${list.length} 条，${changed} 条 timeoutMs ${OLD}→${NEW}` +
      (changed && dryRun ? "（dry-run 未写盘）" : changed ? "（已写盘）" : "（无需改动）"),
  );
  return { scanned: list.length, changed };
}

console.log(`迁移超时默认值 ${OLD} → ${NEW}${dryRun ? "（DRY-RUN）" : ""}`);
const ch = await migrateFile(CHANNELS_FILE, "channels.json");
const pr = await migrateFile(PROFILES_FILE, "profiles.json");
const total = ch.changed + pr.changed;
console.log(`完成：合计改动 ${total} 条${dryRun ? "（未写盘，去掉 --dry-run 实际执行）" : ""}。`);
