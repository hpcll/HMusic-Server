import { ref } from "vue";
import { api } from "/app/api.js";

// 歌词共享状态：播放页（桌面双栏/窄屏歌词条）和歌词页共用，
// 同一首歌只拉一次 /tracks/lyrics。
export const lyric = ref(null); // HMusicLyric | null
export const lyricLoading = ref(false);
let lyricForKey = "";

export async function ensureLyric(track) {
  if (!track) {
    lyric.value = null;
    lyricForKey = "";
    return;
  }
  const key = `${track.source}:${track.sourceTrackId}`;
  if (key === lyricForKey) return;
  lyricForKey = key;
  lyric.value = null;
  lyricLoading.value = true;
  try {
    lyric.value = await api("/tracks/lyrics", { method: "POST", body: { track } });
  } catch {
    lyric.value = null; // 无歌词不算错误
  } finally {
    lyricLoading.value = false;
  }
}
