import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { chromium, type Browser } from "playwright-core";
import { db } from "../../db/index.js";
import { users } from "../../db/schema.js";
import { AppError } from "../../shared/errors.js";
import { linkSession } from "./spotify.service.js";

const LOGIN_URL =
  "https://accounts.spotify.com/login?continue=https%3A%2F%2Fopen.spotify.com%2F";
const LOGIN_TTL_MS = 10 * 60 * 1000;

type LoginState =
  | "starting"
  | "waiting"
  | "verifying"
  | "succeeded"
  | "cancelled"
  | "expired"
  | "failed";

export interface SpotifyLoginStatus {
  id: string;
  status: LoginState;
  expiresAt: number;
  message: string;
}

interface LoginAttempt extends SpotifyLoginStatus {
  ownerId: string;
  controller: AbortController;
  browser: Browser | null;
  timer: ReturnType<typeof setTimeout>;
  task: Promise<void>;
}

// 服务只有一份 Spotify 绑定，同时最多开一个登录窗口。临时浏览器与日常
// Chrome 资料隔离；只读取本次登录的 sp_dc，不采集账号密码或其他站点凭据。
let current: LoginAttempt | null = null;

function pending(attempt: LoginAttempt): boolean {
  return ["starting", "waiting", "verifying"].includes(attempt.status);
}

function publicStatus(attempt: LoginAttempt): SpotifyLoginStatus {
  return {
    id: attempt.id,
    status: attempt.status,
    expiresAt: attempt.expiresAt,
    message: attempt.message,
  };
}

function requireOwner(ownerId: string): void {
  // JWT 签名有效仍须有对应账号，已删账号的旧 token 不能再打开登录窗口。
  if (!db.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).get()) {
    throw new AppError("UNAUTHORIZED", "登录已失效，请重新登录", 401);
  }
}

function ownedAttempt(ownerId: string, id: string): LoginAttempt {
  requireOwner(ownerId);
  if (!current || current.id !== id || current.ownerId !== ownerId) {
    throw new AppError(
      "SPOTIFY_LOGIN_NOT_FOUND",
      "登录窗口已结束，请重新点击登录",
      404,
    );
  }
  return current;
}

function finish(attempt: LoginAttempt, status: LoginState, message: string): void {
  if (!pending(attempt)) return;
  attempt.status = status;
  attempt.message = message;
  clearTimeout(attempt.timer);
  attempt.controller.abort();
  // 关闭浏览器会中断正在等待的页面/网络操作；启动尚未完成时由 runLogin 收尾。
  void attempt.browser?.close().catch(() => {});
}

export function currentSpotifyLogin(ownerId: string): SpotifyLoginStatus | null {
  requireOwner(ownerId);
  return current?.ownerId === ownerId ? publicStatus(current) : null;
}

export function spotifyLoginStatus(ownerId: string, id: string): SpotifyLoginStatus {
  return publicStatus(ownedAttempt(ownerId, id));
}

export function startSpotifyLogin(ownerId: string): SpotifyLoginStatus {
  requireOwner(ownerId);
  if (current && pending(current)) {
    if (current.ownerId === ownerId) return publicStatus(current);
    throw new AppError("SPOTIFY_LOGIN_BUSY", "已有 Spotify 登录窗口正在使用", 409);
  }

  const attempt: LoginAttempt = {
    id: nanoid(),
    ownerId,
    status: "starting",
    expiresAt: Date.now() + LOGIN_TTL_MS,
    message: "正在服务器电脑上打开 Spotify 登录窗口…",
    controller: new AbortController(),
    browser: null,
    timer: setTimeout(() => {
      finish(attempt, "expired", "登录等待已超时，请重新点击登录");
    }, LOGIN_TTL_MS),
    task: Promise.resolve(),
  };
  attempt.timer.unref();
  // 上一次取消恰逢浏览器启动时，也须等它退出后再开新窗口。
  const previous = current?.task;
  current = attempt;
  attempt.task = (async () => {
    await previous;
    if (pending(attempt)) await runLogin(attempt);
  })();
  return publicStatus(attempt);
}

export async function cancelSpotifyLogin(
  ownerId: string,
  id: string,
): Promise<SpotifyLoginStatus> {
  const attempt = ownedAttempt(ownerId, id);
  finish(attempt, "cancelled", "已取消 Spotify 登录");
  await attempt.task;
  return publicStatus(attempt);
}

// 解绑、手动更新、删号和服务关闭都要中止未完成的自动绑定。
export async function stopSpotifyLogin(): Promise<void> {
  const attempt = current;
  if (!attempt) return;
  finish(attempt, "cancelled", "已取消 Spotify 登录");
  await attempt.task;
}

async function runLogin(attempt: LoginAttempt): Promise<void> {
  const signal = attempt.controller.signal;
  let phase = "launch";
  try {
    const browser = await chromium.launch({
      channel: "chrome",
      headless: false,
      timeout: 20_000,
      // 进程退出由服务生命周期统一处理，不为每次登录额外挂信号监听器。
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    attempt.browser = browser;
    if (signal.aborted) return;
    browser.on("disconnected", () => {
      finish(attempt, "cancelled", "Spotify 登录窗口已关闭");
    });
    const context = await browser.newContext({
      viewport: { width: 1000, height: 800 },
      locale: "zh-CN",
      acceptDownloads: false,
    });
    context.on("page", (page) => {
      page.on("close", () => {
        if (!context.pages().some((item) => !item.isClosed())) {
          finish(attempt, "cancelled", "Spotify 登录窗口已关闭");
        }
      });
    });
    const page = await context.newPage();
    phase = "navigate";
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (signal.aborted) return;
    attempt.status = "waiting";
    attempt.message = "请在服务器电脑上的 Spotify 官方窗口完成登录，完成后会自动连接。";
    phase = "capture";

    while (!signal.aborted) {
      const cookies = await context.cookies("https://open.spotify.com/");
      if (signal.aborted) return;
      const cookie = cookies.find(
        (item) =>
          item.name === "sp_dc" &&
          ["spotify.com", "open.spotify.com"].includes(item.domain.replace(/^\./, "")) &&
          item.value.length >= 10,
      );
      if (cookie) {
        requireOwner(attempt.ownerId);
        attempt.status = "verifying";
        attempt.message = "登录已完成，正在连接 Spotify…";
        // 复用验证和加密存储；取消/删号期间到达的 token 不能重新写入绑定。
        await linkSession(cookie.value, signal);
        if (!signal.aborted) finish(attempt, "succeeded", "Spotify 已自动连接");
        return;
      }
      await delay(1000, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted) return;
    const message = error instanceof AppError
      ? error.code === "SPOTIFY_SESSION_INVALID"
        ? "Spotify 登录未成功，请重新登录"
        : error.message
      : phase === "launch"
        ? "无法打开登录窗口，请确认服务器电脑已安装 Google Chrome 并已登录桌面。"
        : phase === "navigate"
          ? "Spotify 登录页无法打开，请检查服务器电脑的网络后重试。"
          : "Spotify 登录窗口连接中断，请重新登录。";
    finish(attempt, "failed", message);
  } finally {
    clearTimeout(attempt.timer);
    await attempt.browser?.close().catch(() => {});
    attempt.browser = null;
  }
}
