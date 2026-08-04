import { ref, computed, watch, onMounted, onUnmounted, h } from "vue";
import { api, setToken } from "/app/api.js";
import { router, go, toast } from "/app/main.js";
import { Icons } from "/app/icons.js";
import { EmptyState, ErrorState, LoadingState } from "/app/components/feedback.js";
import { MiAccountSection } from "/app/views/settings-mi.js";
import { SourcesSection, TracksSection, DownloadsSection } from "/app/views/settings-sources.js";

// 设置中心。桌面（≥860px）：左菜单常驻 + 右内容区双栏，无需来回跳转；
// 窄屏：保持「分组菜单 → 子页」两级（移动端设置 App 范式）。
// 两种布局由同一份路由状态驱动：桌面无参数时回落 mi，窄屏无参数时显示菜单页。
// 菜单行右侧显示实时摘要（登录态/设备/插件数），一眼看清系统状态。
const DESKTOP_QUERY = "(min-width: 860px)";
const STRATEGY_LABELS = {
  qqFirst: "QQ 优先",
  kuwoFirst: "酷我优先",
  neteaseFirst: "网易云优先",
};

export const SettingsView = {
  setup() {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const isDesktop = ref(mq.matches);
    const sectionKey = computed(() => ALL_ITEMS.some(i => i.key === router.params.s) ? router.params.s : null);
    const summary = ref({});

    async function loadSummary() {
      const [mi, devices, plugins, config, downloads] = await Promise.all([
        api("/mi/status").catch(() => null),
        api("/devices").catch(() => null),
        api("/sources/lx-plugins").catch(() => null),
        api("/config").catch(() => null),
        api("/downloads").catch(() => null),
      ]);
      const defaultDevice = (devices?.devices || []).find((d) => d.isDefault);
      summary.value = {
        mi: mi?.loggedIn
          ? `已登录 ${mi.accountMasked || ""}`
          : mi?.sessionExpired
            ? "会话已失效"
            : "未登录",
        devices: defaultDevice ? defaultDevice.name : `${devices?.devices?.length ?? 0} 台`,
        sources: `${plugins?.plugins?.length ?? 0} 个`,
        downloads: `${(downloads?.downloads || []).filter((d) => d.status === "done").length} 首`,
        tracks: `${config?.manualTracks?.length ?? 0} 首`,
        config: config ? `${config.defaultQuality} · ${STRATEGY_LABELS[config.searchStrategy] || ""}` : "",
        diag: "",
        security: "",
      };
    }

    function open(key) {
      go("settings", { s: key });
    }

    function back() {
      go("settings");
    }

    function onMqChange(e) {
      isDesktop.value = e.matches;
    }

    watch(
      [() => router.name, sectionKey],
      ([name, key]) => {
        if (name === "settings" && key === null) loadSummary();
      },
    );

    onMounted(() => {
      loadSummary();
      mq.addEventListener("change", onMqChange);
    });
    onUnmounted(() => mq.removeEventListener("change", onMqChange));

    function menuEl() {
      return h("div", { class: "settings-menu" },
        GROUPS.map((group) =>
          h("div", { class: "menu-group", key: group.title }, [
            h("div", { class: "menu-group-title" }, group.title),
            h("div", { class: "card menu-card" },
              group.items.map((item) =>
                h("button", {
                  key: item.key,
                  class: ["menu-row", { active: isDesktop.value && (sectionKey.value || "mi") === item.key }],
                  onClick: () => open(item.key),
                }, [
                  h("span", { class: "menu-icon" }, item.icon()),
                  h("span", { class: "menu-label" }, item.label),
                  h("span", { class: "menu-summary" }, summary.value[item.key] || ""),
                  h("span", { class: "menu-chevron" }, Icons.chevronRight()),
                ]),
              ),
            ),
          ]),
        ),
      );
    }

    return () => {
      // 桌面：双栏（菜单 + 内容），永不进入单独子页。
      if (isDesktop.value) {
        const def = ALL_ITEMS.find((item) => item.key === (sectionKey.value || "mi"));
        return h("main", { class: "view settings-view" }, [
          h("h2", { class: "view-title" }, "设置"),
          h("div", { class: "settings-grid" }, [
            menuEl(),
            h("div", { class: "settings-content" }, [
              h("h3", { class: "settings-content-title" }, def.label),
              h(SECTION_COMPONENTS[def.key], { key: def.key }),
            ]),
          ]),
        ]);
      }

      // 窄屏：菜单页 ↔ 子页。
      if (sectionKey.value) {
        const def = ALL_ITEMS.find((item) => item.key === sectionKey.value);
        return h("main", { class: "view settings-view" }, [
          h("div", { class: "section-head" }, [
            h("button", { class: "secondary-btn", onClick: back }, "‹ 设置"),
            h("span", { class: "section-title" }, def?.label || ""),
          ]),
          h(SECTION_COMPONENTS[sectionKey.value], { key: sectionKey.value }),
        ]);
      }

      return h("main", { class: "view settings-view" }, [
        h("h2", { class: "view-title" }, "设置"),
        menuEl(),
      ]);
    };
  },
};

