import { ref, onMounted, h } from "vue";
import { api } from "/app/api.js";
import { refreshPlayback, toast } from "/app/main.js";

const PLAY_MODES = [
  { value: "list_loop", label: "列表循环" },
  { value: "single_loop", label: "单曲循环" },
  { value: "shuffle", label: "随机" },
  { value: "sequence", label: "顺序" },
];

// 播放队列：查看、点播、删单曲、切模式、清空。
export const QueueView = {
  setup() {
    const queue = ref(null);
    const busy = ref(false);

    async function load() {
      try {
        queue.value = await api("/queue");
      } catch (error) {
        toast(error.message, "error");
      }
    }

    async function playAt(index) {
      busy.value = true;
      try {
        // 跳到该曲后触发播放（后端 setCurrentQueueIndex 只改指针，需再 play 当前曲）。
        await api("/queue/current", { method: "POST", body: { index } });
        const track = queue.value.items[index]?.track;
        if (track) {
          await api("/playback/play", { method: "POST", body: { track, queueIndex: index } });
          await refreshPlayback();
        }
        await load();
      } catch (error) {
        toast(error.message, "error");
      } finally {
        busy.value = false;
      }
    }

    async function removeAt(index) {
      // 无单曲删除接口，用 PUT 整体替换为「去掉该曲后的列表」。
      const remaining = queue.value.items
        .filter((_, i) => i !== index)
        .map((it) => it.track);
      const curr = queue.value.currentIndex;
      const nextCurrent = index < curr ? curr - 1 : curr >= remaining.length ? remaining.length - 1 : curr;
      try {
        queue.value = await api("/queue", {
          method: "PUT",
          body: {
            tracks: remaining,
            currentIndex: Math.max(0, nextCurrent),
            playMode: queue.value.playMode,
          },
        });
      } catch (error) {
        toast(error.message, "error");
      }
    }

    async function changeMode(mode) {
      try {
        queue.value = await api("/queue/mode", { method: "POST", body: { playMode: mode } });
      } catch (error) {
        toast(error.message, "error");
      }
    }

    async function clear() {
      try {
        queue.value = await api("/queue/clear", { method: "POST" });
        toast("队列已清空", "success");
      } catch (error) {
        toast(error.message, "error");
      }
    }

    onMounted(load);

    return () => {
      const q = queue.value;
      const items = q?.items || [];
      return h("main", { class: "view queue-view" }, [
        h("div", { class: "queue-head" }, [
          h("h2", { class: "view-title" }, `播放队列 (${items.length})`),
          items.length
            ? h("button", { class: "ghost-btn", onClick: clear }, "清空")
            : null,
        ]),

        h("div", { class: "mode-tabs" },
          PLAY_MODES.map((m) =>
            h("button", {
              key: m.value,
              class: ["mode-tab", { active: q?.playMode === m.value }],
              onClick: () => changeMode(m.value),
            }, m.label),
          ),
        ),

        items.length === 0
          ? h("div", { class: "muted center" }, "队列是空的，去搜索里加几首歌吧")
          : h("ul", { class: "track-list" },
              items.map((it, i) =>
                h("li", {
                  key: it.id,
                  class: ["track-row", { "queue-current": i === q.currentIndex }],
                }, [
                  h("div", { class: "queue-index" }, i === q.currentIndex ? "♪" : String(i + 1)),
                  h("div", {
                    class: "track-info", style: { cursor: "pointer" },
                    onClick: () => playAt(i),
                  }, [
                    h("div", { class: "track-title" }, it.track.title),
                    h("div", { class: "track-artist" }, it.track.artist || "未知"),
                  ]),
                  h("div", { class: "track-actions" }, [
                    h("button", {
                      class: "icon-btn", disabled: busy.value,
                      title: "播放", onClick: () => playAt(i),
                    }, "▶"),
                    h("button", {
                      class: "icon-btn", title: "移除", onClick: () => removeAt(i),
                    }, "✕"),
                  ]),
                ]),
              ),
            ),
      ]);
    };
  },
};
