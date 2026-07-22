// server/mailer.mjs
// 邮件报警的发信能力：把 notify-config + secret-store 里取好的配置拼成一封邮件发出去。
// 参考 newapi-monitor 的 monitor/alert.go（465 端口=隐式 TLS，其余端口=STARTTLS）。
// 真实发信走懒加载的 nodemailer（非请求热路径的管理员触发操作，与 newapi-source.mjs 的 mysql2 先例一致）；
// 测试通过 opts.transportFactory 注入假 transporter，与 auth.mjs 的 opts.fetchImpl 是同一惯例。

// 把收件人字符串（逗号/分号/换行/空白混合分隔）拆成去空、去重、保序的邮箱列表。
export function recipientList(raw) {
  const parts = String(raw || "")
    .split(/[,;\n\r\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(parts)];
}

export function buildTestMailBody() {
  const now = new Date().toISOString();
  return `这是一封 API-evaluator 的【配置测试邮件】。\n\n如果你收到了这封邮件，说明 SMTP 发信配置正确。\n\n发送时间：${now}`;
}

export async function sendMail(cfg, subject, body, opts = {}) {
  const to = recipientList(cfg.recipients);
  if (to.length === 0) {
    throw new Error("收件人为空，无法发送邮件。");
  }
  const transportFactory = opts.transportFactory || defaultTransportFactory;
  const transporter = await transportFactory(cfg);
  await transporter.sendMail({
    from: cfg.smtpFrom || cfg.smtpUser,
    to,
    subject,
    text: body,
  });
}

async function defaultTransportFactory(cfg) {
  let nodemailer;
  try {
    nodemailer = (await import("nodemailer")).default ?? (await import("nodemailer"));
  } catch {
    throw new Error("缺少 nodemailer 依赖，无法发送邮件。");
  }
  return nodemailer.createTransport({
    ...resolveTransportOptions(cfg),
    auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPassword } : undefined,
  });
}

// 纯函数：算出 host/port/secure/超时，不碰 nodemailer/网络，便于单测覆盖 SSL 判定分支
// （此前这里的判定曾只看端口号、完全没读 cfg.smtpSsl——页面上的 SSL 勾选框存了、也显示了，
// 但实际发信时形同虚设。465 端口固定隐式 TLS 与勾选无关；其它端口勾了才走隐式 TLS，
// 没勾则强制 STARTTLS——从不允许明文发信）。
export function resolveTransportOptions(cfg) {
  const port = Number(cfg.smtpPort) || 465;
  const secure = port === 465 || cfg.smtpSsl === true;
  return {
    host: cfg.smtpHost,
    port,
    secure,
    requireTLS: !secure,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 15_000,
  };
}
