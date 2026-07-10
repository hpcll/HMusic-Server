import { createApp, reactive, h } from "vue";
import { api, getToken, setToken, clearToken } from "/app/api.js";
import { Icons } from "/app/icons.js";
import { LoginView } from "/app/views/login.js";
import { PlayerView } from "/app/views/player.js";
import { LyricsView } from "/app/views/lyrics.js";
import { SearchView } from "/app/views/search.js";
import { QueueView } from "/app/views/queue.js";
import { PlaylistsView } from "/app/views/playlists.js";
import { ChartsView } from "/app/views/charts.js";
import { StatsView } from "/app/views/stats.js";
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
    syncLocalAudio();
  } catch {
    // 播放状态是尽力而为，失败不打断界面。
  }
}

// ===== 本机播放引擎 =====
// 后端把「本机播放」当虚拟设备记账，真正出声的是这里的全局 <audio>。
// 挂在 main.js 而非播放页：切到别的页面音乐也不能停。
// 职责：跟随 streamUrl 换歌、跟随 state 播/停、音量同步、
//        每 3s 回写实际进度、播完上报 ended 让服务端推进队列。
export const LOCAL_DEVICE_ID = "local-browser";

const localAudio = new Audio();
localAudio.preload = "auto";
let localStreamUrl = "";
let localReportTimer = 0;

function isLocalPlayback() {
  return store.playback?.deviceId === LOCAL_DEVICE_ID;
}

// streamUrl 是后端用 publicBaseUrl 拼的绝对地址（给音箱抓流用），
// 浏览器必须改走自己当前的 origin——否则配置默认 127.0.0.1 时，
// 从局域网其它机器打开页面会去拉自己电脑的 127.0.0.1，永远无声。
function toSameOriginUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

function syncLocalAudio() {
  const pb = store.playback;
  if (!pb || !isLocalPlayback()) {
    stopLocalAudio();
    return;
  }

  if (pb.streamUrl && pb.streamUrl !== localStreamUrl) {
    // 新曲目：换源。仅当服务端状态为 playing 时才开播——否则暂停态曲目
    // （如刷新页面重载暂停的歌）会在 src 一装载就自动响起来。
    localStreamUrl = pb.streamUrl;
    localAudio.src = toSameOriginUrl(pb.streamUrl);
    localAudio.currentTime = (pb.positionMs || 0) / 1000;
    if (pb.state === "playing") {
      localAudio.play().catch(() => {
        // 浏览器自动播放策略拦截：等用户任意点击后重试。
        toast("浏览器拦截了自动播放，点击页面任意处开始", "info");
        const resume = () => {
          localAudio.play().catch(() => {});
          document.removeEventListener("click", resume);
        };
        document.addEventListener("click", resume, { once: true });
      });
    }
    startLocalReporting();
    return;
  }

  // 同曲目：对齐播放/暂停状态
  if (pb.state === "playing" && localAudio.paused && localAudio.src) {
    localAudio.play().catch(() => {});
  } else if (pb.state === "paused" && !localAudio.paused) {
    localAudio.pause();
  } else if ((pb.state === "stopped" || pb.state === "idle") && localAudio.src) {
    stopLocalAudio();
  }

  if (typeof pb.volume === "number") {
    localAudio.volume = Math.max(0, Math.min(1, pb.volume / 100));
  }
}

function stopLocalAudio() {
  if (!localAudio.src) return;
  localAudio.pause();
  localAudio.removeAttribute("src");
  localAudio.load();
  localStreamUrl = "";
  clearInterval(localReportTimer);
  localReportTimer = 0;
}

function startLocalReporting() {
  if (localReportTimer) return;
  localReportTimer = setInterval(async () => {
    if (!isLocalPlayback() || !localAudio.src) return;
    try {
      store.playback = await api("/playback/local-report", {
        method: "POST",
        body: {
          state: localAudio.paused ? "paused" : "playing",
          positionMs: Math.round(localAudio.currentTime * 1000),
          ...(localAudio.duration && Number.isFinite(localAudio.duration)
            ? { durationMs: Math.round(localAudio.duration * 1000) }
            : {}),
        },
      });
    } catch {
      // 回写尽力而为
    }
  }, 3000);
}

