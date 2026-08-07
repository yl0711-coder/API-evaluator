import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(join(__dirname, "../评测数据/evaluator.db"));

// Most recent 5 scenario runs
// First check schema
const trSchema = db.prepare("PRAGMA table_info(test_runs)").all();
console.log("test_runs cols:", trSchema.map((c) => c.name).join(", "));

const runs = db.prepare("SELECT run_id FROM test_runs WHERE type='scenario' ORDER BY rowid DESC LIMIT 5").all();
console.log("=== Recent scenario runs ===");
runs.forEach((r) => console.log(r.run_id, r.created_at));

if (runs.length > 0) {
  const latest = runs[0];
  console.log("\n=== Parsing raw_json of latest run:", latest.run_id, "===");
  const row = db.prepare("SELECT raw_json FROM test_runs WHERE run_id=?").get(latest.run_id);
  const summary = JSON.parse(row.raw_json);

  for (const result of summary.results || []) {
    console.log("\nProfile:", result.profileName || result.profileId);
    for (const s of result.scenarios || []) {
      console.log(
        "  scenario:",
        s.scenarioId || s.scenarioName,
        "| fts.len:",
        (s.firstTokenSamples || []).length,
        "| p50ft:",
        s.p50FirstTokenMs ?? "null",
        "| samples:",
        JSON.stringify((s.firstTokenSamples || []).slice(0, 3)),
      );
    }
  }
}

// Dump full scenario object for a qianwen run
console.log("\n=== Full qianwen scenario object (raw) ===");
const qwRun = db.prepare("SELECT run_id, raw_json FROM test_runs WHERE run_id LIKE '%4sapi%scenario%' ORDER BY rowid DESC LIMIT 1").get();
if (qwRun) {
  const qwS = JSON.parse(qwRun.raw_json);
  for (const r of qwS.results || []) {
    const sc = (r.scenarios || [])[0];
    if (sc) {
      console.log("KEYS:", Object.keys(sc).join(", "));
      console.log(JSON.stringify(sc, null, 2));
    }
  }
} else {
  console.log("(not found)");
}

// Full scenario detail for all recent scenario test_runs
console.log("\n=== Full scenario detail for all recent test_runs ===");
const allRuns2 = db.prepare("SELECT run_id, raw_json FROM test_runs WHERE type='scenario' ORDER BY rowid DESC LIMIT 8").all();
for (const run of allRuns2) {
  try {
    const s = JSON.parse(run.raw_json);
    for (const r of s.results || []) {
      for (const sc of r.scenarios || []) {
        console.log(
          `run: ${run.run_id.slice(-20)} | sc: ${sc.scenarioId || sc.scenarioName} | stream_in_records: n/a | fts: ${JSON.stringify(sc.firstTokenSamples)} | p50ft: ${sc.p50FirstTokenMs} | success: ${sc.successCount}/${sc.count}`,
        );
      }
    }
  } catch (e) {
    console.log("parse error:", e.message);
  }
}

// Also: look inside records of a qianwen run (before slim strips them)
// Actually records ARE stripped. Let's look at the raw_json of test_requests for a qianwen run
const qianwenRun = "测试-4sapi-千问_qwen3.8-max_scenario_20260805_144246_bd92";
const qianwenReqs = db.prepare("SELECT first_token_ms, success, raw_json FROM test_requests WHERE run_id=?").all(qianwenRun);
console.log(`\n=== test_requests for ${qianwenRun} ===`);
for (const r of qianwenReqs) {
  let rj = {};
  try {
    rj = JSON.parse(r.raw_json);
  } catch {}
  console.log(
    `  stream: ${rj.stream} | firstTokenMs: ${rj.firstTokenMs} | success: ${r.success} | first_token_ms(db): ${r.first_token_ms} | normalizedError: ${rj.normalizedError}`,
  );
}

db.close();
