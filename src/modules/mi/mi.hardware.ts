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

// 需要走 miot spec action 播报 TTS 的机型 → "siid-aiid"（对齐 本地音乐服务
// TTS_COMMAND）：这些机型的 MiNA ubus mibrain/text_to_speech 不生效，必须
// 用 miio 域的 /miotspec/action。不在表内的机型仍走 MiNA ubus。
const ttsMiotCommand: Record<string, string> = {
  OH2: "5-3",
  OH2P: "7-3",
  LX06: "5-1",
  S12: "5-1",
  L15A: "7-3",
  LX5A: "5-1",
  LX01: "5-1",
  LX05: "5-1",
  X10A: "7-3",
  L17A: "7-3",
  ASX4B: "5-3",
  L06A: "5-1",
  L05B: "5-3",
  L05C: "5-3",
  X6A: "7-3",
  X08E: "7-3",
  L09A: "3-1",
  LX04: "5-1",
};

// 机型的 miot TTS action（siid/aiid），无映射时返回 undefined（走 MiNA ubus）。
export function ttsMiotAction(
  hardware: string | undefined,
): { siid: number; aiid: number } | undefined {
  const command = ttsMiotCommand[normalizeHardware(hardware)];
  if (!command) return undefined;
  const [siid, aiid] = command.split("-").map(Number);
  if (!Number.isInteger(siid) || !Number.isInteger(aiid)) return undefined;
  return { siid, aiid };
}

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
