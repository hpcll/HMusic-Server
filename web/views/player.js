import { ref, computed, onMounted, onUnmounted, h } from "vue";
import { api } from "/app/api.js";
import { store, refreshPlayback, toast } from "/app/main.js";

// 正在播放：封面卡 + 播放器卡（进度条 / 主控三键 / 停止+音量图标）+ 设备 + TTS。
// 进度条 1s 本地插值推进，5s 与服务端校准一次。
export const PlayerView = {
  setup() {
    const devices = ref([]);
    const volume = ref(0);
    const volumeOpen = ref(false);
    const volDragging = ref(false);
    const speakText = ref("");
    const busy = ref("");
    const displayPos = ref(0); // 本地插值的播放进度 ms
    const dragging = ref(false); // 用户拖进度条时暂停同步
    let syncTimer = 0;
    let localTimer = 0;

    const pb = computed(() => store.playback || {});
    const track = computed(() => pb.value.track);
    const stateLabel = computed(() => STATE_LABELS[pb.value.state] || "空闲");

    async function loadDevices() {
      try {
        const result = await api("/devices");
        devices.value = result.devices || [];
      } catch (error) {
        toast(error.message, "error");
      }
    }

    async function sync() {
      await refreshPlayback();
      if (!dragging.value) {
        displayPos.value = store.playback?.positionMs ?? 0;
      }
      if (typeof store.playback?.volume === "number" && !volDragging.value) {
        volume.value = store.playback.volume;
      }
    }

    function localTick() {
      const state = store.playback;
      if (!state || state.state !== "playing" || dragging.value) return;
      const max = state.durationMs || 0;
      const next = displayPos.value + 1000;
      displayPos.value = max > 0 ? Math.min(next, max) : next;
    }

    async function control(action) {
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
        await sync();
      } catch (error) {
        toast(error.message, "error");
        await sync();
      }
    }

    async function selectDevice(id) {
      try {
        await api(`/devices/${id}/select`, { method: "POST" });
        await loadDevices();
        toast("已切换设备", "success");
      } catch (error) {
        toast(error.message, "error");
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

    async function speak() {
      const text = speakText.value.trim();
      if (!text) return;
      try {
        await api("/playback/speak", { method: "POST", body: { text } });
        speakText.value = "";
        toast("已发送语音播报", "success");
      } catch (error) {
        toast(error.message, "error");
      }
    }

    onMounted(() => {
      loadDevices();
      sync();
      syncTimer = setInterval(sync, 5000);
      localTimer = setInterval(localTick, 1000);
    });
    onUnmounted(() => {
      clearInterval(syncTimer);
      clearInterval(localTimer);
    });

    return () =>
      h("main", { class: "view player-view" }, [
        h("section", { class: "now-playing card" }, [
          h("div", { class: "cover", style: coverStyle(track.value) },
            track.value?.coverUrl ? [] : "♪"),
          h("div", { class: "np-meta" }, [
            h("div", { class: "np-title" }, track.value?.title || "暂无播放"),
            h("div", { class: "np-artist" }, track.value?.artist || ""),
            h("div", { class: "np-state" }, [
              h("span", { class: `dot dot-${pb.value.state || "idle"}` }),
              stateLabel.value,
              pb.value.deviceName ? ` · ${pb.value.deviceName}` : "",
            ]),
          ]),
        ]),

        h("section", { class: "card player-card" }, [
          // 进度条
          h("div", { class: "progress-row" }, [
            h("span", { class: "progress-time" }, formatTime(displayPos.value)),
            h("input", {
              type: "range",
              class: "progress-bar",
              min: 0,
              max: pb.value.durationMs || 0,
              value: Math.min(displayPos.value, pb.value.durationMs || 0),
              disabled: !pb.value.durationMs || !pb.value.seekEnabled,
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
            h("span", { class: "progress-time" }, formatTime(pb.value.durationMs)),
          ]),

          // 主控三键（垂直居中对齐）
          h("div", { class: "controls" }, [
            ctrlBtn("previous", "⏮", busy.value, () => control("previous")),
            pb.value.state === "playing"
              ? ctrlBtn("pause", "⏸", busy.value, () => control("pause"), true)
              : ctrlBtn("resume", "▶", busy.value, () => control("resume"), true),
            ctrlBtn("next", "⏭", busy.value, () => control("next")),
          ]),

          // 次行：停止（弱化） + 音量（图标，点击/悬停展开滑块）
          h("div", { class: "sub-controls" }, [
            h("button", {
              class: "icon-btn",
              title: "停止播放",
              disabled: !!busy.value,
              onClick: () => control("stop"),
            }, "⏹"),
            h("div", {
              class: ["volume-wrap", { open: volumeOpen.value }],
              onMouseenter: () => (volumeOpen.value = true),
              onMouseleave: () => {
                if (!volDragging.value) volumeOpen.value = false;
              },
            }, [
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
              h("span", { class: "volume-pct" },
                volumeOpen.value ? String(volume.value) : ""),
              h("button", {
                class: "icon-btn",
                title: "音量",
                onClick: () => (volumeOpen.value = !volumeOpen.value),
              }, volumeIcon(volume.value)),
            ]),
          ]),
        ]),

        h("section", { class: "card" }, [
          h("div", { class: "row-label" }, "播放设备"),
          devices.value.length === 0
            ? h("div", { class: "muted" }, "未发现设备，请到 设置 → 小米账号 登录后刷新")
            : h("div", { class: "device-list" },
                devices.value.map((d) =>
                  h("button", {
                    key: d.id,
                    class: ["device-item", { active: d.isDefault }],
                    onClick: () => selectDevice(d.id),
                  }, [
                    h("span", { class: `dot ${d.isOnline ? "dot-playing" : "dot-idle"}` }),
                    h("span", null, d.name),
                    d.isDefault ? h("span", { class: "badge" }, "默认") : null,
                  ]),
                ),
              ),
        ]),

        h("section", { class: "card" }, [
          h("div", { class: "row-label" }, "让音箱说话"),
          h("div", { class: "inline-form" }, [
            h("input", {
              placeholder: "输入要播报的文字…",
              value: speakText.value,
              onInput: (e) => (speakText.value = e.target.value),
              onKeyup: (e) => e.key === "Enter" && speak(),
            }),
            h("button", { class: "secondary-btn", onClick: speak }, "播报"),
          ]),
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

function volumeIcon(volume) {
  if (volume <= 0) return "🔇";
  if (volume < 34) return "🔈";
  if (volume < 67) return "🔉";
  return "🔊";
}

function ctrlBtn(key, icon, busy, onClick, primary = false) {
  return h("button", {
    key,
    class: ["ctrl-btn", { primary, busy: busy === key }],
    disabled: !!busy,
    onClick,
  }, icon);
}
