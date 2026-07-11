import { ref, onMounted, h } from "vue";
import { api } from "/app/api.js";
import { Icons } from "/app/icons.js";
import { Modal } from "/app/components/modal.js";
import { refreshPlayback, toast, primeLocalAudio } from "/app/main.js";
import {
  openDownloadPicker,
  renderDownloadPicker,
  refreshDownloadedKeys,
  downloadedBadge,
} from "/app/download.js";

// 搜索歌曲并一键播放 / 加入队列 / 加入歌单。
// 搜索词和结果放模块级：切到别的页面再回来不丢（刷新页面才重置）。
const keyword = ref("");
const tracks = ref([]);
const searching = ref(false);
const searched = ref(false);

export const SearchView = {
  setup() {
    const actingId = ref("");

    // ── 加入歌单弹窗 ──
    const pickerTrack = ref(null); // 非空时展示歌单选择器
    const playlists = ref([]);
    const playlistsLoading = ref(false);
    const newName = ref("");
    const pickBusy = ref(false);

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
      // 本机播放：在点击手势里先解锁 <audio>，否则 syncLocalAudio 里
      // 那次 play() 会被浏览器自动播放策略拦截（点了停在 0:00）。
      primeLocalAudio();
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

    // 下载到服务器本地：弹窗选音质后提交；下载后这首歌播放走本地文件。
    function download(track) {
      openDownloadPicker(track);
    }

    onMounted(refreshDownloadedKeys);

    // ── 加入歌单 ──
    async function openPicker(track) {
      pickerTrack.value = track;
      newName.value = "";
      playlistsLoading.value = true;
      try {
        const result = await api("/playlists");
        playlists.value = result.playlists || [];
      } catch (error) {
        toast(error.message, "error");
        playlists.value = [];
      } finally {
        playlistsLoading.value = false;
      }
    }

    function closePicker() {
      pickerTrack.value = null;
    }

    async function addToPlaylist(playlistId) {
      if (pickBusy.value) return;
      pickBusy.value = true;
      try {
        await api(`/playlists/${playlistId}/tracks`, {
          method: "POST",
          body: { track: pickerTrack.value },
        });
        toast(`已加入歌单：${pickerTrack.value.title}`, "success");
        closePicker();
      } catch (error) {
        toast(error.message, "error");
      } finally {
        pickBusy.value = false;
      }
    }

    // 新建歌单并把当前歌曲加进去（快速通道）。
    async function createAndAdd() {
      const name = newName.value.trim();
      if (!name || pickBusy.value) return;
      pickBusy.value = true;
      try {
        const created = await api("/playlists", {
          method: "POST",
          body: { name },
        });
        const id = created.playlist?.id;
        await api(`/playlists/${id}/tracks`, {
          method: "POST",
          body: { track: pickerTrack.value },
        });
        toast(`已创建「${name}」并加入歌曲`, "success");
        closePicker();
      } catch (error) {
        toast(error.message, "error");
      } finally {
        pickBusy.value = false;
      }
    }

    function renderPicker() {
      return Modal(
        {
          title: "加入歌单",
          onClose: closePicker,
        },
        [
          h("div", { class: "picker-song muted" },
            `${pickerTrack.value.title} · ${pickerTrack.value.artist || "未知"}`),
          h("div", { class: "picker-create" }, [
            h("input", {
              class: "modal-input",
              placeholder: "新建歌单…",
              value: newName.value,
              onInput: (e) => (newName.value = e.target.value),
              onKeyup: (e) => e.key === "Enter" && createAndAdd(),
            }),
            h("button", {
              class: "primary-btn", disabled: pickBusy.value || !newName.value.trim(),
              onClick: createAndAdd,
            }, [Icons.plus(), "新建"]),
          ]),
          playlistsLoading.value
            ? h("div", { class: "muted center" }, "加载中…")
            : playlists.value.length === 0
              ? h("div", { class: "muted center" }, "还没有歌单，上面新建一个吧")
              : h("ul", { class: "picker-list" },
                  playlists.value.map((p) =>
                    h("li", {
                      key: p.id, class: "picker-item",
                      onClick: () => addToPlaylist(p.id),
                    }, [
                      h("span", { class: "pl-icon" }, Icons.playlists()),
                      h("span", { class: "picker-name" }, p.name),
                      h("span", { class: "muted" }, `${p.trackCount} 首`),
                    ]),
                  ),
                ),
        ],
      );
    }

    return () =>
      h("main", { class: "view search-view" }, [
        h("h2", { class: "view-title" }, "搜索"),
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
                      h("div", { class: "track-title" }, [t.title, downloadedBadge(t)]),
                      h("div", { class: "track-artist" }, `${t.artist || "未知"}${t.album ? " · " + t.album : ""}`),
                    ]),
                    h("div", { class: "track-actions" }, [
                      h("button", {
                        class: "icon-btn", disabled: actingId.value === t.id,
                        title: "播放", onClick: () => play(t),
                      }, Icons.play()),
                      h("button", {
                        class: "icon-btn", disabled: actingId.value === t.id,
                        title: "加入队列", onClick: () => enqueue(t),
                      }, Icons.plus()),
                      h("button", {
                        class: "icon-btn",
                        title: "加入歌单", onClick: () => openPicker(t),
                      }, Icons.playlists()),
                      h("button", {
                        class: "icon-btn", disabled: actingId.value === t.id,
                        title: "下载到服务器", onClick: () => download(t),
                      }, Icons.download()),
                    ]),
                  ]),
                ),
              ),
        pickerTrack.value ? renderPicker() : null,
        renderDownloadPicker(),
      ]);
  },
};
