// 出站安全兜底
// 发起出站前校验目标解析 IP，拒绝内网/保留网段；防 DNS rebinding（校验实连 IP）。
// 主防护是「仅超管能填 URL」，本模块是兜底（防误填 / 防超管账号被盗）。
// 开关：EVALUATOR_EGRESS_DENY_PRIVATE，默认 true。
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

function isPrivateV6(ip) {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 ULA
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
  if (mapped) return isPrivateV4(mapped[1]);
  return false;
}

async function defaultLookupAll(host) {
  const records = await dns.lookup(host, { all: true });
  return records.map((record) => record.address);
}

// 校验目标 URL：协议须为 http/https，且其字面 IP 或所有解析 IP 都必须是公网。内网则抛 EgressBlockedError。
// 返回解析到的 IP 列表（仅供诊断/日志；调用方当前未 pin 该 IP，故 DNS-rebinding 的 TOCTOU 窗口
// 未完全消除——本模块是兜底防护，主防护是「仅超管能填 URL」）。
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
