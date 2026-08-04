import { createHash, createHmac, randomBytes } from "node:crypto";
import { AppError } from "../../shared/errors.js";
import { moduleLogger } from "../../shared/logger.js";

const log = moduleLogger("xiaomi.client");

const accountUserAgent =
  "APP/com.xiaomi.mico APPV/2.4.24 iosPassportSDK/3.5.1 iOS/14.4 miHSTS";
const minaUserAgent =
  "MiHome/6.0.103 (com.xiaomi.mihome; build:6.0.103.1; iOS 14.4.0) Alamofire/6.0.103 MICO/iOSApp/appStore/6.0.103";
const identityUserAgent =
  "Android-7.1.1-1.0.0-ONEPLUS A3010-136-ABCDEABCDEABC APP/xiaomi.smarthome APPV/62830";
const identityWebUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

// 跟随验证完成重定向链时的最大跳数。
const MAX_IDENTITY_REDIRECTS = 10;

export type XiaomiSession = {
  serviceToken: string;
  userId: string;
  ssecurity?: string;
  deviceId: string;
  // 长期凭据：用于静默换取其他 sid scope 的 serviceToken（如 miio 域 TTS）。
  // 登录时能拿到就带上；导入旧凭据等路径可能没有。
  passToken?: string;
};

// miio 域（api.io.mi.com）会话：sid=xiaomiio 的 serviceToken + 同次登录的
// ssecurity（签名密钥，与 micoapi 的不通用）。miot action（TTS 等）专用。
export type XiaomiMiioSession = {
  serviceToken: string;
  ssecurity: string;
  userId: string;
  deviceId: string;
};

export type XiaomiDevice = {
  deviceId: string;
  did: string;
  name: string;
  hardware: string;
  ip?: string;
};

export type UbusResponse = {
  code?: number;
  data?: unknown;
  message?: string;
};

export type XiaomiIdentityChallengeState = {
  referer: string;
  cookies: Array<[string, string]>;
  maskedPhone?: string;
};

export type XiaomiIdentitySmsStatus = "sent" | "recent" | "limited";

type XiaomiLoginResponse = {
  code?: number;
  desc?: string;
  description?: string;
  location?: string;
  ssecurity?: string;
  nonce?: string | number;
  userId?: string | number;
  passToken?: string;
  notificationUrl?: string;
  securityStatus?: unknown;
  captchaUrl?: string;
};

type XiaomiIdentityResponse = {
  code?: number;
  desc?: string;
  description?: string;
  tips?: string;
  location?: string;
  maskedPhone?: string;
  phone?: string;
  data?: unknown;
};

