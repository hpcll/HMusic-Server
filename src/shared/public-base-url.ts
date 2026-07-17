import os from "node:os";
import { env } from "../config/env.js";

const ipv4Pattern = /^\d{1,3}(?:\.\d{1,3}){3}$/;

// 面向局域网设备（小爱音箱、<audio>）生成绝对地址时的基座。配置值若是回环
// 地址，或换网后已不在本机任何网卡上的失效 IPv4，实时替换为当前局域网
// IPv4——换网后不需要改 .env、也不需要手动重启才能出声。域名（含反向代理
// HTTPS）视为用户刻意配置，原样信任。
export function resolvePublicBaseUrl(): string {
  return pickPublicBaseUrl(env.publicBaseUrl, currentIPv4Addresses());
}

// 纯函数部分单独导出，便于单测注入网卡地址列表。返回值恒不带尾斜杠。
export function pickPublicBaseUrl(
  configured: string,
  addresses: string[],
): string {
  const trimmed = configured.replace(/\/$/, "");
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return trimmed;
  }

  const host = url.hostname;
  const isLoopback = host === "localhost" || host.startsWith("127.");
  if (!isLoopback && !ipv4Pattern.test(host)) return trimmed;
  if (!isLoopback && addresses.includes(host)) return trimmed;

  const lan = pickLanAddress(addresses);
  if (!lan) return trimmed;

  url.hostname = lan;
  return url.toString().replace(/\/$/, "");
}

// 链路本地地址音箱访问不到，不能当替换目标；有私网地址时优先私网。
function pickLanAddress(addresses: string[]): string | undefined {
  const usable = addresses.filter(
    (address) => !address.startsWith("127.") && !address.startsWith("169.254."),
  );
  return usable.find(isPrivateIPv4) ?? usable[0];
}

function isPrivateIPv4(address: string): boolean {
  if (address.startsWith("192.168.") || address.startsWith("10.")) return true;
  const second = Number(address.split(".")[1]);
  return address.startsWith("172.") && second >= 16 && second <= 31;
}

function currentIPv4Addresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(
      (item): item is os.NetworkInterfaceInfo =>
        item !== undefined && item.family === "IPv4" && !item.internal,
    )
    .map((item) => item.address);
}