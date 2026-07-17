import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";
import { AppError } from "../../shared/errors.js";
import { resolvePublicBaseUrl } from "../../shared/public-base-url.js";

const signatureLength = 22;

export function createAudioProxyUrl(targetUrl: string): string {
  const base = resolvePublicBaseUrl();
  const url = parseHttpUrl(targetUrl);
  // 自家代理地址（本地已下载文件、历史队列存的签名链接）已是终点，二次包装
  // 会让服务器自呼自。按路径识别并重挂到当前 base：换网后带旧 IP 的存量链接
  // 也能继续用——签名只覆盖 token 部分，与 host 无关。
  if (url.pathname.startsWith("/api/v1/proxy/")) {
    return `${base}${url.pathname}`;
  }
  const encoded = Buffer.from(url.toString()).toString("base64url");
  const signature = sign(encoded);
  return `${base}/api/v1/proxy/audio/${encoded}.${signature}`;
}

// 本地已下载音频：/proxy/local/<downloadId>.<签名>，与音频代理同一信任模型
// （无需登录但必须持有效签名——音箱和 <audio> 都带不了 JWT）。
export function createLocalAudioUrl(downloadId: string): string {
  const base = resolvePublicBaseUrl();
  return `${base}/api/v1/proxy/local/${downloadId}.${sign(downloadId)}`;
}

export function verifyLocalAudioToken(token: string): string {
  const [id, signature] = token.split(".");
  if (!id || !signature || !isValidSignature(id, signature)) {
    throw new AppError("AUDIO_PROXY_TOKEN_INVALID", "本地音频链接无效", 403);
  }
  return id;
}

export function decodeAudioProxyToken(token: string): string {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature || !isValidSignature(encoded, signature)) {
    throw new AppError("AUDIO_PROXY_TOKEN_INVALID", "音频代理链接无效", 403);
  }

  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  return parseHttpUrl(decoded).toString();
}

function parseHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("AUDIO_PROXY_URL_INVALID", "音频地址无效", 400);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(
      "AUDIO_PROXY_URL_UNSUPPORTED",
      "音频代理仅支持 http/https 地址",
      400,
    );
  }

  return url;
}

function sign(encoded: string): string {
  return createHmac("sha256", env.jwtSecret)
    .update(encoded)
    .digest("base64url")
    .slice(0, signatureLength);
}

function isValidSignature(encoded: string, signature: string): boolean {
  if (signature.length !== signatureLength) return false;

  const expected = sign(encoded);
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
