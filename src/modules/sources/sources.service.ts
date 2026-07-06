import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env.js";
import type { HMusicSource, HMusicTrack } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { createTestToneTrack } from "../../shared/test-tone.js";
import {
  getRuntimeConfig,
  saveRuntimeConfig,
  type RuntimeConfig,
} from "../config/config.service.js";
import {
  assertLxPluginLoadable,
  createLxPluginRuntime,
  type LxLyricResult,
  type LxPluginConfig,
} from "./lx-plugin.runtime.js";

type ManualTrackConfig = {
  id?: string;
  title?: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  coverUrl?: string;
  url?: string;
};

export type LxPluginFile = {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
  defaultQuality: HMusicSource["config"]["defaultQuality"];
  sizeBytes?: number;
  updatedAt?: number;
};

const manualSource: HMusicSource = {
  id: "manual",
  name: "手工 URL 音源",
  type: "manual",
  enabled: true,
  priority: 100,
  config: {
    defaultQuality: "320k",
  },
  health: {
    status: "ok",
    message: "可搜索配置中的手工曲目，也可直接输入 URL",
    checkedAt: Date.now(),
  },
  updatedAt: Date.now(),
};

export async function listSources(): Promise<HMusicSource[]> {
  const config = await getRuntimeConfig();
  const lxSources = config.lxPlugins.map((plugin) =>
    createLxSource(plugin, plugin.enabled !== false),
  );

  return [manualSource, ...lxSources];
}

export async function testSource(sourceId: string) {
  const sources = await listSources();
  const source = sources.find((item) => item.id === sourceId);
  if (!source) {
    throw new AppError("SOURCE_NOT_FOUND", "音源不存在", 404, { sourceId });
  }

  if (source.id !== manualSource.id) {
    await assertLxPluginLoadable(await getLxPluginConfig(source.id));
  }

  return source.health;
}

export async function listLxPlugins(): Promise<{ plugins: LxPluginFile[] }> {
  const config = await getRuntimeConfig();
  const plugins = await Promise.all(
    config.lxPlugins.map(async (plugin) => ({
      id: plugin.id,
      name: plugin.name,
      path: plugin.path,
      enabled: plugin.enabled !== false,
      defaultQuality: plugin.defaultQuality || "320k",
      ...(await statPluginFile(plugin.path)),
    })),
  );

  return { plugins };
}

export async function getLxPluginCode(
  pluginId: string,
): Promise<{ id: string; code: string }> {
  const plugin = await getLxPluginConfig(pluginId, { includeDisabled: true });
  const pluginPath = ensurePluginPath(plugin.path);
  return {
    id: pluginId,
    code: await fs.readFile(pluginPath, "utf8"),
  };
}

export async function saveLxPlugin(input: {
  id: string;
  name: string;
  code: string;
  enabled?: boolean;
  defaultQuality?: HMusicSource["config"]["defaultQuality"];
}): Promise<LxPluginFile> {
  const id = normalizePluginId(input.id);
  const pluginPath = path.join(pluginDir(), `${id}.js`);
  await fs.mkdir(pluginDir(), { recursive: true });
  await fs.writeFile(pluginPath, input.code, "utf8");

  await assertLxPluginLoadable({
    id,
    name: input.name,
    path: pluginPath,
  });

  const config = await getRuntimeConfig();
  const nextPlugins = upsertPluginConfig(config, {
    id,
    name: input.name,
    path: pluginPath,
    enabled: input.enabled ?? true,
    defaultQuality: input.defaultQuality || "320k",
  });
  await saveRuntimeConfig({ lxPlugins: nextPlugins });

  return {
    id,
    name: input.name,
    path: pluginPath,
    enabled: input.enabled ?? true,
    defaultQuality: input.defaultQuality || "320k",
    ...(await statPluginFile(pluginPath)),
  };
}

export async function deleteLxPlugin(
  pluginId: string,
): Promise<{ deletedPluginId: string }> {
  const plugin = await getLxPluginConfig(pluginId, { includeDisabled: true });
  const pluginPath = ensurePluginPath(plugin.path);
  await fs.rm(pluginPath, { force: true });

  const config = await getRuntimeConfig();
  await saveRuntimeConfig({
    lxPlugins: config.lxPlugins.filter((item) => item.id !== pluginId),
  });

  return { deletedPluginId: pluginId };
}

export async function searchSourceTracks(
  sourceId: string,
  query: string,
): Promise<HMusicTrack[]> {
  if (sourceId !== manualSource.id) {
    const plugin = await getLxPluginConfig(sourceId);
    const runtime = await createLxPluginRuntime(plugin);
    return runtime.search(query, 1);
  }

  return searchManualTracks(query);
}

export async function resolveSourceTrack(
  track: HMusicTrack,
  quality?: string,
): Promise<string | undefined> {
  if (track.url) return track.url;
  if (track.source === manualSource.id) return undefined;

  const plugins = await getResolveCandidatePlugins(track.source);
  for (const plugin of plugins) {
    const runtime = await createLxPluginRuntime(plugin);
    const url = await runtime.resolve(track, quality);
    if (url) return url;
  }

  return undefined;
}