localAudio.addEventListener("ended", async () => {
  if (!isLocalPlayback()) return;
  try {
    store.playback = await api("/playback/local-report", {
      method: "POST",
      body: { ended: true },
    });
    syncLocalAudio(); // 服务端已推进队列，新 streamUrl 立即接着放
  } catch {
    // 队列尽头等情况，保持静默
  }
});

localAudio.addEventListener("error", () => {
  if (!isLocalPlayback() || !localAudio.src) return;
  toast("本机播放加载音频失败，可能是音源链接失效", "error");
});

// 本机 seek：播放页拖进度条后调用（服务端只记数字，音频要在这里跳）。
export function localSeek(positionMs) {
  if (localAudio.src) localAudio.currentTime = positionMs / 1000;
}

// 本机播放/暂停：必须在用户手势的同步调用栈里触发 play()，否则浏览器
// 自动播放策略会拦截——api 请求 await 之后再 play() 手势令牌已失效，
// 表现为「点了播放按钮却一直停在 0:00 已暂停」。播放页按钮直接先调这两个。
export function localPlay() {
  if (localAudio.src) localAudio.play().catch(() => {});
}

export function localPause() {
  if (localAudio.src && !localAudio.paused) localAudio.pause();
}

// 在用户手势里「解锁」<audio> 元素：搜索/榜单/歌单点播放是手势，但真正的
// play() 要等 /playback/play 返回后才在 syncLocalAudio 里发生（已脱离手势）。
// 关键：解锁前必须先清掉元素里残留的上一首——否则手势内这次 play() 会把
// 之前暂停的旧歌恢复播放，等新歌 streamUrl 回来才切走，听感就是「先放几秒旧歌」。
// 清空后对空元素 play()（静默失败）同样能给元素授予播放许可，解锁目的不变。
export function primeLocalAudio() {
  if (localAudio.src) {
    localAudio.pause();
    localAudio.removeAttribute("src");
    localAudio.load();
    localStreamUrl = ""; // 让 syncLocalAudio 认定这是新源，重新 setSrc 播放
  }
  const p = localAudio.play();
  if (p && typeof p.catch === "function") p.catch(() => {});
}

// 本机播放的实时进度：<audio> 是唯一真相源。播放页直接读它，
// 不走「本地插值 + 服务端校准」那套（那是为音箱设计的，两边会打架导致进度回跳）。
export function localPositionMs() {
  return localAudio.src ? Math.round(localAudio.currentTime * 1000) : 0;
}

export function localDurationMs() {
  return localAudio.src && Number.isFinite(localAudio.duration)
    ? Math.round(localAudio.duration * 1000)
    : 0;
}

export function logout() {
  clearToken();
  store.authenticated = false;
  store.user = null;
  go("login");
}

