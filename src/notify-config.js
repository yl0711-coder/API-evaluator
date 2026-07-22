// src/notify-config.js
// 「邮件报警配置」：本页只做发信配置（SMTP 服务器/账号/收发件人）+ 发送测试邮件。
// 密码从不回显：GET 只带 smtpPasswordSet 布尔，保存时留空密码框＝保留原密码。
import { toast } from "./client-utils.js";
import { api } from "./api-client.js";
import { requireElement } from "./dom-utils.js";

export function createNotifyConfig({ state }) {
  const form = requireElement("#notify-config-form");
  const hostInput = requireElement("#ntf-host");
  const portInput = requireElement("#ntf-port");
  const sslInput = requireElement("#ntf-ssl");
  const userInput = requireElement("#ntf-user");
  const passwordInput = requireElement("#ntf-password");
  const fromInput = requireElement("#ntf-from");
  const recipientsInput = requireElement("#ntf-recipients");
  const testButton = requireElement("#ntf-test");
  const syncButton = requireElement("#ntf-sync");
  const statusEl = requireElement("#ntf-status");

  function fill(cfg) {
    hostInput.value = cfg.smtpHost || "";
    portInput.value = cfg.smtpPort || 465;
    sslInput.checked = cfg.smtpSsl !== false;
    userInput.value = cfg.smtpUser || "";
    passwordInput.value = "";
    passwordInput.placeholder = cfg.smtpPasswordSet ? "已设置（留空则保留）" : "未配置";
    fromInput.value = cfg.smtpFrom || "";
    recipientsInput.value = cfg.recipients || "";
  }

  async function load() {
    statusEl.textContent = "";
    try {
      const cfg = await api("/api/notify/config");
      fill(cfg);
    } catch (error) {
      toast(`加载失败：${error.message}`, true);
    }
  }

  function collect() {
    const payload = {
      smtpHost: hostInput.value.trim(),
      smtpPort: Number(portInput.value) || 465,
      smtpSsl: sslInput.checked,
      smtpUser: userInput.value.trim(),
      smtpFrom: fromInput.value.trim(),
      recipients: recipientsInput.value,
    };
    if (passwordInput.value) {
      payload.smtpPassword = passwordInput.value;
    }
    return payload;
  }

  async function save(event) {
    event.preventDefault();
    statusEl.textContent = "";
    try {
      const cfg = await api("/api/notify/config", {
        method: "PUT",
        body: JSON.stringify(collect()),
      });
      fill(cfg);
      toast("已保存邮件发信配置。");
    } catch (error) {
      toast(`保存失败：${error.message}`, true);
    }
  }

  async function test() {
    statusEl.textContent = "发送中…";
    try {
      await api("/api/notify/test", { method: "POST" });
      statusEl.textContent = "测试邮件已发送，请查收。";
      toast("测试邮件已发送。");
    } catch (error) {
      statusEl.textContent = `发送失败：${error.message}`;
      toast(`发送失败：${error.message}`, true);
    }
  }

  async function sync() {
    statusEl.textContent = "同步中…";
    try {
      const cfg = await api("/api/notify/smtp/sync", { method: "POST" });
      fill(cfg);
      statusEl.textContent = "已从线上 new-api 同步发信配置。";
      toast("已同步线上发信配置。");
    } catch (error) {
      statusEl.textContent = `同步失败：${error.message}`;
      toast(`同步失败：${error.message}`, true);
    }
  }

  form.addEventListener("submit", save);
  testButton.addEventListener("click", test);
  syncButton.addEventListener("click", sync);

  return { load };
}
