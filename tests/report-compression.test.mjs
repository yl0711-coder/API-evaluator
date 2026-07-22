// tests/report-compression.test.mjs
// 老化报告原地 gzip 压缩：compressAgedReportFiles 只压超龄且未压缩的文件（幂等），
// readReportFileText 对 plain / gzip 文件都能透明读出原始文本。
//
// 注意：EVALUATOR_DATA_DIR 必须在本文件任何模块（含 server/paths.mjs）首次加载前设好——
// report-files.mjs 内部对 paths.mjs 是不带 query 的静态 import，一旦 paths.mjs 在本进程里
// 被加载过一次，其 REPORTS_DIR 常量就定死了；之后即便测试再对 report-files.mjs 做 `?case=`
// 换个 query 强制拿"新实例"，它内部那个静态 import 解析到的仍是同一个、已缓存的 paths.mjs，
// 不会跟着变。所以本文件全程共享一个 dataDir（像 tests/reports-ledger.test.mjs 那样），
// 每个测试用不重名的文件名避免互相干扰，而不是每个测试各起一个临时目录。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test, { after, before } from "node:test";

let REPORTS_DIR;
let compressAgedReportFiles;
let readReportFileText;
let dataDir;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "evaluator-report-compress-test-"));
  process.env.EVALUATOR_DATA_DIR = dataDir;
  const paths = await import("../server/paths.mjs");
  const reportFiles = await import("../server/report-files.mjs");
  REPORTS_DIR = paths.REPORTS_DIR;
  compressAgedReportFiles = reportFiles.compressAgedReportFiles;
  readReportFileText = reportFiles.readReportFileText;
  const { mkdir } = await import("node:fs/promises");
  await mkdir(REPORTS_DIR, { recursive: true });
});

after(async () => {
  delete process.env.EVALUATOR_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
});

// 把一个文件的 mtime 拨到 N 天前，模拟“老报告”。
async function ageFile(path, days) {
  const past = new Date(Date.now() - days * 24 * 3600 * 1000);
  await utimes(path, past, past);
}

test("compressAgedReportFiles: 只压超龄文件，新文件跳过", async () => {
  await writeFile(join(REPORTS_DIR, "old1.md"), "# 老报告\n内容", "utf8");
  await ageFile(join(REPORTS_DIR, "old1.md"), 40);
  await writeFile(join(REPORTS_DIR, "new1.md"), "# 新报告\n内容", "utf8");

  const compressed = await compressAgedReportFiles({ compressAfterDays: 30 });

  assert.ok(compressed.includes("old1.md"), "老文件应被压缩");
  assert.ok(!compressed.includes("new1.md"), "新文件不应被压缩");
  const oldBuf = await readFile(join(REPORTS_DIR, "old1.md"));
  assert.equal(oldBuf[0], 0x1f, "老文件应已被压缩为 gzip（magic byte 0x1f）");
  assert.equal(oldBuf[1], 0x8b);
  const newBuf = await readFile(join(REPORTS_DIR, "new1.md"));
  assert.equal(newBuf.slice(0, 2).toString("utf8"), "# ", "新文件应保持原样未压缩");
});

test("compressAgedReportFiles: 幂等，重复调用不会二次压缩已压缩文件", async () => {
  const path = join(REPORTS_DIR, "old2.html");
  await writeFile(path, "<html>老报告</html>", "utf8");
  await ageFile(path, 40);

  const first = await compressAgedReportFiles({ compressAfterDays: 30 });
  assert.ok(first.includes("old2.html"));
  const afterFirst = await readFile(path);

  const second = await compressAgedReportFiles({ compressAfterDays: 30 });
  assert.ok(!second.includes("old2.html"), "已压缩的文件不应再被压缩");
  const afterSecond = await readFile(path);
  assert.deepEqual(afterFirst, afterSecond, "内容应保持不变（未被二次压缩坏掉）");
});

test("compressAgedReportFiles: compressAfterDays 非法(NaN/负数)时整次跳过，不误压刚生成的报告", async () => {
  const path = join(REPORTS_DIR, "brandnew1.md");
  await writeFile(path, "# 刚生成的报告", "utf8"); // mtime = 此刻

  // NaN：算术上 `mtimeMs >= NaN` 恒为 false，若不加校验会导致"任何文件都判超龄"。
  const withNaN = await compressAgedReportFiles({ compressAfterDays: Number("not-a-number") });
  assert.deepEqual(withNaN, [], "NaN 配置应整次跳过，不压缩任何文件（含刚生成的）");

  // 负数同样是非法配置，不应导致提前压缩。
  const withNegative = await compressAgedReportFiles({ compressAfterDays: -5 });
  assert.deepEqual(withNegative, [], "负数配置应整次跳过");

  const buf = await readFile(path);
  assert.equal(buf.slice(0, 2).toString("utf8"), "# ", "文件应仍是明文，未被误压缩");
});

test("compressAgedReportFiles: 目录不存在时静默返回空列表", async () => {
  const { mkdir } = await import("node:fs/promises");
  await rm(REPORTS_DIR, { recursive: true, force: true });
  try {
    const compressed = await compressAgedReportFiles({ compressAfterDays: 30 });
    assert.deepEqual(compressed, []);
  } finally {
    await mkdir(REPORTS_DIR, { recursive: true }); // 恢复，供后续测试使用
  }
});

test("compressAgedReportFiles: 压缩后内容 gunzip 还原与原文一致", async () => {
  const original = "# 稳定性测试报告\n成功率 99%\n包含中文与换行\n";
  const path = join(REPORTS_DIR, "old3.md");
  await writeFile(path, original, "utf8");
  await ageFile(path, 31);

  await compressAgedReportFiles({ compressAfterDays: 30 });

  const { gunzipSync } = await import("node:zlib");
  const restored = gunzipSync(await readFile(path)).toString("utf8");
  assert.equal(restored, original);
});

test("readReportFileText: 明文文件按 utf8 原样读出", async () => {
  const path = join(REPORTS_DIR, "plain1.md");
  await writeFile(path, "# 明文报告", "utf8");
  assert.equal(await readReportFileText(path), "# 明文报告");
});

test("readReportFileText: 已被 gzip 的文件透明解压", async () => {
  const path = join(REPORTS_DIR, "gz1.md");
  const original = "# 被压缩的报告\n数据行";
  await writeFile(path, gzipSync(Buffer.from(original, "utf8")));
  assert.equal(await readReportFileText(path), original);
});

test("compressAgedReportFiles: 压缩不改变文件的 mtime（handleReportFilesList/模型对比按 mtime 排序，压缩不能让老报告看起来更新）", async () => {
  const path = join(REPORTS_DIR, "old5.md");
  await writeFile(path, "# 老报告\n用于验证 mtime 保持不变", "utf8");
  await ageFile(path, 40);
  const before = await stat(path);

  await compressAgedReportFiles({ compressAfterDays: 30 });

  const after = await stat(path);
  assert.equal(after.mtimeMs, before.mtimeMs, "压缩后 mtime 应与压缩前一致（不应刷新成当前时间）");
});

test("compressAgedReportFiles + readReportFileText: 端到端——压缩后仍能读出原文", async () => {
  const original = "<html><body>老报告正文</body></html>";
  const path = join(REPORTS_DIR, "old4.html");
  await writeFile(path, original, "utf8");
  await ageFile(path, 45);

  await compressAgedReportFiles({ compressAfterDays: 30 });
  assert.equal(await readReportFileText(path), original);

  const st = await stat(path);
  assert.ok(st.size < Buffer.byteLength(original, "utf8") + 50, "压缩后文件应变小（允许极小内容的 gzip 开销）");
});
