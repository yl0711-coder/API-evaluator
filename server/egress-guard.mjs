// 出站安全兜底
// 发起出站前校验目标的字面 IP 或 DNS 解析结果，拒绝内网/保留网段。
// 主防护是「仅超管能填 URL」，本模块是兜底（防误填 / 防超管账号被盗）。
// 开关：EVALUATOR_EGRESS_DENY_PRIVATE，默认 true。
//
// 【本模块不防 DNS rebinding】——曾经这里写着「防 DNS rebinding（校验实连 IP）」，那是错的：
// 本模块既不校验实连 IP，也不 pin 校验通过的 IP（详见 assertPublicTarget 上的决策记录）。
// 那句话比漏洞本身更危险，因为它让读代码的人以为这事办了，从而不去看。别再写回去。
//
// 【这道守卫的历史教训】v0.5.3–v0.6.1 期间，下面 isPrivateV6 的 IPv4-mapped 判定一直是死代码
// （按点分十进制写正则，而 WHATWG URL 会先归一化成十六进制），整整两个版本没人发现，
// 期间 [::ffff:a9fe:a9fe]（云元数据）畅通无阻。结论不是「守卫要写得更花哨」，而是：
// 别把这一道守卫当成唯一防线，收益端（云元数据 / IAM 凭证）的封堵必须在基础设施层另有一手。
import dns from "node:dns/promises";
import net from "node:net";

export class EgressBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "EgressBlockedError";
    this.code = "egress_blocked";
    this.status = 502;
    this.userMessage = `出站被安全策略拦截：${message}`;
  }
}

function denyPrivateEnabled() {
  return process.env.EVALUATOR_EGRESS_DENY_PRIVATE !== "false";
}

// 内网 / 保留网段判定。解析不出或非法一律视为不安全（fail-closed）。
export function isPrivateOrReservedIp(ip) {
  if (!ip || typeof ip !== "string") return true;
  const family = net.isIP(ip);
  if (family === 4) return isPrivateV4(ip);
  if (family === 6) return isPrivateV6(ip);
  return true;
}

function isPrivateV4(ip) {
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224) return true; // 224+ multicast / 保留
  return false;
}

