import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../../shared/errors.js";
import {
  completeMiWebVerification,
  getMiWebVerificationProxySession,
  updateMiWebVerificationCookies,
} from "./mi.service.js";

const verificationCookieName = "hmusic_mi_verification_id";
const accountOrigin = "https://account.xiaomi.com";
const browserUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export async function miPublicRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => done(null, body),
  );

  app.get("/mi-web-verification/:id", async (request, reply) => {
    const verificationId = getVerificationIdFromParams(request);
    const session = await getMiWebVerificationProxySession(verificationId);
    return reply
      .header("set-cookie", verificationCookie(verificationId))
      .type("text/html; charset=utf-8")
      .send(renderVerificationShell(verificationId, session.verificationUrl));
  });

  app.all("/mi-web-verification/:id/proxy", async (request, reply) => {
    const verificationId = getVerificationIdFromParams(request);
    const target = getTargetFromQuery(request);
    if (!target) {
      throw new AppError(
        "MI_WEB_PROXY_TARGET_MISSING",
        "小米验证代理缺少目标地址",
        400,
      );
    }
    return proxyXiaomiVerification(request, reply, verificationId, target);
  });

  for (const path of ["/fe/*", "/identity/*", "/pass/*", "/static/*"]) {
    app.all(path, async (request, reply) => {
      const verificationId = getVerificationIdFromCookie(request);
      if (!verificationId) {
        throw new AppError(
          "MI_WEB_PROXY_SESSION_MISSING",
          "小米验证代理会话不存在，请重新打开验证窗口",
          401,
        );
      }
      return proxyXiaomiVerification(
        request,
        reply,
        verificationId,
        `${accountOrigin}${request.url}`,
      );
    });
  }
}

async function proxyXiaomiVerification(
  request: FastifyRequest,
  reply: FastifyReply,
  verificationId: string,
  target: string,
) {
  const session = await getMiWebVerificationProxySession(verificationId);
  const targetUrl = normalizeTargetUrl(target);
  if (!targetUrl) {
    throw new AppError(
      "MI_WEB_PROXY_TARGET_INVALID",
      "小米验证代理目标地址无效",
      400,
    );
  }

  if (isStsUrl(targetUrl)) {
    return completeVerificationFromSts(reply, verificationId, targetUrl);
  }

  const response = await fetch(targetUrl, {
    method: request.method,
    redirect: "manual",
    headers: buildProxyHeaders(request, session.cookies, targetUrl),
    body: buildProxyBody(request),
  });

  const nextCookies = mergeCookies(
    session.cookies,
    extractCookiePairs(response.headers),
  );
  if (!cookiesEqual(nextCookies, session.cookies)) {
    await updateMiWebVerificationCookies(verificationId, nextCookies);
  }

  const redirectLocation = normalizeRedirectUrl(
    response.headers.get("location"),
    targetUrl,
  );
  if (redirectLocation) {
    if (isStsUrl(redirectLocation)) {
      return completeVerificationFromSts(
        reply,
        verificationId,
        redirectLocation,
      );
    }
    return reply.redirect(proxyUrl(verificationId, redirectLocation));
  }

  const contentType =
    response.headers.get("content-type") ?? "application/octet-stream";
  if (isRewriteableContent(contentType)) {
    const body = await response.text();
    return reply
      .code(response.status)
      .type(contentType)
      .send(rewriteBody(body, verificationId, targetUrl));
  }

  const body = Buffer.from(await response.arrayBuffer());
  return reply.code(response.status).type(contentType).send(body);
}

async function completeVerificationFromSts(
  reply: FastifyReply,
  verificationId: string,
  stsUrl: string,
) {
  await completeMiWebVerification(verificationId, {
    stsUrl,
  });
  return reply.type("text/html; charset=utf-8").send(renderSuccessHtml());
}

