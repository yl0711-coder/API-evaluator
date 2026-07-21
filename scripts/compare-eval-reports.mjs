// 模型对比（第一阶段 POC 入口）：读 Evaluation Report/ 下两个文件夹里的评测报告，
// 聚合对比、产出一份 Markdown 对比报告。看效果用；核心逻辑在 server/report-compare.mjs。
//
// 用法：
//   node scripts/compare-eval-reports.mjs
//   node scripts/compare-eval-reports.mjs "<文件夹A>" "<文件夹B>"
// 不传参时默认对比 Evaluation Report/新建文件夹 与 Evaluation Report/新建文件夹 (2)。
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateSubject, buildComparison, formatCompareReportMarkdown } from "../server/report-compare.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EVAL_DIR = join(ROOT, "Evaluation Report");

async function readFolder(dir) {
  const names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith(".md"));
  const files = await Promise.all(
    names.map(async (name) => ({ name, md: await readFile(join(dir, name), "utf8") })),
  );
  return files;
}

async function main() {
  const [argA, argB] = process.argv.slice(2);
  const dirA = argA || join(EVAL_DIR, "新建文件夹");
  const dirB = argB || join(EVAL_DIR, "新建文件夹 (2)");

  const filesA = await readFolder(dirA);
  const filesB = await readFolder(dirB);
  if (!filesA.length || !filesB.length) {
    console.error(`两个文件夹都要至少有一份 .md 报告：\n  A(${dirA}) = ${filesA.length} 份\n  B(${dirB}) = ${filesB.length} 份`);
    process.exit(1);
  }

  const a = aggregateSubject({ files: filesA });
  const b = aggregateSubject({ files: filesB });
  const cmp = buildComparison(a, b);
  const markdown = formatCompareReportMarkdown(cmp);

  const slug = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, "_").replace(/_+/g, "_").slice(0, 40);
  const outName = `对比报告_${slug(a.label)}_vs_${slug(b.label)}.md`;
  const outPath = join(EVAL_DIR, outName);
  await writeFile(outPath, markdown, "utf8");

  // 控制台摘要，便于「看效果」。
  console.log("已生成对比报告：", outPath);
  console.log("");
  console.log(`对象 A：${a.label}（报告 ${a.reportCounts.total} 份）`);
  console.log(`对象 B：${b.label}（报告 ${b.reportCounts.total} 份）`);
  console.log("");
  console.log(`稳定性成功率判定：${cmp.verdicts.stability.verdict}`);
  console.log(`场景通过率判定：${cmp.verdicts.scenarioPass.verdict}`);
  console.log(`场景质量：A 均分 ${fmt(a.quality.mean)} / B 均分 ${fmt(b.quality.mean)}（配对场景 ${cmp.scenarioQuality.matched.length} 个）`);
}

function fmt(v) {
  return v == null || Number.isNaN(v) ? "-" : Math.round(Number(v));
}

main().catch((err) => {
  console.error("对比失败：", err?.stack || err);
  process.exit(1);
});
