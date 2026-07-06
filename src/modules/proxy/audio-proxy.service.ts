import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";
import { AppError } from "../../shared/errors.js";

const signatureLength = 22;

export function createAudioProxyUrl(targetUrl: string): string {
  const url = parseHttpUrl(targetUrl);
  const encoded = Buffer.from(url.toString()).toString("base64url");
  const signature = sign(encoded);
  return `${env.publicBaseUrl.replace(/\/$/, "")}/api/v1/proxy/audio/${encoded}.${signature}`;
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
