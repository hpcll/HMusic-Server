import { ref, computed, watch, nextTick, onMounted, onUnmounted, h } from "vue";
import { api } from "/app/api.js";
import { Icons } from "/app/icons.js";
import {
  store, go, toast, refreshPlayback,
  localSeek, localPlay, localPause, localPositionMs, LOCAL_DEVICE_ID,
} from "/app/main.js";
import { lyric, lyricLoading, ensureLyric } from "/app/lyric-state.js";

// 歌词页（#/lyrics，窄屏专用的沉浸式独立路由）：
//   头部收起键 + 曲名/歌手 → 全屏歌词滚动（行点跳转）→ 底部迷你播控（进度 + 三键）。
// 是真路由所以系统返回手势天然可退出；外壳在该路由下隐藏顶栏/底部导航（沉浸）。
// 桌面（≥1024）无此页需求（播放页已有双栏歌词），直接跳回播放页。
export const LyricsView = {
  setup() {
    const displayPos = ref(0);
    const dragging = ref(false);
    const busy = ref("");
    const lyricListEl = ref(null);
    let syncTimer = 0;
    let tickTimer = 0;

    const pb = computed(() => store.playback || {});
    const track = computed(() => pb.value.track);
    const isLocal = () => pb.value.deviceId === LOCAL_DEVICE_ID;
    const totalMs = () => pb.value.durationMs || 0;

    const lyricLines = computed(() => lyric.value?.lines || []);
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

    watch(activeLine, (index) => {
      if (index < 0 || !lyricListEl.value) return;
      const el = lyricListEl.value.children[index];
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    watch(track, (t) => ensureLyric(t));

    async function sync() {
      await refreshPlayback();
      if (!dragging.value) {
        displayPos.value = isLocal()
          ? localPositionMs()
          : (store.playback?.positionMs ?? 0);
      }
    }

    function tick() {
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
        if (isLocal()) localSeek(positionMs);
        await sync();
      } catch (error) {
        toast(error.message, "error");
        await sync();
      }
    }

    onMounted(async () => {
      // 桌面无此页需求（播放页已有双栏歌词）。
      if (window.matchMedia("(min-width: 1024px)").matches) {
        go("player");
        return;
      }
      await sync();
      ensureLyric(track.value);
      syncTimer = setInterval(sync, 5000);
      tickTimer = setInterval(tick, 1000);
      // 进页即把当前行定位到视口中部。
      await nextTick();
      const el = lyricListEl.value?.children[activeLine.value];
      if (el) el.scrollIntoView({ block: "center" });
    });
    onUnmounted(() => {
      clearInterval(syncTimer);
      clearInterval(tickTimer);
    });

    function renderBody() {
      const lines = lyricLines.value;
      if (!track.value) {
        return placeholder("暂无播放", "回去挑一首歌吧");
      }
      if (lyricLoading.value) return placeholder("歌词加载中…", "");
      if (lines.length === 0) {
        return lyric.value?.lrc
          ? h("div", { class: "lyrics-empty" }, lyric.value.lrc)
          : placeholder("暂无歌词", "纯音乐或该音源没有提供歌词");
      }
      return h("div", { class: "lyrics-list", ref: lyricListEl },
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

    function placeholder(title, sub) {
      return h("div", { class: "lyrics-placeholder" }, [
        h("span", { class: "lyrics-placeholder-icon" }, Icons.note()),
        h("div", { class: "lyrics-placeholder-title" }, title),
        sub ? h("div", { class: "lyrics-placeholder-sub" }, sub) : null,
      ]);
    }

    return () =>
      h("main", { class: "lyrics-page" }, [
        h("div", { class: "lyrics-page-head" }, [
          h("button", {
            class: "icon-btn ghost",
            title: "收起歌词",
            onClick: () => go("player"),
          }, Icons.chevronDown()),
          h("div", { class: "lyrics-page-title" }, [
            h("div", { class: "np-title-sm" }, track.value?.title || "歌词"),
            h("div", { class: "muted" }, track.value?.artist || ""),
          ]),
          h("span", { class: "lyrics-page-pad" }),
        ]),

        h("section", { class: "np-lyrics" }, [renderBody()]),

        h("div", { class: "lyrics-page-ctrl" }, [
          h("div", { class: "progress-row" }, [
            h("span", { class: "progress-time" }, formatTime(displayPos.value)),
            h("input", {
              type: "range",
              class: "progress-bar",
              min: 0,
              max: totalMs(),
              value: Math.min(displayPos.value, totalMs()),
              disabled: !totalMs() || !pb.value.seekEnabled,
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
          h("div", { class: "lyrics-page-btns" }, [
            h("button", {
              class: "ctrl-btn", disabled: !!busy.value, title: "上一曲",
              onClick: () => control("previous"),
            }, ICON.previous()),
            pb.value.state === "playing"
              ? h("button", {
                  class: "ctrl-btn primary", disabled: !!busy.value, title: "暂停",
                  onClick: () => control("pause"),
                }, ICON.pause())
              : h("button", {
                  class: "ctrl-btn primary", disabled: !!busy.value, title: "播放",
                  onClick: () => control("resume"),
                }, ICON.play()),
            h("button", {
              class: "ctrl-btn", disabled: !!busy.value, title: "下一曲",
              onClick: () => control("next"),
            }, ICON.next()),
          ]),
        ]),
      ]);
  },
};

function formatTime(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

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
