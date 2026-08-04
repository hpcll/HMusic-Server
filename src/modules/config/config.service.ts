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
  // 音箱播放前语音播报歌名（「即将播放 XX」）：仅远端小爱设备生效，
  // 播报失败不阻断播放。默认关闭（播报会拖慢开播 2-4 秒）。
  announceTracks: boolean;
  // NAS 存量音乐目录（绝对路径）：扫描器只读遍历入库，不改动原文件。
  // dataDir/music 始终扫描，无需在此重复声明。
  libraryDirs: string[];
};

export const defaultRuntimeConfig: RuntimeConfig = {
  serverName: "HMusic Server",
  defaultQuality: "320k",
  searchStrategy: "qqFirst",
  resolveStrategy: "originalFirst",
  manualTracks: [],
  lxPlugins: [],
  extraPlayMusicModels: [],
  announceTracks: false,
  libraryDirs: [],
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