export async function loginXiaomiAccount(input: {
  account: string;
  password: string;
  captchaCode?: string;
  deviceId?: string;
}): Promise<XiaomiSession> {
  const deviceId = input.deviceId || createXiaomiDeviceId();
  const signData = await requestLoginSign(deviceId);
  const sign = asString(signData._sign);
  if (!sign) {
    throw new AppError("MI_LOGIN_SIGN_FAILED", "小米登录初始化失败", 502);
  }

  const form = new URLSearchParams({
    _json: "true",
    qs: asString(signData.qs) ?? "",
    sid: asString(signData.sid) ?? "micoapi",
    _sign: sign,
    callback: asString(signData.callback) ?? "",
    user: input.account,
    hash: createHash("md5").update(input.password).digest("hex").toUpperCase(),
  });

  if (input.captchaCode) {
    form.set("captCode", input.captchaCode);
  }

  const response = await fetch(
    "https://account.xiaomi.com/pass/serviceLoginAuth2",
    {
      method: "POST",
      headers: {
        ...baseHeaders(deviceId),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    },
  );
  const rawBody = await response.text();
  const data = parseXiaomiJson<XiaomiLoginResponse>(rawBody);
  // nonce 是大整数，用正则从原始文本提取，避免 JSON.parse 精度丢失导致 clientSign 算错。
  const nonce = extractBigIntField(rawBody, "nonce") ?? data.nonce;

  if (data.code !== 0) {
    const captchaUrl = data.captchaUrl || asString(signData.location);
    if (data.code === 70016 || captchaUrl || data.notificationUrl) {
      throw new AppError(
        "MI_LOGIN_VERIFICATION_REQUIRED",
        "小米账号需要验证码或二次身份验证",
        409,
        {
          captchaUrl,
          verificationUrl: normalizeAccountUrl(data.notificationUrl),
          cookies: extractCookiePairs(response.headers),
          securityStatus: data.securityStatus,
        },
      );
    }

    throw new AppError(
      "MI_LOGIN_FAILED",
      data.desc || data.description || "小米账号登录失败",
      502,
      {
        code: data.code,
      },
    );
  }

  const location = data.location;
  const userId = asString(data.userId);
  if (!location || !data.ssecurity || !nonce || !userId) {
    if (data.notificationUrl || data.captchaUrl) {
      throw new AppError(
        "MI_LOGIN_VERIFICATION_REQUIRED",
        "小米账号需要验证码或二次身份验证",
        409,
        {
          captchaUrl: data.captchaUrl,
          verificationUrl: normalizeAccountUrl(data.notificationUrl),
          cookies: extractCookiePairs(response.headers),
          securityStatus: data.securityStatus,
        },
      );
    }

    throw new AppError(
      "MI_LOGIN_TOKEN_DATA_MISSING",
      "小米登录响应缺少 token 交换字段",
      502,
    );
  }

  let serviceToken: string;
  try {
    serviceToken = await exchangeServiceToken(
      location,
      nonce,
      data.ssecurity,
    );
  } catch (error) {
    const passToken = asString(data.passToken);
    if (
      error instanceof AppError &&
      error.code === "MI_SERVICE_TOKEN_MISSING" &&
      passToken
    ) {
      try {
        return await loginXiaomiAccountWithPassToken({
          passToken,
          userId,
          deviceId,
        });
      } catch (passTokenError) {
        const verification = await requestIdentityVerificationUrl({
          account: input.account,
          password: input.password,
          deviceId,
        });
        if (verification?.verificationUrl) {
          throw new AppError(
            "MI_LOGIN_VERIFICATION_REQUIRED",
            "小米账号需要完成二次身份验证",
            409,
            {
              verificationUrl: verification.verificationUrl,
              cookies: verification.cookies,
              exchangeMode: "identity",
              fallbackCode:
                passTokenError instanceof AppError
                  ? passTokenError.code
                  : undefined,
            },
          );
        }

        throw passTokenError;
      }
    }

    if (
      error instanceof AppError &&
      error.code === "MI_SERVICE_TOKEN_MISSING"
    ) {
      const verification = await requestIdentityVerificationUrl({
        account: input.account,
        password: input.password,
        deviceId,
      });
      if (verification?.verificationUrl) {
        throw new AppError(
          "MI_LOGIN_VERIFICATION_REQUIRED",
          "小米账号需要完成二次身份验证",
          409,
          {
            verificationUrl: verification.verificationUrl,
            cookies: verification.cookies,
            exchangeMode: "identity",
          },
        );
      }
    }

    throw error;
  }

  return {
    serviceToken,
    userId,
    ssecurity: data.ssecurity,
    deviceId,
    passToken: asString(data.passToken),
  };
}

export async function createXiaomiSessionFromWebCredentials(input: {
  credentials: Record<string, string>;
  deviceId: string;
}): Promise<XiaomiSession> {
  const stsUrlInput =
    asString(input.credentials.stsUrl) ??
    asString(input.credentials.finalStsUrl) ??
    asString(input.credentials.completionUrl) ??
    asString(input.credentials.finalUrl) ??
    asString(input.credentials.url);
  if (stsUrlInput) {
    const stsUrl = await resolveWebCredentialStsUrl(stsUrlInput);
    return createXiaomiSessionFromStsUrl({
      stsUrl,
      deviceId: input.deviceId,
    });
  }

  const serviceToken = asString(input.credentials.serviceToken);
  const userId = asString(input.credentials.userId);
  if (serviceToken && userId) {
    return {
      serviceToken,
      userId,
      ssecurity: asString(input.credentials.ssecurity),
      deviceId: input.deviceId,
    };
  }

  const passToken = asString(input.credentials.passToken);
  if (passToken && userId) {
    return loginXiaomiAccountWithPassToken({
      passToken,
      userId,
      deviceId: input.deviceId,
    });
  }

  throw new AppError(
    "MI_WEB_CREDENTIALS_INCOMPLETE",
    "小米网页验证凭据不完整，请重新验证",
    400,
    {
      fields: Object.keys(input.credentials),
    },
  );
}

export type XiaomiQrLoginStart = {
  loginUrl: string;
  lpUrl: string;
  deviceId: string;
};

// 扫码登录第一步（longPolling/loginUrl 流程）：
// 无凭据请求 serviceLogin 拿登录页参数，再换取二维码内容与长轮询地址。
export async function startXiaomiQrLogin(input: {
  deviceId?: string;
}): Promise<XiaomiQrLoginStart> {
  const deviceId = input.deviceId || createXiaomiDeviceId();
  const passO = randomBytes(8).toString("hex");
  const response = await fetch(
    "https://account.xiaomi.com/pass/serviceLogin?_json=true&sid=micoapi&_locale=zh_CN",
    {
      headers: {
        "User-Agent": accountUserAgent,
        Cookie: `deviceId=${deviceId}; pass_o=${passO}; sdkVersion=3.4.1; uLocale=zh_CN`,
      },
    },
  );
  const data = parseXiaomiJson<XiaomiLoginResponse>(await response.text());
  const location = asString(data.location);
  const locationUrl = location ? safeParseUrl(location) : undefined;
  if (!locationUrl) {
    throw new AppError("MI_QR_INIT_FAILED", "小米扫码登录初始化失败", 502, {
      code: data.code,
    });
  }

  // 登录页 location 的 query（qs/sid/callback/_sign/serviceParam…）就是二维码接口的参数。
  const params = locationUrl.searchParams;
  params.set("theme", "");
  params.set("bizDeviceType", "");
  params.set("_hasLogo", "false");
  params.set("_qrsize", "240");
  params.set("_dc", String(Date.now()));

  const qrResponse = await fetch(
    `https://account.xiaomi.com/longPolling/loginUrl?${params.toString()}`,
    {
      headers: {
        "User-Agent": accountUserAgent,
        Cookie: `deviceId=${deviceId}; pass_o=${passO}`,
      },
    },
  );
  const qrRaw = await qrResponse.text();
  const qrData = parseXiaomiJson<{
    code?: number;
    desc?: string;
    loginUrl?: string;
    lp?: string;
  }>(qrRaw);
  const loginUrl = asString(qrData.loginUrl);
  const lpUrl = asString(qrData.lp);
  if (qrData.code !== 0 || !loginUrl || !lpUrl) {
    throw new AppError(
      "MI_QR_INIT_FAILED",
      qrData.desc || "小米扫码登录初始化失败",
      502,
      { code: qrData.code },
    );
  }

  log.info({ step: "qr.start", deviceId }, "小米扫码登录二维码已生成");
  return { loginUrl, lpUrl, deviceId };
}

// 扫码登录第二步：长轮询 lp 地址等待手机确认。单次最多等 90 秒，
// 超时抛 MI_QR_POLL_TIMEOUT（调用方可用同一 lp 地址继续等）。
export async function waitXiaomiQrLogin(input: {
  lpUrl: string;
  deviceId: string;
}): Promise<XiaomiSession> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  let raw: string;
  try {
    const response = await fetch(input.lpUrl, {
      headers: { "User-Agent": accountUserAgent },
      signal: controller.signal,
    });
    raw = await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new AppError("MI_QR_POLL_TIMEOUT", "等待扫码超时", 408);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const data = parseXiaomiJson<XiaomiLoginResponse>(raw);
  if (data.code !== 0) {
    throw new AppError(
      "MI_QR_FAILED",
      data.desc || data.description || "扫码登录未完成",
      502,
      { code: data.code },
    );
  }

  const nonce = extractBigIntField(raw, "nonce") ?? data.nonce;
  const userId = asString(data.userId);
  const location = data.location;
  if (!location || !userId) {
    throw new AppError("MI_QR_TOKEN_DATA_MISSING", "扫码结果缺少登录字段", 502);
  }

  log.info({ step: "qr.confirmed", userId }, "扫码已确认，开始换取 serviceToken");

  // 首选带 clientSign 的标准 STS 交换；失败回退 passToken 通道。
  if (data.ssecurity && nonce) {
    try {
      const serviceToken = await exchangeServiceToken(
        location,
        nonce,
        data.ssecurity,
      );
      return {
        serviceToken,
        userId,
        ssecurity: data.ssecurity,
        deviceId: input.deviceId,
        // passToken 顺手带回：miio 域 TTS 靠它静默换 xiaomiio token。
        passToken: asString(data.passToken),
      };
    } catch (error) {
      log.warn(
        { step: "qr.exchange.failed", code: error instanceof AppError ? error.code : undefined },
        "扫码 STS 交换失败，尝试 passToken 回退",
      );
    }
  }

  const passToken = asString(data.passToken);
  if (passToken) {
    return loginXiaomiAccountWithPassToken({
      passToken,
      userId,
      deviceId: input.deviceId,
    });
  }

  throw new AppError("MI_QR_TOKEN_DATA_MISSING", "扫码结果缺少登录凭据", 502);
}

export async function startXiaomiIdentityChallenge(input: {
  verificationUrl: string;
  deviceId: string;
  cookies?: Array<[string, string]>;
}): Promise<{
  state: XiaomiIdentityChallengeState;
  maskedPhone?: string;
  smsStatus: XiaomiIdentitySmsStatus;
}> {
  const state: XiaomiIdentityChallengeState = {
    referer: input.verificationUrl,
    cookies: [
      ["sdkVersion", "3.4.1"],
      ["deviceId", input.deviceId],
      ...(input.cookies ?? []),
    ],
  };

  await requestIdentityPage(state, input.verificationUrl);
  await requestIdentityJson(state, identityListPath(input.verificationUrl));
  const verifyPhone = await requestIdentityJson(
    state,
    "/identity/auth/verifyPhone?_flag=4&_json=true",
  );
  await requestIdentityJson(state, "/identity/pass/sms/userQuota", {
    method: "POST",
    body: new URLSearchParams({ _flag: "4", _json: "true" }),
  });
  let smsStatus: XiaomiIdentitySmsStatus = "sent";
  try {
    await sendXiaomiIdentitySms(state);
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

  const maskedPhone = extractMaskedPhone(verifyPhone);
  state.maskedPhone = maskedPhone;
  return { state, maskedPhone, smsStatus };
}

export async function sendXiaomiIdentitySms(
  state: XiaomiIdentityChallengeState,
): Promise<void> {
  const data = await requestIdentityJson(
    state,
    "/identity/auth/sendPhoneTicket",
    {
      method: "POST",
      body: new URLSearchParams({ _flag: "4", _json: "true" }),
    },
  );

  if (data.code !== 0) {
    throw new AppError(
      "MI_IDENTITY_SMS_FAILED",
      data.tips || data.desc || data.description || "小米验证码发送失败",
      502,
      {
        code: data.code,
      },
    );
  }
}

export async function completeXiaomiIdentityChallenge(input: {
  state: XiaomiIdentityChallengeState;
  ticket: string;
  deviceId: string;
}): Promise<{ session: XiaomiSession; state: XiaomiIdentityChallengeState }> {
  const data = await requestIdentityJson(
    input.state,
    "/identity/auth/verifyPhone",
    {
      method: "POST",
      body: new URLSearchParams({
        _flag: "4",
        ticket: input.ticket,
        trust: "true",
        _json: "true",
      }),
    },
  );

  if (data.code !== 0) {
    throw new AppError(
      "MI_IDENTITY_CODE_INVALID",
      data.tips || data.desc || data.description || "小米验证码错误",
      400,
      {
        code: data.code,
      },
    );
  }

  log.info(
    {
      step: "verifyPhone.ok",
      code: data.code,
      hasLocation: Boolean(data.location),
      locationHost: safeParseUrl(asString(data.location) ?? "")?.host,
      dataKeys: Object.keys(data),
    },
    "小米短信验证通过，开始换取登录凭据",
  );

  // 跟随验证完成后的重定向链，把 passToken / userId / serviceToken 收进 cookie jar。
  // 不再死磕 STS 地址，优先用 passToken 直接换 serviceToken。
  const location = asString(data.location);
  await followIdentityRedirects(input.state, location);

  // 路径 A（首选）：passToken → serviceLogin → serviceToken，完全绕开 STS。
  const passToken = cookieFromState(input.state, "passToken");
  const jarUserId = cookieFromState(input.state, "userId");
  if (passToken && jarUserId) {
    try {
      const session = await loginXiaomiAccountWithPassToken({
        passToken,
        userId: jarUserId,
        deviceId: input.deviceId,
      });
      log.info({ step: "identity.passToken.ok" }, "已用 passToken 换取 serviceToken");
      return { session, state: input.state };
    } catch (error) {
      log.warn(
        {
          step: "identity.passToken.failed",
          code: error instanceof AppError ? error.code : undefined,
        },
        "passToken 换取失败，回退 STS 解析",
      );
    }
  }

  // 路径 B：重定向链里直接带回了 serviceToken（部分账号会这样）。
  const jarServiceToken = cookieFromState(input.state, "serviceToken");
  if (jarServiceToken && jarUserId) {
    log.info({ step: "identity.cookie.ok" }, "已从重定向 cookie 获取 serviceToken");
    return {
      session: {
        serviceToken: jarServiceToken,
        userId: jarUserId,
        deviceId: input.deviceId,
      },
      state: input.state,
    };
  }

  // 路径 C（兜底）：老的 STS 地址解析。
  const stsUrl = await resolveIdentityStsUrl(input.state, location);
  if (!stsUrl) {
    throw new AppError(
      "MI_IDENTITY_STS_MISSING",
      "小米验证完成但未返回登录地址",
      502,
      {
        code: data.code,
      },
    );
  }

  const session = await createXiaomiSessionFromStsUrl({
    stsUrl,
    deviceId: input.deviceId,
  });
  return { session, state: input.state };
}

// 跟随小米验证完成后的重定向链（最多 MAX_IDENTITY_REDIRECTS 跳），
// 每一跳都把响应里的 Set-Cookie 累积进 identity state 的 cookie jar。
async function followIdentityRedirects(
  state: XiaomiIdentityChallengeState,
  location: string | undefined,
): Promise<void> {
  let current = location;
  for (let hop = 0; hop < MAX_IDENTITY_REDIRECTS && current; hop++) {
    let response: Response;
    try {
      response = await fetch(accountUrl(current), {
        redirect: "manual",
        headers: identityHeaders(state),
      });
    } catch {
      return; // 网络错误非致命，passToken 可能已在之前的跳中拿到
    }
    absorbCookies(response.headers, state);

    const next = response.headers.get("location");
    if (!next) return;
    current = next.startsWith("http") ? next : accountUrl(next);
  }
}

function cookieFromState(
  state: XiaomiIdentityChallengeState,
  key: string,
): string | undefined {
  const match = state.cookies.find(([name]) => name === key);
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

async function resolveIdentityStsUrl(
  state: XiaomiIdentityChallengeState,
  location: string | undefined,
): Promise<string | undefined> {
  const normalized = normalizeIdentityStsUrl(location);
  log.debug(
    {
      step: "resolveSts.start",
      hasLocation: Boolean(location),
      normalizedHost: normalized ? safeParseUrl(normalized)?.host : undefined,
      normalizedPath: normalized
        ? safeParseUrl(normalized)?.pathname
        : undefined,
      normalizedIsSts: normalized ? isStsUrl(normalized) : false,
    },
    "解析 identity STS：检查初始 location",
  );
  if (normalized && isStsUrl(normalized)) return normalized;
  if (!location) {
    log.warn({ step: "resolveSts.noLocation" }, "小米验证响应未携带 location");
    return undefined;
  }

  const response = await fetch(accountUrl(location), {
    redirect: "manual",
    headers: identityHeaders(state),
  });
  absorbCookies(response.headers, state);

  const redirectLocation = response.headers.get("location");
  log.info(
    {
      step: "resolveSts.followLocation",
      requestHost: safeParseUrl(accountUrl(location))?.host,
      statusCode: response.status,
      responseUrlHost: safeParseUrl(response.url)?.host,
      responseUrlPath: safeParseUrl(response.url)?.pathname,
      redirectLocationHost: redirectLocation
        ? safeParseUrl(
            normalizeIdentityStsUrl(redirectLocation) ?? redirectLocation,
          )?.host
        : undefined,
      redirectLocationPath: redirectLocation
        ? safeParseUrl(
            normalizeIdentityStsUrl(redirectLocation) ?? redirectLocation,
          )?.pathname
        : undefined,
      hasSetCookie: hasSetCookieHeader(response.headers),
    },
    "解析 identity STS：跟随 location 后的响应",
  );

  const redirectStsUrl = normalizeIdentityStsUrl(redirectLocation ?? undefined);
  if (redirectStsUrl && isStsUrl(redirectStsUrl)) return redirectStsUrl;

  const finalStsUrl = normalizeIdentityStsUrl(response.url);
  if (finalStsUrl && isStsUrl(finalStsUrl)) return finalStsUrl;

  const body = await response.text();
  const bodyStsUrl = extractStsUrl(body);
  if (bodyStsUrl) return bodyStsUrl;

  log.warn(
    {
      step: "resolveSts.exhausted",
      statusCode: response.status,
      responseUrl: response.url,
      redirectLocation: redirectLocation ?? undefined,
      bodyPreview: body.slice(0, 200),
    },
    "解析 identity STS：所有途径都没拿到 /sts 地址",
  );

  throw new AppError(
    "MI_IDENTITY_STS_INVALID",
    "小米验证已通过，但没有拿到可用的 STS 登录地址，请改用网页登录验证",
    502,
    {
      statusCode: response.status,
      locationHost: safeParseUrl(accountUrl(location))?.host,
      redirectHost: redirectLocation
        ? safeParseUrl(
            normalizeAccountUrl(redirectLocation) ?? redirectLocation,
          )?.host
        : undefined,
      body: body.slice(0, 80),
    },
  );
}

async function createXiaomiSessionFromStsUrl(input: {
  stsUrl: string;
  deviceId: string;
}): Promise<XiaomiSession> {
  const url = safeParseUrl(input.stsUrl);
  const allowedStsHosts = new Set([
    "api.mina.mi.com",
    "api2.mina.mi.com",
    "sts.api.io.mi.com",
  ]);
  if (!url || !allowedStsHosts.has(url.host) || url.pathname !== "/sts") {
    throw new AppError(
      "MI_STS_URL_INVALID",
      "小米验证完成地址无效，请复制验证页显示 ok 后的 sts 页面地址",
      400,
    );
  }

  const response = await fetch(url.toString(), {
    redirect: "manual",
    headers: {
      "User-Agent":
        url.host === "sts.api.io.mi.com" ? identityUserAgent : accountUserAgent,
    },
  });
  const body = await response.text();
  const serviceToken = extractCookieFromHeaders(
    response.headers,
    "serviceToken",
  );
  const userId = extractCookieFromHeaders(response.headers, "userId");
  if (!serviceToken || !userId) {
    throw new AppError(
      "MI_STS_TOKEN_MISSING",
      "无法从小米验证完成地址获取登录凭据",
      400,
      {
        statusCode: response.status,
        hasSetCookie: hasSetCookieHeader(response.headers),
        body: body.slice(0, 32),
      },
    );
  }

  return {
    serviceToken,
    userId,
    deviceId: input.deviceId,
  };
}

async function resolveWebCredentialStsUrl(value: string): Promise<string> {
  const trimmed = value.trim();
  if (isStsUrl(trimmed)) return trimmed;

  const embeddedStsUrl = extractStsUrl(trimmed);
  if (embeddedStsUrl) return embeddedStsUrl;

  const url = safeParseUrl(trimmed);
  if (
    url?.host === "account.xiaomi.com" &&
    url.pathname.endsWith("/pass/serviceLoginAuth2/end")
  ) {
    const response = await fetch(url.toString(), {
      redirect: "manual",
      headers: {
        "User-Agent": accountUserAgent,
      },
    });
    const redirectStsUrl = normalizeIdentityStsUrl(
      response.headers.get("location") ?? undefined,
    );
    if (redirectStsUrl && isStsUrl(redirectStsUrl)) return redirectStsUrl;

    const bodyStsUrl = extractStsUrl(await response.text());
    if (bodyStsUrl) return bodyStsUrl;
  }

  return trimmed;
}

async function loginXiaomiAccountWithPassToken(input: {
  passToken: string;
  userId: string;
  deviceId: string;
}): Promise<XiaomiSession> {
  const response = await fetch(
    "https://account.xiaomi.com/pass/serviceLogin?sid=micoapi&_json=true",
    {
      headers: {
        ...baseHeaders(input.deviceId),
        Cookie: `passToken=${input.passToken}; userId=${input.userId}; sdkVersion=3.9; deviceId=${input.deviceId}`,
      },
    },
  );

  if (!response.ok) {
    throw new AppError(
      "MI_PASS_TOKEN_LOGIN_FAILED",
      "小米网页凭据登录失败",
      502,
      {
        statusCode: response.status,
      },
    );
  }

  const rawBody = await response.text();
  const data = parseXiaomiJson<XiaomiLoginResponse>(rawBody);
  const nonce = extractBigIntField(rawBody, "nonce") ?? data.nonce;
  const location = data.location;
  const userId = asString(data.userId) || input.userId;
  if (data.code !== 0 || !location || !data.ssecurity || !nonce) {
    throw new AppError(
      "MI_PASS_TOKEN_LOGIN_FAILED",
      data.desc || data.description || "小米网页凭据登录失败",
      502,
      {
        code: data.code,
      },
    );
  }

  const serviceToken = await exchangeServiceToken(
    location,
    nonce,
    data.ssecurity,
    `passToken=${input.passToken}; userId=${input.userId}`,
    "passToken",
  );
  return {
    serviceToken,
    userId,
    ssecurity: data.ssecurity,
    deviceId: input.deviceId,
    passToken: input.passToken,
  };
}

// 用 passToken 静默换取 miio 域（sid=xiaomiio）会话：serviceToken 与签名用
// ssecurity 都是本次登录专属，与 micoapi 的不通用。miot action（TTS）专用。
export async function loginXiaomiMiioWithPassToken(input: {
  passToken: string;
  userId: string;
  deviceId: string;
}): Promise<XiaomiMiioSession> {
  const response = await fetch(
    "https://account.xiaomi.com/pass/serviceLogin?sid=xiaomiio&_json=true",
    {
      headers: {
        ...baseHeaders(input.deviceId),
        Cookie: `passToken=${input.passToken}; userId=${input.userId}; sdkVersion=3.9; deviceId=${input.deviceId}`,
      },
    },
  );
  if (!response.ok) {
    throw new AppError("MI_MIIO_LOGIN_FAILED", "小米 miio 登录失败", 502, {
      statusCode: response.status,
    });
  }
  const rawBody = await response.text();
  const data = parseXiaomiJson<XiaomiLoginResponse>(rawBody);
  const nonce = extractBigIntField(rawBody, "nonce") ?? data.nonce;
  if (data.code !== 0 || !data.location || !data.ssecurity || !nonce) {
    throw new AppError(
      "MI_MIIO_LOGIN_FAILED",
      data.desc || data.description || "小米 miio 登录失败，请重新登录小米账号",
      502,
      { code: data.code },
    );
  }
  const serviceToken = await exchangeServiceToken(
    data.location,
    nonce,
    data.ssecurity,
    `passToken=${input.passToken}; userId=${input.userId}`,
    "passToken",
  );
  return {
    serviceToken,
    ssecurity: data.ssecurity,
    userId: asString(data.userId) || input.userId,
    deviceId: input.deviceId,
  };
}

// miio 域请求签名（对齐 miservice sign_data）：
//   nonce = base64(8 随机字节 + 4 字节 time/60)
//   signedNonce = base64(sha256(b64d(ssecurity) + b64d(nonce)))
//   signature = base64(hmac-sha256(key=b64d(signedNonce), uri&snonce&nonce&data=json))
function signMiioData(
  uri: string,
  dataJson: string,
  ssecurity: string,
): { _nonce: string; data: string; signature: string } {
  const minutes = Math.floor(Date.now() / 60000);
  const timeBuf = Buffer.alloc(4);
  timeBuf.writeUInt32BE(minutes);
  const nonce = Buffer.concat([randomBytes(8), timeBuf]).toString("base64");
  const signedNonce = createHash("sha256")
    .update(Buffer.from(ssecurity, "base64"))
    .update(Buffer.from(nonce, "base64"))
    .digest("base64");
  const msg = [uri, signedNonce, nonce, `data=${dataJson}`].join("&");
  const signature = createHmac("sha256", Buffer.from(signedNonce, "base64"))
    .update(msg)
    .digest("base64");
  return { _nonce: nonce, data: dataJson, signature };
}

const miioUserAgent =
  "iOS-14.4-6.0.103-iPhone12,3--D7744744F7AF32F0544445285880DD63E47D9BE9-8816080-84A3F44E137B71AE-iPhone";

// 执行 miot spec action（POST api.io.mi.com/app/miotspec/action）。
// did 是数字 miotDID（不是 MiNA deviceID），siid/aiid 按机型映射。
export async function sendXiaomiMiotAction(input: {
  miioSession: XiaomiMiioSession;
  did: string;
  siid: number;
  aiid: number;
  args: unknown[];
}): Promise<void> {
  const uri = "/miotspec/action";
  const dataJson = JSON.stringify({
    params: {
      did: input.did,
      siid: input.siid,
      aiid: input.aiid,
      in: input.args,
    },
  });
  const signed = signMiioData(uri, dataJson, input.miioSession.ssecurity);
  const response = await fetch(`https://api.io.mi.com/app${uri}`, {
    method: "POST",
    headers: {
      "User-Agent": miioUserAgent,
      "x-xiaomi-protocal-flag-cli": "PROTOCAL-HTTP2",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: [
        `userId=${input.miioSession.userId}`,
        `serviceToken=${input.miioSession.serviceToken}`,
        `PassportDeviceId=${input.miioSession.deviceId}`,
      ].join("; "),
    },
    body: new URLSearchParams(signed),
  });
  if (response.status === 401) {
    // 401 语义仅内部用（code 匹配后静默重登一次），状态码用 502 防客户端误判登出。
    throw new AppError("MI_MIIO_UNAUTHORIZED", "miio 会话已过期", 502);
  }
  if (!response.ok) {
    throw new AppError("MI_MIOT_ACTION_FAILED", "miot action 请求失败", 502, {
      statusCode: response.status,
    });
  }
  const payload = (await response.json()) as {
    code?: number;
    message?: string;
  };
  if (payload.code !== 0) {
    throw new AppError(
      "MI_MIOT_ACTION_FAILED",
      `miot action 失败：${payload.message || `code ${payload.code}`}`,
      502,
      { code: payload.code },
    );
  }
}

async function requestIdentityVerificationUrl(input: {
  account: string;
  password: string;
  deviceId: string;
}): Promise<
  | {
      verificationUrl: string;
      cookies: Array<[string, string]>;
    }
  | undefined
> {
  const signResponse = await fetch(
    "https://account.xiaomi.com/pass/serviceLogin?sid=micoapi&_json=true",
    {
      headers: baseHeaders(input.deviceId),
    },
  );

  if (!signResponse.ok) return undefined;

  const signData = parseXiaomiJson<Record<string, unknown>>(
    await signResponse.text(),
  );
  const sign = asString(signData._sign);
  if (!sign) return undefined;

  const form = new URLSearchParams({
    _json: "true",
    qs: asString(signData.qs) ?? "%3Fsid%3Dmicoapi%26_json%3Dtrue",
    sid: asString(signData.sid) ?? "micoapi",
    _sign: sign,
    callback: asString(signData.callback) ?? "https://api2.mina.mi.com/sts",
    user: input.account,
    hash: createHash("md5").update(input.password).digest("hex").toUpperCase(),
  });

  const response = await fetch(
    "https://account.xiaomi.com/pass/serviceLoginAuth2",
    {
      method: "POST",
      headers: {
        "User-Agent": accountUserAgent,
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `sdkVersion=3.4.1; deviceId=${input.deviceId}`,
      },
      body: form,
    },
  );

  const data = parseXiaomiJson<XiaomiLoginResponse>(await response.text());
  const verificationUrl =
    normalizeAccountUrl(data.notificationUrl) ??
    normalizeAccountUrl(data.captchaUrl);
  if (!verificationUrl) return undefined;

  return {
    verificationUrl,
    cookies: [
      ...extractCookiePairs(signResponse.headers),
      ...extractCookiePairs(response.headers),
    ],
  };
}

export async function fetchXiaomiDevices(
  session: XiaomiSession,
): Promise<XiaomiDevice[]> {
  const response = await fetch("https://api.mina.mi.com/admin/v2/device_list", {
    headers: {
      Cookie: `serviceToken=${session.serviceToken}; userId=${session.userId}`,
      "User-Agent": minaUserAgent,
    },
  });

  if (!response.ok) {
    throw new AppError("MI_DEVICE_LIST_FAILED", "获取小米设备列表失败", 502, {
      statusCode: response.status,
    });
  }

  const data = (await response.json()) as { data?: unknown };
  const rows = Array.isArray(data.data) ? data.data : [];

  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as Record<string, unknown>;
    const deviceId = asString(item.deviceID);
    const did = asString(item.miotDID);
    if (!deviceId || !did) return [];

    return [
      {
        deviceId,
        did,
        name: asString(item.alias) || asString(item.name) || "未知设备",
        hardware: asString(item.hardware) || "",
        ip:
          asString(item.localip) || asString(item.localIp) || asString(item.ip),
      },
    ];
  });
}

export type XiaomiConversationRecord = {
  query: string;
  time: number;
  requestId?: string;
};

// 语音接管 spike（M3）：拉音箱最近对话记录。非公开接口，与 xiaomusic 同源
// （userprofile.mina.mi.com）；部分新固件可能拿不到——原始响应一并透出，
// 供 /mi/conversation/probe 真机验证时人工判断。
export async function fetchXiaomiConversations(input: {
  session: XiaomiSession;
  deviceId: string;
  hardware: string;
  limit?: number;
}): Promise<{ records: XiaomiConversationRecord[]; raw: unknown }> {
  const url = new URL(
    "https://userprofile.mina.mi.com/device_profile/v2/conversation",
  );
  url.searchParams.set("source", "dialogu");
  url.searchParams.set("hardware", input.hardware);
  url.searchParams.set("timestamp", String(Date.now()));
  url.searchParams.set("limit", String(input.limit ?? 5));

  const response = await fetch(url, {
    headers: {
      Cookie:
        `userId=${input.session.userId}; ` +
        `serviceToken=${input.session.serviceToken}; ` +
        `deviceId=${input.deviceId}`,
      "User-Agent": minaUserAgent,
    },
  });
  if (!response.ok) {
    throw new AppError("MI_CONVERSATION_FAILED", "拉取对话记录失败", 502, {
      statusCode: response.status,
    });
  }

  const payload = (await response.json()) as { code?: number; data?: unknown };
  // data 是 JSON 字符串（双重编码），失败保留原样供 probe 观察。
  let parsed: unknown = payload.data;
  if (typeof payload.data === "string") {
    try {
      parsed = JSON.parse(payload.data);
    } catch {
      parsed = payload.data;
    }
  }
  const records: XiaomiConversationRecord[] = [];
  if (parsed && typeof parsed === "object") {
    const rows = (parsed as { records?: unknown }).records;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const item = row as Record<string, unknown>;
        const query = asString(item.query);
        const time = typeof item.time === "number" ? item.time : 0;
        if (!query) continue;
        records.push({
          query,
          time,
          requestId: asString(item.requestId) || undefined,
        });
      }
    }
  }
  return { records, raw: payload };
}

