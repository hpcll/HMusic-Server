import { eq, lte } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db } from "../../db/index.js";
import {
  miAccounts,
  miVerificationSessions,
  miWebVerificationSessions,
} from "../../db/schema.js";
import { AppError } from "../../shared/errors.js";
import { decryptSecret, encryptSecret } from "../../shared/secrets.js";
import { kvGet, kvSet } from "../../db/kv.js";
import { upsertDevice } from "../devices/devices.service.js";
import {
  completeXiaomiIdentityChallenge,
  createXiaomiSessionFromWebCredentials,
  createXiaomiDeviceId,
  fetchXiaomiConversations,
  fetchXiaomiDevices,
  loginXiaomiAccount,
  loginXiaomiMiioWithPassToken,
  sendXiaomiIdentitySms,
  sendXiaomiUbusRequest,
  startXiaomiIdentityChallenge,
  startXiaomiQrLogin,
  waitXiaomiQrLogin,
  type XiaomiConversationRecord,
  type XiaomiIdentityChallengeState,
  type XiaomiDevice,
  type XiaomiMiioSession,
  type XiaomiSession,
} from "./xiaomi.client.js";
import {
  hasUnreliablePlayStatus,
  needsPlayMusicApi,
  supportsSeek,
} from "./mi.hardware.js";

const accountId = "default";
const verificationTtlMs = 10 * 60 * 1000;
const webVerificationTtlMs = 15 * 60 * 1000;

type VerificationSession = {
  id: string;
  account: string;
  accountMasked: string;
  deviceId: string;
  state: XiaomiIdentityChallengeState;
  expiresAt: number;
};

type WebVerificationSession = {
  id: string;
  account: string;
  accountMasked: string;
  password: string;
  deviceId: string;
  verificationUrl: string;
  cookies: Array<[string, string]>;
  expiresAt: number;
};

export type MiStatus = {
  loggedIn: boolean;
  // 曾登录但小米侧 401 确证会话失效：客户端据此展示「登录已过期」而非「未登录」。
  sessionExpired: boolean;
  accountMasked?: string;
  deviceId?: string;
  deviceCount?: number;
  updatedAt?: number;
};

export type MiVerificationChallenge = {
  loggedIn: false;
  verificationId: string;
  maskedPhone?: string;
  smsStatus?: "sent" | "recent" | "limited";
  accountMasked: string;
  expiresAt: number;
};

export type MiWebVerificationChallenge = {
  loggedIn: false;
  verificationId: string;
  verificationUrl: string;
  accountMasked: string;
  expiresAt: number;
};

export type MiWebVerificationProxySession = {
  id: string;
  verificationUrl: string;
  cookies: Array<[string, string]>;
  expiresAt: number;
};

// verify=true 的真校验限频窗口：状态查询不能每次都打小米，App 冷启/回前台
// 命中同一窗口时直接回数据库快照。进程内存即可，重启后首查会重新校验。
const statusVerifyIntervalMs = 5 * 60 * 1000;
let lastStatusVerifyAt = 0;

export async function getMiStatus(options?: {
  verify?: boolean;
}): Promise<MiStatus> {
  const account = await readMiAccount();
  if (!account) return { loggedIn: false, sessionExpired: false };

  // 真校验：拉一次设备列表验证 serviceToken 仍有效（副产品是设备表保鲜）。
  // 只有确证 401 才翻状态；网络抖动/小米服务不可达一律保持数据库快照，
  // 避免把「暂时连不上」谎报成「登录过期」。
  if (
    options?.verify &&
    account.isLoggedIn === 1 &&
    Date.now() - lastStatusVerifyAt >= statusVerifyIntervalMs
  ) {
    lastStatusVerifyAt = Date.now();
    try {
      const devices = await fetchXiaomiDevices(await getStoredMiSession());
      await saveDevices(devices);
    } catch (error) {
      await markMiSessionExpiredIfUnauthorized(error);
    }
    return toMiStatus(await readMiAccount());
  }

  return toMiStatus(account);
}

async function readMiAccount() {
  const rows = await db
    .select()
    .from(miAccounts)
    .where(eq(miAccounts.id, accountId))
    .limit(1);
  return rows[0];
}

