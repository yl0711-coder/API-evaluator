// src/model-profile-page.js
// 「模型档案」独立页面（/model-profile/）的入口。
//
// 与 src/app.js 的关系：**不复用它**。app.js 是主站 SPA 的入口，会初始化 20 多个模块、
// 拉 7 份数据、建整套侧栏导航——本页只需要渠道/模型两份数据加一个模块，
// 引 app.js 等于为一个页面启动整个应用。
//
// 本文件只做四件事：登录闸门 → 拉两份数据 → 建模块 → 支持 ?targetId= 深链。
import { api } from "./api-client.js";
import { ensureAuthenticated, wireUnauthorizedRedirect } from "./auth-gate.js";
import { installClientErrorReporter } from "./client-error-reporter.js";
import { createCascadeTargetPicker } from "./target-picker.js";
import { createModelProfile } from "./model-profile.js";
import { toast } from "./client-utils.js";

installClientErrorReporter();

// 本页只用到这三份（filterFilesForTarget 读 aliases、级联下拉读渠道与模型目标）。
// 结构与 app.js 的 state 同形，让 model-profile.js 在两处都能用而不必分叉。
const state = { channels: [], modelTargets: [], profiles: [] };

const modelProfile = createModelProfile({ state, deps: { createCascadeTargetPicker } });

// 独立页面同样要过登录闸门：后端已强制鉴权（/api/model-profile 不在免登录白名单），
// 这里只是把 401 变成一个登录框而不是一页报错。
await ensureAuthenticated();
wireUnauthorizedRedirect();

try {
  // profiles 是老版「渠道+模型二合一」的遗留配置，级联下拉要用它补出「旧配置」分组。
  // 三个都失败不了就并行拉；任一失败则整页给可读提示（下同 app.js 的兜底思路）。
  const [channels, modelTargets, profiles] = await Promise.all([
    api("/api/channels").catch(() => []),
    api("/api/model-targets"),
    api("/api/profiles").catch(() => []),
  ]);
  state.channels = channels;
  state.modelTargets = modelTargets;
  state.profiles = profiles;
  modelProfile.refreshTargets(state);

  // 深链支持：/model-profile/?targetId=xxx 直接打开某个模型。
  // 这是独立页面才有的好处——可以把某个模型的档案链接发给别人。
  const wanted = new URLSearchParams(location.search).get("targetId");
  if (wanted) modelProfile.selectTarget(wanted);
  await modelProfile.load();
} catch (error) {
  const main = document.querySelector(".mp-main");
  if (main) {
    const box = document.createElement("section");
    box.className = "mp-startup-error";
    const title = document.createElement("strong");
    title.textContent = "连接本地服务失败";
    const tip = document.createElement("p");
    tip.textContent = "请确认评测平台正在运行，然后刷新本页。若反复出现，把这条提示发给负责人。";
    const detail = document.createElement("p");
    detail.className = "mp-dim-text";
    detail.textContent = error?.message ? String(error.message) : String(error);
    box.append(title, tip, detail);
    main.prepend(box);
  }
  toast("加载失败。", true);
}
