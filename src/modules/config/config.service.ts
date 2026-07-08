import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { appConfig } from "../../db/schema.js";

export type RuntimeConfig = {
  serverName: string;
  defaultQuality: "128k" | "320k" | "flac" | "hires";
  searchStrategy: "qqFirst" | "kuwoFirst" | "neteaseFirst";
  resolveStrategy: "originalFirst" | "qqFirst" | "kuwoFirst" | "neteaseFirst";
  manualTracks: Array<{
    id?: string;
    title: string;
    artist?: string;
    album?: string;
    durationMs?: number;
    coverUrl?: string;
    url: string;
  }>;
  lxPlugins: Array<{
    id: string;
    name: string;
    path: string;
    enabled?: boolean;
    defaultQuality?: "128k" | "320k" | "flac" | "hires";
    // 订阅链接：从远程 URL 导入的插件记住来源，支持一键更新。
    sourceUrl?: string;
  }>;
  // 补充内置 player_play_music 白名单的自定义小爱音箱型号（大写，如 "L20A"）。
  // 用于覆盖内置表未收录、直连播放静音的新机型。
  extraPlayMusicModels: string[];
};

export const defaultRuntimeConfig: RuntimeConfig = {
  serverName: "HMusic Server",
  defaultQuality: "320k",
  searchStrategy: "qqFirst",
  resolveStrategy: "originalFirst",
  manualTracks: [],
  lxPlugins: [],
  extraPlayMusicModels: [],
};

const configKey = "runtime";

export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  const rows = await db
    .select()
    .from(appConfig)
    .where(eq(appConfig.key, configKey))
    .limit(1);
  if (!rows[0]) return defaultRuntimeConfig;

  return {
    ...defaultRuntimeConfig,
    ...(JSON.parse(rows[0].valueJson) as Partial<RuntimeConfig>),
  };
}

export async function saveRuntimeConfig(
  next: Partial<RuntimeConfig>,
): Promise<RuntimeConfig> {
  const merged = {
    ...(await getRuntimeConfig()),
    ...next,
  };

  await db
    .insert(appConfig)
    .values({
      key: configKey,
      valueJson: JSON.stringify(merged),
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: appConfig.key,
      set: {
        valueJson: JSON.stringify(merged),
        updatedAt: Date.now(),
      },
    });

  return merged;
}