// 同一小爱音箱的 ubus 请求串行执行，避免快速切歌 / 连续操作时并发打架
// key 为 deviceId，value 为该设备的请求尾链。
const ubusQueues = new Map<string, Promise<unknown>>();

export async function sendXiaomiUbusRequest(input: {
  session: XiaomiSession;
  deviceId: string;
  method: string;
  message: Record<string, unknown>;
  path?: string;
}): Promise<UbusResponse> {
  const previous = ubusQueues.get(input.deviceId);
  const run = (previous ?? Promise.resolve())
    .catch(() => {})
    .then(() => doXiaomiUbusRequest(input));
  ubusQueues.set(input.deviceId, run);
  try {
    return await run;
  } finally {
    // 只有当自己仍是队尾时才清理，避免误删后续排队的请求链。
    if (ubusQueues.get(input.deviceId) === run) {
      ubusQueues.delete(input.deviceId);
    }
  }
}

async function doXiaomiUbusRequest(input: {
  session: XiaomiSession;
  deviceId: string;
  method: string;
  message: Record<string, unknown>;
  path?: string;
}): Promise<UbusResponse> {
  const body = new URLSearchParams({
    deviceId: input.deviceId,
    method: input.method,
    path: input.path ?? "mediaplayer",
    message: JSON.stringify(input.message),
    requestId: `hmusic_${Date.now()}`,
  });

  const endpoints = [
    "https://api2.mina.xiaoaisound.com/remote/ubus",
    "https://api2.mina.mi.com/remote/ubus",
  ];
  let lastStatusCode: number | undefined;
  let lastMiMessage: string | undefined;

  for (const endpoint of endpoints) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Cookie: `serviceToken=${input.session.serviceToken}; userId=${input.session.userId}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": minaUserAgent,
      },
      body,
    });
    lastStatusCode = response.status;
    if (!response.ok) continue;

    const data = (await response.json()) as UbusResponse;
    if (data.code === 0) {
      return data;
    }
    if (data.message) lastMiMessage = String(data.message);
  }

  // 错误必须可行动：401 是会话过期（最常见），data.message 是小米侧真实原因
  // （如设备离线）。笼统的"请求失败"会让用户在"状态明明正常"里打转。
  const hint =
    lastStatusCode === 401
      ? "小米登录已过期，请到 设置 → 小米账号 重新登录"
      : lastMiMessage || "设备可能离线或小米服务不可达";
  throw new AppError(
    "MI_UBUS_REQUEST_FAILED",
    `小米设备控制请求失败：${hint}`,
    502,
    {
      method: input.method,
      statusCode: lastStatusCode,
      miMessage: lastMiMessage,
    },
  );
}

export function createXiaomiDeviceId(): string {
  return randomBytes(6).toString("hex").toUpperCase();
}

// 让小爱音箱语音播报一段文字。优先走 mibrain/text_to_speech（多数固件真正的
// 播报入口），失败再回退到老的 mediaplayer/player_play_tts。
export async function sendXiaomiTts(input: {
  session: XiaomiSession;
  deviceId: string;
  text: string;
}): Promise<void> {
  const attempts: Array<{ path: string; method: string }> = [
    { path: "mibrain", method: "text_to_speech" },
    { path: "mediaplayer", method: "player_play_tts" },
  ];

  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      const data = await sendXiaomiUbusRequest({
        session: input.session,
        deviceId: input.deviceId,
        method: attempt.method,
        message: { text: input.text },
        path: attempt.path,
      });
      if (data.code === 0) return;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof AppError) throw lastError;
  throw new AppError("MI_TTS_FAILED", "小米设备语音播报失败", 502, {
    deviceId: input.deviceId,
  });
}

async function requestLoginSign(
  deviceId: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    "https://account.xiaomi.com/pass/serviceLogin?sid=micoapi&_json=true",
    {
      headers: baseHeaders(deviceId),
    },
  );

  if (!response.ok) {
    throw new AppError("MI_LOGIN_SIGN_FAILED", "小米登录初始化失败", 502, {
      statusCode: response.status,
    });
  }

  return parseXiaomiJson<Record<string, unknown>>(await response.text());
}

async function exchangeServiceToken(
  location: string,
  nonce: string | number,
  ssecurity: string,
  cookieHeader?: string,
  mode = "password",
): Promise<string> {
  const clientSign = createSignPayload(nonce, ssecurity);
  const separator = location.includes("?") ? "&" : "?";
  const tokenUrl = `${location}${separator}clientSign=${encodeURIComponent(clientSign)}`;
  const response = await fetch(tokenUrl, {
    redirect: "manual",
    headers: {
      "User-Agent": accountUserAgent,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
  });

  const serviceToken = extractCookieFromHeaders(
    response.headers,
    "serviceToken",
  );
  if (!serviceToken) {
    const parsedUrl = safeParseUrl(tokenUrl);
    throw new AppError(
      "MI_SERVICE_TOKEN_MISSING",
      "无法从小米响应中获取 serviceToken",
      502,
      {
        statusCode: response.status,
        hasSetCookie: hasSetCookieHeader(response.headers),
        locationHost: parsedUrl?.host,
        locationPath: parsedUrl?.pathname,
        redirectLocation: response.headers.get("location") ? true : false,
        exchangeMode: mode,
      },
    );
  }

  return serviceToken;
}

function createSignPayload(nonce: string | number, ssecurity: string): string {
  return createHash("sha1")
    .update(`nonce=${nonce}&${ssecurity}`)
    .digest("base64");
}

function parseXiaomiJson<T>(raw: string): T {
  const cleaned = raw
    .trim()
    .replace(/^&&&START&&&\s*/, "")
    .replace(/^\)\]\}',?\s*/, "");
  return JSON.parse(cleaned) as T;
}

// 从原始 JSON 文本里用正则提取大整数字段（如 nonce），避免 JSON.parse 丢失
// 超过 2^53 的精度。
// @internal 导出仅供单元测试使用。
export function extractBigIntField(
  raw: string,
  field: string,
): string | undefined {
  const cleaned = raw
    .trim()
    .replace(/^&&&START&&&\s*/, "")
    .replace(/^\)\]\}',?\s*/, "");
  const match = cleaned.match(new RegExp(`"${field}"\\s*:\\s*(\\d+)`));
  return match?.[1];
}

async function requestIdentityPage(
  state: XiaomiIdentityChallengeState,
  url: string,
): Promise<void> {
  const response = await fetch(url, {
    redirect: "follow",
    headers: identityHeaders(state),
  });
  absorbCookies(response.headers, state);
  await response.arrayBuffer();
}

async function requestIdentityJson(
  state: XiaomiIdentityChallengeState,
  pathOrUrl: string,
  init: RequestInit = {},
): Promise<XiaomiIdentityResponse> {
  const response = await fetch(accountUrl(pathOrUrl), {
    ...init,
    headers: {
      ...identityHeaders(state),
      "X-Requested-With": "XMLHttpRequest",
      ...(init.body
        ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }
        : {}),
      ...(init.headers || {}),
    },
  });
  absorbCookies(response.headers, state);
  return parseXiaomiJson<XiaomiIdentityResponse>(await response.text());
}

function identityHeaders(
  state: XiaomiIdentityChallengeState,
): Record<string, string> {
  return {
    "User-Agent": identityWebUserAgent,
    Referer: state.referer,
    Cookie: cookieHeader(state),
  };
}

function cookieHeader(state: XiaomiIdentityChallengeState): string {
  return state.cookies.map(([key, value]) => `${key}=${value}`).join("; ");
}

function absorbCookies(
  headers: Headers,
  state: XiaomiIdentityChallengeState,
): void {
  const jar = new Map(state.cookies);
  for (const [key, value] of extractCookiePairs(headers)) {
    jar.set(key, value);
  }
  state.cookies = Array.from(jar.entries());
}

function accountUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith("http")) return pathOrUrl;
  return `https://account.xiaomi.com${
    pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`
  }`;
}

