import { ref, computed, watch, onMounted, onUnmounted, h } from "vue";
import { api } from "/app/api.js";
import { Icons } from "/app/icons.js";
import {
  store, refreshPlayback, toast,
  localSeek, localPlay, localPause, localPositionMs, localDurationMs, LOCAL_DEVICE_ID,
} from "/app/main.js";

const FAV_PLAYLIST_NAME = "我喜欢的音乐";

// 正在播放（桌面双栏）：
//   左栏 = 大封面 + 曲目信息 + 进度 + 单行主控（上一曲/播放暂停/下一曲/音量）
//   右栏 = 同步歌词，当前行衬线加深，自动跟随滚动
// 设备切换在 设置 → 播放设备，TTS 在 设置 → 链路诊断，此页只留播放本身。
// 窄屏自动叠为单列。进度条 1s 本地插值推进，5s 与服务端校准一次，
// 歌词行级同步直接复用这套插值（行粒度不需要毫秒精度）。
export const PlayerView = {
  setup() {
    const volume = ref(0);
    const volumeOpen = ref(false);
    const volDragging = ref(false);
    const busy = ref("");
    const displayPos = ref(0); // 本地插值的播放进度 ms
    const dragging = ref(false); // 用户拖进度条时暂停同步
    let syncTimer = 0;
    let localTimer = 0;

    // ── 歌词状态 ──
    const lyric = ref(null); // HMusicLyric | null
    const lyricLoading = ref(false);
    let lyricForKey = ""; // 已加载歌词对应的曲目 key，防重复拉取
    const lyricListEl = ref(null);

    const pb = computed(() => store.playback || {});
    const track = computed(() => pb.value.track);
    const stateLabel = computed(() => STATE_LABELS[pb.value.state] || "空闲");

    // ── 收藏（「我喜欢的音乐」歌单，首次收藏时自动创建） ──
    const favPlaylist = ref(null); // {id, items} | null
    const favBusy = ref(false);
    const trackKey = (t) => (t ? `${t.source}:${t.sourceTrackId}` : "");
    const favItem = computed(() => {
      const items = favPlaylist.value?.items || [];
      const key = trackKey(track.value);
      return key
        ? items.find((it) => trackKey(it.track) === key)
        : undefined;
    });

    async function loadFavorites() {
      try {
        const result = await api("/playlists");
        const summary = (result.playlists || []).find(
          (p) => p.name === FAV_PLAYLIST_NAME,
        );
        if (!summary) {
          favPlaylist.value = null;
          return;
        }
        const detail = await api(`/playlists/${summary.id}`);
        favPlaylist.value = detail.playlist;
      } catch {
        // 收藏状态尽力而为，不打扰播放
      }
    }

    async function toggleFavorite() {
      const t = track.value;
      if (!t || favBusy.value) return;
      favBusy.value = true;
      try {
        if (favItem.value) {
          const result = await api(
            `/playlists/${favPlaylist.value.id}/tracks/${favItem.value.id}`,
            { method: "DELETE" },
          );
          favPlaylist.value = result.playlist;
          toast("已从「我喜欢的音乐」移除", "info");
        } else {
          if (!favPlaylist.value) {
            const created = await api("/playlists", {
              method: "POST",
              body: { name: FAV_PLAYLIST_NAME },
            });
            favPlaylist.value = created.playlist;
          }
          const result = await api(
            `/playlists/${favPlaylist.value.id}/tracks`,
            { method: "POST", body: { track: t } },
          );
          favPlaylist.value = result.playlist;
          toast("已加入「我喜欢的音乐」", "success");
        }
      } catch (error) {
        toast(error.message, "error");
      } finally {
        favBusy.value = false;
      }
    }

    const lyricLines = computed(() => lyric.value?.lines || []);
    // 当前行 = 最后一个 timeMs <= 播放进度的行
    const activeLine = computed(() => {
      const lines = lyricLines.value;
      const pos = displayPos.value;
      let active = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].timeMs <= pos) active = i;
        else break;
      }
      return active;
    });

    // 当前行变化时，把它滚到歌词栏视口中部。
    watch(activeLine, (index) => {
      if (index < 0 || !lyricListEl.value) return;
      const el = lyricListEl.value.children[index];
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    async function loadLyric() {
      const t = track.value;
      if (!t) {
        lyric.value = null;
        lyricForKey = "";
        return;
      }
      const key = `${t.source}:${t.sourceTrackId}`;
      if (key === lyricForKey) return;
      lyricForKey = key;
      lyric.value = null;
      lyricLoading.value = true;
      try {
        lyric.value = await api("/tracks/lyrics", {
          method: "POST",
          body: { track: t },
        });
      } catch {
        lyric.value = null; // 无歌词不算错误
      } finally {
        lyricLoading.value = false;
      }
    }

    watch(track, loadLyric);

    const isLocal = () => pb.value.deviceId === LOCAL_DEVICE_ID;
    // 曲目总时长：服务端值优先，本机播放用 <audio>.duration 兜底。
    const totalMs = () => (pb.value.durationMs || 0) || (isLocal() ? localDurationMs() : 0);

    async function sync() {
      await refreshPlayback();
      if (!dragging.value) {
        // 本机播放：<audio> 是进度真相源，服务端的 positionMs 是延迟回写的旧值，
        // 用它覆盖会导致进度条每 5 秒回跳一次。
        displayPos.value = isLocal()
          ? localPositionMs()
          : (store.playback?.positionMs ?? 0);
      }
      if (typeof store.playback?.volume === "number" && !volDragging.value) {
        volume.value = store.playback.volume;
      }
    }

    function localTick() {
      const state = store.playback;
      if (!state || state.state !== "playing" || dragging.value) return;
      if (isLocal()) {
        displayPos.value = localPositionMs();
        return;
      }
      const max = state.durationMs || 0;
      const next = displayPos.value + 1000;
      displayPos.value = max > 0 ? Math.min(next, max) : next;
    }

    async function control(action) {
      // 本机播放先在手势栈里同步驱动 <audio>：resume/pause 若等 api 返回再动，
      // 浏览器会因手势令牌失效拦截 play()，表现为点了没反应还停在 0:00。
      if (isLocal()) {
        if (action === "resume") localPlay();
        else if (action === "pause") localPause();
      }
      busy.value = action;
      try {
        await api(`/playback/${action}`, { method: "POST" });
        await sync();
      } catch (error) {
        toast(error.message, "error");
      } finally {
        busy.value = "";
      }
    }

    async function seekTo(positionMs) {
      try {
        await api("/playback/seek", { method: "POST", body: { positionMs } });
        // 本机播放：服务端只记数字，音频元素要在前端跳。
        if (pb.value.deviceId === LOCAL_DEVICE_ID) localSeek(positionMs);
        await sync();
      } catch (error) {
        toast(error.message, "error");
        await sync();
      }
    }

    async function commitVolume() {
      volDragging.value = false;
      try {
        await api("/playback/volume", { method: "POST", body: { volume: volume.value } });
      } catch (error) {
        toast(error.message, "error");
      }
    }

    onMounted(() => {
      sync().then(loadLyric);
      loadFavorites();
      syncTimer = setInterval(sync, 5000);
      localTimer = setInterval(localTick, 1000);
    });
    onUnmounted(() => {
      clearInterval(syncTimer);
      clearInterval(localTimer);
    });

    function renderStage() {
      return h("section", { class: "np-stage" }, [
        h("div", { class: "np-cover", style: coverStyle(track.value) },
          track.value?.coverUrl ? [] : Icons.note()),
        h("div", { class: "np-head" }, [
          h("div", { class: "np-title" }, track.value?.title || "暂无播放"),
          h("div", { class: "np-artist" },
            track.value
              ? `${track.value.artist || "未知"}${track.value.album ? " · " + track.value.album : ""}`
              : "在搜索或榜单里挑一首歌"),
          h("div", { class: "np-state" }, [
            h("span", { class: `dot dot-${pb.value.state || "idle"}` }),
            stateLabel.value,
            pb.value.deviceName ? ` · ${pb.value.deviceName}` : "",
          ]),
        ]),

        // 进度条（本机播放时长以 <audio> 为准兜底）
        h("div", { class: "progress-row" }, [
          h("span", { class: "progress-time" }, formatTime(displayPos.value)),
          h("input", {
            type: "range",
            class: "progress-bar",
            min: 0,
            max: totalMs(),
            value: Math.min(displayPos.value, totalMs()),
            disabled: !totalMs() || !pb.value.seekEnabled,
            title: pb.value.seekEnabled ? "" : "当前设备不支持进度跳转",
            onInput: (e) => {
              dragging.value = true;
              displayPos.value = Number(e.target.value);
            },
            onChange: (e) => {
              dragging.value = false;
              seekTo(Number(e.target.value));
            },
          }),
          h("span", { class: "progress-time" }, formatTime(totalMs())),
        ]),

        // 单行主控：收藏 / 上一曲 / 播放暂停 / 下一曲 / 音量 —— 五键对称，
        // 播放键正中，收藏与音量作两端配重；滑块悬浮展开不挤动布局。
        h("div", { class: "controls" }, [
          h("button", {
            class: ["ctrl-btn", "ctrl-fav", { active: !!favItem.value }],
            title: favItem.value ? "从「我喜欢的音乐」移除" : "加入「我喜欢的音乐」",
            disabled: !track.value || favBusy.value,
            onClick: toggleFavorite,
          }, favItem.value ? Icons.heartFilled() : Icons.heart()),
          ctrlBtn("previous", ICON.previous(), busy.value, () => control("previous")),
          pb.value.state === "playing"
            ? ctrlBtn("pause", ICON.pause(), busy.value, () => control("pause"), true)
            : ctrlBtn("resume", ICON.play(), busy.value, () => control("resume"), true),
          ctrlBtn("next", ICON.next(), busy.value, () => control("next")),
          h("div", {
            class: ["volume-wrap", { open: volumeOpen.value }],
            onMouseenter: () => (volumeOpen.value = true),
            onMouseleave: () => {
              if (!volDragging.value) volumeOpen.value = false;
            },
          }, [
            h("button", {
              class: "ctrl-btn",
              title: "音量",
              onClick: () => (volumeOpen.value = !volumeOpen.value),
            }, volumeIcon(volume.value)),
            h("div", { class: "volume-flyout" }, [
              h("input", {
                type: "range",
                class: "volume-slider",
                min: 0,
                max: 100,
                value: volume.value,
                "aria-label": "音量",
                onInput: (e) => {
                  volDragging.value = true;
                  volume.value = Number(e.target.value);
                },
                onChange: commitVolume,
              }),
              h("span", { class: "volume-pct" }, String(volume.value)),
            ]),
          ]),
        ]),
      ]);
    }

    function renderLyrics() {
      const lines = lyricLines.value;
      let body;
      if (!track.value) {
        body = lyricsPlaceholder("这里会显示歌词", "播放一首歌试试");
      } else if (lyricLoading.value) {
        body = lyricsPlaceholder("歌词加载中…", "");
      } else if (lines.length === 0) {
        body = lyric.value?.lrc
          ? h("div", { class: "lyrics-empty" }, lyric.value.lrc)
          : lyricsPlaceholder("暂无歌词", "纯音乐或该音源没有提供歌词");
      } else {
        body = h("div", { class: "lyrics-list", ref: lyricListEl },
          lines.map((line, i) =>
            h("p", {
              key: `${i}-${line.timeMs}`,
              class: ["lyric-line", { active: i === activeLine.value }],
              onClick: () => {
                if (pb.value.seekEnabled) seekTo(line.timeMs);
              },
            }, line.text || "…"),
          ),
        );
      }
      return h("section", { class: "np-lyrics" }, [body]);
    }

    function lyricsPlaceholder(title, sub) {
      return h("div", { class: "lyrics-placeholder" }, [
        h("span", { class: "lyrics-placeholder-icon" }, Icons.note()),
        h("div", { class: "lyrics-placeholder-title" }, title),
        sub ? h("div", { class: "lyrics-placeholder-sub" }, sub) : null,
      ]);
    }

    return () =>
      h("main", { class: "view player-view" }, [
        h("div", { class: "np-grid" }, [renderStage(), renderLyrics()]),
      ]);
  },
};

