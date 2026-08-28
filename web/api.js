// HMusic 前端 API 客户端：统一处理 JWT、错误契约和 JSON 编解码。
// 后端错误格式为 { error: { code, message, details } }，见 src/shared/errors.ts。

const TOKEN_KEY = "hmusic.accessToken";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

// 前端可捕获的结构化错误，携带后端的 code 便于分支处理。
export class ApiError extends Error {
  constructor(code, message, statusCode, details) {
    super(message || code || "请求失败");
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let body = options.body;
  // FormData（如曲库上传）原样透传：不设 Content-Type，浏览器自带 multipart boundary。
  if (body !== undefined && typeof body !== "string" && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }

  const response = await fetch(`/api/v1${path}`, {
    method: options.method || "GET",
    headers,
    body,
  });

  const text = await response.text();
  const payload = text ? safeJson(text) : undefined;

  // 401 统一视为登录失效，清 token 并广播——main.js 监听后跳登录页，
  // 否则页面停在原地装死，点什么都只弹"登录已失效"。
  // 但只有「本来带了 token」的请求才算会话失效：登录/首次创建管理员这种
  // 不带 token 的请求收到 401，说的是凭据本身不对（见 describeFailure）。
  if (response.status === 401) {
    console.warn(
      `[hmusic] 401 ${path}`,
      payload?.error?.code || "(响应里没有 HMusic 错误信封)",
      payload?.error?.message || "",
    );
    if (token) {
      clearToken();
      window.dispatchEvent(new Event("hmusic:unauthorized"));
    }
  }

  if (!response.ok) {
    const err = payload?.error;
    const code =
      err?.code ||
      (response.status === 401 ? "UNAUTHORIZED" : "REQUEST_FAILED");
    throw new ApiError(
      code,
      describeFailure(response.status, code, err, Boolean(token)),
      response.status,
      err?.details,
    );
  }

  return payload;
}

// 服务端明确表示「没拿到可用凭据」的 code（@fastify/jwt）：
// NO_AUTHORIZATION_IN_HEADER = 没有 Authorization，或它不是 `Bearer xxx` 形式（401，
//   代理删掉了头、或换成了自己的 Basic 凭据）；
// BAD_REQUEST = 是 Bearer 但格式被破坏（400，头在路上被拼接/改写过）。
const MISSING_CREDENTIAL_CODES = new Set([
  "FST_JWT_NO_AUTHORIZATION_IN_HEADER",
  "FST_JWT_BAD_REQUEST",
]);

// 公网反代下这几种失败最容易被误读成同一件事，这里分开说：
// 曾有用户反代到公网后登录报「登录已失效，请重新登录」，实际是后端返回的
// 「用户名或密码错误」被前端一律改写成了会话失效的文案。
function describeFailure(status, code, err, hadToken) {
  if (hadToken && MISSING_CREDENTIAL_CODES.has(code)) {
    return "服务端没收到本次请求的登录凭据；公网/反向代理访问时请检查代理是否删除或改写了 Authorization 请求头";
  }
  if (status === 401) {
    // 401 里连 { error: { code, message } } 都没有 → 这个 401 不是 HMusic 发的，
    // 大概率被反向代理/网关（Basic auth、Authelia 之类）拦在了门外。
    if (!err) {
      return "请求被拒绝（401），且响应不是 HMusic 的错误格式；公网/反向代理访问时请检查代理是否拦截了 /api/v1 请求";
    }
    if (hadToken) return "登录已失效，请重新登录";
    return err.message || "用户名或密码错误";
  }
  return err?.message || `请求失败 (${status})`;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
