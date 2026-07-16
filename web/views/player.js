import { ref, computed, watch, onMounted, onUnmounted, h } from "vue";
import { api } from "/app/api.js";
import { Icons } from "/app/icons.js";
import {
  store, refreshPlayback, toast, go,
  localSeek, localPlay, localPause, localPositionMs, localDurationMs, LOCAL_DEVICE_ID,
} from "/app/main.js";
import { lyric, lyricLoading, ensureLyric } from "/app/lyric-state.js";
import { downloadedBadge, refreshDownloadedKeys } from "/app/download.js";

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

    // ── 歌词状态（共享自 lyric-state.js，与歌词页同一份缓存） ──
    const lyricListEl = ref(null);

    // ── 窄屏（≤1023px，np-grid 单列）歌词模式 ──
    // 桌面双栏的歌词栏塌缩到手机上会把页面撑出一屏多（歌词孤零零飘在下面）。
    // 窄屏改为：内联只留「当前句」歌词条，点条/点封面进独立歌词页（#/lyrics）。
    const narrowMq = window.matchMedia("(max-width: 1023px)");
    const isNarrow = ref(narrowMq.matches);
    const hoverable = window.matchMedia("(hover: hover)").matches;
    function onNarrowChange(e) {
      isNarrow.value = e.matches;
    }

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

    // 染色进度：rAF 每帧直写 DOM（不经 Vue 响应式）——100ms 定时器只有 10fps，
    // 肉眼可见一卡一卡。本机播放每帧读 <audio> 实时进度；音箱播放用
    // 「最近已知进度 + 距上次校准的流逝时间」插值，同样逐帧丝滑。
    const stripTextEl = ref(null);
    let stripRaf = 0;
    let stripLineIdx = -1;
    let posStampAt = 0;

    function setDisplayPos(v) {
      displayPos.value = v;
      posStampAt = performance.now();
    }

    // 本机播放的平滑时钟：<audio>.currentTime 在部分内核随音频缓冲块每 100-250ms
    // 才更新一格，逐帧直读染色仍是"一次跳好几个字"。以「锚点 + 墙钟流逝」为主钟
    // 保证每帧连续，与真实采样漂移超过 300ms（seek/换曲/卡顿）才硬对齐。
    let localAnchorMs = 0;
    let localAnchorAt = 0;

    function smoothLocalPos() {
      const raw = localPositionMs();
      const now = performance.now();
      if (store.playback?.state !== "playing") {
        localAnchorMs = raw;
        localAnchorAt = now;
        return raw;
      }
      const predicted = localAnchorMs + (now - localAnchorAt);
      if (Math.abs(raw - predicted) > 300) {
        localAnchorMs = raw;
        localAnchorAt = now;
        return raw;
      }
      return predicted;
    }

    function livePos() {
      if (isLocal()) return smoothLocalPos();
      const playing = store.playback?.state === "playing" && !dragging.value;
      return displayPos.value + (playing ? performance.now() - posStampAt : 0);
    }

    function stripFrame() {
      stripRaf = requestAnimationFrame(stripFrame);
      if (!isNarrow.value) return;
      const lines = lyricLines.value;
      const el = stripTextEl.value;
      if (!el || lines.length === 0) return;
      let pos = livePos();
      const durMax = totalMs();
      if (durMax > 0) pos = Math.min(pos, durMax);
      let i = -1;
      for (let k = 0; k < lines.length; k++) {
        if (lines[k].timeMs <= pos) i = k;
        else break;
      }
      if (i < 0) {
        el.style.setProperty("--fill", "0%");
        return;
      }
      const start = lines[i].timeMs;
      const end = i + 1 < lines.length ? lines[i + 1].timeMs : (totalMs() || start + 5000);
      const fill = Math.min(100, Math.max(0, ((pos - start) / Math.max(1, end - start)) * 100));
      el.style.setProperty("--fill", `${fill.toFixed(2)}%`);
      // 响应式（歌词条文本/进度条）节流更新：换行立即同步，其余 250ms 一次——
      // 染色的每帧丝滑靠上面的直写，不需要每帧重渲染组件。
      if (!dragging.value && (i !== stripLineIdx || performance.now() - posStampAt > 250)) {
        stripLineIdx = i;
        setDisplayPos(pos);
      }
    }

    // 当前行变化时，把它滚到歌词栏视口中部。
    watch(activeLine, (index) => {
      if (index < 0 || !lyricListEl.value) return;
      const el = lyricListEl.value.children[index];
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    function loadLyric() {
      ensureLyric(track.value);
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
        setDisplayPos(isLocal() ? localPositionMs() : (store.playback?.positionMs ?? 0));
      }
      if (typeof store.playback?.volume === "number" && !volDragging.value) {
        volume.value = store.playback.volume;
      }
    }

    function localTick() {
      const state = store.playback;
      if (!state || state.state !== "playing" || dragging.value) return;
      if (isLocal()) {
        setDisplayPos(localPositionMs());
        return;
      }
      // 音箱播放：按「锚点 + 真实流逝时间」推进（livePos），不能盲加 +1000——
      // rAF 节流分支也会重设锚点，两个推进器各自累加会双倍计速
      // （症状：歌词染色跑得比歌快，提前染完，再被 5s 服务器校准拽回来重染）。
      const max = state.durationMs || 0;
      const pos = livePos();
      setDisplayPos(max > 0 ? Math.min(pos, max) : pos);
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
      refreshDownloadedKeys();
      syncTimer = setInterval(sync, 5000);
      localTimer = setInterval(localTick, 1000);
      stripRaf = requestAnimationFrame(stripFrame);
      narrowMq.addEventListener("change", onNarrowChange);
    });
    onUnmounted(() => {
      clearInterval(syncTimer);
      clearInterval(localTimer);
      cancelAnimationFrame(stripRaf);
      narrowMq.removeEventListener("change", onNarrowChange);
    });

    function renderStage() {
      return h("section", { class: "np-stage" }, [
        h("div", {
          class: ["np-cover", { tappable: isNarrow.value && !!track.value }],
          style: coverStyle(track.value),
          // 窄屏点封面 = 进歌词页（大拇指友好的大目标，移动播放器惯例）
          onClick: () => {
            if (isNarrow.value && track.value) go("lyrics");
          },
        }, track.value?.coverUrl ? [] : Icons.note()),
        h("div", { class: "np-head" }, [
          h("div", { class: "np-title" }, [
            track.value?.title || "暂无播放",
            track.value ? downloadedBadge(track.value) : null,
          ]),
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

        // 窄屏：染色歌词条放在信息与进度之间（QQ 音乐同构布局）
        isNarrow.value ? renderLyricStrip() : null,

        // 进度条（本机播放时长以 <audio> 为准兜底）+ 行末音量键。
        // 音量是「输出强度」，语义上与进度同层（Spotify 桌面版同款位置），
        // 把主控第五键让给队列——窄屏队列页的唯一入口。
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
              setDisplayPos(Number(e.target.value));
            },
            onChange: (e) => {
              dragging.value = false;
              seekTo(Number(e.target.value));
            },
          }),
          h("span", { class: "progress-time" }, formatTime(totalMs())),
          h("div", {
            class: ["volume-wrap", { open: volumeOpen.value }],
            // hover 展开仅限有悬停能力的设备——触屏上 mouseenter 会和 click
            // 打架（一点即开又即关，表现为"无法调节"），触屏只走点击开关。
            onMouseenter: hoverable ? () => (volumeOpen.value = true) : undefined,
            onMouseleave: hoverable
              ? () => {
                  if (!volDragging.value) volumeOpen.value = false;
                }
              : undefined,
          }, [
            h("button", {
              class: "icon-btn",
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

        // 单行主控：收藏 / 上一曲 / 播放暂停 / 下一曲 / 队列 —— 五键对称，
        // 播放键正中，收藏与队列作两端配重。
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
          h("button", {
            class: "ctrl-btn",
            title: "播放队列",
            onClick: () => go("queue"),
          }, Icons.queue()),
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

    // 窄屏：当前句染色歌词条（点击进独立歌词页）。
    // 染色 = 行内进度驱动的左→右渐进填充；歌词本体就是入口，不加多余装饰。
    function renderLyricStrip() {
      if (!track.value) return null;
      const lines = lyricLines.value;
      const hasLine = activeLine.value >= 0 && lines.length > 0;
      const label = lyricLoading.value
        ? "歌词加载中…"
        : hasLine
          ? lines[activeLine.value]?.text || "…"
          : lines.length > 0
            ? "…"
            : lyric.value?.lrc
              ? "查看歌词"
              : "暂无歌词";
      return h("button", {
        class: "np-lyric-strip",
        onClick: () => go("lyrics"),
      }, [
        h("span", {
          ref: stripTextEl,
          class: ["np-lyric-strip-text", { karaoke: hasLine }],
        }, label),
      ]);
    }

    return () =>
      h("main", { class: "view player-view" }, [
        h("div", { class: "np-grid" }, [
          renderStage(),
          isNarrow.value ? null : renderLyrics(),
        ]),
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
