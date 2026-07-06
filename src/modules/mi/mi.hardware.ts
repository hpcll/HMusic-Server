import { createHash } from "node:crypto";

// 需要使用 player_play_music 接口的设备型号（精确匹配）。
// 对齐活跃项目 参考实现 的 NEED_USE_PLAY_MUSIC_API 白名单：
// 这些型号不支持标准 player_play_url，误用会导致「连上但静音」。
const needPlayMusicApi = new Set([
  "X08C",
  "X08E",
  "X8F",
  "X4B",
  "LX05",
  "OH2",
  "OH2P",
  "X6A",
  "LX04",
  "L05B",
  "L05C",
  "LX06",
  "L06A",
  "X08A",
  "X10A",
  "L15A",
  "L16A",
  "L17A",
]);

const noSeekSupport = new Set(["OH2P", "OH2"]);
const unreliablePlayStatus = new Set(["OH2P", "OH2", "S12A"]);
const androidMediaContext = new Set(["S12A"]);

export function needsPlayMusicApi(
  hardware: string | undefined,
  extraModels?: readonly string[],
): boolean {
  const upperHardware = normalizeHardware(hardware);
  if (!upperHardware) return false;
  if (needPlayMusicApi.has(upperHardware)) return true;

  // 用户自定义的额外型号（补充内置白名单），解决「音箱型号太多、内置表覆盖不全」的问题。
  return normalizeExtraModels(extraModels).includes(upperHardware);
}

function normalizeExtraModels(extraModels?: readonly string[]): string[] {
  if (!extraModels) return [];
  return extraModels
    .map((item) => normalizeHardware(item))
    .filter((item) => item.length > 0);
}

export function supportsSeek(hardware: string | undefined): boolean {
  const upperHardware = normalizeHardware(hardware);
  if (!upperHardware) return true;

  return !noSeekSupport.has(upperHardware);
}

export function hasUnreliablePlayStatus(hardware: string | undefined): boolean {
  const upperHardware = normalizeHardware(hardware);
  if (!upperHardware) return false;

  return unreliablePlayStatus.has(upperHardware);
}

export function playbackMediaContext(
  hardware: string | undefined,
): "app_android" | "app_ios" {
  const upperHardware = normalizeHardware(hardware);
  return androidMediaContext.has(upperHardware) ? "app_android" : "app_ios";
}

export function createMiAudioId(input: {
  url: string;
  title?: string;
}): string {
  const qqAudioId = extractQqAudioId(input.url);
  if (qqAudioId) return qqAudioId;

  const base = input.title?.trim().toLowerCase() || input.url;
  const hash = createHash("sha1").update(base).digest();
  const value = hash.readUInt32BE(0);
  return String((value % 999_999_999) + 100_000_000);
}

function extractQqAudioId(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.host.includes("qqmusic.qq.com")) {
      const lastSegment = parsed.pathname.split("/").filter(Boolean).pop();
      if (lastSegment?.startsWith("C400") && lastSegment.endsWith(".m4a")) {
        return lastSegment.slice(3, -4);
      }
    }

    if (parsed.host.includes("y.qq.com")) {
      const match = parsed.pathname.match(/\/songDetail\/([^/.]+)(?:\.html)?/);
      return match?.[1];
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function normalizeHardware(hardware: string | undefined): string {
  return hardware?.toUpperCase() ?? "";
}
