import { ref, watch, onMounted, h } from "vue";
import { api } from "/app/api.js";
import { Icons } from "/app/icons.js";
import { Modal } from "/app/components/modal.js";
import { EmptyState, ErrorState, LoadingState } from "/app/components/feedback.js";
import { openConfirm } from "/app/components/confirm.js";
import { router, go, refreshPlayback, toast, primeLocalAudio } from "/app/main.js";
import {
  openDownloadPicker,
  refreshDownloadedKeys,
  downloadedBadge,
  downloadedList,
} from "/app/download.js";

// 歌单页：列表 + 详情二级视图。家人朋友可保存喜欢的歌单并一键播放。
export const PlaylistsView = {
  setup() {
    const playlists = ref([]);
    const detail = ref(null); // 当前路由对应的歌单详情数据
    const detailLoading = ref(false);
    const detailError = ref("");
    const newName = ref("");
    const busy = ref(false);
    const createOpen = ref(false); // 「创建歌单」弹窗
    const importOpen = ref(false); // 「导入歌单」弹窗
    const importUrl = ref(""); // 粘贴的分享链接
    const importing = ref(false);
    const loading = ref(true);
    const loadError = ref("");

    async function loadList() {
      loading.value = true;
      loadError.value = "";
      try {
        const result = await api("/playlists");
        playlists.value = result.playlists || [];
      } catch (error) {
        loadError.value = error.message || "加载失败";
      } finally {
        loading.value = false;
      }
    }

    async function loadDetail(id) {
      detail.value = null;
      detailLoading.value = true;
      detailError.value = "";
      try {
        // 单歌单接口的返回都包在 { playlist } 里。
        const result = await api(`/playlists/${id}`);
        if (router.name === "playlists" && router.params.id === id) {
          detail.value = result.playlist;
        }
      } catch (error) {
        if (router.name === "playlists" && router.params.id === id) {
          detailError.value = error.message || "加载失败";
        }
      } finally {
        if (router.name === "playlists" && router.params.id === id) {
          detailLoading.value = false;
        }
      }
    }

    function backToList() {
      go("playlists");
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

    function openImport() {
      importUrl.value = "";
      importOpen.value = true;
    }

    // 导入歌单：粘贴 QQ音乐/酷我/网易云 分享链接，服务端抓取后落库。
    async function importPlaylist() {
      const url = importUrl.value.trim();
      if (!url) return;
      importing.value = true;
      try {
        const result = await api("/playlists/import", {
          method: "POST",
          body: { url },
        });
        importUrl.value = "";
        importOpen.value = false;
        await loadList();
        const parts = [`《${result.playlist.name}》已导入 ${result.imported} 首`];
        const skip = result.skipped || {};
        const skipTotal =
          (skip.duplicate || 0) + (skip.emptyTitle || 0) + (skip.truncated || 0);
        if (skipTotal > 0) {
          const detailParts = [];
          if (skip.duplicate) detailParts.push(`去重 ${skip.duplicate}`);
          if (skip.truncated) detailParts.push(`超上限截断 ${skip.truncated}`);
          if (skip.emptyTitle) detailParts.push(`无效 ${skip.emptyTitle}`);
          parts.push(`（跳过 ${detailParts.join("、")}）`);
        }
        toast(parts.join(""), "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        importing.value = false;
      }
    }

    async function deletePlaylist(playlist, event) {
      event.stopPropagation();
      const confirmed = await openConfirm({
        title: "删除歌单",
        message: `「${playlist.name}」及其收录记录将被删除，无法恢复。`,
        confirmText: "删除",
        danger: true,
      });
      if (!confirmed) return;
      try {
        await api(`/playlists/${playlist.id}`, { method: "DELETE" });
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

    // 播放已下载：整批灌队列（本地文件秒开），可从第 N 首开始。
    async function playDownloads(startIndex = 0) {
      const items = downloadedList.value;
      if (!items.length) return;
      primeLocalAudio();
      try {
        const tracks = items.map((d) => d.track);
        await api("/queue", {
          method: "PUT",
          body: { tracks, currentIndex: startIndex },
        });
        await api("/playback/play", {
          method: "POST",
          body: { track: tracks[startIndex], queueIndex: startIndex },
        });
        await refreshPlayback();
        toast("开始播放已下载音乐", "success");
      } catch (error) {
        toast(error.message, "error");
      }
    }

    // 列表加载交给下方 immediate watch（无 id 分支），这里只补下载角标。
    onMounted(refreshDownloadedKeys);

    watch(
      () => [router.name, router.params.id],
      ([name, id]) => {
        if (name !== "playlists") return;
        if (id) {
          loadDetail(id);
        } else {
          detail.value = null;
          detailLoading.value = false;
          detailError.value = "";
          // 回到列表态就刷新列表——浏览器返回键与页内返回按钮同等对待，
          // 详情里的增删不会在返回后留下过时的「N 首」计数。
          loadList();
        }
      },
      { immediate: true },
    );

    return () =>
      router.params.id
        ? renderDetail()
        : router.params.view === "downloads"
          ? renderDownloads()
          : renderList();

    function renderList() {
      return h("main", { class: "view playlists-view" }, [
        h("div", { class: "view-head" }, [
          h("h2", { class: "view-title" }, "歌单"),
          h("div", { class: "head-actions" }, [
            h("button", { class: "secondary-btn", onClick: openImport }, [
              Icons.plus(), "导入歌单",
            ]),
            h("button", { class: "primary-btn", onClick: openCreate }, [
              Icons.plus(), "创建歌单",
            ]),
          ]),
        ]),
        createOpen.value ? renderCreateModal() : null,
        importOpen.value ? renderImportModal() : null,
        // 「已下载」「曲库」系统视图入口卡（非歌单——不可删、不占命名空间）。
        // 曲库卡兼作移动端唯一入口：底栏 6 tab 已满，对齐「已下载」的系统卡模式。
        h("div", { class: "playlist-grid" }, [
          h("div", {
            class: "playlist-card card",
            onClick: () => go("playlists", { view: "downloads" }),
          }, [
            h("div", { class: "pl-icon" }, Icons.download()),
            h("div", { class: "pl-meta" }, [
              h("div", { class: "pl-name" }, "已下载"),
              h("div", { class: "muted" }, `${downloadedList.value.length} 首 · 本地`),
            ]),
            h("div", { class: "pl-actions" }, [
              h("button", {
                class: "icon-btn", title: "播放全部",
                onClick: (e) => { e.stopPropagation(); playDownloads(); },
              }, Icons.play()),
            ]),
          ]),
          h("div", {
            class: "playlist-card card",
            onClick: () => go("library"),
          }, [
            h("div", { class: "pl-icon" }, Icons.library()),
            h("div", { class: "pl-meta" }, [
              h("div", { class: "pl-name" }, "曲库"),
              h("div", { class: "muted" }, "NAS 与本地音乐"),
            ]),
          ]),
        ]),
        loadError.value
          ? ErrorState({ message: loadError.value, onRetry: loadList })
          : loading.value
            ? LoadingState()
            : playlists.value.length === 0
              ? EmptyState({
                  icon: Icons.playlists,
                  title: "还没有歌单",
                  hint: "创建一个，或粘贴分享链接导入",
                })
              : h("div", { class: "playlist-grid" },
              playlists.value.map((p) =>
                h("div", { key: p.id, class: "playlist-card card",
                  onClick: () => go("playlists", { id: p.id }) }, [
                  h("div", { class: "pl-icon" }, Icons.playlists()),
                  h("div", { class: "pl-meta" }, [
                    h("div", { class: "pl-name" }, p.name),
                    h("div", { class: "muted" }, `${p.trackCount} 首`),
                  ]),
                  h("div", { class: "pl-actions" }, [
                    h("button", { class: "icon-btn", title: "播放",
                      onClick: (e) => { e.stopPropagation(); playPlaylist(p.id); } }, Icons.play()),
                    h("button", { class: "icon-btn", title: "删除",
                      onClick: (e) => deletePlaylist(p, e) }, Icons.close()),
                  ]),
                ]),
              ),
            ),
      ]);
    }

    function renderCreateModal() {
      return h(Modal, {
        title: "创建歌单",
        onClose: () => (createOpen.value = false),
        footer: [
          h("button", { class: "secondary-btn", onClick: () => (createOpen.value = false) }, "取消"),
          h("button", { class: "primary-btn", disabled: busy.value || !newName.value.trim(),
            onClick: createPlaylist }, "创建"),
        ],
      }, () => [
          h("input", {
            class: "modal-input",
            placeholder: "新歌单名称…",
            value: newName.value,
            onInput: (e) => (newName.value = e.target.value),
            onKeyup: (e) => e.key === "Enter" && createPlaylist(),
          }),
      ]);
    }

    function renderImportModal() {
      return h(Modal, {
        title: "导入歌单",
        onClose: () => (importOpen.value = false),
        footer: [
          h("button", { class: "secondary-btn", disabled: importing.value,
            onClick: () => (importOpen.value = false) }, "取消"),
          h("button", { class: "primary-btn", disabled: importing.value || !importUrl.value.trim(),
            onClick: importPlaylist }, importing.value ? "导入中…" : "开始导入"),
        ],
      }, () => [
          h("p", { class: "muted", style: { marginTop: "0" } },
            "粘贴 QQ音乐 / 酷我 / 网易云 的歌单分享链接，最多导入 500 首。"),
          h("textarea", {
            class: "modal-input",
            rows: 3,
            placeholder: "粘贴歌单链接或整段分享文案…",
            value: importUrl.value,
            onInput: (e) => (importUrl.value = e.target.value),
          }),
      ]);
    }

    function renderDetail() {
      const d = detail.value;
      const items = d?.items || [];
      return h("main", { class: "view playlist-detail" }, [
        h("div", { class: "detail-head" }, [
          h("button", { class: "secondary-btn", onClick: backToList }, "‹ 返回"),
          d
            ? h("button", { class: "secondary-btn", disabled: !items.length,
                onClick: () => playPlaylist(d.id) }, "播放全部")
            : null,
        ]),
        detailError.value
          ? ErrorState({
              message: detailError.value,
              onRetry: () => loadDetail(router.params.id),
            })
          : detailLoading.value
            ? LoadingState({ label: "歌单加载中…" })
            : d
              ? [
                  h("h2", { class: "view-title" }, d.name),
                  d.description ? h("p", { class: "muted" }, d.description) : null,
                  items.length === 0
                    ? EmptyState({
                        icon: Icons.note,
                        title: "歌单是空的",
                        hint: "在搜索里把歌加进歌单",
                      })
                    : h("ul", { class: "track-list track-cols" },
                        items.map((it, i) =>
                          h("li", { key: it.id, class: "track-row" }, [
                            h("div", { class: "queue-index" }, String(i + 1)),
                            h("div", { class: "track-info", style: { cursor: "pointer" },
                              onClick: () => playPlaylist(d.id, i) }, [
                              h("div", { class: "track-title" }, [
                                it.track.title,
                                downloadedBadge(it.track),
                              ]),
                              h("div", { class: "track-artist" }, it.track.artist || "未知"),
                            ]),
                            h("div", { class: "track-actions" }, [
                              h("button", { class: "icon-btn", title: "下载到服务器",
                                onClick: () => openDownloadPicker(it.track) }, Icons.download()),
                              h("button", { class: "icon-btn", title: "从歌单移除",
                                onClick: () => removeTrack(it.id) }, Icons.close()),
                            ]),
                          ]),
                        ),
                      ),
                ]
              : null,
      ]);
    }

    // 「已下载」系统视图：本地缓存的歌，点行即整批灌队列从该首播（本地文件秒开）。
    function renderDownloads() {
      const items = downloadedList.value;
      return h("main", { class: "view playlist-detail" }, [
        h("div", { class: "detail-head" }, [
          h("button", { class: "secondary-btn", onClick: backToList }, "‹ 返回"),
          h("button", { class: "secondary-btn", disabled: !items.length,
            onClick: () => playDownloads() }, "播放全部"),
        ]),
        h("h2", { class: "view-title" }, "已下载"),
        h("p", { class: "muted" }, "本地缓存的音乐，播放不依赖网络音源、永不过期"),
        items.length === 0
          ? EmptyState({
              icon: Icons.download,
              title: "还没有下载的音乐",
              hint: "在搜索/歌单/榜单里点下载图标",
            })
          : h("ul", { class: "track-list track-cols" },
              items.map((d, i) =>
                h("li", { key: d.id, class: "track-row" }, [
                  h("div", { class: "queue-index" }, String(i + 1)),
                  h("div", { class: "track-info", style: { cursor: "pointer" },
                    onClick: () => playDownloads(i) }, [
                    h("div", { class: "track-title" }, d.title),
                    h("div", { class: "track-artist" },
                      `${d.artist || "未知"}${d.quality ? " · " + d.quality : ""}`),
                  ]),
                ]),
              ),
            ),
      ]);
    }
  },
};