// ===== 极简哈希路由 =====
const routes = {
  player: { component: PlayerView, requiresAuth: true, label: "正在播放", icon: Icons.player },
  // 歌词页：窄屏专用沉浸式路由（无导航壳），从播放页点封面/歌词条进入
  lyrics: { component: LyricsView, requiresAuth: true, immersive: true },
  search: { component: SearchView, requiresAuth: true, label: "搜索", icon: Icons.search },
  queue: { component: QueueView, requiresAuth: true, label: "队列", icon: Icons.queue },
  playlists: { component: PlaylistsView, requiresAuth: true, label: "歌单", icon: Icons.playlists },
  charts: { component: ChartsView, requiresAuth: true, label: "榜单", icon: Icons.charts },
  stats: { component: StatsView, requiresAuth: true, label: "统计", icon: Icons.stats },
  settings: { component: SettingsView, requiresAuth: true, label: "设置", icon: Icons.settings },
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
// 桌面：左侧固定 sidebar（品牌 / 导航 / mini 播放状态 / 用户）+ 右侧内容区。
// 窄屏（<860px）：sidebar 隐藏，回退为顶栏 + 底部导航（CSS 媒体查询切换）。
const NAV_ITEMS = ["player", "search", "queue", "playlists", "charts", "stats", "settings"];

const App = {
  setup() {
    return () => {
      if (!store.ready) {
        return h("div", { class: "boot" }, "加载中…");
      }
      const route = routes[router.name] || routes.player;

      if (!store.authenticated || router.name === "login") {
        return h("div", { class: "app-shell" }, [
          h(route.component),
          toastEl(),
        ]);
      }

      // 沉浸式路由（歌词页）：无侧栏/顶栏/底部导航，内容独占全屏。
      if (route.immersive) {
        return h("div", { class: "app-shell" }, [
          h(route.component),
          toastEl(),
        ]);
      }

      return h("div", { class: "app-shell layout" }, [
        h(Sidebar),
        h(MobileTopBar),
        h("div", { class: "content" }, [h(route.component)]),
        h(MobileNav),
        toastEl(),
      ]);
    };
  },
};

function toastEl() {
  return store.toast
    ? h("div", { class: `toast toast-${store.toast.kind}` }, store.toast.message)
    : null;
}

const STATE_LABELS = {
  idle: "空闲", loading: "加载中", playing: "播放中",
  paused: "已暂停", stopped: "已停止", error: "出错",
};

const Sidebar = {
  setup() {
    return () => {
      const pb = store.playback || {};
      const track = pb.track;
      return h("aside", { class: "sidebar" }, [
        h("div", { class: "side-brand" }, [
          h("img", { class: "side-brand-mark", src: "/app/assets/favicon-64.png", alt: "" }),
          h("span", { class: "side-brand-name" }, "HMusic"),
        ]),

        h("nav", { class: "side-nav" },
          NAV_ITEMS.map((name) =>
            h("button", {
              key: name,
              class: ["side-item", { active: router.name === name }],
              onClick: () => go(name),
            }, [
              h("span", { class: "side-icon" }, routes[name].icon()),
              h("span", { class: "side-label" }, routes[name].label),
            ]),
          ),
        ),

        h("div", { class: "side-foot" }, [
          // mini 播放状态：有曲目时展示，点击跳播放页。
          track
            ? h("button", { class: "side-now", onClick: () => go("player") }, [
                h("div", {
                  class: "side-now-cover",
                  style: track.coverUrl ? { backgroundImage: `url(${track.coverUrl})` } : {},
                }, track.coverUrl ? [] : Icons.note()),
                h("div", { class: "side-now-meta" }, [
                  h("div", { class: "side-now-title" }, track.title),
                  h("div", { class: "side-now-state" }, [
                    h("span", { class: `dot dot-${pb.state || "idle"}` }),
                    STATE_LABELS[pb.state] || "空闲",
                  ]),
                ]),
              ])
            : null,
          h("div", { class: "side-user" }, [
            h("span", { class: "side-user-name" }, store.user?.username || ""),
            h("button", { class: "icon-btn ghost", title: "退出登录", onClick: logout },
              Icons.logout()),
          ]),
        ]),
      ]);
    };
  },
};

const MobileTopBar = {
  setup() {
    return () =>
      h("header", { class: "topbar" }, [
        h("div", { class: "brand" }, [
          h("img", { class: "side-brand-mark", src: "/app/assets/favicon-64.png", alt: "" }),
          "HMusic",
        ]),
        h(
          "button",
          { class: "ghost-btn", onClick: logout, title: "退出登录" },
          store.user?.username ? `${store.user.username} · 退出` : "退出",
        ),
      ]);
  },
};

const MobileNav = {
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
              h("span", { class: "nav-icon" }, routes[name].icon()),
              h("span", { class: "nav-label" }, routes[name].label),
            ],
          ),
        ),
      );
  },
};

// ===== 启动 =====
let playbackTimer = 0;

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
  // sidebar 的 mini 播放状态需要全局轮询（播放页自身还有更快的本地插值）。
  playbackTimer = setInterval(() => {
    if (store.authenticated) refreshPlayback();
  }, 10000);
}

createApp(App).mount("#app");
boot();