function toMiStatus(
  account: Awaited<ReturnType<typeof readMiAccount>>,
): MiStatus {
  if (!account) return { loggedIn: false, sessionExpired: false };
  return {
    loggedIn: account.isLoggedIn === 1,
    sessionExpired: account.isLoggedIn !== 1 && account.sessionExpiredAt != null,
    accountMasked: account.accountMasked,
    deviceId: account.deviceId ?? undefined,
    updatedAt: account.updatedAt,
  };
}

export async function loginMiAccount(
  account: string,
  password: string,
  captchaCode?: string,
  webCredentials?: Record<string, string>,
): Promise<MiStatus> {
  const existing = (
    await db
      .select()
      .from(miAccounts)
      .where(eq(miAccounts.id, accountId))
      .limit(1)
  )[0];
  // 会话过期后的重登也复用原 deviceId：小米按设备标识做风控，换新 ID 容易
  // 再次触发短信验证。仅从未登录过（无 deviceId）时才生成新标识。
  const deviceId =
    existing?.deviceId &&
    (existing.isLoggedIn === 1 || existing.sessionExpiredAt != null)
      ? existing.deviceId
      : createXiaomiDeviceId();
  await saveLoginAttempt(account, deviceId);

  const session = webCredentials
    ? await createXiaomiSessionFromWebCredentials({
        credentials: webCredentials,
        deviceId,
      })
    : await loginXiaomiAccount({
        account,
        password,
        captchaCode,
        deviceId,
      });
  const devices = await fetchXiaomiDevices(session);
  await saveMiSession(account, session);
  await saveDevices(devices);

  return {
    ...(await getMiStatus()),
    deviceCount: devices.length,
  };
}

export async function importMiWebSession(
  account: string,
  webCredentials: Record<string, string>,
): Promise<MiStatus> {
  return loginMiAccount(account, "", undefined, webCredentials);
}

export async function startMiLoginVerification(
  account: string,
  password: string,
  captchaCode?: string,
): Promise<MiStatus | MiVerificationChallenge> {
  try {
    return await loginMiAccount(account, password, captchaCode);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (error.code !== "MI_LOGIN_VERIFICATION_REQUIRED") throw error;

    const details = asRecord(error.details);
    const verificationUrl = asString(details?.verificationUrl);
    if (!verificationUrl) throw error;
    const cookies = parseCookiePairs(details?.cookies);

    const status = await getMiStatus();
    if (!status.deviceId) {
      throw new AppError(
        "MI_VERIFICATION_DEVICE_ID_MISSING",
        "小米验证会话缺少设备标识，请重新登录",
        409,
      );
    }

    const challenge = await startXiaomiIdentityChallenge({
      verificationUrl,
      deviceId: status.deviceId,
      cookies,
    });
    const sessionId = createVerificationId();
    const expiresAt = Date.now() + verificationTtlMs;
    await cleanupVerificationSessions();
    await saveVerificationSession({
      id: sessionId,
      account,
      accountMasked: maskAccount(account),
      deviceId: status.deviceId,
      state: challenge.state,
      expiresAt,
    });

    return {
      loggedIn: false,
      verificationId: sessionId,
      maskedPhone: challenge.maskedPhone,
      smsStatus: challenge.smsStatus,
      accountMasked: maskAccount(account),
      expiresAt,
    };
  }
}

export async function startMiWebVerification(
  account: string,
  password: string,
  captchaCode?: string,
): Promise<MiStatus | MiWebVerificationChallenge> {
  const existing = (
    await db
      .select()
      .from(miAccounts)
      .where(eq(miAccounts.id, accountId))
      .limit(1)
  )[0];
  const deviceId = existing?.deviceId || createXiaomiDeviceId();
  await saveLoginAttempt(account, deviceId);

  try {
    const session = await loginXiaomiAccount({
      account,
      password,
      captchaCode,
      deviceId,
    });
    const devices = await fetchXiaomiDevices(session);
    await saveMiSession(account, session);
    await saveDevices(devices);
    return {
      ...(await getMiStatus()),
      deviceCount: devices.length,
    };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (error.code !== "MI_LOGIN_VERIFICATION_REQUIRED") throw error;

    const details = asRecord(error.details);
    const verificationUrl =
      asString(details?.verificationUrl) || asString(details?.captchaUrl);
    if (!verificationUrl) throw error;
    const cookies = parseCookiePairs(details?.cookies);

    const sessionId = createVerificationId();
    const expiresAt = Date.now() + webVerificationTtlMs;
    await cleanupWebVerificationSessions();
    await saveWebVerificationSession({
      id: sessionId,
      account,
      accountMasked: maskAccount(account),
      password,
      deviceId,
      verificationUrl,
      cookies,
      expiresAt,
    });

    return {
      loggedIn: false,
      verificationId: sessionId,
      verificationUrl,
      accountMasked: maskAccount(account),
      expiresAt,
    };
  }
}

