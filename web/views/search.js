import { ref, onMounted, h } from "vue";
import { api } from "/app/api.js";
import { Icons } from "/app/icons.js";
import { EmptyState, LoadingState } from "/app/components/feedback.js";
import { openPlaylistPicker } from "/app/components/playlist-picker.js";
import { refreshPlayback, toast, primeLocalAudio } from "/app/main.js";
import {
  openDownloadPicker,
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
          ? LoadingState({ label: "搜索中…" })
          : tracks.value.length === 0
            ? EmptyState(searched.value
                ? { icon: Icons.search, title: "没有找到结果", hint: "换个关键词试试" }
                : { icon: Icons.search, title: "输入关键词开始搜索" })
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
                        title: "加入歌单", onClick: () => openPlaylistPicker(t),
                      }, Icons.playlists()),
                      h("button", {
                        class: "icon-btn", disabled: actingId.value === t.id,
                        title: "下载到服务器", onClick: () => download(t),
                      }, Icons.download()),
                    ]),
                  ]),
                ),
              ),
      ]);
  },
};
