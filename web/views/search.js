import { ref, h } from "vue";
import { api } from "/app/api.js";
import { refreshPlayback, toast } from "/app/main.js";

// 搜索歌曲并一键播放 / 加入队列。
export const SearchView = {
  setup() {
    const keyword = ref("");
    const tracks = ref([]);
    const searching = ref(false);
    const searched = ref(false);
    const actingId = ref("");

    async function doSearch() {
      const q = keyword.value.trim();
      if (!q) return;
      searching.value = true;
      searched.value = true;
      try {
        const result = await api(`/search?q=${encodeURIComponent(q)}`);
        tracks.value = result.tracks || [];
      } catch (error) {
        toast(error.message, "error");
        tracks.value = [];
      } finally {
        searching.value = false;
      }
    }

    async function play(track) {
      actingId.value = track.id;
      try {
        await api("/playback/play", { method: "POST", body: { track } });
        await refreshPlayback();
        toast(`正在播放：${track.title}`, "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        actingId.value = "";
      }
    }

    async function enqueue(track) {
      actingId.value = track.id;
      try {
        await api("/queue/items", { method: "POST", body: { track } });
        toast(`已加入队列：${track.title}`, "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        actingId.value = "";
      }
    }

    return () =>
      h("main", { class: "view search-view" }, [
        h("div", { class: "search-bar" }, [
          h("input", {
            class: "search-input",
            placeholder: "搜索歌曲、歌手…",
            value: keyword.value,
            onInput: (e) => (keyword.value = e.target.value),
            onKeyup: (e) => e.key === "Enter" && doSearch(),
          }),
          h("button", { class: "primary-btn", onClick: doSearch }, "搜索"),
        ]),

        searching.value
          ? h("div", { class: "muted center" }, "搜索中…")
          : tracks.value.length === 0
            ? h("div", { class: "muted center" },
                searched.value ? "没有找到结果" : "输入关键词开始搜索")
            : h("ul", { class: "track-list" },
                tracks.value.map((t) =>
                  h("li", { key: t.id, class: "track-row" }, [
                    h("div", { class: "track-cover", style: t.coverUrl ? { backgroundImage: `url(${t.coverUrl})` } : {} },
                      t.coverUrl ? [] : "♪"),
                    h("div", { class: "track-info" }, [
                      h("div", { class: "track-title" }, t.title),
                      h("div", { class: "track-artist" }, `${t.artist || "未知"}${t.album ? " · " + t.album : ""}`),
                    ]),
                    h("div", { class: "track-actions" }, [
                      h("button", {
                        class: "icon-btn", disabled: actingId.value === t.id,
                        title: "播放", onClick: () => play(t),
                      }, "▶"),
                      h("button", {
                        class: "icon-btn", disabled: actingId.value === t.id,
                        title: "加入队列", onClick: () => enqueue(t),
                      }, "＋"),
                    ]),
                  ]),
                ),
              ),
      ]);
  },
};