export async function completeMiWebVerification(
  verificationId: string,
  webCredentials?: Record<string, string>,
): Promise<MiStatus | MiWebVerificationChallenge> {
  const pending = await getWebVerificationSession(verificationId);
  if (webCredentials && Object.keys(webCredentials).length > 0) {
    const session = await createXiaomiSessionFromWebCredentials({
      credentials: webCredentials,
      deviceId: pending.deviceId,
    });
    const devices = await fetchXiaomiDevices(session);
    await saveMiSession(pending.account, session);
    await saveDevices(devices);
    await deleteWebVerificationSession(verificationId);
    return {
      ...(await getMiStatus()),
      deviceCount: devices.length,
    };
  }

  try {
    const session = await loginXiaomiAccount({
      account: pending.account,
      password: pending.password,
      deviceId: pending.deviceId,
    });
    const devices = await fetchXiaomiDevices(session);
    await saveMiSession(pending.account, session);
    await saveDevices(devices);
    await deleteWebVerificationSession(verificationId);
    return {
      ...(await getMiStatus()),
      deviceCount: devices.length,
    };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (error.code !== "MI_LOGIN_VERIFICATION_REQUIRED") throw error;

    const details = asRecord(error.details);
    const verificationUrl =
      asString(details?.verificationUrl) ||
      asString(details?.captchaUrl) ||
      pending.verificationUrl;
    const cookies = parseCookiePairs(details?.cookies);
    await saveWebVerificationSession({
      ...pending,
      verificationUrl,
      cookies: cookies.length ? cookies : pending.cookies,
      expiresAt: Date.now() + webVerificationTtlMs,
    });

    return {
      loggedIn: false,
      verificationId: pending.id,
      verificationUrl,
      accountMasked: pending.accountMasked,
      expiresAt: Date.now() + webVerificationTtlMs,
    };
  }
}

// ===== 扫码登录（米家 APP 扫码，无短信/验证码/新页面）=====

type MiQrSession = {
  id: string;
  deviceId: string;
  loginUrl: string;
  status: "pending" | "success" | "failed" | "expired";
  message?: string;
  expiresAt: number;
  createdAt: number;
};

// 扫码会话是分钟级的临时状态，放内存即可（服务重启后重新生成二维码）。
const qrSessions = new Map<string, MiQrSession>();
const qrSessionTtlMs = 5 * 60 * 1000;

export type MiQrLoginChallenge = {
  qrId: string;
  loginUrl: string;
  expiresAt: number;
};

export type MiQrLoginStatus = {
  status: MiQrSession["status"];
  message?: string;
  mi?: MiStatus;
};

export async function startMiQrLogin(): Promise<MiQrLoginChallenge> {
  cleanupQrSessions();
  const existing = (
    await db
      .select()
      .from(miAccounts)
      .where(eq(miAccounts.id, accountId))
      .limit(1)
  )[0];
  const deviceId = existing?.deviceId || createXiaomiDeviceId();
  const start = await startXiaomiQrLogin({ deviceId });

  const session: MiQrSession = {
    id: createVerificationId(),
    deviceId: start.deviceId,
    loginUrl: start.loginUrl,
    status: "pending",
    expiresAt: Date.now() + qrSessionTtlMs,
    createdAt: Date.now(),
  };
  qrSessions.set(session.id, session);
  void runQrLoginLoop(session, start.lpUrl);

  return {
    qrId: session.id,
    loginUrl: session.loginUrl,
    expiresAt: session.expiresAt,
  };
}

