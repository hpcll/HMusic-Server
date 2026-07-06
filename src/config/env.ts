import "dotenv/config";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  HMUSIC_HOST: z.string().default("0.0.0.0"),
  HMUSIC_PORT: z.coerce.number().int().positive().default(8090),
  HMUSIC_DATA_DIR: z.string().default("./data"),
  HMUSIC_DATABASE_URL: z.string().default("./data/hmusic.db"),
  HMUSIC_JWT_SECRET: z.string().min(8).default("change-me"),
  HMUSIC_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  HMUSIC_PUBLIC_BASE_URL: z.string().url().default("http://127.0.0.1:8090"),
});

const parsed = envSchema.parse(process.env);

export const env = {
  host: parsed.HMUSIC_HOST,
  port: parsed.HMUSIC_PORT,
  dataDir: path.resolve(parsed.HMUSIC_DATA_DIR),
  databaseUrl: path.resolve(parsed.HMUSIC_DATABASE_URL),
  jwtSecret: parsed.HMUSIC_JWT_SECRET,
  logLevel: parsed.HMUSIC_LOG_LEVEL,
  publicBaseUrl: parsed.HMUSIC_PUBLIC_BASE_URL,
};
