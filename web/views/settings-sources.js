import { ref, onMounted, h } from "vue";
import { api } from "/app/api.js";
import { toast } from "/app/main.js";

// LX 音源插件子页：列表（开关/测试/编辑/删除）+ 上传（选文件或粘贴代码）。
export const SourcesSection = {
  setup() {
    const plugins = ref([]);
    const sources = ref([]); // 带 health 状态
    const busy = ref(false);

    // 表单
    const formId = ref("");
    const formName = ref("");
    const formCode = ref("");
    const formQuality = ref("320k");
    const formEnabled = ref(true);

    async function load() {
      try {
        const [pluginsResult, sourcesResult] = await Promise.all([
          api("/sources/lx-plugins"),
          api("/sources"),
        ]);
        plugins.value = pluginsResult.plugins || [];
        sources.value = sourcesResult.sources || [];
      } catch (error) {
        toast(error.message, "error");
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
          },
        });
        formId.value = "";
        formName.value = "";
        formCode.value = "";
        await load();
        toast("插件已保存", "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        busy.value = false;
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
        plugins.value.length === 0
          ? h("div", { class: "muted center" }, "还没有 LX 插件，在下方添加一个音源插件")
          : h("div", { class: "section-body" },
              plugins.value.map((p) =>
                h("section", { key: p.id, class: "card plugin-card" }, [
                  h("div", { class: "kv" }, [
                    h("div", null, [
                      h("div", { class: "track-title" }, `🧩 ${p.name}`),
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
                    h("button", { class: "danger-btn", onClick: () => deletePlugin(p) }, "删除"),
                  ]),
                ]),
              ),
            ),

        h("section", { class: "card" }, [
          h("div", { class: "card-title" }, "添加 / 编辑插件"),
          h("label", { class: "file-pick" }, [
            h("input", { type: "file", accept: ".js", onChange: onPickFile, style: { display: "none" } }),
            "📂 选择 .js 插件文件",
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

// 手工曲目子页：直接可播的音频 URL 列表（存 config.manualTracks）。
export const TracksSection = {
  setup() {
    const tracks = ref([]);
    const title = ref("");
    const artist = ref("");
    const url = ref("");
    const busy = ref(false);

    async function load() {
      try {
        const config = await api("/config");
        tracks.value = config.manualTracks || [];
      } catch (error) {
        toast(error.message, "error");
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
        tracks.value.length === 0
          ? h("div", { class: "muted center" }, "还没有手工曲目")
          : h("ul", { class: "track-list card" },
              tracks.value.map((t, i) =>
                h("li", { key: `${t.url}-${i}`, class: "track-row" }, [
                  h("div", { class: "track-info" }, [
                    h("div", { class: "track-title" }, t.title),
                    h("div", { class: "track-artist" }, t.artist || t.url),
                  ]),
                  h("button", { class: "icon-btn", onClick: () => removeTrack(i) }, "✕"),
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