export async function getMiQrLoginStatus(qrId: string): Promise<MiQrLoginStatus> {
  const session = qrSessions.get(qrId);
  if (!session) {
    throw new AppError(
      "MI_QR_SESSION_NOT_FOUND",
      "扫码会话不存在或已清理，请重新生成二维码",
      404,
      { qrId },
    );
  }
  if (session.status === "pending" && Date.now() >= session.expiresAt) {
    session.status = "expired";
    session.message = "二维码已过期，请重新生成";
  }
  if (session.status === "success") {
    return { status: "success", mi: await getMiStatus() };
  }
  return { status: session.status, message: session.message };
}

async function runQrLoginLoop(
  session: MiQrSession,
  lpUrl: string,
): Promise<void> {
  while (session.status === "pending" && Date.now() < session.expiresAt) {
    try {
      const miSession = await waitXiaomiQrLogin({
        lpUrl,
        deviceId: session.deviceId,
      });
      const devices = await fetchXiaomiDevices(miSession);
      await saveMiSession(miSession.userId, miSession);
      await saveDevices(devices);
      session.status = "success";
      return;
    } catch (error) {
      if (error instanceof AppError && error.code === "MI_QR_POLL_TIMEOUT") {
        continue; // 长轮询单次超时，二维码未过期就继续等
      }
      session.status = "failed";
      session.message =
        error instanceof Error ? error.message : "扫码登录失败";
      return;
    }
  }
  if (session.status === "pending") {
    session.status = "expired";
    session.message = "二维码已过期，请重新生成";
  }
}

function cleanupQrSessions(): void {
  const now = Date.now();
  for (const [id, session] of qrSessions) {
    // 过期后再保留一段时间供前端读到 expired 状态，之后清理。
    if (now - session.createdAt > qrSessionTtlMs * 3) {
      qrSessions.delete(id);
    }
  }
}

export async function getMiWebVerificationProxySession(
  verificationId: string,
): Promise<MiWebVerificationProxySession> {
  const pending = await getWebVerificationSession(verificationId);
  return {
    id: pending.id,
    verificationUrl: pending.verificationUrl,
    cookies: pending.cookies,
    expiresAt: pending.expiresAt,
  };
}

export async function updateMiWebVerificationCookies(
  verificationId: string,
  cookies: Array<[string, string]>,
): Promise<void> {
  const pending = await getWebVerificationSession(verificationId);
  await saveWebVerificationSession({
    ...pending,
    cookies,
  });
}

export async function resendMiVerificationCode(
  verificationId: string,
): Promise<MiVerificationChallenge> {
  const session = await getVerificationSession(verificationId);
  let smsStatus: MiVerificationChallenge["smsStatus"] = "sent";
  try {
    await sendXiaomiIdentitySms(session.state);
  } catch (error) {
    const details =
      error instanceof AppError ? asRecord(error.details) : undefined;
    if (error instanceof AppError && details?.code === 20024) {
      smsStatus = "recent";
    } else if (error instanceof AppError && details?.code === 70022) {
      smsStatus = "limited";
    } else {
      throw error;
    }
  }
  return {
    loggedIn: false,
    verificationId: session.id,
    maskedPhone: session.state.maskedPhone,
    smsStatus,
    accountMasked: session.accountMasked,
    expiresAt: session.expiresAt,
  };
}

export async function confirmMiVerificationCode(
  verificationId: string,
  code: string,
): Promise<MiStatus> {
  const pending = await getVerificationSession(verificationId);
  const completed = await completeXiaomiIdentityChallenge({
    state: pending.state,
    ticket: code,
    deviceId: pending.deviceId,
  });
  const devices = await fetchXiaomiDevices(completed.session);
  await saveMiSession(pending.account, completed.session);
  await saveDevices(devices);
  await deleteVerificationSession(verificationId);

  return {
    ...(await getMiStatus()),
    deviceCount: devices.length,
  };
}

