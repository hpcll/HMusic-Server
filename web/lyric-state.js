import { ref } from "vue";
import { api } from "./api.js";
import { lyricLookupKey } from "./lyric-utils.js";

// 歌词共享状态：播放页（桌面双栏/窄屏歌词条）和歌词页共用；
// 设备歌曲的标题/歌手补齐后会重新查询一次歌词。
export const lyric = ref(null); // HMusicLyric | null
export const lyricLoading = ref(false);
let lyricForKey = "";
let lyricRequestSeq = 0;

export async function ensureLyric(track) {
  const key = lyricLookupKey(track);
  if (!key) {
    lyricRequestSeq += 1;
    lyric.value = null;
    lyricLoading.value = false;
    lyricForKey = "";
    return;
  }
  if (key === lyricForKey) return;
  lyricForKey = key;
  const requestSeq = ++lyricRequestSeq;
  lyric.value = null;
  lyricLoading.value = true;
  try {
    const result = await api("/tracks/lyrics", {
      method: "POST",
      body: { track },
    });
    if (requestSeq === lyricRequestSeq) lyric.value = result;
  } catch {
    if (requestSeq === lyricRequestSeq) lyric.value = null; // 无歌词不算错误
  } finally {
    if (requestSeq === lyricRequestSeq) lyricLoading.value = false;
  }
}
