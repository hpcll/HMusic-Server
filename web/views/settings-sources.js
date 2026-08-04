import { ref, onMounted, onUnmounted, h } from "vue";
import { api } from "/app/api.js";
import { Icons } from "/app/icons.js";
import { EmptyState, ErrorState, LoadingState } from "/app/components/feedback.js";
import { openConfirm } from "/app/components/confirm.js";
import { toast } from "/app/main.js";

// LX 音源插件子页：列表（开关/测试/编辑/更新/删除）
// + 添加（订阅链接拉取 / 选文件 / 粘贴代码三通道，殊途同归都进表单）。
export const SourcesSection = {
  setup() {
    const plugins = ref([]);
    const sources = ref([]); // 带 health 状态
    const busy = ref(false);
    const updatingId = ref("");
    const loading = ref(true);
    const loadError = ref("");

    // 表单
    const formId = ref("");
    const formName = ref("");
    const formCode = ref("");
    const formQuality = ref("320k");
    const formEnabled = ref(true);
    const formSourceUrl = ref(""); // 订阅链接（拉取成功后随保存记录，供一键更新）
    const fetchingUrl = ref(false);

    async function load() {
      loading.value = true;
      loadError.value = "";
      try {
        const [pluginsResult, sourcesResult] = await Promise.all([
          api("/sources/lx-plugins"),
          api("/sources"),
        ]);
        plugins.value = pluginsResult.plugins || [];
        sources.value = sourcesResult.sources || [];
      } catch (error) {
        loadError.value = error.message || "加载失败";
      } finally {
        loading.value = false;
      }
    }

    function healthOf(pluginId) {
      const source = sources.value.find((s) => s.id === pluginId);
      return source?.health?.status || "unknown";
    }

    function onPickFile(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        formCode.value = String(reader.result || "");
        const base = file.name.replace(/\.js$/i, "");
        if (!formId.value) {
          formId.value = base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 32);
        }
        if (!formName.value) formName.value = base;
        toast(`已读取 ${file.name}（${Math.round(file.size / 1024)}KB）`, "success");
      };
      reader.onerror = () => toast("文件读取失败", "error");
      reader.readAsText(file);
      event.target.value = ""; // 允许重复选择同一文件
    }

    // 订阅链接：后端代拉脚本，成功后预填表单（已有内容不覆盖，只补空位）。
    async function fetchFromUrl() {
      const url = formSourceUrl.value.trim();
      if (!url) {
        toast("先粘贴订阅链接", "error");
        return;
      }
      fetchingUrl.value = true;
      try {
        const result = await api("/sources/lx-plugins/fetch", {
          method: "POST",
          body: { url },
        });
        formCode.value = result.code;
        if (!formName.value && result.meta?.name) formName.value = result.meta.name;
        if (!formId.value) formId.value = suggestPluginId(result.meta?.name, url);
        const version = result.meta?.version ? ` v${result.meta.version}` : "";
        toast(`已拉取「${result.meta?.name || "未命名脚本"}」${version}，确认后保存`, "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        fetchingUrl.value = false;
      }
    }

    async function savePlugin() {
      if (!formId.value.trim() || !formName.value.trim() || !formCode.value.trim()) {
        toast("插件 ID、名称和代码都不能为空", "error");
        return;
      }
      busy.value = true;
      try {
        await api("/sources/lx-plugins", {
          method: "POST",
          body: {
            id: formId.value.trim(),
            name: formName.value.trim(),
            code: formCode.value,
            enabled: formEnabled.value,
            defaultQuality: formQuality.value,
            ...(formSourceUrl.value.trim()
              ? { sourceUrl: formSourceUrl.value.trim() }
              : {}),
          },
        });
        formId.value = "";
        formName.value = "";
        formCode.value = "";
        formSourceUrl.value = "";
        await load();
        toast("插件已保存", "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        busy.value = false;
      }
    }

    // 订阅导入的插件一键更新：后端按记住的链接重拉并保存。
    async function updatePlugin(plugin) {
      updatingId.value = plugin.id;
      try {
        await api(`/sources/lx-plugins/${encodeURIComponent(plugin.id)}/update`, {
          method: "POST",
        });
        await load();
        toast(`「${plugin.name}」已从订阅链接更新`, "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        updatingId.value = "";
      }
    }

    async function toggleEnabled(plugin) {
      try {
        // saveLxPlugin 是全量 upsert，需要带上原代码。
        const codeResult = await api(`/sources/lx-plugins/${encodeURIComponent(plugin.id)}`);
        await api("/sources/lx-plugins", {
          method: "POST",
          body: {
            id: plugin.id,
            name: plugin.name,
            code: codeResult.code || "",
            enabled: !(plugin.enabled !== false),
            defaultQuality: plugin.defaultQuality || "320k",
          },
        });
        await load();
      } catch (error) {
        toast(error.message, "error");
      }
    }

    async function editPlugin(plugin) {
      try {
        const codeResult = await api(`/sources/lx-plugins/${encodeURIComponent(plugin.id)}`);
        formId.value = plugin.id;
        formName.value = plugin.name;
        formCode.value = codeResult.code || "";
        formQuality.value = plugin.defaultQuality || "320k";
        formEnabled.value = plugin.enabled !== false;
        formSourceUrl.value = plugin.sourceUrl || "";
        toast("插件已载入下方表单，改完保存即可", "info");
      } catch (error) {
        toast(error.message, "error");
      }
    }

    async function testPlugin(plugin) {
      try {
        const result = await api(`/sources/${encodeURIComponent(plugin.id)}/test`, {
          method: "POST",
        });
        await load();
        toast(result.message || "插件加载测试通过", "success");
      } catch (error) {
        toast(error.message, "error");
      }
    }

    async function deletePlugin(plugin) {
      const confirmed = await openConfirm({
        title: "删除插件",
        message: `「${plugin.name}」将被移除，正在使用它的解析会失效。`,
        confirmText: "删除",
        danger: true,
      });
      if (!confirmed) return;
      try {
        await api(`/sources/lx-plugins/${encodeURIComponent(plugin.id)}`, {
          method: "DELETE",
        });
        await load();
        toast("插件已删除", "success");
      } catch (error) {
        toast(error.message, "error");
      }
    }

    onMounted(load);

    return () =>
      h("div", { class: "section-body" }, [
        loadError.value
          ? ErrorState({ message: loadError.value, onRetry: load })
          : loading.value
            ? LoadingState()
            : plugins.value.length === 0
              ? EmptyState({
                  icon: Icons.plugin,
                  title: "还没有音源插件",
                  hint: "用下方任一通道添加",
                })
              : h("div", { class: "section-body" },
              plugins.value.map((p) =>
                h("section", { key: p.id, class: "card plugin-card" }, [
                  h("div", { class: "kv" }, [
                    h("div", null, [
                      h("div", { class: "track-title" }, p.name),
                      h("div", { class: "muted" }, [
                        h("span", { class: `dot dot-${healthOf(p.id) === "ok" ? "playing" : healthOf(p.id) === "failed" ? "error" : "idle"}` }),
                        `${p.id} · ${p.defaultQuality || "320k"} · 健康 ${healthOf(p.id)}`,
                      ]),
                    ]),
                    h("label", { class: "toggle" }, [
                      h("input", {
                        type: "checkbox",
                        checked: p.enabled !== false,
                        onChange: () => toggleEnabled(p),
                      }),
                      p.enabled !== false ? "启用" : "停用",
                    ]),
                  ]),
                  h("div", { class: "plugin-actions" }, [
                    h("button", { class: "secondary-btn", onClick: () => testPlugin(p) }, "测试"),
                    h("button", { class: "secondary-btn", onClick: () => editPlugin(p) }, "编辑"),
                    p.sourceUrl
                      ? h("button", {
                          class: "secondary-btn",
                          disabled: updatingId.value === p.id,
                          title: p.sourceUrl,
                          onClick: () => updatePlugin(p),
                        }, updatingId.value === p.id ? "更新中…" : "更新")
                      : null,
                    h("button", { class: "danger-btn", onClick: () => deletePlugin(p) }, "删除"),
                  ]),
                ]),
              ),
            ),

        h("section", { class: "card" }, [
          h("div", { class: "card-title" }, "添加 / 编辑插件"),
          h("label", { class: "field" }, [
            "订阅链接（推荐）",
            h("div", { class: "inline-form" }, [
              h("input", {
                placeholder: "https://…/script?key=xxx",
                value: formSourceUrl.value,
                onInput: (e) => (formSourceUrl.value = e.target.value),
                onKeyup: (e) => e.key === "Enter" && fetchFromUrl(),
              }),
              h("button", {
                class: "primary-btn",
                disabled: fetchingUrl.value,
                onClick: fetchFromUrl,
              }, fetchingUrl.value ? "拉取中…" : "拉取"),
            ]),
            h("small", { class: "hint" },
              "服务端会拉取脚本并预填下方表单；保存后列表里可一键「更新」。"),
          ]),
          h("label", { class: "file-pick" }, [
            h("input", { type: "file", accept: ".js", onChange: onPickFile, style: { display: "none" } }),
            "或选择 .js 插件文件",
          ]),
          h("div", { class: "muted center" }, "或粘贴插件代码 ↓"),
          h("textarea", {
            class: "code-area",
            rows: 6,
            placeholder: "// LX 音源插件代码…",
            value: formCode.value,
            onInput: (e) => (formCode.value = e.target.value),
          }),
          h("div", { class: "split" }, [
            h("label", { class: "field" }, [
              "插件 ID",
              h("input", {
                placeholder: "如 liuyin",
                value: formId.value,
                onInput: (e) => (formId.value = e.target.value),
              }),
            ]),
            h("label", { class: "field" }, [
              "名称",
              h("input", {
                value: formName.value,
                onInput: (e) => (formName.value = e.target.value),
              }),
            ]),
          ]),
          h("div", { class: "split" }, [
            h("label", { class: "field" }, [
              "默认音质",
              h("select", {
                value: formQuality.value,
                onChange: (e) => (formQuality.value = e.target.value),
              }, ["128k", "320k", "flac", "hires"].map((q) =>
                h("option", { value: q, selected: formQuality.value === q }, q))),
            ]),
            h("label", { class: "field checkbox-field" }, [
              h("input", {
                type: "checkbox",
                checked: formEnabled.value,
                onChange: (e) => (formEnabled.value = e.target.checked),
              }),
              "保存后启用",
            ]),
          ]),
          h("button", {
            class: "primary-btn",
            disabled: busy.value,
            onClick: savePlugin,
          }, busy.value ? "保存中…" : "保存插件"),
        ]),
      ]);
  },
};

// 订阅拉取后给插件 ID 一个可用的默认值：优先脚本名的 ASCII slug，
// 中文名 slug 后为空时退回域名 slug（如 lx.010504.xyz → lx-010504-xyz）。
function suggestPluginId(name, url) {
  const slug = (text) =>
    (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32);
  const fromName = slug(name);
  if (fromName) return fromName;
  try {
    return slug(new URL(url).hostname.replace(/\./g, "-")) || "lx-plugin";
  } catch {
    return "lx-plugin";
  }
}

// 本地下载子页：已下载列表（状态/大小/失败原因）+ 删除；下载进行中每 3s 轮询。
export const DownloadsSection = {
  setup() {
    const items = ref([]);
    const loading = ref(true);
    const loadError = ref("");
    let timer = 0;

    async function load(showLoading = true) {
      if (showLoading) loading.value = true;
      loadError.value = "";
      try {
        const result = await api("/downloads");
        items.value = result.downloads || [];
        scheduleRefresh();
      } catch (error) {
        loadError.value = error.message || "加载失败";
      } finally {
        if (showLoading) loading.value = false;
      }
    }

    function scheduleRefresh() {
      clearInterval(timer);
      const active = items.value.some(
        (d) => d.status === "pending" || d.status === "downloading",
      );
      if (active) timer = setInterval(() => load(false), 3000);
    }

    async function remove(item) {
      const confirmed = await openConfirm({
        title: "删除本地文件",
        message: `「${item.title}」的本地音频文件将从服务器磁盘删除。`,
        confirmText: "删除",
        danger: true,
      });
      if (!confirmed) return;
      try {
        await api(`/downloads/${encodeURIComponent(item.id)}`, {
          method: "DELETE",
        });
        await load(false);
        toast("已删除本地文件", "success");
      } catch (error) {
        toast(error.message, "error");
      }
    }

    async function retry(item) {
      try {
        await api("/downloads", {
          method: "POST",
          body: { track: item.track },
        });
        await load(false);
        toast(`重新下载：${item.title}`, "success");
      } catch (error) {
        toast(error.message, "error");
      }
    }

    onMounted(() => load());
    onUnmounted(() => clearInterval(timer));

    const STATUS_LABEL = {
      pending: "排队中",
      downloading: "下载中…",
      done: "已下载",
      failed: "失败",
    };

    function sizeLabel(bytes) {
      if (!bytes) return "";
      const mb = bytes / 1024 / 1024;
      return ` · ${mb >= 1 ? mb.toFixed(1) + " MB" : Math.round(bytes / 1024) + " KB"}`;
    }

    return () =>
      h("div", { class: "section-body" }, [
        h("p", { class: "hint" },
          "下载到服务器本地的歌播放时直接走本地文件——不再依赖平台直链，永不过期。" +
          "在搜索结果里点下载图标即可加入。"),
        loadError.value
          ? ErrorState({ message: loadError.value, onRetry: () => load() })
          : loading.value
            ? LoadingState()
            : items.value.length === 0
              ? EmptyState({
                  icon: Icons.download,
                  title: "还没有下载的音乐",
                  hint: "在搜索结果里点下载图标",
                })
              : h("ul", { class: "track-list card" },
              items.value.map((d) =>
                h("li", { key: d.id, class: "track-row" }, [
                  h("div", { class: "track-info" }, [
                    h("div", { class: "track-title" }, d.title),
                    h("div", { class: "track-artist" }, [
                      h("span", {
                        class: `dot dot-${d.status === "done" ? "playing" : d.status === "failed" ? "error" : "paused"}`,
                      }),
                      `${STATUS_LABEL[d.status] || d.status}${sizeLabel(d.byteSize)} · ${d.artist || "未知"}`,
                      d.status === "failed" && d.error
                        ? h("span", { class: "muted" }, `（${d.error}）`)
                        : null,
                    ]),
                  ]),
                  h("div", { class: "track-actions" }, [
                    d.status === "failed"
                      ? h("button", {
                          class: "icon-btn", title: "重试",
                          onClick: () => retry(d),
                        }, Icons.refresh())
                      : null,
                    h("button", {
                      class: "icon-btn", title: "删除本地文件",
                      onClick: () => remove(d),
                    }, Icons.close()),
                  ]),
                ]),
              ),
            ),
      ]);
  },
};

// 手工曲目子页：直接可播的音频 URL 列表（存 config.manualTracks）。
export const TracksSection = {
  setup() {
    const tracks = ref([]);
    const title = ref("");
    const artist = ref("");
    const url = ref("");
    const busy = ref(false);
    const loading = ref(true);
    const loadError = ref("");

    async function load() {
      loading.value = true;
      loadError.value = "";
      try {
        const config = await api("/config");
        tracks.value = config.manualTracks || [];
      } catch (error) {
        loadError.value = error.message || "加载失败";
      } finally {
        loading.value = false;
      }
    }

    async function saveTracks(next) {
      const config = await api("/config", {
        method: "PATCH",
        body: { manualTracks: next },
      });
      tracks.value = config.manualTracks || [];
    }

    async function addTrack() {
      if (!title.value.trim() || !url.value.trim()) {
        toast("标题和音频 URL 不能为空", "error");
        return;
      }
      busy.value = true;
      try {
        await saveTracks([
          ...tracks.value,
          {
            title: title.value.trim(),
            ...(artist.value.trim() ? { artist: artist.value.trim() } : {}),
            url: url.value.trim(),
          },
        ]);
        title.value = "";
        artist.value = "";
        url.value = "";
        toast("曲目已添加", "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        busy.value = false;
      }
    }

    async function removeTrack(index) {
      const track = tracks.value[index];
      const confirmed = await openConfirm({
        title: "删除曲目",
        message: `「${track.title}」将从手工曲目移除。`,
        confirmText: "删除",
        danger: true,
      });
      if (!confirmed) return;
      try {
        await saveTracks(tracks.value.filter((_, i) => i !== index));
        toast("曲目已删除", "success");
      } catch (error) {
        toast(error.message, "error");
      }
    }

    onMounted(load);

    return () =>
      h("div", { class: "section-body" }, [
        loadError.value
          ? ErrorState({ message: loadError.value, onRetry: load })
          : loading.value
            ? LoadingState()
            : tracks.value.length === 0
              ? EmptyState({ icon: Icons.file, title: "还没有手工曲目" })
              : h("ul", { class: "track-list card" },
              tracks.value.map((t, i) =>
                h("li", { key: `${t.url}-${i}`, class: "track-row" }, [
                  h("div", { class: "track-info" }, [
                    h("div", { class: "track-title" }, t.title),
                    h("div", { class: "track-artist" }, t.artist || t.url),
                  ]),
                  h("button", { class: "icon-btn", onClick: () => removeTrack(i) }, Icons.close()),
                ]),
              ),
            ),

        h("section", { class: "card" }, [
          h("div", { class: "card-title" }, "添加曲目"),
          h("div", { class: "split" }, [
            h("label", { class: "field" }, [
              "标题",
              h("input", { value: title.value, onInput: (e) => (title.value = e.target.value) }),
            ]),
            h("label", { class: "field" }, [
              "歌手（可选）",
              h("input", { value: artist.value, onInput: (e) => (artist.value = e.target.value) }),
            ]),
          ]),
          h("label", { class: "field" }, [
            "音频 URL",
            h("input", {
              placeholder: "https://example.com/song.mp3",
              value: url.value,
              onInput: (e) => (url.value = e.target.value),
            }),
          ]),
          h("button", {
            class: "primary-btn",
            disabled: busy.value,
            onClick: addTrack,
          }, "添加曲目"),
        ]),
      ]);
  },
};