async function saveMiSession(
  account: string,
  session: XiaomiSession,
): Promise<void> {
  // passToken（长期凭据）存 kv：mi_accounts 表无此列，走 kv 免建表迁移。
  // 用于静默换 miio 域（sid=xiaomiio）token 做 miot TTS。
  kvSet("mi.passTokenEnc", {
    value: session.passToken ? encryptSecret(session.passToken) : null,
  });
  // 换号/重登后旧 miio 会话作废。
  cachedMiioSession = undefined;
  const now = Date.now();
  await db
    .insert(miAccounts)
    .values({
      id: accountId,
      accountMasked: maskAccount(account),
      serviceTokenEnc: encryptSecret(session.serviceToken),
      userIdEnc: encryptSecret(session.userId),
      ssecurityEnc: session.ssecurity ? encryptSecret(session.ssecurity) : null,
      deviceId: session.deviceId,
      isLoggedIn: 1,
      sessionExpiredAt: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: miAccounts.id,
      set: {
        accountMasked: maskAccount(account),
        serviceTokenEnc: encryptSecret(session.serviceToken),
        userIdEnc: encryptSecret(session.userId),
        ssecurityEnc: session.ssecurity
          ? encryptSecret(session.ssecurity)
          : null,
        deviceId: session.deviceId,
        isLoggedIn: 1,
        sessionExpiredAt: null,
        updatedAt: now,
      },
    });
}

export async function logoutMiAccount(): Promise<MiStatus> {
  await db
    .insert(miAccounts)
    .values({
      id: accountId,
      accountMasked: "",
      isLoggedIn: 0,
      sessionExpiredAt: null,
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: miAccounts.id,
      set: {
        serviceTokenEnc: null,
        userIdEnc: null,
        ssecurityEnc: null,
        deviceId: null,
        isLoggedIn: 0,
        // 主动退出不是过期：横幅与「已过期」状态卡都不应出现。
        sessionExpiredAt: null,
        updatedAt: Date.now(),
      },
    });

  return getMiStatus();
}

// 是否有可用的已登录会话（不抛错版，供"要不要真探测"这类分支判断）。
export async function hasStoredMiSession(): Promise<boolean> {
  const account = (
    await db
      .select()
      .from(miAccounts)
      .where(eq(miAccounts.id, accountId))
      .limit(1)
  )[0];
  return Boolean(account && account.isLoggedIn === 1);
}

export async function getStoredMiSession(): Promise<XiaomiSession> {
  const account = (
    await db
      .select()
      .from(miAccounts)
      .where(eq(miAccounts.id, accountId))
      .limit(1)
  )[0];
  if (!account || account.isLoggedIn !== 1) {
    // 注意：客户端把 401 当 HMusic 会话失效并登出，小米侧状态一律用 409/502。
    if (account?.sessionExpiredAt != null) {
      throw new AppError(
        "MI_SESSION_EXPIRED",
        "小米登录已过期，请到 设置 → 小米账号 重新登录",
        409,
      );
    }
    throw new AppError("MI_ACCOUNT_NOT_LOGGED_IN", "小米账号尚未登录", 409);
  }
  const serviceToken = decryptSecret(account.serviceTokenEnc);
  const userId = decryptSecret(account.userIdEnc);
  if (!serviceToken || !userId || !account.deviceId) {
    throw new AppError(
      "MI_SESSION_INVALID",
      "小米登录会话无效，请重新登录",
      409,
    );
  }

  return {
    serviceToken,
    userId,
    ssecurity: decryptSecret(account.ssecurityEnc),
    deviceId: account.deviceId,
  };
}

export async function refreshMiDevices(): Promise<{ deviceCount: number }> {
  const session = await getStoredMiSession();
  let devices: XiaomiDevice[];
  try {
    devices = await fetchXiaomiDevices(session);
  } catch (error) {
    await markMiSessionExpiredIfUnauthorized(error);
    throw error;
  }
  await saveDevices(devices);
  return { deviceCount: devices.length };
}

// 真·链路探测：向设备发一次真实的状态查询 ubus 请求，会话过期/设备离线
// 当场暴露——之前"探测"只回数据库里的能力表，永远显示正常，播放才翻车。
export async function probeMiDeviceLink(deviceId: string): Promise<void> {
  const session = await getStoredMiSession();
  try {
    await sendXiaomiUbusRequest({
      session,
      deviceId,
      method: "player_get_play_status",
      message: { media: "app_ios" },
    });
  } catch (error) {
    await markMiSessionExpiredIfUnauthorized(error);
    throw error;
  }
}