function identityListPath(verificationUrl: string): string {
  const url = safeParseUrl(verificationUrl);
  const sid = url?.searchParams.get("sid") || "micoapi";
  const context = url?.searchParams.get("context");
  const params = new URLSearchParams({
    sid,
    _flag: "4",
    _json: "true",
  });
  if (context) {
    params.set("context", context);
  }
  return `/identity/list?${params.toString()}`;
}

function extractMaskedPhone(
  response: XiaomiIdentityResponse,
): string | undefined {
  const data = asRecord(response.data);
  return (
    asString(response.maskedPhone) ||
    asString(response.phone) ||
    asString(data?.maskedPhone) ||
    asString(data?.phone)
  );
}

function normalizeIdentityStsUrl(
  location: string | undefined,
): string | undefined {
  if (!location) return undefined;
  if (location.startsWith("http")) return location;
  if (location.startsWith("/sts")) return `https://api2.mina.mi.com${location}`;
  return normalizeAccountUrl(location);
}

function isStsUrl(value: string): boolean {
  const url = safeParseUrl(value);
  return Boolean(
    url &&
    url.pathname === "/sts" &&
    (url.host === "api.mina.mi.com" ||
      url.host === "api2.mina.mi.com" ||
      url.host === "sts.api.io.mi.com"),
  );
}

