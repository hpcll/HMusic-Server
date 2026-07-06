import { ref, onMounted, h } from "vue";
import { api } from "/app/api.js";
import { refreshPlayback, toast } from "/app/main.js";

// 歌单页：列表 + 详情二级视图。家人朋友可保存喜欢的歌单并一键播放。
export const PlaylistsView = {
  setup() {
    const playlists = ref([]);
    const detail = ref(null); // 非空时显示详情
    const newName = ref("");
    const busy = ref(false);

    async function loadList() {
      try {
        const result = await api("/playlists");
        playlists.value = result.playlists || [];
      } catch (error) {
        toast(error.message, "error");
      }
    }

    async function openDetail(id) {
      try {
        // 单歌单接口的返回都包在 { playlist } 里。
        const result = await api(`/playlists/${id}`);
        detail.value = result.playlist;
      } catch (error) {
        toast(error.message, "error");
      }
    }

    function backToList() {
      detail.value = null;
      loadList();
    }

    async function createPlaylist() {
      const name = newName.value.trim();
      if (!name) return;
      busy.value = true;
      try {
        await api("/playlists", { method: "POST", body: { name } });
        newName.value = "";
        await loadList();
        toast("歌单已创建", "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        busy.value = false;
      }
    }

    async function deletePlaylist(id, event) {
      event.stopPropagation();
      try {
        await api(`/playlists/${id}`, { method: "DELETE" });
        await loadList();
        toast("歌单已删除", "success");
      } catch (error) {
        toast(error.message, "error");
      }
    }

    async function playPlaylist(id, startIndex = 0) {
      try {
        await api(`/playlists/${id}/play`, { method: "POST", body: { startIndex } });
        await refreshPlayback();
        toast("开始播放歌单", "success");
      } catch (error) {
        toast(error.message, "error");
      }
    }

    async function removeTrack(itemId) {
      try {
        const result = await api(
          `/playlists/${detail.value.id}/tracks/${itemId}`,
          { method: "DELETE" },
        );
        detail.value = result.playlist;
      } catch (error) {
        toast(error.message, "error");
      }
    }

    onMounted(loadList);

    return () => (detail.value ? renderDetail() : renderList());

    function renderList() {
      return h("main", { class: "view playlists-view" }, [
        h("h2", { class: "view-title" }, "歌单"),
        h("div", { class: "inline-form" }, [
          h("input", {
            placeholder: "新歌单名称…",
            value: newName.value,
            onInput: (e) => (newName.value = e.target.value),
            onKeyup: (e) => e.key === "Enter" && createPlaylist(),
          }),
          h("button", { class: "primary-btn", disabled: busy.value, onClick: createPlaylist }, "创建"),
        ]),
        playlists.value.length === 0
          ? h("div", { class: "muted center" }, "还没有歌单，创建一个吧")
          : h("div", { class: "playlist-grid" },
              playlists.value.map((p) =>
                h("div", { key: p.id, class: "playlist-card card", onClick: () => openDetail(p.id) }, [
                  h("div", { class: "pl-icon" }, "♫"),
                  h("div", { class: "pl-meta" }, [
                    h("div", { class: "pl-name" }, p.name),
                    h("div", { class: "muted" }, `${p.trackCount} 首`),
                  ]),
                  h("div", { class: "pl-actions" }, [
                    h("button", { class: "icon-btn", title: "播放",
                      onClick: (e) => { e.stopPropagation(); playPlaylist(p.id); } }, "▶"),
                    h("button", { class: "icon-btn", title: "删除",
                      onClick: (e) => deletePlaylist(p.id, e) }, "✕"),
                  ]),
                ]),
              ),
            ),
      ]);
    }

    function renderDetail() {
      const d = detail.value;
      const items = d.items || [];
      return h("main", { class: "view playlist-detail" }, [
        h("div", { class: "detail-head" }, [
          h("button", { class: "ghost-btn", onClick: backToList }, "‹ 返回"),
          h("button", { class: "secondary-btn", disabled: !items.length,
            onClick: () => playPlaylist(d.id) }, "▶ 播放全部"),
        ]),
        h("h2", { class: "view-title" }, d.name),
        d.description ? h("p", { class: "muted" }, d.description) : null,
        items.length === 0
          ? h("div", { class: "muted center" }, "歌单是空的，在搜索里加歌到队列或歌单")
          : h("ul", { class: "track-list" },
              items.map((it, i) =>
                h("li", { key: it.id, class: "track-row" }, [
                  h("div", { class: "queue-index" }, String(i + 1)),
                  h("div", { class: "track-info", style: { cursor: "pointer" },
                    onClick: () => playPlaylist(d.id, i) }, [
                    h("div", { class: "track-title" }, it.track.title),
                    h("div", { class: "track-artist" }, it.track.artist || "未知"),
                  ]),
                  h("div", { class: "track-actions" }, [
                    h("button", { class: "icon-btn", title: "从歌单移除",
                      onClick: () => removeTrack(it.id) }, "✕"),
                  ]),
                ]),
              ),
            ),
      ]);
    }
  },
};