const GROUPS = [
  {
    title: "账号与设备",
    items: [
      { key: "mi", icon: Icons.account, label: "小米账号" },
      { key: "devices", icon: Icons.speaker, label: "播放设备" },
    ],
  },
  {
    title: "音源与内容",
    items: [
      { key: "sources", icon: Icons.plugin, label: "LX 音源插件" },
      { key: "downloads", icon: Icons.download, label: "本地下载" },
      { key: "tracks", icon: Icons.file, label: "手工曲目" },
    ],
  },
  {
    title: "播放与诊断",
    items: [
      { key: "config", icon: Icons.sliders, label: "运行配置" },
      { key: "diag", icon: Icons.pulse, label: "链路诊断" },
    ],
  },
  {
    title: "安全",
    items: [{ key: "security", icon: Icons.lock, label: "修改密码" }],
  },
];

const ALL_ITEMS = GROUPS.flatMap((g) => g.items);

// ===== 播放设备子页 =====
const DevicesSection = {
  setup() {
    const devices = ref([]);
    const miStatus = ref(null);
    const refreshing = ref(false);
    const loading = ref(true);
    const loadError = ref("");
    const miInvalid = computed(() => !miStatus.value?.loggedIn);
    const hasMiDevice = computed(() => devices.value.some((device) => device.type !== "browser"));

    async function load() {
      loading.value = true;
      loadError.value = "";
      try {
        const [result, status] = await Promise.all([
          api("/devices"),
          api("/mi/status").catch(() => null),
        ]);
        devices.value = result.devices || [];
        miStatus.value = status;
      } catch (error) {
        loadError.value = error.message || "加载失败";
      } finally {
        loading.value = false;
      }
    }

    async function refresh() {
      refreshing.value = true;
      try {
        const result = await api("/devices/refresh", { method: "POST" });
        await load();
        toast(`已刷新，共 ${result.deviceCount} 台设备`, "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        refreshing.value = false;
      }
    }

    async function select(device) {
      try {
        await api(`/devices/${device.id}/select`, { method: "POST" });
        await load();
        toast(`默认设备已切换为 ${device.name}`, "success");
      } catch (error) {
        toast(error.message, "error");
      }
    }

    async function probe(device, event) {
      event.stopPropagation();
      try {
        await api(`/devices/${device.id}/probe`, { method: "POST" });
        await load();
        toast(`${device.name} 探测完成`, "success");
      } catch (error) {
        toast(error.message, "error");
      }
    }

    onMounted(load);

    return () =>
      h("div", { class: "section-body" }, [
        miInvalid.value && hasMiDevice.value
          ? h("div", { class: "notice-bar" }, [
              h("span", null, miStatus.value?.sessionExpired
                ? "小米会话已失效，音箱暂时无法控制"
                : "未登录小米账号，音箱暂时无法控制"),
              h("button", {
                class: "ghost-btn",
                onClick: () => go("settings", { s: "mi" }),
              }, "去登录 ›"),
            ])
          : null,
        h("button", {
          class: "secondary-btn",
          disabled: refreshing.value,
          onClick: refresh,
        }, refreshing.value ? "刷新中…" : "从小米账号刷新设备"),
        loadError.value
          ? ErrorState({ message: loadError.value, onRetry: load })
          : loading.value
            ? LoadingState()
            : devices.value.length === 0
              ? EmptyState({
                  icon: Icons.speaker,
                  title: "暂无设备",
                  hint: "先登录小米账号后刷新",
                })
              : h("div", { class: "device-list" },
              devices.value.map((d) =>
                h("button", {
                  key: d.id,
                  class: ["device-item", { active: d.isDefault }],
                  onClick: () => select(d),
                }, [
                  // 小米会话无效时，缓存的音箱在线态已不可信；本机播放不受影响。
                  h("span", {
                    class: `dot ${d.type !== "browser" && miInvalid.value
                      ? "dot-idle"
                      : d.isOnline ? "dot-playing" : "dot-idle"}`,
                  }),
                  h("span", null, [
                    h("div", null, d.name),
                    h("div", { class: "muted" }, d.type || ""),
                  ]),
                  h("span", { class: "device-side" }, [
                    d.isDefault ? h("span", { class: "badge" }, "默认") : null,
                    // 虚拟设备（本机播放）没有可探测的硬件能力
                    d.type === "browser"
                      ? null
                      : h("button", { class: "ghost-btn", onClick: (e) => probe(d, e) }, "探测"),
                  ]),
                ]),
              ),
            ),
      ]);
  },
};

// ===== 运行配置子页 =====
const ConfigSection = {
  setup() {
    const config = ref(null);
    const extraModels = ref("");
    const libraryDirs = ref(""); // 多行文本，一行一个绝对路径（NAS 挂载点）
    const saving = ref(false);
    const loading = ref(true);
    const loadError = ref("");

    async function load() {
      loading.value = true;
      loadError.value = "";
      try {
        config.value = await api("/config");
        extraModels.value = (config.value.extraPlayMusicModels || []).join(", ");
        libraryDirs.value = (config.value.libraryDirs || []).join("\n");
      } catch (error) {
        loadError.value = error.message || "加载失败";
      } finally {
        loading.value = false;
      }
    }

    async function save() {
      saving.value = true;
      try {
        const next = await api("/config", {
          method: "PATCH",
          body: {
            serverName: config.value.serverName,
            defaultQuality: config.value.defaultQuality,
            searchStrategy: config.value.searchStrategy,
            resolveStrategy: config.value.resolveStrategy,
            extraPlayMusicModels: parseModels(extraModels.value),
            libraryDirs: parseDirs(libraryDirs.value),
          },
        });
        config.value = next;
        extraModels.value = (next.extraPlayMusicModels || []).join(", ");
        libraryDirs.value = (next.libraryDirs || []).join("\n");
        toast("配置已保存", "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        saving.value = false;
      }
    }

    onMounted(load);

    return () =>
      loadError.value
        ? ErrorState({ message: loadError.value, onRetry: load })
        : loading.value
          ? LoadingState()
          : config.value
            ? h("section", { class: "card" }, [
            h("label", { class: "field" }, [
              "服务端名称",
              h("input", {
                value: config.value.serverName,
                onInput: (e) => (config.value.serverName = e.target.value),
              }),
            ]),
            h("label", { class: "field" }, [
              "默认音质",
              selectEl(config.value, "defaultQuality", [
                ["128k", "128k"], ["320k", "320k"], ["flac", "FLAC"], ["hires", "Hi-Res"],
              ]),
              h("small", { class: "hint" }, "点播与下载的首选档，取不到时自动逐档回退。"),
            ]),
            h("label", { class: "field" }, [
              "搜索策略",
              selectEl(config.value, "searchStrategy", Object.entries(STRATEGY_LABELS)),
              h("small", { class: "hint" }, "决定聚合搜索结果里哪家平台的歌排在前面。"),
            ]),
            h("label", { class: "field" }, [
              "解析策略",
              selectEl(config.value, "resolveStrategy", [
                ["originalFirst", "原始结果优先"],
                ...Object.entries(STRATEGY_LABELS),
              ]),
              h("small", { class: "hint" }, "选某平台优先时，先在该平台匹配同一首歌取播放链接，失败回落歌曲原平台。"),
            ]),
            h("label", { class: "field" }, [
              "自定义直连播放型号",
              h("input", {
                placeholder: "型号逗号分隔，如 L20A, X20C",
                value: extraModels.value,
                onInput: (e) => (extraModels.value = e.target.value),
              }),
              h("small", { class: "hint" }, "某型号小爱直连播放没声音时才填，内置常见型号已适配。"),
            ]),
            h("label", { class: "field" }, [
              "音乐库目录（NAS）",
              h("textarea", {
                rows: 3,
                placeholder: "/mnt/nas/music\n一行一个绝对路径",
                value: libraryDirs.value,
                onInput: (e) => (libraryDirs.value = e.target.value),
              }),
              h("small", { class: "hint" },
                "服务器能访问的目录（如 NAS 挂载点），保存后到曲库页扫描即可入库；上传的音乐另存内置目录，无需配置。"),
            ]),
            h("button", {
              class: "primary-btn",
              disabled: saving.value,
              onClick: save,
            }, saving.value ? "保存中…" : "保存配置"),
              ])
            : ErrorState({ message: "配置加载失败", onRetry: load });
  },
};

function selectEl(target, key, options) {
  return h("select", {
    value: target[key],
    onChange: (e) => (target[key] = e.target.value),
  }, options.map(([value, label]) =>
    h("option", { value, selected: target[key] === value }, label)));
}

function parseModels(value) {
  const seen = new Set();
  return (value || "")
    .split(/[\s,，、]+/)
    .map((item) => item.trim().toUpperCase())
    .filter((item) => {
      if (!item || !/^[A-Z0-9]+$/.test(item) || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

// 音乐库目录：按行拆分，去空白去重（路径校验交给服务端，不存在的目录扫描时自动忽略）。
function parseDirs(value) {
  const seen = new Set();
  return (value || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line || seen.has(line)) return false;
      seen.add(line);
      return true;
    });
}

// ===== 链路诊断子页 =====
const DiagSection = {
  setup() {
    const playback = ref(null);
    const ttsText = ref("你好，我是 HMusic");
    const busy = ref("");
    let timer = 0;

    async function refresh() {
      try {
        playback.value = await api("/playback/state");
      } catch {
        // 尽力而为
      }
    }

    async function playTestTone() {
      busy.value = "tone";
      try {
        await api("/playback/test-tone", { method: "POST" });
        await refresh();
        toast("测试音频已下发，注意听音箱", "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        busy.value = "";
      }
    }

    async function speak() {
      if (!ttsText.value.trim()) return;
      busy.value = "tts";
      try {
        await api("/playback/speak", {
          method: "POST",
          body: { text: ttsText.value.trim() },
        });
        toast("播报已下发，注意听音箱", "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        busy.value = "";
      }
    }

    onMounted(() => {
      refresh();
      timer = setInterval(refresh, 3000);
    });
    onUnmounted(() => clearInterval(timer));

    return () => {
      const pb = playback.value || {};
      return h("div", { class: "section-body" }, [
        h("section", { class: "card" }, [
          h("div", { class: "card-title" }, "① 播放链路"),
          h("p", { class: "hint" }, "向默认音箱播放 3 秒内置测试音，不依赖任何音源插件。"),
          h("button", {
            class: "primary-btn",
            disabled: busy.value === "tone",
            onClick: playTestTone,
          }, "播放测试音频"),
          h("div", { class: "muted" }, [
            h("span", { class: `dot dot-${pb.state || "idle"}` }),
            `${pb.state || "idle"}${pb.deviceName ? " · " + pb.deviceName : ""}`,
            pb.durationMs
              ? ` · ${Math.round((pb.positionMs || 0) / 1000)}s / ${Math.round(pb.durationMs / 1000)}s`
              : "",
          ]),
        ]),
        h("section", { class: "card" }, [
          h("div", { class: "card-title" }, "② 语音播报（TTS）"),
          h("div", { class: "inline-form" }, [
            h("input", {
              value: ttsText.value,
              onInput: (e) => (ttsText.value = e.target.value),
              onKeyup: (e) => e.key === "Enter" && speak(),
            }),
            h("button", {
              class: "secondary-btn",
              disabled: busy.value === "tts",
              onClick: speak,
            }, "播报"),
          ]),
        ]),
        h("p", { class: "hint" }, "两步都能出声，说明服务端 → 小爱音箱链路完全正常。"),
      ]);
    };
  },
};

// ===== 修改密码子页 =====
const SecuritySection = {
  setup() {
    const currentPassword = ref("");
    const newPassword = ref("");
    const changing = ref(false);

    async function change() {
      if (newPassword.value.length < 8) {
        toast("新密码至少 8 个字符", "error");
        return;
      }
      changing.value = true;
      try {
        const result = await api("/auth/password", {
          method: "POST",
          body: {
            currentPassword: currentPassword.value,
            newPassword: newPassword.value,
          },
        });
        setToken(result.accessToken);
        currentPassword.value = "";
        newPassword.value = "";
        toast("密码已修改", "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        changing.value = false;
      }
    }

    return () =>
      h("section", { class: "card" }, [
        h("label", { class: "field" }, [
          "当前密码",
          h("input", {
            type: "password",
            autocomplete: "current-password",
            value: currentPassword.value,
            onInput: (e) => (currentPassword.value = e.target.value),
          }),
        ]),
        h("label", { class: "field" }, [
          "新密码（至少 8 位）",
          h("input", {
            type: "password",
            autocomplete: "new-password",
            value: newPassword.value,
            onInput: (e) => (newPassword.value = e.target.value),
            onKeyup: (e) => e.key === "Enter" && change(),
          }),
        ]),
        h("button", {
          class: "primary-btn",
          disabled: changing.value || !currentPassword.value || !newPassword.value,
          onClick: change,
        }, changing.value ? "修改中…" : "修改密码"),
      ]);
  },
};

const SECTION_COMPONENTS = {
  mi: MiAccountSection,
  devices: DevicesSection,
  sources: SourcesSection,
  downloads: DownloadsSection,
  tracks: TracksSection,
  config: ConfigSection,
  diag: DiagSection,
  security: SecuritySection,
};