// 把 IPv6 文本解析成 16 字节，再按位段判定——不要按文本前缀/正则判。
// 教训：旧实现用 /::ffff:(\d+\.\d+\.\d+\.\d+)$/ 认 IPv4-mapped，要求点分十进制书写；
// 但 WHATWG URL 会先把 [::ffff:127.0.0.1] 归一化成 [::ffff:7f00:1]（十六进制），
// 正则永不命中 → 整段 IPv4-mapped 判定是死代码，[::ffff:a9fe:a9fe]（=169.254.169.254
// 云元数据）可直接绕过守卫。同理 "fe80" 前缀只覆盖 fe80::/16，漏掉 fe80::/10 的其余部分。
// 支持 "::" 压缩、末尾内嵌 IPv4、zone id；解析失败返回 null，调用方按不安全处理。
function v6ToBytes(input) {
  let s = String(input).split("%")[0].toLowerCase().replace(/^\[|\]$/g, "");

  // 末尾内嵌 IPv4（::ffff:127.0.0.1 / ::127.0.0.1）→ 先折成两个十六进制段，统一走下面的解析
  const embedded = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded) {
    const v4 = embedded[1].split(".").map(Number);
    if (v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    s = `${s.slice(0, -embedded[1].length)}${hi}:${lo}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toHextets = (part) => (part ? part.split(":").filter((x) => x !== "").map((h) => parseInt(h, 16)) : []);
  const left = toHextets(halves[0]);
  const right = halves.length === 2 ? toHextets(halves[1]) : [];
  const gap = 8 - left.length - right.length;
  if (halves.length === 2 ? gap < 0 : gap !== 0) return null;
  const hextets = [...left, ...new Array(halves.length === 2 ? gap : 0).fill(0), ...right];
  if (hextets.length !== 8 || hextets.some((h) => !Number.isInteger(h) || h < 0 || h > 0xffff)) return null;

  const bytes = [];
  for (const h of hextets) bytes.push((h >> 8) & 0xff, h & 0xff);
  return bytes;
}

function isPrivateV6(ip) {
  const b = v6ToBytes(ip);
  if (!b) return true; // 解析不出 → fail-closed
  const allZero = (from, to) => b.slice(from, to).every((x) => x === 0);

  // ::ffff:0:0/96 IPv4-mapped —— 还原内嵌 v4 按 v4 规则判（含 169.254.169.254 云元数据、127/8 回环）
  if (allZero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPrivateV4(b.slice(12).join("."));
  // ::/96 —— 含 :: (unspecified)、::1 (loopback)、::a.b.c.d (已废弃的 IPv4-compatible)，整段保留
  if (allZero(0, 12)) return true;
  // 64:ff9b::/96 与 64:ff9b:1::/48 NAT64 —— 同样内嵌 v4，可用于包裹内网地址
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return true;
  // fe80::/10 link-local（按位段判，不是 "fe80" 前缀：fe80–febf 都算）
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;
  // fc00::/7 ULA
  if ((b[0] & 0xfe) === 0xfc) return true;
  // ff00::/8 multicast
  if (b[0] === 0xff) return true;
  // 2002::/16 6to4 —— 内嵌 v4 在 bit 16..47，按内嵌地址判
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateV4(b.slice(2, 6).join("."));
  return false;
}

async function defaultLookupAll(host) {
  const records = await dns.lookup(host, { all: true });
  return records.map((record) => record.address);
}

// 校验目标 URL：协议须为 http/https，且其字面 IP 或所有解析 IP 都必须是公网。内网则抛 EgressBlockedError。
// 返回解析到的 IP 列表（仅供诊断/日志）。
//
// ——— 决策记录：DNS rebinding（原审查 P1-2）为「已知接受的缺口」，非漏修 ———
// 现状：本函数解析域名并逐个校验 IP，但【不 pin】校验通过的 IP；随后 fetch(undici) 会独立再解析
// 一次并连接。两次解析之间无绑定 → TOCTOU 窗口。攻击者控制一个 TTL≈0 的域名（第一次返回公网
// 骗过校验、第二次返回 169.254.169.254），并诱导超管把它填成上游 base URL，即可打进元数据。
// redirect:"error" 挡不住——这不是重定向，是 DNS 层的时间差。
//
// 为什么不修（2026-07-16 决策，内部自用 + 整站在 BasicAuth 之后 + 填 URL 是超管动作）：
//   1) 成本：Node 不公开导出 undici，想在保留 fetch 的前提下传自定义 lookup 必须新增 undici 依赖；
//      不加依赖就得把三个出站点改写成 node:https.request，重新实现流式读取/中止/重定向语义——
//      而这是本产品的核心链路。相对收益，代价过高。
//   2) 收益端另有一手更硬的封堵（见下），它不依赖「守卫代码写得对」——而守卫的 IPv6 判定刚被
//      证明整整两个版本都是死的。收益端封堵是按【目标 IP】在基础设施层拦，故也覆盖任何未来新增、
//      一时漏接守卫的出站点（当前三个出站点 test-runner / client-replay / newapi-source 都已过守卫）。
//   3) 触发链需要攻击者自建 rebinding DNS + 社工超管；相比之下「超管填错内网地址」这类现实误用，
//      本函数已能挡住（且解析出的【全部】IP 都校验，轮询 DNS 混入内网 IP 也挡得住）。
//
// 依赖的补偿控制（这三条任一落地即可，属基础设施层，不在本仓库）：
//   - 摘掉评测机的 IAM 角色（不需要就别给）；或
//   - 强制 IMDSv2（取数据须先 PUT 拿 token，SSRF 的简单 GET 拿不到）；或
//   - 网络层封死到 169.254.169.254 的出站。
//
// 什么时候必须回来修（任一成立即重新评估，别等下一次审查）：
//   - 本平台对公司外部开放（哪怕只是分享报告）；或
//   - 超管从「几个信得过的人」扩大到外包 / 十几人；或
//   - 上面三条补偿控制一条都没落地。
export async function assertPublicTarget(urlString, { lookup } = {}) {
  if (!denyPrivateEnabled()) return [];
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new EgressBlockedError("目标地址无效。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EgressBlockedError(`不支持的出站协议：${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw new EgressBlockedError(`目标指向内网 / 保留地址，已拒绝：${host}`);
    }
    return [host];
  }
  const resolver = lookup || defaultLookupAll;
  let addresses;
  try {
    addresses = await resolver(host);
  } catch {
    throw new EgressBlockedError(`无法解析目标域名：${host}`);
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new EgressBlockedError(`目标域名无解析结果：${host}`);
  }
  for (const ip of addresses) {
    if (isPrivateOrReservedIp(ip)) {
      throw new EgressBlockedError(`目标域名解析到内网 / 保留地址，已拒绝：${host} → ${ip}`);
    }
  }
  return addresses;
}