function renderVerificationShell(
  verificationId: string,
  verificationUrl: string,
) {
  const startUrl = proxyUrl(verificationId, verificationUrl);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>小米账号验证</title>
    <style>
      html, body, iframe { width: 100%; height: 100%; margin: 0; border: 0; }
      body { background: #fff; }
    </style>
  </head>
  <body>
    <iframe src="${escapeHtml(startUrl)}" referrerpolicy="no-referrer"></iframe>
  </body>
</html>`;
}

function renderSuccessHtml() {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>验证完成</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 32px; color: #1f2a2a; }
    </style>
  </head>
  <body>
    <h1>小米账号已登录</h1>
    <p>可以关闭此窗口，返回 HMusic Server 管理后台。</p>
    <script>
      try {
        const opener = window.top && window.top.opener ? window.top.opener : window.opener;
        opener && opener.postMessage({ type: "hmusic-mi-web-verification-complete" }, window.location.origin);
      } catch {}
      setTimeout(() => {
        try {
          window.top && window.top.close ? window.top.close() : window.close();
        } catch {
          window.close();
        }
      }, 800);
    </script>
  </body>
</html>`;
}

function buildProxyHeaders(
  request: FastifyRequest,
  cookies: Array<[string, string]>,
  targetUrl: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: headerValue(request.headers.accept, "*/*"),
    "accept-language": headerValue(
      request.headers["accept-language"],
      "zh-CN,zh;q=0.9",
    ),
    cookie: cookieHeader(cookies),
    referer: refererForTarget(headerValue(request.headers.referer), targetUrl),
    "user-agent": headerValue(request.headers["user-agent"], browserUserAgent),
  };
  const contentType = headerValue(request.headers["content-type"]);
  if (contentType) headers["content-type"] = contentType;
  return headers;
}

function buildProxyBody(request: FastifyRequest): string | Buffer | undefined {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  if (typeof request.body === "string") return request.body;
  if (Buffer.isBuffer(request.body)) return request.body;
  if (request.body && typeof request.body === "object") {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(
      request.body as Record<string, unknown>,
    )) {
      if (typeof value === "string") params.set(key, value);
    }
    return params.toString();
  }
  return undefined;
}

function headerValue(
  value: string | string[] | undefined,
  fallback = "",
): string {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

function isRewriteableContent(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized.includes("javascript") ||
    normalized.includes("json") ||
    normalized.includes("xml")
  );
}

function rewriteBody(
  body: string,
  verificationId: string,
  targetUrl: string,
): string {
  return rewriteCssReferences(
    rewriteHtmlReferences(body, verificationId, targetUrl),
    verificationId,
    targetUrl,
  ).replace(
    /(?:https:)?\/\/(?:account\.xiaomi\.com|api2?\.mina\.mi\.com|sts\.api\.io\.mi\.com)[^\s"'<>)]*/gi,
    (url) =>
      proxyUrl(verificationId, url.startsWith("//") ? `https:${url}` : url),
  );
}

function rewriteHtmlReferences(
  body: string,
  verificationId: string,
  targetUrl: string,
): string {
  return body.replace(
    /\b(href|src|action)=("([^"]*)"|'([^']*)')/gi,
    (
      match,
      attr: string,
      quoted: string,
      doubleValue?: string,
      singleValue?: string,
    ) => {
      const raw = doubleValue ?? singleValue ?? "";
      const target = resolveProxyReference(raw, targetUrl);
      if (!target) return match;
      const quote = quoted.startsWith("'") ? "'" : '"';
      return `${attr}=${quote}${proxyUrl(verificationId, target)}${quote}`;
    },
  );
}

