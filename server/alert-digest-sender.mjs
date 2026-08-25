// server/alert-digest-sender.mjs
// 报警汇总的发信时机与发信动作。
//
// 时机（按你定的口径）：cron 定点 + 等调度器空闲。
//   到点后若自动测试还在跑，顺延到下一个 tick 再看 —— 因为自动测试并发默认是 1
//   （EVALUATOR_AUTO_TEST_CONCURRENCY=1，给手动测试留槽位），作业是【串行】跑的：
//   5 个渠道各跑一次稳定性测试、每次几分钟，整批实际要 20-30 分钟。
//   一到点就发会把同一批结果切成两封，后几个渠道落进下一封 —— 那正是你要避免的。
//
// best-effort：全程 try/catch 吞错，绝不影响调度主流程（与 evaluateAlertRules 同惯例）。
import { computeNextRunAt, loadJobs } from "./auto-test-store.mjs";
import {
  loadDigestConfig,
  updateDigestConfig,
  loadQueue,
  drainQueue,
  requeue,
  removeAlertsByRule,
  jobInDigestScope,
} from "./alert-digest-store.mjs";
import { formatAlertDigest } from "./alert-digest-format.mjs";
import { getNotifyConfig } from "./notify-config.mjs";
import { readSecret } from "./secret-store.mjs";
import { sendMail } from "./mailer.mjs";
import { clearRuleState } from "./alert-rule-state.mjs";

const SMTP_PASSWORD_REF = "notify:smtp-password";

// 顺延上限：到点后若调度器一直忙，最多等这么久就强制发，避免"永远在忙"导致汇总信永不发出
// （例如某个作业卡死在网络读取上，activeJobs 会长期 > 0）。
// 6 小时是权衡：足够长以容纳一整批串行的稳定性测试，又不至于让一天一封变成隔天才到。
export const MAX_DEFER_MS = 6 * 3600 * 1000;

// cron 算不出下一个时刻时的退化间隔。见 maybeSendDigest 里的用法说明：
// 这一层兜住「nextDigestAt 落 null → 每 tick 一封」的失控循环。
export const FALLBACK_INTERVAL_MS = 24 * 3600 * 1000;

async function defaultSendMailFn(subject, body) {
  const cfg = getNotifyConfig();
  if (!cfg.smtpHost || !cfg.recipients) return false; // 未配置 SMTP：静默跳过，与单条报警同口径
  const smtpPassword = await readSecret(SMTP_PASSWORD_REF);
  await sendMail({ ...cfg, smtpPassword }, subject, body);
  return true;
}

// 是否到了该发汇总的时刻。纯判定，不改状态，便于单测。
//
// nextDigestAt 为空（刚开启功能/迁移）时视为立即到期，并由调用方算出并持久化下一个时刻——
// 与 auto-test-scheduler.isDue 对 nextRunAt 缺失的处理同一思路。
export function isDigestDue(config, nowMs) {
  if (!config?.enabled) return false;
  if (!config.nextDigestAt) return true;
  const t = Date.parse(config.nextDigestAt);
  return !Number.isFinite(t) || t <= nowMs;
}

// 到期后是否该为「调度器还在忙」而顺延。
// 超过 MAX_DEFER_MS 仍在忙 → 不再等，强制发（宁可切成两封，也不能永不发信）。
export function shouldDefer({ dueAtMs, nowMs, activeJobs }) {
  if (!activeJobs) return false;
  if (!Number.isFinite(dueAtMs)) return true; // 无从判断已等多久：先等着
  return nowMs - dueAtMs < MAX_DEFER_MS;
}

