import { createApp, reactive, h } from "vue";
import { api, getToken, setToken, clearToken } from "/app/api.js";
import { LoginView } from "/app/views/login.js";
import { PlayerView } from "/app/views/player.js";
import { SearchView } from "/app/views/search.js";
import { QueueView } from "/app/views/queue.js";
import { PlaylistsView } from "/app/views/playlists.js";
import { SettingsView } from "/app/views/settings.js";

// ===== 全局响应式状态 =====
export const store = reactive({
  ready: false,
  authenticated: false,
  initialized: false,
  user: null,
  playback: null,
  toast: null,
});

let toastTimer = 0;
export function toast(message, kind = "info") {
  store.toast = { message, kind };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (store.toast = null), 3200);
}

export async function refreshAuth() {
  const status = await api("/auth/status");
  store.initialized = status.initialized;
  store.authenticated = status.authenticated;
  store.user = status.user || null;
}

export async function refreshPlayback() {
  try {
    store.playback = await api("/playback/state");
  } catch {
    // 播放状态是尽力而为，失败不打断界面。
  }
}

export function logout() {
  clearToken();
  store.authenticated = false;
  store.user = null;
  go("login");
}

// ===== 极简哈希路由 =====
const routes = {
  player: { component: PlayerView, requiresAuth: true, label: "正在播放", icon: "▶" },
  search: { component: SearchView, requiresAuth: true, label: "搜索", icon: "🔍" },
  queue: { component: QueueView, requiresAuth: true, label: "队列", icon: "☰" },
  playlists: { component: PlaylistsView, requiresAuth: true, label: "歌单", icon: "♫" },
  settings: { component: SettingsView, requiresAuth: true, label: "设置", icon: "⚙" },
  login: { component: LoginView, requiresAuth: false },
};

export const router = reactive({ name: "player" });

export function go(name) {
  if (location.hash !== `#/${name}`) location.hash = `#/${name}`;
  else applyRoute();
}

function applyRoute() {
  const name = (location.hash.replace(/^#\//, "") || "player").split("?")[0];
  const route = routes[name] || routes.player;
  if (route.requiresAuth && !store.authenticated) {
    router.name = "login";
    return;
  }
  if (name === "login" && store.authenticated) {
    router.name = "player";
    return;
  }
  router.name = routes[name] ? name : "player";
}

window.addEventListener("hashchange", applyRoute);

// ===== 根组件 =====
const NAV_ITEMS = ["player", "search", "queue", "playlists", "settings"];

const App = {
  setup() {
    return () => {
      if (!store.ready) {
        return h("div", { class: "boot" }, "加载中…");
      }
      const route = routes[router.name] || routes.player;
      const children = [h(route.component)];

      // 已登录时显示底部导航 + 顶栏。
      if (store.authenticated && router.name !== "login") {
        children.unshift(h(TopBar));
        children.push(h(BottomNav));
      }
      if (store.toast) {
        children.push(
          h("div", { class: `toast toast-${store.toast.kind}` }, store.toast.message),
        );
      }
      return h("div", { class: "app-shell" }, children);
    };
  },
};

const TopBar = {
  setup() {
    return () =>
      h("header", { class: "topbar" }, [
        h("div", { class: "brand" }, "🎵 HMusic"),
        h(
          "button",
          { class: "ghost-btn", onClick: logout, title: "退出登录" },
          store.user?.username ? `${store.user.username} · 退出` : "退出",
        ),
      ]);
  },
};

const BottomNav = {
  setup() {
    return () =>
      h(
        "nav",
        { class: "bottom-nav" },
        NAV_ITEMS.map((name) =>
          h(
            "button",
            {
              class: ["nav-item", { active: router.name === name }],
              onClick: () => go(name),
            },
            [
              h("span", { class: "nav-icon" }, routes[name].icon),
              h("span", { class: "nav-label" }, routes[name].label),
            ],
          ),
        ),
      );
  },
};

// ===== 启动 =====
async function boot() {
  // 无 token 时也要拿 initialized 状态（决定登录还是首次创建管理员）。
  try {
    await refreshAuth();
  } catch {
    store.authenticated = false;
  }
  if (store.authenticated) await refreshPlayback();
  store.ready = true;
  applyRoute();
}

createApp(App).mount("#app");
boot();
