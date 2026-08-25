// server/alert-digest-format.mjs
// 报警汇总邮件的纯格式化内核：把 drainQueue() 取出的 { alerts, runs } 渲染成邮件标题 + 正文。
// 纯函数、无 I/O，便于单测（与 auto-test-digest.mjs 的分层同理：采集在别处，这里只负责成文）。
//
// 【措辞纪律】正文绝不出现「全部稳定」「一切正常」这类断言。
// 原因：冷却期内仍在命中的规则不入队（这是既定取舍），于是一个持续挂着的渠道进入冷却后，
// 本时段可能一条报警都没有。此时若断言「稳定」，就是把"我们已报过、现在不重复"讲成"没问题"。
// 改为陈述事实——「本时段无新增报警」+ 列出本时段各目标的实测数字，难看的数字自己会说话。

const pct = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? "-" : `${Math.round(Number(v) * 100)}%`);
const ms = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? "-" : `${Math.round(Number(v))}ms`);
const clock = (iso) => (iso ? String(iso).replace("T", " ").slice(0, 16) : "-");

const TEST_TYPE_LABELS = {
  stability: "稳定性",
  "batch-stability": "批量稳定性",
  admission: "准入评测",
  "batch-admission": "批量准入",
  "quick-verify": "快速验证",
  scenario: "场景测试",
};

const KIND_LABELS = {
  threshold: "阈值",
  "stability-jitter": "稳定性抖动",
  "stability-decline": "稳定性退化",
};

// 目标显示名：入队时已算好 targetLabel（模型名优先），这里只兜底。
const labelOf = (e) => e?.targetLabel || e?.targetId || "未知目标";

// 同一「规则 × 目标 × 原因」在一个汇总窗口内的重复命中，折叠成一行并记次数。
//
// 【为什么必须折叠】冷却时长（默认 1 小时）与汇总周期（可能 24 小时）是两个独立的量。
// 一个持续挂着的渠道，每过一个冷却期就会重新入队一条——实测：冷却 1h + 每 2h 一测 + 24h 汇总，
// 一封信里会出现【12 条逐字相同】的报警行。那只是把「邮件太多」换成了「一封信里太吵」，
// 收敛邮件数量的初衷落空了。
// 折叠保留全部信息量：次数 + 首末时刻都在，看得出它响了多少次、持续了多久。
function collapseRepeats(items) {
  const map = new Map();
  for (const a of items) {
    const key = `${a.ruleId}||${a.targetId}||${a.reason}`;
    const hit = map.get(key);
    if (!hit) {
      map.set(key, { ...a, count: 1, firstAt: a.at, lastAt: a.at });
      continue;
    }
    hit.count += 1;
    // at 是入队顺序，未必严格有序（并发入队），故取字符串比较的极值而非首尾元素。
    if (String(a.at || "") < String(hit.firstAt || "")) hit.firstAt = a.at;
    if (String(a.at || "") > String(hit.lastAt || "")) hit.lastAt = a.at;
  }
  return [...map.values()];
}

// 按目标归并报警：同一渠道命中多条规则时，信里归到一处，读起来是「这个渠道怎么了」
// 而不是「这条规则报了什么」——收件人关心的是前者。
function groupByTarget(alerts) {
  const map = new Map();
  for (const a of alerts) {
    const key = a.targetId || labelOf(a);
    if (!map.has(key)) map.set(key, { label: labelOf(a), items: [] });
    map.get(key).items.push(a);
  }
  return [...map.values()].map((g) => ({ ...g, items: collapseRepeats(g.items) }));
}

// 每个目标在本时段的最后一次运行（同一目标可能跑了多次，取最新的那次做代表）。
// enqueueRun 已按目标覆盖式记账，正常情况下这里每个目标本就只有一条；
// 但回填（requeue）与早期形状的队列文件仍可能出现同一目标多条，故保留归并。
// runCount 取各条之和：覆盖记账时它已是累计值，回填合并时要把两段窗口的次数加起来。
function latestRunPerTarget(runs) {
  const map = new Map();
  for (const r of runs) {
    const key = r.targetId || labelOf(r);
    const prev = map.get(key);
    const count = (Number(prev?.runCount) || (prev ? 1 : 0)) + (Number(r.runCount) || 1);
    // at 相同时取后出现的那条（入队顺序即时间顺序）。
    const newer = !prev || String(r.at || "") >= String(prev.at || "") ? r : prev;
    map.set(key, { ...newer, runCount: count });
  }
  return [...map.values()];
}

// 该次运行有没有报出任何可读的指标。全是 null 时不能只显示三个横杠 ——
// 那与「这个目标没测」长得一模一样，而真相是「测了，但上游一个数都没给出来」，
// 通常意味着连接失败/全部超时，是最严重的情形之一。
function hasAnyMetric(r) {
  return [r?.successRate, r?.p95TotalMs].some((v) => v !== null && v !== undefined && Number.isFinite(Number(v))) || Boolean(r?.grade);
}

