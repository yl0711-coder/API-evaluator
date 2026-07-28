// src/settings.js
// 设置页：AI 总结模型 / 场景题库开关 / new-api 网关 / 高危报告提示等。
//
// 从 app.js 整块搬出（16 号报告 C1 第二阶段）。代码**逐字未改**——纯搬运才能用构建产物比对证明等价。
//
// 依赖：api、toast、createCascadeTargetPicker，以及 channelAdmin / highRiskBanner / loadScenarios 回调，
// 全部通过 deps 注入。模块自身不 import 任何文件（零外部耦合）。
export function createSettings({ state, els, deps }) {
  const { api, toast, createCascadeTargetPicker, channelAdmin, highRiskBanner, loadScenarios, onProfileData } = deps;

  // 复用「模型管理」那套渠道→模型级联：value 即模型目标 id。
  const settingsAiCascade = createCascadeTargetPicker(els.setAiChannel, els.setAiModel);

  // 自定义能力标签已迁至「开发者界面」（src/developer.js），设置页不再承载。

  // 「指定模型」勾选门控两级下拉：未勾=都禁用（AI 用被测模型）；勾上=渠道可选，模型随级联。
  function applyAiSpecifiedGate() {
    const on = els.setAiSpecified.checked;
    els.setAiChannel.disabled = !on;
    if (!on) els.setAiModel.disabled = true;
    else if (els.setAiChannel.value) els.setAiModel.disabled = false;
  }
  els.setAiSpecified.addEventListener("change", applyAiSpecifiedGate);

  // 启动预载：只把设置塞进 state（供各处读设置开关），不碰下面才声明的 set-* 元素，避免 TDZ。
  // 函数声明会提升，可在上方启动 Promise.all 里调用。
  async function preload() {
    try {
      state.settings = await api("/api/settings");
    } catch {
      /* 启动期设置加载失败不阻断首屏；进设置页会再试 */
    }
  }

  async function load() {
    try {
      const s = await api("/api/settings");
      state.settings = s; // 缓存设置供各处读取开关
      els.setLivebench.checked = Boolean(s.enableLivebench);
      els.setSafety.checked = Boolean(s.enableSafety);
      els.setHle.checked = Boolean(s.enableHle);
      els.setHardcoreLogic.checked = Boolean(s.enableHardcoreLogic);
      els.setCodingHard.checked = Boolean(s.enableCodingHard);
      els.setAutoTag.checked = s.enableAutoTag !== false; // 默认开启
      els.setTestCycleDays.value = Number(s.testCycleDays) > 0 ? String(Math.trunc(s.testCycleDays)) : ""; // 0/空 → 空框（占位符 0）
      els.setHighRiskAlert.checked = s.enableHighRiskAlert === true;
      // new-api 网关：网址/用户ID 回填；令牌不回显，按已配置状态切占位符、清空输入值。
      els.setNewapiBase.value = s.newapiBaseUrl || "";
      els.setNewapiUserid.value = s.newapiUserId || "";
      els.setNewapiToken.value = "";
      els.setNewapiToken.placeholder = s.newapiImportTokenSet ? "已配置（留空不改）" : "未配置";
      settingsAiCascade.refresh({ channels: state.channels, modelTargets: state.modelTargets, profiles: state.profiles });
      settingsAiCascade.setValue(s.aiAnalysisModelTargetId || "", { silent: true });
      els.setAiSpecified.checked = Boolean(s.aiAnalysisModelTargetId);
      applyAiSpecifiedGate();
      markClean();
    } catch (error) {
      toast(`加载设置失败：${error.message}`, true);
    }
  }

  // 未保存改动追踪（同时供模块内部和外部 showPage 读取）。
  let _dirty = false;
  function isDirty() {
    return _dirty;
  }
  function markClean() {
    _dirty = false;
  }

  // 用户改动任一设置项（复选框/AI 模型选择等）→ 标记未保存。程序化赋值（loadSettings）不触发 change，故不会误标。
  els.settingsForm.addEventListener("change", () => {
    _dirty = true;
  });

  els.settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      aiAnalysisModelTargetId: els.setAiSpecified.checked ? settingsAiCascade.value || "" : "",
      enableLivebench: els.setLivebench.checked,
      enableSafety: els.setSafety.checked,
      enableHle: els.setHle.checked,
      enableHardcoreLogic: els.setHardcoreLogic.checked,
      enableCodingHard: els.setCodingHard.checked,
      enableAutoTag: els.setAutoTag.checked,
      testCycleDays: Math.max(0, Math.trunc(Number(els.setTestCycleDays.value) || 0)),
      enableHighRiskAlert: els.setHighRiskAlert.checked,
      newapiBaseUrl: els.setNewapiBase.value.trim(),
      newapiUserId: els.setNewapiUserid.value.trim(),
      newapiImportToken: els.setNewapiToken.value, // 空串→后端保留原令牌
    };
    try {
      const saved = await api("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
      state.settings = saved; // 即时生效：删除流随即按新开关走
      markClean();
      await loadScenarios(); // 题库开关改动后，场景测试选项即时刷新
      await load(); // 刷新令牌「已配置」占位符状态
      channelAdmin.renderTagOptions(); // 自定义标签变化 → 模型表单勾选项即时并入
      await highRiskBanner.load(); // 高危报告提示开关变化 → 即时显示/收起横幅
      toast("设置已保存。");
    } catch (error) {
      toast(`保存设置失败：${error.message}`, true);
    }
  });

  // 供 renderProfileOptions 在渠道/模型数据变化时刷新设置页自身的级联。
  onProfileData((data) => settingsAiCascade.refresh(data));

  return { preload, load, isDirty, markClean };
}
