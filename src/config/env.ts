import "dotenv/config";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  HMUSIC_HOST: z.string().default("0.0.0.0"),
  HMUSIC_PORT: z.coerce.number().int().positive().default(6650),
  HMUSIC_DATA_DIR: z.string().default("./data"),
  HMUSIC_DATABASE_URL: z.string().default("./data/hmusic.db"),
  HMUSIC_JWT_SECRET: z
    .string()
    .min(8)
    .refine((value) => value !== "change-me", {
      message: "HMUSIC_JWT_SECRET 不能使用默认值 change-me",
    }),
  HMUSIC_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  HMUSIC_PUBLIC_BASE_URL: z.string().url().default("http://127.0.0.1:6650"),
});

// 测试环境允许使用内置临时值；生产环境缺少密钥或仍使用默认值时直接拒绝启动。
const isVitest =
  Boolean(process.env.VITEST) ||
  process.argv.some((argument) => argument.includes("vitest"));
const configuredJwtSecret = process.env.HMUSIC_JWT_SECRET;
const parsed = envSchema.parse({
  ...process.env,
  HMUSIC_JWT_SECRET:
    isVitest && configuredJwtSecret === "change-me"
      ? "vitest-only-secret"
      : configuredJwtSecret,
});

export const env = {
  host: parsed.HMUSIC_HOST,
  port: parsed.HMUSIC_PORT,
  dataDir: path.resolve(parsed.HMUSIC_DATA_DIR),
  databaseUrl: path.resolve(parsed.HMUSIC_DATABASE_URL),
  jwtSecret: parsed.HMUSIC_JWT_SECRET,
  logLevel: parsed.HMUSIC_LOG_LEVEL,
  publicBaseUrl: parsed.HMUSIC_PUBLIC_BASE_URL,
};