export async function getSourceTrackLyric(
  track: HMusicTrack,
): Promise<LxLyricResult | undefined> {
  if (track.source === manualSource.id) return undefined;

  const plugins = await getResolveCandidatePlugins(track.source);
  for (const plugin of plugins) {
    const runtime = await createLxPluginRuntime(plugin);
    const lyric = await runtime.lyric(track);
    if (lyric) return lyric;
  }

  return undefined;
}

async function searchManualTracks(query: string): Promise<HMusicTrack[]> {
  const urlTrack = createUrlTrack(query);
  const configuredTracks = [
    createTestToneTrack(),
    ...(await getConfiguredManualTracks()),
  ];
  const loweredQuery = query.toLowerCase();
  const matched = configuredTracks.filter((track) =>
    [track.sourceTrackId, track.title, track.artist, track.album, track.url]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(loweredQuery)),
  );

  return [...(urlTrack ? [urlTrack] : []), ...matched];
}

async function getConfiguredManualTracks(): Promise<HMusicTrack[]> {
  const config = await getRuntimeConfig();
  const rawTracks = Array.isArray(config.manualTracks)
    ? config.manualTracks
    : [];

  return rawTracks.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const track = item as ManualTrackConfig;
    if (!track.url || !track.title) return [];

    return [
      {
        id: `manual:${track.id || index}`,
        source: "manual",
        sourceTrackId: track.id || String(index),
        title: track.title,
        artist: track.artist || "未知艺术家",
        album: track.album,
        durationMs: track.durationMs,
        coverUrl: track.coverUrl,
        url: track.url,
        qualities: ["source"],
        raw: track,
      },
    ];
  });
}

function createUrlTrack(query: string): HMusicTrack | undefined {
  try {
    const url = new URL(query);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;

    return {
      id: `manual:url:${Buffer.from(query).toString("base64url")}`,
      source: "manual",
      sourceTrackId: query,
      title: decodeURIComponent(
        url.pathname.split("/").filter(Boolean).pop() || "URL 音频",
      ),
      artist: "手工 URL",
      url: query,
      qualities: ["source"],
      raw: {
        url: query,
      },
    };
  } catch {
    return undefined;
  }
}

function createLxSource(
  plugin: {
    id: string;
    name: string;
    defaultQuality?: HMusicSource["config"]["defaultQuality"];
  },
  enabled: boolean,
): HMusicSource {
  return {
    id: plugin.id,
    name: plugin.name,
    type: "lx_js",
    enabled,
    priority: 10,
    config: {
      defaultQuality: plugin.defaultQuality || "320k",
    },
    health: {
      status: "unknown",
    },
    updatedAt: Date.now(),
  };
}

async function getLxPluginConfig(
  sourceId: string,
  options: { includeDisabled?: boolean } = {},
): Promise<LxPluginConfig> {
  const config = await getRuntimeConfig();
  const plugin = config.lxPlugins.find((item) => item.id === sourceId);
  if (!plugin || (!options.includeDisabled && plugin.enabled === false)) {
    throw new AppError("SOURCE_NOT_FOUND", "LX 插件音源不存在或未启用", 404, {
      sourceId,
    });
  }

  return {
    id: plugin.id,
    name: plugin.name,
    path: plugin.path,
  };
}

async function getResolveCandidatePlugins(
  sourceId: string,
): Promise<LxPluginConfig[]> {
  const config = await getRuntimeConfig();
  const enabledPlugins = config.lxPlugins.filter(
    (plugin) => plugin.enabled !== false,
  );
  const sourcePlugin = enabledPlugins.find((plugin) => plugin.id === sourceId);

  const orderedPlugins = sourcePlugin
    ? [
        sourcePlugin,
        ...enabledPlugins.filter((plugin) => plugin.id !== sourcePlugin.id),
      ]
    : enabledPlugins;

  if (orderedPlugins.length === 0) {
    throw new AppError("SOURCE_NOT_FOUND", "没有可用的 LX 插件音源", 404, {
      sourceId,
    });
  }

  return orderedPlugins.map((plugin) => ({
    id: plugin.id,
    name: plugin.name,
    path: plugin.path,
  }));
}

function normalizePluginId(id: string): string {
  const normalized = id.trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(normalized)) {
    throw new AppError(
      "LX_PLUGIN_ID_INVALID",
      "插件 ID 只能包含字母、数字、下划线和短横线",
      400,
      { id },
    );
  }
  return normalized;
}

function pluginDir(): string {
  return path.join(env.dataDir, "plugins", "lx");
}

function ensurePluginPath(pluginPath: string): string {
  const resolved = path.resolve(pluginPath);
  const root = path.resolve(pluginDir());
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new AppError("LX_PLUGIN_PATH_INVALID", "插件路径不在受控目录内", 400);
  }
  return resolved;
}

async function statPluginFile(pluginPath: string) {
  try {
    const stat = await fs.stat(pluginPath);
    return {
      sizeBytes: stat.size,
      updatedAt: stat.mtimeMs,
    };
  } catch {
    return {};
  }
}

function upsertPluginConfig(
  config: RuntimeConfig,
  plugin: RuntimeConfig["lxPlugins"][number],
): RuntimeConfig["lxPlugins"] {
  const others = config.lxPlugins.filter((item) => item.id !== plugin.id);
  return [...others, plugin];
}