async function saveLoginAttempt(
  account: string,
  deviceId: string,
): Promise<void> {
  await db
    .insert(miAccounts)
    .values({
      id: accountId,
      accountMasked: maskAccount(account),
      serviceTokenEnc: null,
      userIdEnc: null,
      ssecurityEnc: null,
      deviceId,
      isLoggedIn: 0,
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: miAccounts.id,
      set: {
        accountMasked: maskAccount(account),
        serviceTokenEnc: null,
        userIdEnc: null,
        ssecurityEnc: null,
        deviceId,
        isLoggedIn: 0,
        updatedAt: Date.now(),
      },
    });
}

// 小米侧 401 确证会话失效：清掉已死的凭据、翻登录位并记过期时间。保留
// accountMasked（UI 要说清是哪个账号过期）和 deviceId（重登复用降风控）。
export async function markMiSessionExpired(): Promise<void> {
  cachedMiioSession = undefined;
  await db
    .update(miAccounts)
    .set({
      serviceTokenEnc: null,
      userIdEnc: null,
      ssecurityEnc: null,
      isLoggedIn: 0,
      sessionExpiredAt: Date.now(),
      updatedAt: Date.now(),
    })
    .where(eq(miAccounts.id, accountId));
}

// 供所有真实调用小米的链路（播放控制/探测/设备列表/状态真校验）在 catch 里
// 统一落状态：只认确证的 401，其余错误（离线/网络/限频）不动登录位。
export async function markMiSessionExpiredIfUnauthorized(
  error: unknown,
): Promise<void> {
  if (isMiUnauthorizedError(error)) await markMiSessionExpired();
}

function isMiUnauthorizedError(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  if (
    error.code !== "MI_UBUS_REQUEST_FAILED" &&
    error.code !== "MI_DEVICE_LIST_FAILED"
  ) {
    return false;
  }
  const details = asRecord(error.details);
  return details?.statusCode === 401;
}

async function saveDevices(devices: XiaomiDevice[]): Promise<void> {
  // MiNA deviceID → 数字 miotDID 映射存 kv：miot action（TTS）用 did 寻址，
  // devices 表无此列，走 kv 免建表迁移。
  const didMap: Record<string, string> = {
    ...(kvGet<Record<string, string>>("mi.miotDids") ?? {}),
  };
  for (const device of devices) {
    didMap[device.deviceId] = device.did;
  }
  kvSet("mi.miotDids", didMap);
  for (const [index, device] of devices.entries()) {
    await upsertDevice({
      id: device.deviceId,
      name: device.name,
      type: device.hardware,
      ip: device.ip,
      isOnline: true,
      isDefault: index === 0,
      capabilities: inferCapabilities(device.hardware),
    });
  }
}

// 查设备的数字 miotDID（miot action 寻址用）；未刷新过设备列表时为空。
export function getMiotDid(deviceId: string): string | undefined {
  return kvGet<Record<string, string>>("mi.miotDids")?.[deviceId];
}

// miio 域会话内存缓存：passToken 换 token 有网络成本，进程内复用；
// 401 时由调用方 invalidateMiioSession() 后重试一次。
let cachedMiioSession: XiaomiMiioSession | undefined;

export function invalidateMiioSession(): void {
  cachedMiioSession = undefined;
}

export async function getMiioSession(): Promise<XiaomiMiioSession> {
  if (cachedMiioSession) return cachedMiioSession;
  const session = await getStoredMiSession();
  const stored = kvGet<{ value: string | null }>("mi.passTokenEnc");
  const passToken = stored?.value ? decryptSecret(stored.value) : undefined;
  if (!passToken) {
    throw new AppError(
      "MI_MIIO_PASS_TOKEN_MISSING",
      "缺少小米长期凭据，请重新登录小米账号后再试语音播报",
      409,
    );
  }
  cachedMiioSession = await loginXiaomiMiioWithPassToken({
    passToken,
    userId: session.userId,
    deviceId: session.deviceId,
  });
  return cachedMiioSession;
}