const STATE_LABELS = {
  idle: "空闲", loading: "加载中", playing: "播放中",
  paused: "已暂停", stopped: "已停止", error: "出错",
};

function coverStyle(track) {
  if (track?.coverUrl) {
    return { backgroundImage: `url(${track.coverUrl})` };
  }
  return {};
}

function formatTime(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

// 内联 SVG 图标：fill/stroke 用 currentColor，尺寸交给 CSS 统一控制，
// 避免 emoji 字形在各平台大小/基线/配色不一致（播放↔暂停切换不再跳动）。
function svgIcon(children) {
  return h("svg", {
    viewBox: "0 0 24 24",
    fill: "currentColor",
    "aria-hidden": "true",
    focusable: "false",
  }, children);
}

const ICON = {
  previous: () => svgIcon([
    h("path", { d: "M7 6.5h2.3v11H7z" }),
    h("path", { d: "M19 6.5v11l-8.4-5.5z" }),
  ]),
  next: () => svgIcon([
    h("path", { d: "M14.7 6.5H17v11h-2.3z" }),
    h("path", { d: "M5 6.5v11l8.4-5.5z" }),
  ]),
  play: () => svgIcon([h("path", { d: "M8 5.5v13l11-6.5z" })]),
  pause: () => svgIcon([h("path", { d: "M7.5 5.5h3v13h-3zM13.5 5.5h3v13h-3z" })]),
};

// 音量图标：喇叭 + 声波弧线，静音画叉。
// 喇叭右移到中线偏左、且「有音量必画至少一道弧」，让内容始终左右平衡——
// 否则低音量时右侧弧线全缺，图案会整体偏左，在圆钮里看着没居中。
function volumeIcon(volume) {
  const wave = (d) => h("path", {
    d, fill: "none", stroke: "currentColor",
    "stroke-width": 1.9, "stroke-linecap": "round",
  });
  const children = [h("path", { d: "M5.5 9.5h3l4.5-3.5v12L9 14.5H5.5z" })];
  if (volume <= 0) {
    children.push(wave("M15.5 9.5l4 5M19.5 9.5l-4 5"));
  } else {
    children.push(wave("M15.5 9a4.2 4.2 0 0 1 0 6")); // 有声必画，撑住右侧
    if (volume >= 50) children.push(wave("M18 6.5a7.8 7.8 0 0 1 0 11"));
  }
  return svgIcon(children);
}

function ctrlBtn(key, icon, busy, onClick, primary = false) {
  return h("button", {
    key,
    class: ["ctrl-btn", { primary, busy: busy === key }],
    disabled: !!busy,
    onClick,
  }, icon);
}