export function formatAlertDigest(taken, { windowFrom = null, windowTo = null } = {}) {
  // 【不能只靠默认参数】`taken = {}` 只在传 undefined 时生效，传 null 仍会走进来并在
  // taken.alerts 上抛 TypeError。本函数在 best-effort 链路上（maybeSendDigest 的 try/catch 里），
  // 抛错的后果是那一期汇总信整封发不出去 —— 而队列已经被 drainQueue 取空了。
  const src = taken && typeof taken === "object" ? taken : {};
  const alerts = Array.isArray(src.alerts) ? src.alerts : [];
  const runs = Array.isArray(src.runs) ? src.runs : [];
  const groups = groupByTarget(alerts);
  const runRows = latestRunPerTarget(runs);

  const span = windowFrom ? `${clock(windowFrom)} ~ ${clock(windowTo)}` : `截至 ${clock(windowTo)}`;

  // 标题按【去重后】的条数计：收件箱里要回答的是「有几件事坏了」。
  // 用原始条数会失真——一个渠道持续挂 24 小时可能入队 12 条逐字相同的记录，
  // 标题写「12 条报警」会让人以为出了 12 个问题。
  const distinct = groups.reduce((sum, g) => sum + g.items.length, 0);
  const subject = distinct
    ? `【API-evaluator 报警汇总】${groups.length} 个目标 ${distinct} 项报警`
    : `【API-evaluator 报警汇总】本时段无新增报警`;

  const lines = [`时间范围：${span}`, ""];

  if (distinct) {
    // 去重后条数与原始条数不同时，把「重复命中已折叠」说明白，否则读者会怀疑漏报。
    const repeated = alerts.length > distinct ? `（共 ${alerts.length} 次命中，重复的已按次数折叠）` : "";
    lines.push(`本时段新增报警 ${distinct} 项，涉及 ${groups.length} 个目标${repeated}：`, "");
    for (const g of groups) {
      lines.push(`■ ${g.label}`);
      for (const a of g.items) {
        const kind = KIND_LABELS[a.ruleKind] || a.ruleKind || "阈值";
        // 重复命中：显示次数与持续区间，而不是把同一行抄 N 遍。
        const when = a.count > 1 ? `${clock(a.firstAt)} ~ ${clock(a.lastAt)}，共 ${a.count} 次` : clock(a.firstAt || a.at);
        lines.push(`  [${kind}] ${a.ruleName || a.ruleId}（${when}）`);
        // reason 是多行的（复合规则会列出各越界项），逐行缩进保持层次。
        for (const line of String(a.reason || "").split("\n")) {
          if (line.trim()) lines.push(`    ${line.trim()}`);
        }
      }
      lines.push("");
    }
  } else {
    lines.push("本时段没有新增报警。", "");
    // 这句是本文件存在的核心理由，见文件头「措辞纪律」。
    lines.push(
      "注意：已在冷却期内的规则不会重复计入。若某个目标此前已报警且问题仍在持续，",
      "它不会出现在上面，但下方的实测数字会反映它的真实状态——请看数字，而非本段措辞。",
      "",
    );
  }

  if (runRows.length) {
    lines.push(`本时段完成的测试（${runRows.length} 个目标，同一目标取最后一次）：`, "");
    lines.push("目标 | 测试类型 | 次数 | 成功率 | P95 | 等级");
    lines.push("--- | --- | --- | --- | --- | ---");
    // 一个数都没报出来的目标排在最前：那通常是连不上/全超时，比数字难看更严重。
    const ordered = [...runRows].sort((a, b) => Number(hasAnyMetric(a)) - Number(hasAnyMetric(b)));
    const mute = [];
    for (const r of ordered) {
      const type = TEST_TYPE_LABELS[r.testType] || r.testType || "-";
      const times = Number(r.runCount) > 1 ? `${r.runCount} 次` : "1 次";
      if (!hasAnyMetric(r)) {
        // 显式标注，不能只留三个横杠——那与「这个目标没测」无法区分。
        lines.push(`${labelOf(r)} | ${type} | ${times} | 未报出 | 未报出 | -`);
        mute.push(labelOf(r));
        continue;
      }
      lines.push(`${labelOf(r)} | ${type} | ${times} | ${pct(r.successRate)} | ${ms(r.p95TotalMs)} | ${r.grade || "-"}`);
    }
    lines.push("");
    if (mute.length) {
      lines.push(
        `⚠ 以下目标测了但一个指标都没报出来：${mute.join("、")}。`,
        "  这通常意味着连接失败或全部请求超时，而非「表现正常」。阈值规则在指标缺失时按「不满足」处理，",
        "  所以这种情况【不会】触发报警——请直接查这些目标的报告。",
        "",
      );
    }
  } else {
    // 没有任何运行记录 = 定时测试根本没跑（作业停用/熔断/进程重启），这比"跑了但都正常"严重得多。
    lines.push("本时段没有完成任何测试。请检查自动测试作业是否被停用或熔断。", "");
  }

  return { subject, body: lines.join("\n") };
}