// 尝试发一次汇总。由调度器每 tick 调用；未到期/需顺延时什么都不做并返回原因。
//
// opts.sendMailFn / opts.now / opts.getActiveJobs 供测试注入（同 mailer 的 transportFactory 惯例）。
export async function maybeSendDigest(opts = {}) {
  const sendMailFn = opts.sendMailFn || defaultSendMailFn;
  const now = opts.now || (() => Date.now());
  const getActiveJobs = opts.getActiveJobs || (() => 0);
  try {
    const nowMs = now();

    // 【到期判定与推进节奏必须是一次原子操作】
    // 两者若分成「读配置 → 判到期 → 写新节奏」三步，两个并发的 tick 会都在对方写入之前
    // 读到同一个已到期的 nextDigestAt，于是【各发一封】。实测两封信的内容还是互补的残信：
    // 第一封列出报警，第二封紧跟着说「本时段无新增报警」（队列已被第一封取空）。
    // setInterval 不等上一个 tick 结束，长批次期间确实会有多个 tick 并行走到这里，
    // 而 loadDigestConfig 是异步读盘 —— 两个 tick 落在这个 await 的间隙里就会撞上。
    //
    // 把判定搬进 updateDigestConfig 的 mutator：那条链是串行化的（一把锁排队），
    // 于是「判到期 + 占位」不可分割，只有抢到的那一个 tick 会拿到 claimed=true。
    const claim = await updateDigestConfig((cfg) => {
      if (!isDigestDue(cfg, nowMs)) return { claimed: false, reason: "not_due" };

      const dueAtMs = cfg.nextDigestAt ? Date.parse(cfg.nextDigestAt) : nowMs;
      if (shouldDefer({ dueAtMs, nowMs, activeJobs: getActiveJobs() })) {
        return { claimed: false, reason: "deferred_scheduler_busy" };
      }

      // 推进用「当前时刻」而非原定到期时刻算下一个 cron 点：顺延过的这次不该把后续节奏也往前拖。
      // cron 算不出下一个时刻（表达式坏了 / 手改过配置文件 / 四年内无可执行时刻）时，
      // 【绝不能留 null】——isDigestDue 把 null 当「立即到期」，于是每个 tick 都发一封：
      // 实测 10 个 tick 发 10 封，一天 1440 封，比「邮件太多」这个原始问题严重得多。
      // 端点已挡掉坏 cron，但手改配置文件、跨部署拷贝配置仍能绕过，故这里必须兜住。
      // 退化成固定 24 小时而不是停用：停用会让「每期必到」的心跳消失，
      // 于是「没收到信」重新变得有歧义——那正是本功能要消除的东西。
      const cronNext = computeNextRunAt({ cron: cfg.cron }, nowMs);
      if (!cronNext) {
        console.error(`[alert-digest] cron「${cfg.cron}」无可执行时刻，已退化为每 24 小时一封；请到报警规则页修正。`);
      }
      const windowFrom = cfg.lastDigestAt;
      cfg.lastDigestAt = new Date(nowMs).toISOString();
      cfg.nextDigestAt = cronNext || new Date(nowMs + FALLBACK_INTERVAL_MS).toISOString();
      // 顺带把汇总范围带出来：下面成文时要按它过滤作业表。
      // 在这里取而不是回头再 loadDigestConfig 一次，是为了拿到与本次占位【同一快照】的范围 ——
      // 期间若有人改了设置，重读会让判定与实际发出的内容不一致。
      return { claimed: true, windowFrom, scope: { enabled: cfg.enabled, jobScope: cfg.jobScope, jobIds: cfg.jobIds } };
    });
    if (!claim.claimed) return { sent: false, reason: claim.reason };
    const windowFrom = claim.windowFrom;

    const taken = await drainQueue();

    // 【成文也必须在回填保护之内】队列已经被取空了，此后任何抛错都会让这批报警凭空消失。
    // formatAlertDigest 是纯函数、理应不抛，但"理应不抛"不是保证——把它和发信一起纳入
    // 同一个 catch，任何失败都走回填重试。
    try {
      // 作业表只在「本时段一条运行记录都没有」时才用得上（决定该不该说「请检查是否被停用」）。
      // 读失败给 null，formatAlertDigest 会退回保守措辞，不影响发信。
      //
      // 【必须先按汇总范围过滤】只有范围内的作业才可能产出汇总内容。不过滤的话，
      // 「范围内的作业今天不跑、范围外的一小时后跑」会让信里说
      // 「属正常，下一次运行在 10:00」—— 而 10:00 那次根本不进汇总，
      // 用户等到 10:00 之后仍然看不到它的数字。指着一个不相干的时刻说「属正常」是误导。
      const allJobs = await (opts.loadJobsFn || loadJobs)().catch(() => null);
      const jobs = Array.isArray(allJobs) ? allJobs.filter((j) => jobInDigestScope(claim.scope, j?.id)) : null;
      const { subject, body } = formatAlertDigest(taken, {
        windowFrom,
        windowTo: new Date(nowMs).toISOString(),
        jobs,
        jobScope: claim.scope.jobScope,
      });
      const ok = await sendMailFn(subject, body);
      if (!ok) {
        // 未配 SMTP：内容放回队列。否则开着汇总但没配发信时，队列会被反复清空，
        // 等真正配好 SMTP 后，之前所有报警都已无声消失。
        await requeue(taken);
        return { sent: false, reason: "smtp_not_configured" };
      }
      return { sent: true, alerts: taken.alerts.length, runs: taken.runs.length };
    } catch (error) {
      // 发信（或成文）失败：内容回填队列，下个周期连同新报警一起重试。
      // 与单条报警「markFired 只在发信成功后才记」同一取向——绝不让失败的发信吞掉报警。
      await requeue(taken);
      console.error("[alert-digest] 汇总发信失败（内容已回填队列）：", error?.message || error);
      return { sent: false, reason: "send_failed" };
    }
  } catch (error) {
    console.error("[alert-digest] 汇总流程异常：", error?.message || error);
    return { sent: false, reason: "error" };
  }
}

