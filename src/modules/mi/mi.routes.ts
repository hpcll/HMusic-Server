import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../shared/auth.js";
import {
  completeMiWebVerification,
  confirmMiVerificationCode,
  getMiQrLoginStatus,
  getMiStatus,
  importMiWebSession,
  loginMiAccount,
  logoutMiAccount,
  probeMiConversation,
  resendMiVerificationCode,
  startMiLoginVerification,
  startMiQrLogin,
  startMiWebVerification,
} from "./mi.service.js";

// verify=1 触发限频真校验（拉一次设备列表验 serviceToken），供客户端
// 冷启/回前台确认小米会话是否已过期；缺省保持纯数据库快照。
const statusQuerySchema = z.object({
  verify: z.enum(["1", "true"]).optional(),
});

const conversationProbeQuerySchema = z.object({
  deviceId: z.string().min(1).optional(),
});

const loginSchema = z
  .object({
    account: z.string().min(1),
    password: z.string().min(1),
    captchaCode: z.string().optional(),
    webCredentials: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const verificationStartSchema = z
  .object({
    account: z.string().min(1),
    password: z.string().min(1),
    captchaCode: z.string().optional(),
  })
  .strict();

const sessionImportSchema = z
  .object({
    account: z.string().min(1).default("imported"),
    webCredentials: z
      .record(z.string(), z.string())
      .refine(
        (value) =>
          Boolean(
            value.stsUrl ||
            value.finalStsUrl ||
            value.completionUrl ||
            value.finalUrl ||
            value.url,
          ) || Boolean(value.serviceToken && value.userId),
        "需要提供 stsUrl，或 serviceToken + userId",
      ),
  })
  .strict();

const verificationParamsSchema = z.object({
  id: z.string().min(1),
});

const verificationConfirmSchema = z
  .object({
    code: z.string().min(4).max(12),
  })
  .strict();

const webVerificationCompleteSchema = z
  .object({
    stsUrl: z.string().optional(),
    finalStsUrl: z.string().optional(),
    completionUrl: z.string().optional(),
    finalUrl: z.string().optional(),
    url: z.string().optional(),
    webCredentials: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export async function miRoutes(app: FastifyInstance): Promise<void> {
  requireAuth(app);

  app.get("/status", async (request) => {
    const query = statusQuerySchema.parse(request.query);
    return getMiStatus({ verify: query.verify != null });
  });

  // M3 spike：真机验证能否拉到音箱对话记录（非公开接口，固件差异风险）。
  // curl -H "Authorization: Bearer <token>" <base>/api/v1/mi/conversation/probe
  app.get("/conversation/probe", async (request) => {
    const query = conversationProbeQuerySchema.parse(request.query);
    return probeMiConversation(query.deviceId);
  });

  app.post("/login", async (request) => {
    const body = loginSchema.parse(request.body);
    return loginMiAccount(
      body.account,
      body.password,
      body.captchaCode,
      body.webCredentials,
    );
  });

  app.post("/qr/start", async () => startMiQrLogin());

  app.get("/qr/:id/status", async (request) => {
    const params = verificationParamsSchema.parse(request.params);
    return getMiQrLoginStatus(params.id);
  });

  app.post("/verification/start", async (request) => {
    const body = verificationStartSchema.parse(request.body);
    return startMiLoginVerification(
      body.account,
      body.password,
      body.captchaCode,
    );
  });

  app.post("/web-verification/start", async (request) => {
    const body = verificationStartSchema.parse(request.body);
    return startMiWebVerification(
      body.account,
      body.password,
      body.captchaCode,
    );
  });

  app.post("/web-verification/:id/complete", async (request) => {
    const params = verificationParamsSchema.parse(request.params);
    const body = webVerificationCompleteSchema.parse(request.body ?? {});
    return completeMiWebVerification(
      params.id,
      normalizeWebVerificationCredentials(body),
    );
  });

  app.post("/session/import", async (request) => {
    const body = sessionImportSchema.parse(request.body);
    return importMiWebSession(body.account, body.webCredentials);
  });

  app.post("/verification/:id/resend", async (request) => {
    const params = verificationParamsSchema.parse(request.params);
    return resendMiVerificationCode(params.id);
  });

  app.post("/verification/:id/confirm", async (request) => {
    const params = verificationParamsSchema.parse(request.params);
    const body = verificationConfirmSchema.parse(request.body);
    return confirmMiVerificationCode(params.id, body.code);
  });

  app.post("/logout", async () => logoutMiAccount());
}

function normalizeWebVerificationCredentials(
  body: z.infer<typeof webVerificationCompleteSchema>,
): Record<string, string> | undefined {
  const webCredentials = { ...(body.webCredentials ?? {}) };
  for (const key of [
    "stsUrl",
    "finalStsUrl",
    "completionUrl",
    "finalUrl",
    "url",
  ] as const) {
    if (body[key]) webCredentials[key] = body[key];
  }

  return Object.keys(webCredentials).length > 0 ? webCredentials : undefined;
}
