// src/task-center.js
// 「任务中心」（总结与交付栏，登录即可用）：PRD FR-004。
// 集中查看所有长任务（准入 / 标准评测 / 稳定性 / 场景 / 压测）的状态与逐步骤明细，
// 取代原先藏在报告中心里的「最近任务状态」折叠区——那里只有一行聚合状态，
// 看不出「哪一步没通过」，而这正是用户排查时唯一想知道的事。
//
// 数据全部来自服务端：列表 GET /api/tasks/recent（不带 steps），
// 明细 GET /api/tasks/:id（带 steps，内存里没有会回退事件日志）。
// 前端【绝不】自己算准入结论：聚合判定归服务端 aggregateSuite 独有，
// 这里只如实展示 executionStatus × verdict 两个字段。
import { api, cancelTaskById, observeRemoteTask } from "./api-client.js";
import { escapeHtml, formatDateTime, toast } from "./client-utils.js";
import { requireElement } from "./dom-utils.js";
import { formatTaskStatus, formatTaskType, taskStatusClass } from "./formatters.js";

const ACTIVE_STATUSES = new Set(["queued", "running"]);

export function createTaskCenter({ state, confirm, onRetest }) {
  const listElement = requireElement("#tc-list");
  const detailElement = requireElement("#tc-detail");
  const refreshButton = requireElement("#tc-refresh");
  const statusFilter = requireElement("#tc-filter-status");
  const typeFilter = requireElement("#tc-filter-type");
  const hint = requireElement("#tc-hint");

  let tasks = [];
  let openTaskId = "";
  // 每次打开新明细都推进一版：迟到的轮询回调不能把上一个任务的 steps 画到当前面板上。
  let detailRevision = 0;

  async function load() {
    try {
      tasks = await api("/api/tasks/recent");
    } catch (error) {
      listElement.innerHTML = `<div class="empty-state"><strong>读取任务记录失败</strong><p>${escapeHtml(error.message)}</p></div>`;
      return;
    }
    renderTypeOptions();
    render();
    // 页面停留期间运行中的任务要自己往前走，否则用户得一直点刷新。
    observeActiveTasks();
  }

  function renderTypeOptions() {
    const types = [...new Set(tasks.map((task) => task.type).filter(Boolean))];
    const current = typeFilter.value;
    typeFilter.innerHTML = [
      '<option value="">全部类型</option>',
      ...types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(formatTaskType(type))}</option>`),
    ].join("");
    // 过滤项重建后要把用户选的值放回去，否则每次刷新都被重置成「全部类型」。
    if (types.includes(current)) typeFilter.value = current;
  }

  function visibleTasks() {
    return tasks.filter((task) => {
      if (statusFilter.value && task.status !== statusFilter.value) return false;
      if (typeFilter.value && task.type !== typeFilter.value) return false;
      return true;
    });
  }

  function render() {
    const rows = visibleTasks();
    hint.textContent = `共 ${tasks.length} 条任务记录${rows.length === tasks.length ? "" : `，当前筛选出 ${rows.length} 条`}。任务记录来自事件日志，仅保留最近一批；更早的任务不再可查。`;
    if (!rows.length) {
      listElement.innerHTML = `
        <div class="empty-state">
          <strong>${tasks.length ? "没有符合筛选条件的任务" : "还没有长任务记录"}</strong>
          <p>${tasks.length ? "换个状态或类型再看看。" : "标准评测、准入、稳定性、场景或压力测试开始后，这里会记录每个任务的进度与逐步骤明细。"}</p>
          ${tasks.length ? "" : '<button class="secondary" type="button" data-go-page="standard-eval">去标准评测</button>'}
        </div>`;
      return;
    }
    listElement.innerHTML = rows.map((task) => renderRow(task)).join("");
  }

  // 所有数据字段均经 escapeHtml；HTML 结构是硬编码的，不是用户数据。
  function renderRow(task) {
    const isOpen = task.taskId === openTaskId;
    return `
      <div class="row task-center-row ${isOpen ? "open" : ""}" data-tc-row="${escapeHtml(task.taskId)}">
        <div>
          <strong>${escapeHtml(formatTaskType(task.type))}</strong><br />
          <small>${escapeHtml(formatDateTime(task.startedAt || task.createdAt))}${task.createdBy ? ` · ${escapeHtml(task.createdBy)}` : ""}</small>
        </div>
        <span class="${taskStatusClass(task.status)}">${escapeHtml(formatTaskStatus(task.status))}</span>
        <span>${Number(task.progress ?? 0)}%</span>
        <span>${Number(task.completedUnits ?? 0)}/${escapeHtml(String(task.totalUnits ?? "-"))}</span>
        <small>${escapeHtml(task.message || task.error || "-")}</small>
        <button class="secondary" type="button" data-tc-detail="${escapeHtml(task.taskId)}">${isOpen ? "收起明细" : "查看明细"}</button>
      </div>`;
  }

  async function openDetail(taskId) {
    if (openTaskId === taskId) {
      closeDetail();
      return;
    }
    openTaskId = taskId;
    detailRevision += 1;
    const revision = detailRevision;
    render();
    detailElement.classList.remove("hidden");
    detailElement.innerHTML = '<p class="muted">正在读取任务明细…</p>';
    let detail;
    try {
      detail = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
    } catch (error) {
      if (revision !== detailRevision) return;
      detailElement.innerHTML = `<p class="fail">读取明细失败：${escapeHtml(error.message)}</p>
        <p class="muted">任务记录只在事件日志的最近一批里可查，更早的任务查不到明细。</p>`;
      return;
    }
    if (revision !== detailRevision) return; // 用户已经点开别的任务了
    renderDetail(detail);
    // 明细里的运行中任务同样要自己刷新，否则展开着的网格是死的。
    if (ACTIVE_STATUSES.has(detail.status)) {
      observeRemoteTask(taskId, {
        onProgress: (current) => {
          if (revision !== detailRevision) return;
          renderDetail(current);
          mergeIntoList(current);
        },
        shouldStop: () => revision !== detailRevision,
      }).then((final) => {
        if (final && revision === detailRevision) {
          renderDetail(final);
          mergeIntoList(final);
        }
      });
    }
  }

  function closeDetail() {
    openTaskId = "";
    detailRevision += 1; // 让在跑的轮询自己停下
    detailElement.classList.add("hidden");
    detailElement.innerHTML = "";
    render();
  }

  // 把轮询到的最新快照并回列表，让上方那一行的进度和下方明细保持一致。
  // 列表刻意不带 steps，这里也不要把 steps 塞进去。
  function mergeIntoList(current) {
    const id = current.taskId || current.id;
    const index = tasks.findIndex((task) => task.taskId === id);
    if (index < 0) return;
    const { steps, ...rest } = current;
    tasks[index] = { ...tasks[index], ...rest, taskId: id };
    render();
  }

  function renderDetail(task) {
    const steps = Array.isArray(task.steps) ? task.steps : [];
    const canCancel = ACTIVE_STATUSES.has(task.status);
    const retestable = Boolean(task.payload?.profileIds?.length) && task.type === "admission-suite";
    detailElement.innerHTML = `
      <div class="section-header">
        <div>
          <h3>${escapeHtml(formatTaskType(task.type))} · <span class="${taskStatusClass(task.status)}">${escapeHtml(formatTaskStatus(task.status))}</span></h3>
          <p class="section-desc">${escapeHtml(task.message || task.error || "—")}</p>
        </div>
        <div class="action-row">
          ${canCancel ? `<button class="danger" type="button" data-tc-cancel="${escapeHtml(task.taskId)}">取消任务</button>` : ""}
          ${retestable ? `<button class="secondary" type="button" data-tc-retest="${escapeHtml(task.taskId)}">再测一次</button>` : ""}
          <button class="secondary" type="button" data-tc-close>收起</button>
        </div>
      </div>
      <div class="task-center-meta">
        <span>开始：${escapeHtml(formatDateTime(task.startedAt || task.createdAt))}</span>
        <span>结束：${escapeHtml(task.endedAt ? formatDateTime(task.endedAt) : "—")}</span>
        <span>进度：${Number(task.progress ?? 0)}%（${Number(task.completedUnits ?? 0)}/${escapeHtml(String(task.totalUnits ?? "-"))} 步）</span>
        ${renderActorMeta(task)}
      </div>
      ${task.status === "interrupted" ? '<p class="fail">程序曾在任务运行中退出，这个任务已中断，结果不完整，需要重新测试。</p>' : ""}
      ${renderStepGrid(steps)}
      ${renderReportLinks(task.result)}`;
  }

  // 发起人 / 取消人。多人共用一台工具时「这轮谁跑的、谁停的」是最常问的。
  // 这里【只展示不判权】：取消按钮对所有登录者可见（取消是止损操作，见服务端注释）。
  // 历史任务与无会话的内部调用没有这两个字段，不显示占位（写「发起人：—」是噪音）。
  function renderActorMeta(task) {
    const parts = [];
    if (task.createdBy) parts.push(`<span>发起：${escapeHtml(task.createdBy)}</span>`);
    if (task.cancelledBy) parts.push(`<span>取消：${escapeHtml(task.cancelledBy)}</span>`);
    return parts.join("");
  }

  // 复用标准评测那套「模型 × 步骤」网格的类名（.flow-model-group / .standard-flow / .flow-step），
  // 保证两处观感一致：用户在标准评测页看到的格子，回头在任务中心看到的还是同一种格子。
  function renderStepGrid(steps) {
    if (!steps.length) {
      return '<p class="muted">这个任务没有留下逐步骤明细。程序重启前跑完的旧任务可能只剩聚合状态。</p>';
    }
    const groups = [];
    const byKey = new Map();
    for (const step of steps) {
      let group = byKey.get(step.groupKey);
      if (!group) {
        group = { key: step.groupKey, label: step.groupLabel || step.groupKey || "任务", steps: [] };
        byKey.set(step.groupKey, group);
        groups.push(group);
      }
      group.steps.push(step);
    }
    return groups
      .map(
        (group) => `
        <article class="flow-model-group">
          <h4>${escapeHtml(group.label)}</h4>
          <div class="standard-flow">
            ${group.steps
              .map(
                (step) => `
                <article class="flow-step ${stepStatusClass(step)}">
                  <span></span>
                  <strong>${escapeHtml(step.stepLabel || step.stepName || "步骤")}</strong>
                  <small>${escapeHtml(step.summary || "—")}</small>
                </article>`,
              )
              .join("")}
          </div>
        </article>`,
      )
      .join("");
  }

  // executionStatus（跑没跑完）与 verdict（达没达标）正交，样式必须同时看两者：
  // 只看 executionStatus 会把「跑完了但没通过」画成绿勾（v0.7.3 的原始 bug）；
  // 只看 verdict 会把「平台自己出错」和「渠道不达标」画成同一种失败，误导用户去改配置。
  // 与 standard-eval-controller 的同名函数保持一致；本项目是星形拓扑，模块间不互相 import，
  // 故此处照抄而非跨模块复用。
  function stepStatusClass(step) {
    if (step.executionStatus === "running") return "running";
    if (step.executionStatus === "skipped") return "skipped";
    if (step.executionStatus === "failed" || step.executionStatus === "cancelled") return "failed";
    if (step.executionStatus !== "completed") return "";
    if (step.verdict === "not_passed") return "failed";
    if (step.verdict === "warning" || step.verdict === "indeterminate") return "warn";
    return "done";
  }

  function renderReportLinks(result) {
    const paths = [result?.reportPath, result?.reportHtmlPath, result?.rawJsonPath].filter(Boolean);
    if (!paths.length) return "";
    return `<div class="task-center-meta">${paths.map((path) => `<span>${escapeHtml(path)}</span>`).join("")}</div>`;
  }

  function observeActiveTasks() {
    for (const task of tasks.filter((item) => ACTIVE_STATUSES.has(item.status))) {
      observeRemoteTask(task.taskId, {
        onProgress: (current) => mergeIntoList(current),
        // 用户切走任务中心就停：留着轮询只是白费请求。
        shouldStop: () => !document.getElementById("task-center")?.classList.contains("active"),
      }).then((final) => {
        if (final) mergeIntoList(final);
      });
    }
  }

  async function onCancel(taskId) {
    const ok = await confirm({
      title: "取消这个任务？",
      message: "已经发出的请求仍会计费，未开始的步骤会被跳过。取消后本次结果不完整，需要重新测试。",
      confirmLabel: "取消任务",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await cancelTaskById(taskId);
      toast("已请求取消任务。");
    } catch (error) {
      toast(`取消失败：${error.message}`, true);
    }
  }

  // 「再测一次」只回填表单、跳到准入评测页，【不】直接开跑：
  // 任务是花钱的，让用户自己按下最后那一下。
  // 模型目标可能已被删除或改名，故先核对 profileIds 还在不在，能填多少填多少并明确告知。
  async function onRetestClick(taskId) {
    const task = tasks.find((item) => item.taskId === taskId);
    const wanted = task?.payload?.profileIds || [];
    if (!wanted.length) {
      toast("这个任务没有留下参数，无法回填。", true);
      return;
    }
    const known = new Set((state.modelTargets || []).map((target) => target.id));
    const available = wanted.filter((id) => known.has(id));
    if (!available.length) {
      toast("原来测的模型目标都已被删除或改名，无法回填参数。请手动选择。", true);
      return;
    }
    // 回填方（锚点单值，跨渠道填不全）如实返回真正勾上的 id，据此报数，别假装全填上了。
    const filled = onRetest?.({ profileIds: available, payload: task.payload }) || available;
    const missing = wanted.length - filled.length;
    toast(
      missing > 0
        ? `已回填 ${filled.length} 个模型；另有 ${missing} 个已被删除或不属于同一渠道，未回填。请确认后再开始测试。`
        : "已回填参数，请确认后再开始测试。",
    );
  }

  listElement.addEventListener("click", (event) => {
    const detailButton = event.target.closest("[data-tc-detail]");
    if (detailButton) openDetail(detailButton.dataset.tcDetail);
  });

  detailElement.addEventListener("click", (event) => {
    if (event.target.closest("[data-tc-close]")) {
      closeDetail();
      return;
    }
    const cancelButton = event.target.closest("[data-tc-cancel]");
    if (cancelButton) {
      onCancel(cancelButton.dataset.tcCancel);
      return;
    }
    const retestButton = event.target.closest("[data-tc-retest]");
    if (retestButton) onRetestClick(retestButton.dataset.tcRetest);
  });

  refreshButton.addEventListener("click", () => load());
  statusFilter.addEventListener("change", () => render());
  typeFilter.addEventListener("change", () => render());

  return { load };
}
