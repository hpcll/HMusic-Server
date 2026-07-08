import { ref, onMounted, h } from "vue";
import { api } from "/app/api.js";
import { Icons } from "/app/icons.js";
import { Modal } from "/app/components/modal.js";
import { refreshPlayback, toast, primeLocalAudio } from "/app/main.js";

// 歌单页：列表 + 详情二级视图。家人朋友可保存喜欢的歌单并一键播放。
export const PlaylistsView = {
  setup() {
    const playlists = ref([]);
    const detail = ref(null); // 非空时显示详情
    const newName = ref("");
    const busy = ref(false);
    const createOpen = ref(false); // 「创建歌单」弹窗

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
        createOpen.value = false;
        await loadList();
        toast("歌单已创建", "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        busy.value = false;
      }
    }

    function openCreate() {
      newName.value = "";
      createOpen.value = true;
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
      primeLocalAudio(); // 本机播放：手势内解锁 <audio>
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
        h("div", { class: "view-head" }, [
          h("h2", { class: "view-title" }, "歌单"),
          h("button", { class: "primary-btn", onClick: openCreate }, [
            Icons.plus(), "创建歌单",
          ]),
        ]),
        createOpen.value ? renderCreateModal() : null,
        playlists.value.length === 0
          ? h("div", { class: "muted center" }, "还没有歌单，创建一个吧")
          : h("div", { class: "playlist-grid" },
              playlists.value.map((p) =>
                h("div", { key: p.id, class: "playlist-card card", onClick: () => openDetail(p.id) }, [
                  h("div", { class: "pl-icon" }, Icons.playlists()),
                  h("div", { class: "pl-meta" }, [
                    h("div", { class: "pl-name" }, p.name),
                    h("div", { class: "muted" }, `${p.trackCount} 首`),
                  ]),
                  h("div", { class: "pl-actions" }, [
                    h("button", { class: "icon-btn", title: "播放",
                      onClick: (e) => { e.stopPropagation(); playPlaylist(p.id); } }, Icons.play()),
                    h("button", { class: "icon-btn", title: "删除",
                      onClick: (e) => deletePlaylist(p.id, e) }, Icons.close()),
                  ]),
                ]),
              ),
            ),
      ]);
    }

    function renderCreateModal() {
      return Modal(
        {
          title: "创建歌单",
          onClose: () => (createOpen.value = false),
          footer: [
            h("button", { class: "secondary-btn", onClick: () => (createOpen.value = false) }, "取消"),
            h("button", { class: "primary-btn", disabled: busy.value || !newName.value.trim(),
              onClick: createPlaylist }, "创建"),
          ],
        },
        [
          h("input", {
            class: "modal-input",
            placeholder: "新歌单名称…",
            value: newName.value,
            // autofocus 由浏览器在挂载时处理
            ref: (el) => el && el.focus?.(),
            onInput: (e) => (newName.value = e.target.value),
            onKeyup: (e) => e.key === "Enter" && createPlaylist(),
          }),
        ],
      );
    }

    function renderDetail() {
      const d = detail.value;
      const items = d.items || [];
      return h("main", { class: "view playlist-detail" }, [
        h("div", { class: "detail-head" }, [
          h("button", { class: "ghost-btn", onClick: backToList }, "‹ 返回"),
          h("button", { class: "secondary-btn", disabled: !items.length,
            onClick: () => playPlaylist(d.id) }, "播放全部"),
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
                      onClick: () => removeTrack(it.id) }, Icons.close()),
                  ]),
                ]),
              ),
            ),
      ]);
    }
  },
};