// 关闭汇总时处置队列里已攒的报警。
//
// 【为什么不能就这么放着】maybeSendDigest 在功能关闭时直接早退，既不发也不清。
// 而这些报警【入队时已经记过冷却】（入队即视为已交付），于是关掉汇总意味着：
//   ① 它们永不送达，且在冷却期内不会重报 —— 等于被静默吞掉；
//   ② 日后重新开启时，一封信里会冒出几周前的陈旧报警（实测会诈尸）。
// 处置：清空队列，并清掉这些规则的冷却记录，让下一次命中立刻重新报警
// （此时汇总已关，会走立即发信）。宁可重复报一次，不可静默丢失。
//
// 抽成函数而非写在端点里，是为了可测 —— 端点路径上很难造出「队列非空」的状态。
// opts.clearRuleStateFn 供测试注入。
export async function discardQueuedAlerts(opts = {}) {
  const clearFn = opts.clearRuleStateFn || clearRuleState;
  const taken = await drainQueue();
  if (!taken.alerts.length) return null;
  const ruleIds = [...new Set(taken.alerts.map((a) => a.ruleId).filter(Boolean))];
  for (const id of ruleIds) await clearFn(id);
  return { alerts: taken.alerts.length, rules: ruleIds.length };
}

// 某条规则被删除时，把它在队列里尚未发出的报警一并丢掉。
//
// 【为什么要丢】删除一条规则的含义是「别再就这件事提醒我」。留着的话，
// 汇总信会在数小时后报出一条【已经不存在的规则】——收件人按名字去页面上找，找不到。
// 而且这与删除时已有的 clearRuleState（清冷却）不一致：既然冷却记录都清了，
// 待发内容更该清。
// 不清冷却：规则都没了，冷却桶由 clearRuleState 那边负责。
// best-effort：失败不影响删除本身（规则已删，残留几条队列项只会多一行陈旧信息）。
export async function dropQueuedAlertsForRule(ruleId) {
  if (!ruleId) return 0;
  try {
    return await removeAlertsByRule(ruleId);
  } catch (error) {
    console.error("[alert-digest] 清理已删除规则的待发报警失败：", error?.message || error);
    return 0;
  }
}

// 立即发一封（供「发送测试汇总」按钮用）。不看 cron、不推进节奏、不清空队列——
// 只把当前队列内容渲染出来发一封，让管理员确认收件人/格式对不对。
export async function sendDigestNow(opts = {}) {
  const sendMailFn = opts.sendMailFn || defaultSendMailFn;
  const taken = await loadQueue();
  const config = await loadDigestConfig();
  // 与定时发的那封同样传作业表和范围：否则这封「测试信」里「本时段没跑任何测试」那段
  // 会退回保守措辞，与真实汇总信长得不一样 —— 而这个按钮的全部用途就是【预览真实的信】。
  //
  // 【enabled 必须强制成 true】jobInDigestScope 在 config.enabled 为 false 时对任何作业都返回
  // false。而本按钮在汇总【关闭】时也能按（用来试发信配置），那样作业表会被整个过滤空，
  // 信里于是谎称「没有任何已启用的自动测试作业」——实测确实如此。作业明明都在，
  // 只是汇总没开。这里要问的是「按当前范围设置，哪些作业会进汇总」，与开关状态无关。
  const scopeForPreview = { enabled: true, jobScope: config.jobScope, jobIds: config.jobIds };
  const allJobs = await (opts.loadJobsFn || loadJobs)().catch(() => null);
  const jobs = Array.isArray(allJobs) ? allJobs.filter((j) => jobInDigestScope(scopeForPreview, j?.id)) : null;
  const { subject, body } = formatAlertDigest(taken, {
    windowFrom: config.lastDigestAt,
    windowTo: new Date().toISOString(),
    jobs,
    jobScope: config.jobScope,
  });
  const ok = await sendMailFn(`${subject}（手动发送）`, body);
  if (!ok) throw new Error("尚未配置 SMTP 服务器或收件人，无法发送。");
  return { alerts: taken.alerts.length, runs: taken.runs.length };
}
