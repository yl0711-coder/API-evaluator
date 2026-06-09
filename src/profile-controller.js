import { api } from "./api-client.js";
import { toast } from "./client-utils.js";
import { formatResult } from "./formatters.js";
import { buildErrorAdviceText, validateProfileConfig } from "./operator-guidance.js";

export function createProfileController({
  state,
  profileForm,
  profileTemplate,
  demoModeBanner,
  renderProfileConfigCheck,
  loadProfiles,
  loadRequests,
  quickProfileSelect,
  quickTestResult,
  quickFailurePanel,
  showPage,
  confirmAction,
}) {
  async function saveProfileFromForm({ resetAfterSave }) {
    if (state.demoMode) {
      state.demoMode = false;
      demoModeBanner.classList.add("hidden");
    }
    const payload = Object.fromEntries(new FormData(profileForm).entries());
    const validation = validateProfileConfig(payload);
    renderProfileConfigCheck(validation);
    if (validation.hasBlockers) {
      throw new Error("配置里有必须修正的问题，请先按提示修改。");
    }
    if (validation.hasWarnings) {
      const warnings = validation.issues
        .filter((issue) => issue.level === "warning")
        .map((issue) => `${issue.title}：${issue.detail}`);
      const confirmed = await confirmAction({
        title: "配置里有一些风险",
        message: "这些问题不一定会导致失败，但建议先确认后再保存。",
        items: warnings,
        confirmLabel: "仍然保存",
        cancelLabel: "返回修改",
        tone: "normal",
      });
      if (!confirmed) {
        throw new Error("已取消保存。");
      }
    }

    const saved = await api("/api/profiles", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    // 保存后清掉编辑 id，表单回到“新建”态，避免后续误更新到刚编辑过的渠道。
    if (profileForm.elements.id) profileForm.elements.id.value = "";
    if (resetAfterSave) {
      profileForm.reset();
      profileTemplate.value = "";
      profileForm.elements.maxTokens.value = "512";
      profileForm.elements.timeoutMs.value = "60000";
      renderProfileConfigCheck();
    }
    await loadProfiles();
    return saved;
  }

  async function saveAndTestProfile() {
    const button = document.querySelector("#save-and-test-profile");
    button.disabled = true;
    button.textContent = "保存并测试中...";
    try {
      const saved = await saveProfileFromForm({ resetAfterSave: false });
      await loadProfiles();
      const result = await api("/api/tests/quick", {
        method: "POST",
        body: JSON.stringify({
          profileId: saved.id,
          prompt: "请用一句话说明你现在可以正常工作。",
        }),
      });
      await loadRequests();
      if (result.success) {
        toast("配置可用，快速测试已通过。");
        quickProfileSelect.value = saved.id;
        quickTestResult.textContent = formatResult(result);
        quickFailurePanel.renderSuccess(saved.id);
        showPage("quick-test");
      } else {
        quickProfileSelect.value = saved.id;
        quickTestResult.textContent = `${formatResult(result)}\n\n${buildErrorAdviceText(result)}`;
        quickFailurePanel.render(result, saved.id);
        showPage("quick-test");
        toast("配置已保存，但快速测试失败。请按页面建议修正。", true);
      }
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = "保存并测试配置";
    }
  }

  async function importProfiles(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (state.demoMode) {
        state.demoMode = false;
        demoModeBanner.classList.add("hidden");
      }
      const raw = await file.text();
      const data = JSON.parse(raw);
      const result = await api("/api/profiles/import", {
        method: "POST",
        body: JSON.stringify(data),
      });
      await loadProfiles();
      const missingCount = state.profiles.filter((profile) => profile.hasKey === false || !profile.apiKey).length;
      toast(missingCount > 0 ? `配置导入完成：${result.imported} 条。还有 ${missingCount} 条需要补 Key。` : `配置导入完成：${result.imported} 条。`);
    } catch (error) {
      toast(`导入失败：${error.message}`, true);
    } finally {
      event.target.value = "";
    }
  }

  return { saveProfileFromForm, saveAndTestProfile, importProfiles };
}