function extractStsUrl(value: string): string | undefined {
  const match = value.match(
    /https:\/\/(?:api2?\.mina\.mi\.com|sts\.api\.io\.mi\.com)\/sts[^\s"'<>]*/i,
  );
  return match?.[0];
}

function extractCookie(raw: string | null, key: string): string | undefined {
  if (!raw) return undefined;
  const match = raw.match(new RegExp(`(?:^|[;,]\\s*)${key}=([^;,]+)`, "i"));
  return match?.[1];
}

function extractCookieFromHeaders(
  headers: Headers,
  key: string,
): string | undefined {
  for (const cookie of getSetCookieHeaders(headers)) {
    const value = extractCookie(cookie, key);
    if (value) return value;
  }

  return extractCookie(headers.get("set-cookie"), key);
}

function getSetCookieHeaders(headers: Headers): string[] {
  const getter = (headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie;
  if (typeof getter === "function") {
    return getter.call(headers);
  }

  const combined = headers.get("set-cookie");
  return combined ? [combined] : [];
}

function extractCookiePairs(headers: Headers): Array<[string, string]> {
  return getSetCookieHeaders(headers).flatMap((cookie) => {
    const match = cookie.match(/^([^=;]+)=([^;]*)/);
    if (!match?.[1] || !match[2]) return [];
    return [[match[1], match[2]]];
  });
}

function hasSetCookieHeader(headers: Headers): boolean {
  return getSetCookieHeaders(headers).length > 0 || headers.has("set-cookie");
}

function baseHeaders(deviceId: string): Record<string, string> {
  return {
    "User-Agent": accountUserAgent,
    Cookie: `sdkVersion=3.4.1; deviceId=${deviceId}`,
  };
}

function normalizeAccountUrl(
  pathOrUrl: string | undefined,
): string | undefined {
  if (!pathOrUrl) return undefined;
  return pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `https://account.xiaomi.com${pathOrUrl}`;
}

function safeParseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}
