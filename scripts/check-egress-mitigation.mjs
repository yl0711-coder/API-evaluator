#!/usr/bin/env node
// 在【评测机本机】上跑，验证 SSRF 的「收益端」到底封没封。
//
// 背景：出站守卫（server/egress-guard.mjs）只是兜底，且它的 IPv6 判定曾经整整两个版本是死代码。
// DNS rebinding（审查 P1-2）是已知接受的缺口——接受的前提，是收益端在基础设施层另有封堵。
// 这个脚本就是去核实那个前提是否真的成立，别让它停留在「打算做」。
//
// 【必须在真正跑评测的那个环境里执行，否则结论无意义】
//   - 本项目按 deploy/docker-compose.evaluator.yml 跑在容器里，发起出站的是容器内的进程，
//     而容器有自己的网络命名空间——宿主机能不能通【不代表】容器能不能通。以容器内的结论为准：
//         docker exec api-evaluator node scripts/check-egress-mitigation.mjs
//     （镜像已 COPY scripts/，重新构建后即可用；旧镜像里没有本文件，用下面的一行版）
//   - 未部署新镜像时的等价一行版（容器里有 node，不需要本文件、不需要 curl）：
//         docker exec api-evaluator node -e "fetch('http://169.254.169.254/latest/meta-data/',{signal:AbortSignal.timeout(2000)}).then(r=>console.log('HTTP',r.status)).catch(e=>console.log('unreachable:',e.cause?.code||e.name))"
//   - 在开发机（笔记本 / 非云主机）上跑必然报「不可达」，那个 ✅ 一文不值，别拿它当结论。
//
// 只读探测云元数据端点，不改任何配置；退出码 0=已封堵，1=仍暴露。

const IMDS = "169.254.169.254";
const TIMEOUT_MS = 1500;

async function probe(path, headers = {}, method = "GET") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`http://${IMDS}${path}`, { method, headers, signal: controller.signal, redirect: "manual" });
    const body = await res.text().catch(() => "");
    return { ok: true, status: res.status, body: body.slice(0, 400) };
  } catch (error) {
    return { ok: false, reason: error?.cause?.code || error?.name || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

console.log(`探测 http://${IMDS}/ （超时 ${TIMEOUT_MS}ms）…\n`);

// 1) IMDSv1 直接 GET —— SSRF 能做到的就是这个
const v1 = await probe("/latest/meta-data/");

if (!v1.ok) {
  console.log(`  [1] IMDSv1 GET /latest/meta-data/ → 不可达（${v1.reason}）`);
  console.log("\n结论：✅ 元数据端点从【本进程所在的网络环境】不可达。");
  console.log("      SSRF 即便绕过出站守卫也拿不到云凭证——P1-2 的补偿控制成立。");
  console.log("\n⚠️  这个结论只对『跑本脚本的这个环境』有效，请确认你是在对的地方跑的：");
  console.log("      · 开发机 / 非云主机 → 必然不可达，此 ✅ 无意义，不能当结论");
  console.log("      · 宿主机上跑出的不可达 → 不代表容器内也不可达（容器有独立网络命名空间）");
  console.log("      · 真正要看的是评测进程所在处：docker exec api-evaluator node scripts/check-egress-mitigation.mjs");
  process.exit(0);
}

if (v1.status === 401) {
  console.log("  [1] IMDSv1 GET /latest/meta-data/ → 401（IMDSv2 已强制：取数据须先 PUT 拿 token）");
  const token = await probe("/latest/api/token", { "x-aws-ec2-metadata-token-ttl-seconds": "60" }, "PUT");
  console.log(`  [2] PUT /latest/api/token → ${token.ok ? `${token.status}（v2 通道正常）` : `不可达（${token.reason}）`}`);
  console.log("\n结论：✅ 已强制 IMDSv2。SSRF 的简单 GET 拿不到凭证——P1-2 的补偿控制成立。");
  process.exit(0);
}

// 2) v1 通了 —— 看看到底能拿到什么
console.log(`  [1] IMDSv1 GET /latest/meta-data/ → ${v1.status} ⚠️  可直接读取，未强制 IMDSv2`);
const roles = await probe("/latest/meta-data/iam/security-credentials/");
const roleName = roles.ok && roles.status === 200 ? roles.body.trim().split("\n")[0] : "";

if (roleName) {
  const cred = await probe(`/latest/meta-data/iam/security-credentials/${roleName}`);
  const hasKey = cred.ok && /AccessKeyId/.test(cred.body);
  console.log(`  [2] IAM 角色 → ${roleName}`);
  console.log(`  [3] 临时凭证 → ${hasKey ? "⚠️  可读出 AccessKeyId/SecretAccessKey（内容不打印）" : `${cred.status}`}`);
} else {
  console.log("  [2] IAM 角色 → 未挂载（元数据可读，但没有可偷的角色凭证）");
}

console.log("\n结论：❌ 收益端未封堵，出站守卫是唯一防线。");
console.log("      而 P1-2（DNS rebinding）是已知缺口、当前不修——前提正是收益端另有封堵，现在这个前提不成立。");
console.log("\n三条任选其一：");
console.log("  1. 摘掉本机 IAM 角色（不需要就别给）——最彻底");
console.log("  2. 强制 IMDSv2（AWS: MetadataOptions.HttpTokens=required）");
console.log(`  3. 网络层封死出站到 ${IMDS}（如 iptables -A OUTPUT -d ${IMDS} -j REJECT）`);
console.log("\n若三条都做不了，请回头修 P1-2（pin 已校验 IP），见 server/egress-guard.mjs 的决策记录。");
process.exit(1);
