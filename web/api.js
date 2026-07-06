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
  if (body !== undefined && typeof body !== "string") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }

  const response = await fetch(`/api/v1${path}`, {
    method: options.method || "GET",
    headers,
    body,
  });

  // 401 统一视为登录失效，清 token 让路由回登录页。
  if (response.status === 401) {
    clearToken();
    throw new ApiError("UNAUTHORIZED", "登录已失效，请重新登录", 401);
  }

  const text = await response.text();
  const payload = text ? safeJson(text) : undefined;

  if (!response.ok) {
    const err = payload?.error;
    throw new ApiError(
      err?.code || "REQUEST_FAILED",
      err?.message || `请求失败 (${response.status})`,
      response.status,
      err?.details,
    );
  }

  return payload;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