function rewriteCssReferences(
  body: string,
  verificationId: string,
  targetUrl: string,
): string {
  return body.replace(
    /url\((["']?)([^"')]+)\1\)/gi,
    (match, quote: string, raw: string) => {
      const target = resolveProxyReference(raw.trim(), targetUrl);
      if (!target) return match;
      return `url(${quote}${proxyUrl(verificationId, target)}${quote})`;
    },
  );
}

function resolveProxyReference(
  value: string,
  targetUrl: string,
): string | undefined {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("/mi-web-verification/") ||
    /^(?:data|blob|mailto|tel|javascript):/i.test(trimmed)
  ) {
    return undefined;
  }

  try {
    const normalized = trimmed.startsWith("//")
      ? `https:${trimmed}`
      : trimmed.replace(/&amp;/g, "&");
    return normalizeTargetUrl(new URL(normalized, targetUrl).toString());
  } catch {
    return undefined;
  }
}

function getVerificationIdFromParams(request: FastifyRequest): string {
  const id = (request.params as { id?: string }).id;
  if (!id) {
    throw new AppError(
      "MI_WEB_PROXY_SESSION_MISSING",
      "小米验证代理会话不存在，请重新打开验证窗口",
      400,
    );
  }
  return id;
}

function getVerificationIdFromCookie(
  request: FastifyRequest,
): string | undefined {
  return parseCookieHeader(request.headers.cookie)[verificationCookieName];
}

function getTargetFromQuery(request: FastifyRequest): string | undefined {
  const value = (request.query as { url?: unknown }).url;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function proxyUrl(verificationId: string, target: string): string {
  return `/mi-web-verification/${encodeURIComponent(
    verificationId,
  )}/proxy?url=${encodeURIComponent(target)}`;
}

function verificationCookie(verificationId: string): string {
  return `${verificationCookieName}=${encodeURIComponent(
    verificationId,
  )}; Path=/; HttpOnly; SameSite=Lax; Max-Age=900`;
}

function normalizeTargetUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.host === "account.xiaomi.com" ||
      url.host === "api.mina.mi.com" ||
      url.host === "api2.mina.mi.com" ||
      url.host === "sts.api.io.mi.com"
    ) {
      return url.toString();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function normalizeRedirectUrl(
  location: string | null,
  targetUrl: string,
): string | undefined {
  if (!location) return undefined;
  try {
    return new URL(location, targetUrl).toString();
  } catch {
    return undefined;
  }
}

function isStsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.pathname === "/sts" &&
      (url.host === "api.mina.mi.com" ||
        url.host === "api2.mina.mi.com" ||
        url.host === "sts.api.io.mi.com")
    );
  } catch {
    return false;
  }
}

function refererForTarget(
  referer: string | undefined,
  targetUrl: string,
): string {
  if (!referer) return targetUrl;
  const urlMatch = referer.match(/[?&]url=([^&]+)/);
  if (!urlMatch?.[1]) return targetUrl;
  try {
    return decodeURIComponent(urlMatch[1]);
  } catch {
    return targetUrl;
  }
}

function cookieHeader(cookies: Array<[string, string]>): string {
  return cookies.map(([key, value]) => `${key}=${value}`).join("; ");
}

function mergeCookies(
  current: Array<[string, string]>,
  next: Array<[string, string]>,
): Array<[string, string]> {
  const jar = new Map(current);
  for (const [key, value] of next) {
    jar.set(key, value);
  }
  return Array.from(jar.entries());
}

function cookiesEqual(
  left: Array<[string, string]>,
  right: Array<[string, string]>,
): boolean {
  if (left.length !== right.length) return false;
  const rightMap = new Map(right);
  return left.every(([key, value]) => rightMap.get(key) === value);
}

function extractCookiePairs(headers: Headers): Array<[string, string]> {
  return getSetCookieHeaders(headers).flatMap((cookie) => {
    const match = cookie.match(/^([^=;]+)=([^;]*)/);
    if (!match?.[1] || !match[2]) return [];
    return [[match[1], match[2]]];
  });
}

function getSetCookieHeaders(headers: Headers): string[] {
  const getter = (headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie;
  if (typeof getter === "function") return getter.call(headers);
  const combined = headers.get("set-cookie");
  return combined ? [combined] : [];
}

function parseCookieHeader(value: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!value) return cookies;
  for (const part of value.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    cookies[trimmed.slice(0, separator)] = decodeURIComponent(
      trimmed.slice(separator + 1),
    );
  }
  return cookies;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
