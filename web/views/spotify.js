import { ref, computed, onMounted, onUnmounted, h } from "vue";
import { api } from "/app/api.js";
import { Icons } from "/app/icons.js";
import { ErrorState, LoadingState } from "/app/components/feedback.js";
import { openConfirm } from "/app/components/confirm.js";
import { go, toast } from "/app/main.js";

const LOGIN_PENDING = ["starting", "waiting", "verifying"];

// Spotify 独立页只负责账号连接；内容分别汇入歌单与榜单页面。
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
    const login = ref(null);
    const openingLogin = ref(false);
    const cancellingLogin = ref(false);
    const loginError = ref("");
    const loginPending = computed(() => LOGIN_PENDING.includes(login.value?.status));
    const busy = computed(() => linking.value || unlinking.value
      || openingLogin.value || cancellingLogin.value || loginPending.value);
    let disposed = false;
    let sessionRequest = 0;
    let loginRevision = 0;
    let loginTimer = 0;

    function unlinked(message = "") {
      connected.value = false;
      editing.value = false;
      cookie.value = "";
      linkError.value = message;
    }

    function didConnect() {
      sessionRequest += 1;
      checking.value = false;
      sessionError.value = "";
      cookie.value = "";
      linkError.value = "";
      editing.value = false;
      connected.value = true;
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
        // 页面刷新后尽力恢复尚未结束的登录窗口。
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
        if (!disposed && revision === loginRevision) loginError.value = error.message;
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
        if (status.loggedIn) connected.value = true;
        else unlinked();
      } catch (error) {
        if (!disposed && request === sessionRequest) sessionError.value = error.message;
      } finally {
        if (!disposed && request === sessionRequest) checking.value = false;
      }
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
        if (!disposed) didConnect();
      } catch (error) {
        if (!disposed) linkError.value = error.message;
      } finally {
        linking.value = false;
      }
    }

    async function unlink() {
      if (busy.value) return;
      const confirmed = await openConfirm({
        title: "解除 Spotify 绑定",
        message: "移除 Spotify 登录信息。已加入队列的歌曲会保留。",
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

    onMounted(() => {
      void checkSession();
      void resumeLogin();
    });
    onUnmounted(() => {
      disposed = true;
      sessionRequest += 1;
      loginRevision += 1;
      clearTimeout(loginTimer);
      cookie.value = "";
    });

    function accountCard() {
      return h("section", { class: "card spotify-account" }, [
        h("div", { class: "spotify-account-head" }, [
          h("span", { class: "spotify-mark spotify-account-icon" }, Icons.spotify()),
          h("div", { class: "spotify-account-info" }, [
            h("h3", { class: "card-title" }, connected.value ? "Spotify 账号已连接" : "连接你的 Spotify"),
            h("p", { class: "muted" }, connected.value ? "歌单和榜单会自动显示 Spotify 内容。" : "登录后，个人歌单与常听榜会自动汇入 HMusic。"),
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
          h("button", { class: "secondary-btn", disabled: openingLogin.value || cancellingLogin.value, onClick: cancelLogin }, "取消登录"),
        ]) : h("div", { class: "spotify-login-flow" }, [
          h("div", { class: "spotify-actions" }, [
            h("button", { class: connected.value ? "secondary-btn" : "primary-btn", disabled: busy.value, onClick: startLogin }, [Icons.spotify(), connected.value ? "重新登录" : "登录 Spotify"]),
            connected.value ? h("button", { class: "danger-btn", disabled: busy.value, onClick: unlink }, unlinking.value ? "正在解绑…" : "解除绑定") : null,
          ]),
          h("p", { class: "hint" }, "登录窗口会在运行 HMusic 服务的电脑上打开，完成登录后自动连接。"),
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
              disabled: linking.value, onInput: (event) => { cookie.value = event.target.value; linkError.value = ""; },
            }),
            h("small", { class: "hint" }, "登录信息会加密保存在这台 HMusic 服务器上。"),
          ]),
          h("button", { class: "primary-btn", type: "submit", disabled: busy.value || !cookie.value.trim() }, linking.value ? "正在验证账号…" : "保存绑定"),
        ]) : null,
      ]);
    }

    return () => h("main", { class: "view spotify-view" }, [
      h("div", { class: "view-head" }, [
        h("div", { class: "spotify-title" }, [h("h2", { class: "view-title" }, "Spotify"), h("span", { class: "badge" }, "账号与同步")]),
        h("button", { class: "secondary-btn", disabled: checking.value || busy.value, onClick: checkSession }, [Icons.refresh(), "刷新状态"]),
      ]),
      checking.value ? LoadingState({ label: "正在检查 Spotify 绑定状态…" })
        : sessionError.value ? ErrorState({ message: sessionError.value, onRetry: checkSession })
        : h("div", { class: "spotify-content" }, [
          accountCard(),
          connected.value ? h("section", { class: "card spotify-account spotify-links" }, [
            h("h3", { class: "card-title" }, "内容入口"),
            h("p", { class: "muted" }, "个人歌单在“歌单”页面；常听排行与 Spotify 热门榜在“榜单”页面。"),
            h("div", { class: "spotify-actions" }, [
              h("button", { class: "secondary-btn", onClick: () => go("playlists") }, [Icons.playlists(), "打开歌单"]),
              h("button", { class: "secondary-btn", onClick: () => go("charts") }, [Icons.charts(), "打开榜单"]),
            ]),
          ]) : null,
        ]),
    ]);
  },
};