function inferCapabilities(hardware: string) {
  return {
    supportsPlayUrl: !needsPlayMusicApi(hardware),
    supportsPauseResume: true,
    supportsSeek: supportsSeek(hardware),
    supportsVolume: true,
    supportsRichStatus: !hasUnreliablePlayStatus(hardware),
    supportsDeviceNext: true,
  };
}

function maskAccount(account: string): string {
  const trimmed = account.trim();
  if (trimmed.length <= 4) return "****";
  if (trimmed.includes("@")) {
    const [name, domain] = trimmed.split("@");
    return `${name.slice(0, 2)}***@${domain}`;
  }
  return `${trimmed.slice(0, 3)}***${trimmed.slice(-2)}`;
}

async function saveVerificationSession(
  session: VerificationSession,
): Promise<void> {
  const now = Date.now();
  await db
    .insert(miVerificationSessions)
    .values({
      id: session.id,
      accountEnc: encryptSecret(session.account),
      accountMasked: session.accountMasked,
      deviceId: session.deviceId,
      stateJsonEnc: encryptSecret(JSON.stringify(session.state)),
      expiresAt: session.expiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: miVerificationSessions.id,
      set: {
        accountEnc: encryptSecret(session.account),
        accountMasked: session.accountMasked,
        deviceId: session.deviceId,
        stateJsonEnc: encryptSecret(JSON.stringify(session.state)),
        expiresAt: session.expiresAt,
        updatedAt: now,
      },
    });
}

async function getVerificationSession(
  verificationId: string,
): Promise<VerificationSession> {
  await cleanupVerificationSessions();
  const row = (
    await db
      .select()
      .from(miVerificationSessions)
      .where(eq(miVerificationSessions.id, verificationId))
      .limit(1)
  )[0];
  if (!row) {
    throw new AppError(
      "MI_VERIFICATION_SESSION_NOT_FOUND",
      "小米验证会话不存在或已过期，请重新登录",
      404,
      { verificationId },
    );
  }

  const account = decryptSecret(row.accountEnc);
  const stateJson = decryptSecret(row.stateJsonEnc);
  const state = parseVerificationState(stateJson);
  if (!account || !state) {
    await deleteVerificationSession(verificationId);
    throw new AppError(
      "MI_VERIFICATION_SESSION_INVALID",
      "小米验证会话已损坏，请重新登录",
      409,
      { verificationId },
    );
  }

  return {
    id: row.id,
    account,
    accountMasked: row.accountMasked,
    deviceId: row.deviceId,
    state,
    expiresAt: row.expiresAt,
  };
}

async function saveWebVerificationSession(
  session: WebVerificationSession,
): Promise<void> {
  const now = Date.now();
  await db
    .insert(miWebVerificationSessions)
    .values({
      id: session.id,
      accountEnc: encryptSecret(session.account),
      accountMasked: session.accountMasked,
      passwordEnc: encryptSecret(session.password),
      deviceId: session.deviceId,
      verificationUrlEnc: encryptSecret(session.verificationUrl),
      cookiesJsonEnc: encryptSecret(JSON.stringify(session.cookies)),
      expiresAt: session.expiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: miWebVerificationSessions.id,
      set: {
        accountEnc: encryptSecret(session.account),
        accountMasked: session.accountMasked,
        passwordEnc: encryptSecret(session.password),
        deviceId: session.deviceId,
        verificationUrlEnc: encryptSecret(session.verificationUrl),
        cookiesJsonEnc: encryptSecret(JSON.stringify(session.cookies)),
        expiresAt: session.expiresAt,
        updatedAt: now,
      },
    });
}

