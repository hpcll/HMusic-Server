import { ref, computed, onMounted, onUnmounted, h } from "vue";
import { api } from "/app/api.js";
import { store, refreshPlayback, toast } from "/app/main.js";

// 正在播放 + 设备控制页。家人朋友进来最先看到这个。
export const PlayerView = {
  setup() {
    const devices = ref([]);
    const volume = ref(0);
    const speakText = ref("");
    const busy = ref("");
    let timer = 0;

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

    async function tick() {
      await refreshPlayback();
      if (typeof store.playback?.volume === "number") {
        volume.value = store.playback.volume;
      }
    }

    async function control(action, label) {
      busy.value = action;
      try {
        await api(`/playback/${action}`, { method: "POST" });
        await tick();
      } catch (error) {
        toast(error.message, "error");
      } finally {
        busy.value = "";
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
      tick();
      timer = setInterval(tick, 5000); // 轮询播放状态
    });
    onUnmounted(() => clearInterval(timer));

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

        h("section", { class: "controls card" }, [
          ctrlBtn("previous", "⏮", busy.value, () => control("previous")),
          pb.value.state === "playing"
            ? ctrlBtn("pause", "⏸", busy.value, () => control("pause"), true)
            : ctrlBtn("resume", "▶", busy.value, () => control("resume"), true),
          ctrlBtn("stop", "⏹", busy.value, () => control("stop")),
          ctrlBtn("next", "⏭", busy.value, () => control("next")),
        ]),

        h("section", { class: "card" }, [
          h("div", { class: "row-label" }, `音量 ${volume.value}`),
          h("input", {
            type: "range", min: 0, max: 100, value: volume.value,
            class: "slider",
            onInput: (e) => (volume.value = Number(e.target.value)),
            onChange: commitVolume,
          }),
        ]),

        h("section", { class: "card" }, [
          h("div", { class: "row-label" }, "播放设备"),
          devices.value.length === 0
            ? h("div", { class: "muted" }, "未发现设备，请先在设置里登录小米账号并刷新设备")
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

function ctrlBtn(key, icon, busy, onClick, primary = false) {
  return h("button", {
    key,
    class: ["ctrl-btn", { primary, busy: busy === key }],
    disabled: !!busy,
    onClick,
  }, icon);
}
