import { ref, reactive, computed, onMounted, onUnmounted, h } from "vue";
import { api } from "/app/api.js";
import { Icons } from "/app/icons.js";
import { EmptyState, ErrorState, LoadingState } from "/app/components/feedback.js";
import { openConfirm } from "/app/components/confirm.js";
import { go, store, toast, refreshPlayback, primeLocalAudio, LOCAL_DEVICE_ID } from "/app/main.js";

const TOP_LIMIT = 50;
const TIME_RANGES = [
  ["short_term", "最近 4 周"],
  ["medium_term", "最近 6 个月"],
  ["long_term", "全部时间"],
];
const LOGIN_PENDING = ["starting", "waiting", "verifying"];

function createPage() {
  return reactive({
    items: [], total: 0, offset: 0, nextOffset: 0, history: [],
    loaded: false, loading: false, error: "", revision: 0, retry: null,
  });
}

function resetPage(page) {
  page.revision += 1;
  Object.assign(page, {
    items: [], total: 0, offset: 0, nextOffset: 0, history: [],
    loaded: false, loading: false, error: "", retry: null,
  });
}

export const SpotifyView = {
  setup() {
    const connected = ref(false);
    const checking = ref(true);
    const sessionError = ref("");
    const cookie = ref("");
    const linkError = ref("");
    const editing = ref(false);
    const linking = ref(false);
    const unlinking = ref(false);
    const playing = ref("");
    const login = ref(null);
    const openingLogin = ref(false);
    const cancellingLogin = ref(false);
    const loginError = ref("");
    const loginPending = computed(() => LOGIN_PENDING.includes(login.value?.status));
    const busy = computed(() => linking.value || unlinking.value || Boolean(playing.value)
      || openingLogin.value || cancellingLogin.value || loginPending.value);
    const tab = ref("top");
    const timeRange = ref("short_term");
    const devices = ref([]);
    const deviceId = ref("");
    const selectedPlaylist = ref(null);
    const top = createPage();
    const playlists = createPage();
    const tracks = createPage();
    const pages = [top, playlists, tracks];
    let disposed = false;
    let sessionRequest = 0;
    let accountRevision = 0;
    let loginRevision = 0;
    let loginTimer = 0;

    function unlinked(message = "") {
      accountRevision += 1;
      connected.value = false;
      editing.value = false;
      cookie.value = "";
      linkError.value = message;
      selectedPlaylist.value = null;
      pages.forEach(resetPage);
    }

    function handleSessionError(error) {
      if (!["SPOTIFY_SESSION_INVALID", "SPOTIFY_NOT_LINKED"].includes(error.code)) return false;
      unlinked(error.code === "SPOTIFY_NOT_LINKED"
        ? "Spotify 尚未连接，请先登录。"
        : "Spotify 登录已失效，请重新登录。");
      return true;
    }

    function messageFor(error) {
      if (error.code === "SPOTIFY_RATE_LIMITED") return error.message;
      return error.message || "Spotify 列表暂时无法显示，请稍后重试。";
    }

    function didConnect() {
      sessionRequest += 1;
      checking.value = false;
      sessionError.value = "";
      cookie.value = "";
      linkError.value = "";
      editing.value = false;
      connected.value = true;
      accountRevision += 1;
      pages.forEach(resetPage);
      selectedPlaylist.value = null;
      tab.value = "top";
      void loadTop();
      toast("Spotify 已连接", "success");
    }

    function updateLogin(result, revision) {
      if (disposed || revision !== loginRevision) return;
      login.value = result;
      loginError.value = "";
      if (result.status === "succeeded") didConnect();
      else if (["failed", "expired"].includes(result.status)) linkError.value = result.message;
      else if (result.status === "cancelled") toast(result.message || "已取消 Spotify 登录");
      else loginTimer = setTimeout(() => pollLogin(result.id, revision), 1000);
    }

    async function pollLogin(id, revision) {
      if (disposed || revision !== loginRevision) return;
      try {
        updateLogin(await api(`/spotify/login/${encodeURIComponent(id)}`), revision);
      } catch (error) {
        if (disposed || revision !== loginRevision) return;
        if (error.statusCode === 404) {
          login.value = null;
          linkError.value = error.message;
        } else {
          loginError.value = "暂时无法读取登录进度，正在重试…";
          loginTimer = setTimeout(() => pollLogin(id, revision), 2000);
        }
      }
    }

    async function resumeLogin() {
      const revision = loginRevision;
      try {
        const result = await api("/spotify/login");
        if (LOGIN_PENDING.includes(result.login?.status)) updateLogin(result.login, revision);
      } catch {
        // 页面刷新后可恢复尚未结束的窗口；读取失败时再次点登录会复用原窗口。
      }
    }

    async function startLogin() {
      if (busy.value) return;
      const revision = ++loginRevision;
      clearTimeout(loginTimer);
      openingLogin.value = true;
      cookie.value = "";
      editing.value = false;
      linkError.value = "";
      loginError.value = "";
      try {
        updateLogin(await api("/spotify/login", { method: "POST" }), revision);
      } catch (error) {
        if (!disposed && revision === loginRevision) linkError.value = error.message;
      } finally {
        openingLogin.value = false;
      }
    }

    async function cancelLogin() {
      if (!loginPending.value || cancellingLogin.value) return;
      const id = login.value.id;
      const revision = ++loginRevision;
      clearTimeout(loginTimer);
      cancellingLogin.value = true;
      try {
        updateLogin(await api(`/spotify/login/${encodeURIComponent(id)}`, { method: "DELETE" }), revision);
      } catch (error) {
        if (!disposed && revision === loginRevision) {
          loginError.value = error.message;
          loginTimer = setTimeout(() => pollLogin(id, revision), 1000);
        }
      } finally {
        cancellingLogin.value = false;
      }
    }

    async function checkSession() {
      const request = ++sessionRequest;
      checking.value = true;
      sessionError.value = "";
      try {
        const status = await api("/spotify/session");
        if (disposed || request !== sessionRequest) return;
        if (!status.loggedIn) unlinked();
        else {
          connected.value = true;
          if (!top.loaded && !top.loading) void loadTop();
        }
      } catch (error) {
        if (!disposed && request === sessionRequest) sessionError.value = error.message;
      } finally {
        if (!disposed && request === sessionRequest) checking.value = false;
      }
    }

    async function loadDevices() {
      try {
        const result = await api("/devices");
        if (disposed) return;
        devices.value = result.devices || [];
        deviceId.value = devices.value.find(d => d.id === store.playback?.deviceId)?.id
          || devices.value.find(d => d.isDefault)?.id || LOCAL_DEVICE_ID;
      } catch {
        // 设备目录失败时仍可使用服务端默认设备。
      }
    }

    // 同一列表的迟到响应、旧账号的数据都不能覆盖当前界面。
    async function loadPage(page, path, field, options = {}) {
      if (!connected.value || disposed) return;
      const request = ++page.revision;
      const account = accountRevision;
      const isCurrent = () => !disposed && request === page.revision && account === accountRevision;
      page.loading = true;
      page.error = "";
      page.retry = () => loadPage(page, path, field, options);
      try {
        const result = await api(path);
        if (!isCurrent()) return;
        if (!Array.isArray(result[field])) throw new Error("Spotify 列表暂时无法显示，请稍后重试。");
        page.items = options.append ? [...page.items, ...result[field]] : result[field];
        page.offset = options.offset ?? 0;
        page.nextOffset = result.nextOffset ?? null;
        page.total = result.total ?? page.items.length;
        page.history = options.history || [];
        page.loaded = true;
      } catch (error) {
        if (isCurrent() && !handleSessionError(error)) page.error = messageFor(error);
      } finally {
        if (isCurrent()) page.loading = false;
      }
    }

    function loadTop(offset = 0, history = []) {
      const query = new URLSearchParams({ timeRange: timeRange.value, limit: String(TOP_LIMIT), offset: String(offset) });
      return loadPage(top, `/spotify/recommendations?${query}`, "tracks", { offset, history });
    }

    function loadPlaylists(reset = false) {
      if (playlists.loading && !reset) return;
      const offset = reset ? 0 : playlists.nextOffset;
      if (offset === null) return;
      return loadPage(playlists, `/spotify/playlists?limit=50&offset=${offset}`, "playlists", { offset, append: !reset });
    }

    function loadPlaylistTracks(reset = false) {
      if (!selectedPlaylist.value || (tracks.loading && !reset)) return;
      const offset = reset ? 0 : tracks.nextOffset;
      if (offset === null) return;
      const id = encodeURIComponent(selectedPlaylist.value.id);
      return loadPage(tracks, `/spotify/playlists/${id}/tracks?limit=100&offset=${offset}`, "tracks", { offset, append: !reset });
    }

    function selectTab(value) {
      tab.value = value;
      selectedPlaylist.value = null;
      resetPage(tracks);
      if (value === "top" && !top.loaded && !top.loading) void loadTop();
      if (value === "playlists" && !playlists.loaded && !playlists.loading) void loadPlaylists(true);
    }

    function openPlaylist(playlist) {
      selectedPlaylist.value = playlist;
      resetPage(tracks);
      void loadPlaylistTracks(true);
    }

    function refresh() {
      if (!connected.value) return checkSession();
      if (tab.value === "top") {
        resetPage(top);
        return loadTop();
      }
      if (selectedPlaylist.value) {
        resetPage(tracks);
        return loadPlaylistTracks(true);
      }
      resetPage(playlists);
      return loadPlaylists(true);
    }

    async function bind(event) {
      event.preventDefault();
      if (busy.value) return;
      const spDc = cookie.value.trim();
      if (spDc.length < 10 || spDc.length > 4096 || /[\s;]/.test(spDc) || spDc.startsWith("sp_dc=")) {
        linkError.value = "请粘贴 sp_dc 的完整值，不要包含 sp_dc=、空格或其他 Cookie。";
        return;
      }
      linking.value = true;
      linkError.value = "";
      try {
        await api("/spotify/session", { method: "POST", body: { spDc } });
        if (disposed) return;
        didConnect();
      } catch (error) {
        // 更新绑定失败时，后端仍保留原会话，不把旧账号误标为已解绑。
        if (!disposed) linkError.value = messageFor(error);
      } finally {
        linking.value = false;
      }
    }

    async function unlink() {
      if (busy.value) return;
      const confirmed = await openConfirm({
        title: "解除 Spotify 绑定",
        message: "移除 Spotify 登录信息，并停止未完成的匹配任务。已加入队列的歌曲会保留。",
        confirmText: "解除绑定",
        danger: true,
      });
      if (!confirmed || disposed) return;
      unlinking.value = true;
      try {
        await api("/spotify/session", { method: "DELETE" });
        if (!disposed) unlinked();
        toast("Spotify 已解除绑定", "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        unlinking.value = false;
      }
    }

    async function play(kind, startIndex = 0) {
      const page = kind === "top" ? top : tracks;
      if (busy.value || page.loading || !page.items[startIndex]) return;
      const playlist = selectedPlaylist.value;
      const path = kind === "top" ? "/spotify/recommendations/play"
        : `/spotify/playlists/${encodeURIComponent(playlist.id)}/play`;
      const body = { startIndex, ...(deviceId.value ? { deviceId: deviceId.value } : {}) };
      if (kind === "top") Object.assign(body, { limit: TOP_LIMIT, offset: top.offset, timeRange: timeRange.value });
      // 常听按本页索引播放；歌单连续追加已过滤的曲目，索引对应完整歌单。
      playing.value = `${kind}:${startIndex}`;
      primeLocalAudio();
      try {
        await api(path, { method: "POST", body });
        await refreshPlayback();
        toast("已开始播放，后续匹配的曲目会继续加入队列", "success");
      } catch (error) {
        if (!disposed) handleSessionError(error);
        toast(error.message, "error");
      } finally {
        playing.value = "";
      }
    }

    onMounted(() => { void checkSession(); void loadDevices(); void resumeLogin(); });
    onUnmounted(() => {
      disposed = true;
      sessionRequest += 1;
      loginRevision += 1;
      clearTimeout(loginTimer);
      cookie.value = "";
      pages.forEach(resetPage);
    });

    function accountCard() {
      return h("section", { class: "card spotify-account" }, [
        h("div", { class: "spotify-account-head" }, [
          h("span", { class: "spotify-mark spotify-account-icon" }, Icons.spotify()),
          h("div", { class: "spotify-account-info" }, [
            h("h3", { class: "card-title" }, connected.value ? "Spotify 账号已连接" : "连接你的 Spotify"),
            h("p", { class: "muted" }, connected.value ? "常听曲目与个人歌单，随时接着听。" : "登录后，即可浏览常听曲目与个人歌单。"),
          ]),
          h("span", { class: ["spotify-status", { connected: connected.value }] }, [
            h("span", { class: `dot ${connected.value ? "dot-playing" : "dot-idle"}` }),
            connected.value ? "已绑定" : "未绑定",
          ]),
        ]),
        linkError.value ? h("div", { class: "notice-bar error", role: "alert" }, linkError.value) : null,
        loginPending.value || openingLogin.value ? h("div", { class: "spotify-login-flow" }, [
          h("div", { class: "spotify-login-progress", role: "status", "aria-live": "polite" }, [
            h("span", { class: "spinner" }),
            h("span", null, cancellingLogin.value ? "正在关闭登录窗口…" : login.value?.message || "正在打开 Spotify 登录窗口…"),
          ]),
          loginError.value ? h("p", { class: "hint", role: "alert" }, loginError.value) : null,
          h("div", { class: "spotify-actions" }, [
            h("button", { class: "secondary-btn", disabled: openingLogin.value || cancellingLogin.value, onClick: cancelLogin }, "取消登录"),
          ]),
        ]) : h("div", { class: "spotify-login-flow" }, [
          h("div", { class: "spotify-actions" }, [
            h("button", { class: connected.value ? "secondary-btn" : "primary-btn", disabled: busy.value, onClick: startLogin }, [Icons.spotify(), connected.value ? "重新登录" : "登录 Spotify"]),
            connected.value ? h("button", { class: "danger-btn", disabled: busy.value, onClick: unlink }, unlinking.value ? "正在解绑…" : "解除绑定") : null,
          ]),
          h("p", { class: "hint" }, "在运行 HMusic 服务的电脑上打开 Spotify 官方窗口，登录后自动连接。"),
          h("button", {
            class: "ghost-btn spotify-manual-toggle", disabled: busy.value,
            "aria-expanded": editing.value, "aria-controls": "spotify-manual-import",
            onClick: () => { editing.value = !editing.value; cookie.value = ""; linkError.value = ""; },
          }, editing.value ? "收起手动导入" : "手动导入（高级）"),
        ]),
        editing.value && !loginPending.value && !openingLogin.value ? h("form", { id: "spotify-manual-import", class: "spotify-bind-form", onSubmit: bind }, [
          h("label", { class: "field", for: "spotify-cookie" }, [
            "Spotify Cookie（sp_dc）",
            h("input", {
              id: "spotify-cookie", type: "password", autocomplete: "off", spellcheck: false,
              placeholder: "粘贴 sp_dc 的值", maxlength: 4096, value: cookie.value,
              disabled: linking.value, "aria-describedby": "spotify-cookie-hint",
              onInput: event => { cookie.value = event.target.value; linkError.value = ""; },
            }),
            h("small", { class: "hint", id: "spotify-cookie-hint" }, "登录信息将加密保存在这台 HMusic 服务器上。"),
          ]),
          h("div", { class: "spotify-actions" }, [
            h("button", { class: "primary-btn", type: "submit", disabled: busy.value || !cookie.value.trim() }, linking.value ? "正在验证账号…" : connected.value ? "保存新绑定" : "绑定 Spotify"),
            connected.value ? h("button", { class: "secondary-btn", type: "button", disabled: busy.value, onClick: () => { editing.value = false; cookie.value = ""; linkError.value = ""; } }, "取消") : null,
          ]),
          h("details", { class: "spotify-cookie-help" }, [
            h("summary", null, "如何获取 sp_dc？"),
            h("ol", null, [
              h("li", null, ["在电脑浏览器打开 ", h("a", { href: "https://open.spotify.com/", target: "_blank", rel: "noopener noreferrer" }, "Spotify 网页版"), "，登录自己的账号。"]),
              h("li", null, "打开浏览器开发者工具，在「应用 / Application → Cookie」中选择 https://open.spotify.com。Firefox 可在「存储」中找到 Cookie。"),
              h("li", null, "找到名称为 sp_dc 的一项，复制其值（Value）粘贴到上方。只需这一项，无需复制其他 Cookie。"),
            ]),
          ]),
        ]) : null,
      ]);
    }

    function listError(page) {
      return page.error && page.items.length ? h("div", { class: "notice-bar error", role: "alert" }, [
        h("span", null, page.error),
        h("button", { class: "ghost-btn", disabled: page.loading, onClick: page.retry }, "重试"),
      ]) : null;
    }

    function trackList(page, kind) {
      if (page.loading && !page.loaded) return LoadingState({ label: "正在读取 Spotify 曲目…" });
      if (page.error && !page.items.length) return ErrorState({ message: page.error, onRetry: page.retry });
      if (!page.items.length) return EmptyState({
        icon: Icons.spotify,
        title: kind === "top" ? "暂时没有常听曲目" : "暂无可显示的歌曲",
        hint: kind === "top" ? "可以换个时间范围，再看看常听排行。" : "下架歌曲、本地文件和播客不会显示在这里。",
      });
      return h("ol", { class: "track-list track-cols spotify-tracks", "aria-label": kind === "top" ? "常听曲目" : "歌单曲目" },
        page.items.map((track, index) => h("li", { class: "track-row", key: `${track.id}:${index}` }, [
          cover(track.coverUrl),
          h("div", { class: "track-info" }, [
            h("div", { class: "track-title", title: track.title }, track.title),
            h("div", { class: "track-artist", title: [track.artist, track.album].filter(Boolean).join(" · ") }, [track.artist || "未知歌手", track.album].filter(Boolean).join(" · ")),
          ]),
          h("span", { class: "spotify-duration" }, duration(track.durationMs)),
          h("div", { class: "track-actions" }, [
            h("button", {
              class: "icon-btn", disabled: busy.value || page.loading,
              title: `从《${track.title}》开始播放`, "aria-label": `从《${track.title}》开始播放`,
              onClick: () => play(kind, index),
            }, Icons.play()),
          ]),
        ])),
      );
    }

    function playButton(label, page, kind) {
      return h("button", { class: "primary-btn", disabled: busy.value || page.loading || !page.items.length, onClick: () => play(kind) }, [Icons.play(), label]);
    }

    function renderTop() {
      return h("section", { class: "spotify-section", "aria-label": "最近常听" }, [
        h("div", { class: "spotify-toolbar" }, [
          h("label", { class: "spotify-select" }, ["时间范围", h("select", {
            value: timeRange.value, disabled: busy.value, "aria-label": "时间范围",
            onChange: event => { timeRange.value = event.target.value; resetPage(top); void loadTop(); },
          }, TIME_RANGES.map(([value, label]) => h("option", { value }, label)))]),
          playButton("播放本页", top, "top"),
        ]),
        listError(top),
        trackList(top, "top"),
        top.loaded ? h("div", { class: "spotify-pagination" }, [
          h("span", { class: "muted" }, `第 ${top.history.length + 1} 页 · 本页 ${top.items.length} 首`),
          h("div", { class: "spotify-actions" }, [
            h("button", { class: "secondary-btn", disabled: busy.value || top.loading || !top.history.length, onClick: () => loadTop(top.history.at(-1), top.history.slice(0, -1)) }, "上一页"),
            h("button", { class: "secondary-btn", disabled: busy.value || top.loading || top.nextOffset === null, onClick: () => loadTop(top.nextOffset, [...top.history, top.offset]) }, top.loading ? "加载中…" : "下一页"),
          ]),
        ]) : null,
      ]);
    }

    function loadMore(page, action, label) {
      return page.loaded && page.nextOffset !== null ? h("div", { class: "load-more" }, [
        h("button", { class: "secondary-btn", disabled: busy.value || page.loading, onClick: () => action() }, page.loading ? "加载中…" : label),
      ]) : null;
    }

    function renderPlaylists() {
      if (selectedPlaylist.value) return h("section", { class: "spotify-section", "aria-label": "歌单详情" }, [
        h("div", { class: "spotify-toolbar" }, [
          h("button", { class: "secondary-btn", onClick: () => { selectedPlaylist.value = null; resetPage(tracks); } }, [Icons.chevronLeft(), "我的歌单"]),
          playButton("播放整张歌单", tracks, "playlist"),
        ]),
        h("div", { class: "spotify-playlist-heading" }, [
          cover(selectedPlaylist.value.coverUrl),
          h("div", { class: "pl-meta" }, [
            h("h3", { class: "spotify-playlist-title" }, selectedPlaylist.value.name),
            h("p", { class: "muted" }, `已显示 ${tracks.items.length} 首 · Spotify 收录 ${tracks.loaded ? tracks.total : selectedPlaylist.value.tracksTotal} 首`),
          ]),
        ]),
        listError(tracks),
        trackList(tracks, "playlist"),
        loadMore(tracks, loadPlaylistTracks, "加载更多曲目"),
      ]);
      return h("section", { class: "spotify-section", "aria-label": "我的歌单" }, [
        listError(playlists),
        playlists.loading && !playlists.loaded ? LoadingState({ label: "正在读取 Spotify 歌单…" })
          : playlists.error && !playlists.items.length ? ErrorState({ message: playlists.error, onRetry: playlists.retry })
          : !playlists.items.length ? EmptyState({ icon: Icons.playlists, title: "暂时没有歌单", hint: "在 Spotify 创建或收藏歌单后，刷新这里即可查看。" })
          : h("div", { class: "playlist-grid" }, playlists.items.map(playlist => h("button", {
            class: "playlist-card card spotify-playlist", key: playlist.id, onClick: () => openPlaylist(playlist),
          }, [
            cover(playlist.coverUrl),
            h("span", { class: "pl-meta" }, [h("span", { class: "pl-name" }, playlist.name), h("span", { class: "muted" }, `${playlist.tracksTotal} 首`)]),
            h("span", { class: "spotify-chevron" }, Icons.chevronRight()),
          ]))),
        loadMore(playlists, loadPlaylists, "加载更多歌单"),
      ]);
    }

    return () => h("main", { class: "view spotify-view" }, [
      h("div", { class: "view-head" }, [
        h("div", { class: "spotify-title" }, [h("h2", { class: "view-title" }, "Spotify"), h("span", { class: "badge" }, "实验性")]),
        h("button", { class: "secondary-btn", disabled: checking.value || busy.value, onClick: refresh }, [Icons.refresh(), "刷新"]),
      ]),
      checking.value ? LoadingState({ label: "正在检查 Spotify 绑定状态…" })
        : sessionError.value ? ErrorState({ message: sessionError.value, onRetry: checkSession })
        : h("div", { class: "spotify-content" }, [
          accountCard(),
          connected.value ? h("div", { class: "spotify-content" }, [
            h("div", { class: "spotify-toolbar" }, [
              h("div", { class: "tabs spotify-tabs", "aria-label": "Spotify 内容" }, [["top", "最近常听"], ["playlists", "我的歌单"]].map(([value, label]) => h("button", {
                class: ["tab", { active: tab.value === value }], "aria-pressed": tab.value === value, onClick: () => selectTab(value),
              }, label))),
              h("label", { class: "spotify-select spotify-device" }, ["播放到", h("select", { value: deviceId.value, disabled: busy.value, "aria-label": "播放到", onChange: event => { deviceId.value = event.target.value; } }, [
                h("option", { value: "" }, "默认设备"),
                ...devices.value.map(device => h("option", { value: device.id, key: device.id }, device.name)),
              ])]),
            ]),
            playing.value ? h("div", { class: "notice-bar", role: "status", "aria-live": "polite" }, "正在匹配歌曲，第一首匹配成功后开始播放…") : null,
            tab.value === "top" ? renderTop() : renderPlaylists(),
          ]) : null,
          h("p", { class: "spotify-play-hint" }, [
            "播放使用 HMusic 已配置的音源，未匹配的曲目会跳过。",
            h("button", { class: "ghost-btn", onClick: () => go("settings", { s: "sources" }) }, "配置音源"),
            connected.value ? h("button", { class: "ghost-btn", onClick: () => go("queue") }, "查看队列") : null,
          ]),
        ]),
    ]);
  },
};

function cover(url) {
  return h("span", { class: "track-cover spotify-cover" }, [
    Icons.note(),
    url ? h("img", { src: url, alt: "", loading: "lazy", referrerpolicy: "no-referrer", onError: event => { event.target.hidden = true; } }) : null,
  ]);
}

function duration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
