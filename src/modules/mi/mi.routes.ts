import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../shared/auth.js";
import {
  completeMiWebVerification,
  confirmMiVerificationCode,
  getMiStatus,
  importMiWebSession,
  loginMiAccount,
  logoutMiAccount,
  resendMiVerificationCode,
  startMiLoginVerification,
  startMiWebVerification,
} from "./mi.service.js";

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

  app.get("/status", async () => getMiStatus());

  app.post("/login", async (request) => {
    const body = loginSchema.parse(request.body);
    return loginMiAccount(
      body.account,
      body.password,
      body.captchaCode,
      body.webCredentials,
    );
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
