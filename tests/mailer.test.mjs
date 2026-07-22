// tests/mailer.test.mjs
// 单元：mailer.mjs 的收件人解析 + 发信调用参数，全程通过注入的假 transportFactory
// 验证（不加载真实 nodemailer、不碰网络），DI 手法与 auth.mjs 的 opts.fetchImpl 一致。
import assert from "node:assert/strict";
import test from "node:test";
import { recipientList, buildTestMailBody, sendMail, resolveTransportOptions } from "../server/mailer.mjs";

test("recipientList：逗号/分号/换行/空格混合分隔，trim+去空+去重", () => {
  assert.deepEqual(recipientList("a@x.com, b@x.com;c@x.com\nd@x.com  e@x.com"), [
    "a@x.com",
    "b@x.com",
    "c@x.com",
    "d@x.com",
    "e@x.com",
  ]);
  assert.deepEqual(recipientList("a@x.com, a@x.com"), ["a@x.com"], "去重");
  assert.deepEqual(recipientList(""), []);
  assert.deepEqual(recipientList(null), []);
});

test("buildTestMailBody：含测试邮件说明与时间戳", () => {
  const body = buildTestMailBody();
  assert.match(body, /配置测试邮件/);
  assert.match(body, /\d{4}-\d{2}-\d{2}T/);
});

test("sendMail：收件人为空直接抛错，不调用 transportFactory", async () => {
  let called = false;
  await assert.rejects(
    () =>
      sendMail(
        { smtpHost: "smtp.example.com", smtpPort: 465, recipients: "" },
        "subject",
        "body",
        { transportFactory: async () => ({ sendMail: async () => { called = true; } }) },
      ),
    /收件人为空/,
  );
  assert.equal(called, false);
});

test("sendMail：cfg 原样传给 transportFactory；mail 里的 from/to/subject/text 正确透传", async () => {
  const calls = [];
  const fakeTransportFactory = async (cfg) => {
    calls.push({ cfg });
    return {
      sendMail: async (mail) => {
        calls.push({ mail });
      },
    };
  };
  await sendMail(
    {
      smtpHost: "smtp.example.com",
      smtpPort: 465,
      smtpUser: "bot@example.com",
      smtpFrom: "alerts@example.com",
      smtpPassword: "s3cret",
      recipients: "a@example.com, b@example.com",
    },
    "测试主题",
    "测试正文",
    { transportFactory: fakeTransportFactory },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].cfg.smtpPort, 465);
  assert.deepEqual(calls[1].mail, {
    from: "alerts@example.com",
    to: ["a@example.com", "b@example.com"],
    subject: "测试主题",
    text: "测试正文",
  });
});

test("sendMail：未填发件人 → from 落回登录账号", async () => {
  let sentMail;
  await sendMail(
    { smtpHost: "smtp.example.com", smtpPort: 587, smtpUser: "bot@example.com", smtpFrom: "", recipients: "a@example.com" },
    "s",
    "b",
    {
      transportFactory: async () => ({
        sendMail: async (mail) => {
          sentMail = mail;
        },
      }),
    },
  );
  assert.equal(sentMail.from, "bot@example.com");
});

test("sendMail：transportFactory 抛错原样透出", async () => {
  await assert.rejects(
    () =>
      sendMail({ smtpHost: "bad.example.com", smtpPort: 465, recipients: "a@example.com" }, "s", "b", {
        transportFactory: async () => {
          throw new Error("连接失败");
        },
      }),
    /连接失败/,
  );
});

// 回归：SSL 勾选框此前只存、只显示，实际发信时被完全忽略（只看端口号），页面提示与真实行为不符。
test("resolveTransportOptions：465 端口固定隐式 TLS，与 smtpSsl 勾选无关", () => {
  assert.equal(resolveTransportOptions({ smtpPort: 465, smtpSsl: false }).secure, true);
  assert.equal(resolveTransportOptions({ smtpPort: 465, smtpSsl: true }).secure, true);
});

test("resolveTransportOptions：非 465 端口，勾选 SSL → 隐式 TLS；不勾 → 强制 STARTTLS（从不明文）", () => {
  const withSsl = resolveTransportOptions({ smtpPort: 587, smtpSsl: true });
  assert.equal(withSsl.secure, true);
  assert.equal(withSsl.requireTLS, false);

  const withoutSsl = resolveTransportOptions({ smtpPort: 587, smtpSsl: false });
  assert.equal(withoutSsl.secure, false);
  assert.equal(withoutSsl.requireTLS, true, "不勾 SSL 仍必须要求 STARTTLS，不允许明文发信");
});

test("resolveTransportOptions：非法/缺省端口兜底 465；带显式超时避免主机无响应时无限期挂起", () => {
  const cfg = resolveTransportOptions({ smtpHost: "smtp.example.com", smtpPort: 0, smtpSsl: true });
  assert.equal(cfg.port, 465);
  assert.equal(cfg.host, "smtp.example.com");
  assert.equal(cfg.connectionTimeout, 15_000);
  assert.equal(cfg.greetingTimeout, 15_000);
  assert.equal(cfg.socketTimeout, 15_000);
});
