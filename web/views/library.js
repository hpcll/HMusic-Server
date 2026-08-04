import { ref, watch, onMounted, onUnmounted, h } from "vue";
import { api } from "/app/api.js";
import { Icons } from "/app/icons.js";
import { router, go, refreshPlayback, toast, primeLocalAudio } from "/app/main.js";
import { EmptyState, LoadingState, ErrorState } from "/app/components/feedback.js";
import { openConfirm } from "/app/components/confirm.js";
import { openPlaylistPicker } from "/app/components/playlist-picker.js";

// 曲库页：NAS/本地音乐。全部/歌手/专辑/文件夹四种视图由 URL 驱动：
//   #/library                → 全部曲目（可搜索）
//   #/library?by=artist      → 分组列表（专辑/文件夹同理）
//   #/library?artist=X       → 该分组下的曲目（folder 允许空串 = 根目录直属）
// 条目自带 track，播放/加队列/加歌单直接走既有播放管线。
const PAGE_SIZE = 50;
const PLAY_ALL_PAGE = 200; // 播放全部的分页拉取步长
const PLAY_ALL_CAP = 500; // 与歌单导入同上限，防整库万曲灌队列

const GROUP_DIMS = [
  { by: "artist", label: "歌手", emptyName: "未知歌手" },
  { by: "album", label: "专辑", emptyName: "未知专辑" },
  { by: "folder", label: "文件夹", emptyName: "（根目录）" },
];