async function getWebVerificationSession(
  verificationId: string,
): Promise<WebVerificationSession> {
  await cleanupWebVerificationSessions();
  const row = (
    await db
      .select()
      .from(miWebVerificationSessions)
      .where(eq(miWebVerificationSessions.id, verificationId))
      .limit(1)
  )[0];
  if (!row) {
    throw new AppError(
      "MI_WEB_VERIFICATION_SESSION_NOT_FOUND",
      "小米网页验证会话不存在或已过期，请重新登录",
      404,
      { verificationId },
    );
  }

  const account = decryptSecret(row.accountEnc);
  const password = decryptSecret(row.passwordEnc);
  const verificationUrl = decryptSecret(row.verificationUrlEnc);
  const cookiesJson = decryptSecret(row.cookiesJsonEnc);
  if (!account || !password || !verificationUrl) {
    await deleteWebVerificationSession(verificationId);
    throw new AppError(
      "MI_WEB_VERIFICATION_SESSION_INVALID",
      "小米网页验证会话已损坏，请重新登录",
      409,
      { verificationId },
    );
  }

  return {
    id: row.id,
    account,
    accountMasked: row.accountMasked,
    password,
    deviceId: row.deviceId,
    verificationUrl,
    cookies: parseStoredCookiePairs(cookiesJson),
    expiresAt: row.expiresAt,
  };
}

async function cleanupVerificationSessions(): Promise<void> {
  await db
    .delete(miVerificationSessions)
    .where(lte(miVerificationSessions.expiresAt, Date.now()));
}

async function cleanupWebVerificationSessions(): Promise<void> {
  await db
    .delete(miWebVerificationSessions)
    .where(lte(miWebVerificationSessions.expiresAt, Date.now()));
}

async function deleteVerificationSession(
  verificationId: string,
): Promise<void> {
  await db
    .delete(miVerificationSessions)
    .where(eq(miVerificationSessions.id, verificationId));
}

async function deleteWebVerificationSession(
  verificationId: string,
): Promise<void> {
  await db
    .delete(miWebVerificationSessions)
    .where(eq(miWebVerificationSessions.id, verificationId));
}

function createVerificationId(): string {
  return randomBytes(12).toString("base64url");
}

function parseVerificationState(
  stateJson: string | undefined,
): XiaomiIdentityChallengeState | undefined {
  if (!stateJson) return undefined;
  try {
    const parsed = JSON.parse(
      stateJson,
    ) as Partial<XiaomiIdentityChallengeState>;
    if (typeof parsed.referer !== "string" || !Array.isArray(parsed.cookies)) {
      return undefined;
    }
    return {
      referer: parsed.referer,
      cookies: parsed.cookies.flatMap((item) => {
        if (!Array.isArray(item) || item.length < 2) return [];
        const key = asString(item[0]);
        const value = asString(item[1]);
        return key && value ? [[key, value] as [string, string]] : [];
      }),
      maskedPhone: asString(parsed.maskedPhone),
    };
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseCookiePairs(value: unknown): Array<[string, string]> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!Array.isArray(item) || item.length < 2) return [];
    const key = asString(item[0]);
    const cookieValue = asString(item[1]);
    return key && cookieValue ? [[key, cookieValue] as [string, string]] : [];
  });
}

function parseStoredCookiePairs(
  value: string | undefined,
): Array<[string, string]> {
  if (!value) return [];
  try {
    return parseCookiePairs(JSON.parse(value));
  } catch {
    return [];
  }
}

// M3 语音接管 spike：拉指定（缺省第一台）音箱的最近对话记录，验证当前
// 账号/固件能否读到。可行性一锤定音——拿不到 records 则 M3 改道或作废。
export async function probeMiConversation(deviceIdFilter?: string): Promise<{
  device: { deviceId: string; name: string; hardware: string };
  records: XiaomiConversationRecord[];
  raw: unknown;
}> {
  const session = await getStoredMiSession();
  const devices = await fetchXiaomiDevices(session);
  const device = deviceIdFilter
    ? devices.find((item) => item.deviceId === deviceIdFilter)
    : devices[0];
  if (!device) {
    throw new AppError(
      "MI_CONVERSATION_NO_DEVICE",
      "没有可用的小爱音箱设备",
      404,
    );
  }
  const result = await fetchXiaomiConversations({
    session,
    deviceId: device.deviceId,
    hardware: device.hardware,
    limit: 5,
  });
  return {
    device: {
      deviceId: device.deviceId,
      name: device.name,
      hardware: device.hardware,
    },
    records: result.records,
    raw: result.raw,
  };
}