export const LibraryView = {
  setup() {
    const items = ref([]);
    const total = ref(0);
    const groups = ref([]);
    const loading = ref(true);
    const loadError = ref("");
    const loadingMore = ref(false);
    const search = ref(""); // 搜索词不入 URL：即输即弃的过滤，深链价值低
    const scan = ref(null);
    const scrape = ref(null);
    const busy = ref(""); // upload | scan | scrape | playall
    const actingId = ref("");
    let pollTimer = 0;
    let loadSeq = 0; // 竞态守卫：只认最后一次发起的加载

    // ── 路由派生：当前视图 ──
    function routeFilter() {
      const p = router.params;
      // folder 允许空串，用 in 判断而非真值
      if ("artist" in p) return { key: "artist", value: p.artist };
      if ("album" in p) return { key: "album", value: p.album };
      if ("folder" in p) return { key: "folder", value: p.folder };
      return null;
    }

    function routeDim() {
      return GROUP_DIMS.find((d) => d.by === router.params.by) || null;
    }

    // ── 数据加载 ──
    async function loadTracks({ append = false } = {}) {
      const seq = ++loadSeq;
      if (!append) {
        loading.value = true;
        loadError.value = "";
      } else {
        loadingMore.value = true;
      }
      try {
        const params = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(append ? items.value.length : 0),
        });
        const q = search.value.trim();
        if (q) params.set("search", q);
        const filter = routeFilter();
        if (filter) params.set(filter.key, filter.value);
        const result = await api(`/library?${params}`);
        if (seq !== loadSeq) return; // 已被更新的请求取代
        items.value = append ? [...items.value, ...(result.items || [])] : result.items || [];
        total.value = result.total || 0;
        scan.value = result.scan || null;
        scrape.value = result.scrape || null;
        schedulePoll();
      } catch (error) {
        if (seq !== loadSeq) return;
        if (append) toast(error.message, "error");
        else loadError.value = error.message || "加载失败";
      } finally {
        if (seq === loadSeq) {
          loading.value = false;
          loadingMore.value = false;
        }
      }
    }

    async function loadGroups(by) {
      const seq = ++loadSeq;
      loading.value = true;
      loadError.value = "";
      try {
        const result = await api(`/library/groups?by=${encodeURIComponent(by)}`);
        if (seq !== loadSeq) return;
        groups.value = result.groups || [];
      } catch (error) {
        if (seq !== loadSeq) return;
        loadError.value = error.message || "加载失败";
      } finally {
        if (seq === loadSeq) loading.value = false;
      }
    }

    function reload() {
      const dim = routeDim();
      if (dim && !routeFilter()) loadGroups(dim.by);
      else loadTracks();
    }

    // 扫描/刮削进行中每 3s 轮询刷新（无任务即停，页面卸载清理）。
    function schedulePoll() {
      clearTimeout(pollTimer);
      const running =
        scan.value?.status === "scanning" || scrape.value?.status === "running";
      if (running) pollTimer = setTimeout(() => loadTracks(), 3000);
    }

    watch(
      () => [router.name, router.params.by, router.params.artist, router.params.album, router.params.folder],
      ([name]) => {
        if (name !== "library") return;
        search.value = "";
        reload();
      },
      { immediate: true },
    );

    onMounted(() => {});
    onUnmounted(() => clearTimeout(pollTimer));

    // ── 页头操作 ──
    async function onPickUpload(event) {
      const file = event.target.files?.[0];
      event.target.value = ""; // 允许重复选同一文件
      if (!file) return;
      busy.value = "upload";
      try {
        const form = new FormData();
        form.append("file", file);
        const result = await api("/library/upload", { method: "POST", body: form });
        toast(`已入库：${result.item?.title || file.name}`, "success");
        reload();
      } catch (error) {
        toast(error.message, "error");
      } finally {
        busy.value = "";
      }
    }

    async function startScan() {
      busy.value = "scan";
      try {
        const result = await api("/library/scan", { method: "POST" });
        scan.value = result.scan;
        schedulePoll();
      } catch (error) {
        toast(error.message, "error");
      } finally {
        busy.value = "";
      }
    }

    async function startScrape() {
      busy.value = "scrape";
      try {
        const result = await api("/library/scrape", { method: "POST" });
        scrape.value = result.scrape;
        schedulePoll();
      } catch (error) {
        toast(error.message, "error");
      } finally {
        busy.value = "";
      }
    }

    // ── 曲目操作 ──
    async function play(item) {
      actingId.value = item.id;
      primeLocalAudio(); // 本机播放：手势内解锁 <audio>
      try {
        await api("/playback/play", { method: "POST", body: { track: item.track } });
        await refreshPlayback();
        toast(`正在播放：${item.title}`, "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        actingId.value = "";
      }
    }

    async function enqueue(item) {
      actingId.value = item.id;
      try {
        await api("/queue/items", { method: "POST", body: { track: item.track } });
        toast(`已加入队列：${item.title}`, "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        actingId.value = "";
      }
    }

    async function removeItem(item) {
      // 删除语义随来源不同：scan 只移出曲库（存量目录只读承诺），上传的才真删文件。
      const isScan = item.origin === "scan";
      const confirmed = await openConfirm(
        isScan
          ? {
              title: "从曲库移除",
              message: `「${item.title}」仅从曲库列表移除，不会删除 NAS 上的原文件（目录仍在配置中时，下次扫描会重新收录）。`,
              confirmText: "移除",
              danger: true,
            }
          : {
              title: "删除文件",
              message: `「${item.title}」的音频文件将从服务器磁盘删除，无法恢复。`,
              confirmText: "删除",
              danger: true,
            },
      );
      if (!confirmed) return;
      try {
        await api(`/library/${encodeURIComponent(item.id)}`, { method: "DELETE" });
        items.value = items.value.filter((it) => it.id !== item.id);
        total.value = Math.max(0, total.value - 1);
        toast(isScan ? "已从曲库移除" : "文件已删除", "success");
      } catch (error) {
        toast(error.message, "error");
      }
    }

    // 播放全部（当前筛选）：分页拉全 → 整批灌队列从头播。
    async function playAll() {
      if (busy.value) return;
      busy.value = "playall";
      primeLocalAudio();
      try {
        const tracks = [];
        while (tracks.length < Math.min(total.value, PLAY_ALL_CAP)) {
          const params = new URLSearchParams({
            limit: String(PLAY_ALL_PAGE),
            offset: String(tracks.length),
          });
          const filter = routeFilter();
          if (filter) params.set(filter.key, filter.value);
          const q = search.value.trim();
          if (q) params.set("search", q);
          const result = await api(`/library?${params}`);
          const batch = (result.items || []).map((it) => it.track);
          if (!batch.length) break;
          tracks.push(...batch);
        }
        if (!tracks.length) return;
        const capped = tracks.slice(0, PLAY_ALL_CAP);
        if (total.value > PLAY_ALL_CAP) {
          toast(`曲目较多，本次播放前 ${PLAY_ALL_CAP} 首`, "info");
        }
        await api("/queue", { method: "PUT", body: { tracks: capped, currentIndex: 0 } });
        await api("/playback/play", {
          method: "POST",
          body: { track: capped[0], queueIndex: 0 },
        });
        await refreshPlayback();
        toast("开始播放", "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        busy.value = "";
      }
    }

    // ── 渲染 ──
    function headActions() {
      return h("div", { class: "head-actions" }, [
        h("label", { class: "secondary-btn upload-btn" }, [
          h("input", {
            type: "file",
            accept: "audio/*",
            style: { display: "none" },
            disabled: busy.value === "upload",
            onChange: onPickUpload,
          }),
          busy.value === "upload" ? "上传中…" : "上传",
        ]),
        h("button", {
          class: "secondary-btn",
          disabled: busy.value === "scan" || scan.value?.status === "scanning",
          onClick: startScan,
        }, scan.value?.status === "scanning" ? "扫描中…" : "扫描"),
        h("button", {
          class: "secondary-btn",
          disabled: busy.value === "scrape" || scrape.value?.status === "running",
          onClick: startScrape,
        }, scrape.value?.status === "running" ? "刮削中…" : "补刮"),
      ]);
    }

    function statusBar() {
      if (scan.value?.status === "failed") {
        return h("div", { class: "notice-bar error" }, [
          h("span", null, `扫描失败：${scan.value.error || "未知错误"}`),
          h("button", { class: "ghost-btn", onClick: startScan }, "重试 ›"),
        ]);
      }
      if (scan.value?.status === "scanning") {
        return h("div", { class: "notice-bar" }, [
          h("span", null, "正在扫描曲库，新曲目会陆续出现…"),
        ]);
      }
      if (scrape.value?.status === "running") {
        const s = scrape.value;
        return h("div", { class: "notice-bar" }, [
          h("span", null, `正在补全封面歌词…（${s.filled}/${s.total}）`),
        ]);
      }
      return null;
    }

    function dimTabs() {
      return h("div", { class: "mode-tabs" }, [
        h("button", {
          class: ["mode-tab", { active: !routeDim() }],
          onClick: () => go("library"),
        }, "全部"),
        ...GROUP_DIMS.map((d) =>
          h("button", {
            key: d.by,
            class: ["mode-tab", { active: routeDim()?.by === d.by }],
            onClick: () => go("library", { by: d.by }),
          }, d.label),
        ),
      ]);
    }

    function trackRow(item) {
      return h("li", { key: item.id, class: "track-row" }, [
        h("div", {
          class: "track-cover",
          style: item.track?.coverUrl
            ? { backgroundImage: `url(${item.track.coverUrl})` }
            : {},
        }, item.track?.coverUrl ? [] : "♪"),
        h("div", {
          class: "track-info",
          style: { cursor: "pointer" },
          onClick: () => play(item),
        }, [
          h("div", { class: "track-title" }, item.title),
          h("div", { class: "track-artist" },
            `${item.artist || "未知"}${item.album ? " · " + item.album : ""}`),
        ]),
        h("div", { class: "track-actions" }, [
          h("button", {
            class: "icon-btn", disabled: actingId.value === item.id,
            title: "播放", onClick: () => play(item),
          }, Icons.play()),
          h("button", {
            class: "icon-btn", disabled: actingId.value === item.id,
            title: "加入队列", onClick: () => enqueue(item),
          }, Icons.plus()),
          h("button", {
            class: "icon-btn",
            title: "加入歌单", onClick: () => openPlaylistPicker(item.track),
          }, Icons.playlists()),
          h("button", {
            class: "icon-btn",
            title: item.origin === "scan" ? "从曲库移除" : "删除文件",
            onClick: () => removeItem(item),
          }, Icons.close()),
        ]),
      ]);
    }

    function trackList({ withSearch }) {
      return [
        withSearch
          ? h("div", { class: "search-bar" }, [
              h("input", {
                class: "search-input",
                placeholder: "在曲库中搜索…",
                value: search.value,
                onInput: (e) => (search.value = e.target.value),
                onKeyup: (e) => e.key === "Enter" && loadTracks(),
              }),
              h("button", { class: "secondary-btn", onClick: () => loadTracks() }, "搜索"),
            ])
          : null,
        loadError.value
          ? ErrorState({ message: loadError.value, onRetry: () => loadTracks() })
          : loading.value
            ? LoadingState()
            : items.value.length === 0
              ? EmptyState({
                  icon: Icons.library,
                  title: search.value.trim() ? "没有匹配的曲目" : "曲库是空的",
                  hint: search.value.trim()
                    ? "换个关键词试试"
                    : "上传音乐，或在 设置 → 运行配置 里添加 NAS 目录后扫描",
                })
              : h("ul", { class: "track-list track-cols" }, items.value.map(trackRow)),
        !loading.value && !loadError.value && items.value.length < total.value
          ? h("div", { class: "load-more" }, [
              h("button", {
                class: "secondary-btn",
                disabled: loadingMore.value,
                onClick: () => loadTracks({ append: true }),
              }, loadingMore.value ? "加载中…" : `加载更多（${items.value.length}/${total.value}）`),
            ])
          : null,
      ];
    }

    // 全部曲目 / 维度分组列表
    function renderRoot() {
      const dim = routeDim();
      return h("main", { class: "view library-view" }, [
        h("div", { class: "view-head" }, [
          h("h2", { class: "view-title" }, "曲库"),
          headActions(),
        ]),
        statusBar(),
        dimTabs(),
        ...(dim ? [renderGroups(dim)] : trackList({ withSearch: true })),
      ]);
    }

    function renderGroups(dim) {
      if (loadError.value) {
        return ErrorState({ message: loadError.value, onRetry: () => loadGroups(dim.by) });
      }
      if (loading.value) return LoadingState();
      if (groups.value.length === 0) {
        return EmptyState({
          icon: Icons.library,
          title: "曲库是空的",
          hint: "上传音乐，或在 设置 → 运行配置 里添加 NAS 目录后扫描",
        });
      }
      return h("ul", { class: "track-list" },
        groups.value.map((g) =>
          h("li", {
            key: g.name,
            class: "track-row group-row",
            onClick: () => go("library", { [dim.by]: g.name }),
          }, [
            h("div", { class: "pl-icon" },
              dim.by === "folder" ? Icons.library() : Icons.note()),
            h("div", { class: "track-info" }, [
              h("div", { class: "track-title" }, g.name || dim.emptyName),
              h("div", { class: "track-artist" }, `${g.count} 首`),
            ]),
            h("span", { class: "menu-chevron" }, Icons.chevronRight()),
          ]),
        ),
      );
    }

    // 分组下钻的曲目列表
    function renderFiltered(filter) {
      const dim = GROUP_DIMS.find((d) => d.by === filter.key);
      const title = filter.value || dim?.emptyName || "";
      return h("main", { class: "view library-view" }, [
        h("div", { class: "detail-head" }, [
          h("button", {
            class: "secondary-btn",
            onClick: () => go("library", { by: filter.key }),
          }, "‹ 返回"),
          h("button", {
            class: "secondary-btn",
            disabled: busy.value === "playall" || !items.value.length,
            onClick: playAll,
          }, busy.value === "playall" ? "准备中…" : "播放全部"),
        ]),
        h("h2", { class: "view-title" }, title),
        h("p", { class: "muted" }, `${dim?.label || ""} · ${total.value} 首`),
        ...trackList({ withSearch: false }),
      ]);
    }

    return () => {
      const filter = routeFilter();
      return filter ? renderFiltered(filter) : renderRoot();
    };
  },
};
