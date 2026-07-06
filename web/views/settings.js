import { ref, onMounted, h } from "vue";
import { api, setToken } from "/app/api.js";
import { toast } from "/app/main.js";

// 设置页（管理员）：小米账号状态、运行配置、自定义型号、设备刷新。
// 复杂的小米短信/网页验证仍走老的 /admin 页面，这里给出入口链接。
export const SettingsView = {
  setup() {
    const mi = ref(null);
    const config = ref(null);
    const extraModels = ref("");
    const saving = ref(false);
    const refreshing = ref(false);
    const currentPassword = ref("");
    const newPassword = ref("");
    const changingPw = ref(false);

    async function load() {
      try {
        const [miStatus, cfg] = await Promise.all([
          api("/mi/status"),
          api("/config"),
        ]);
        mi.value = miStatus;
        config.value = cfg;
        extraModels.value = (cfg.extraPlayMusicModels || []).join(", ");
      } catch (error) {
        toast(error.message, "error");
      }
    }

    async function saveConfig() {
      saving.value = true;
      try {
        const next = await api("/config", {
          method: "PATCH",
          body: {
            serverName: config.value.serverName,
            defaultQuality: config.value.defaultQuality,
            extraPlayMusicModels: parseModels(extraModels.value),
          },
        });
        config.value = next;
        extraModels.value = (next.extraPlayMusicModels || []).join(", ");
        toast("配置已保存", "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        saving.value = false;
      }
    }

    async function refreshDevices() {
      refreshing.value = true;
      try {
        const result = await api("/devices/refresh", { method: "POST" });
        toast(`已刷新，共 ${result.deviceCount} 个设备`, "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        refreshing.value = false;
      }
    }

    async function logoutMi() {
      try {
        await api("/mi/logout", { method: "POST" });
        await load();
        toast("已退出小米账号", "success");
      } catch (error) {
        toast(error.message, "error");
      }
    }

    async function doChangePassword() {
      if (newPassword.value.length < 8) {
        toast("新密码至少 8 个字符", "error");
        return;
      }
      changingPw.value = true;
      try {
        const result = await api("/auth/password", {
          method: "POST",
          body: {
            currentPassword: currentPassword.value,
            newPassword: newPassword.value,
          },
        });
        // 后端签发了新 token，续上会话免重登。
        setToken(result.accessToken);
        currentPassword.value = "";
        newPassword.value = "";
        toast("密码已修改", "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        changingPw.value = false;
      }
    }

    onMounted(load);

    return () =>
      h("main", { class: "view settings-view" }, [
        h("h2", { class: "view-title" }, "设置"),

        h("section", { class: "card" }, [
          h("div", { class: "card-title" }, "小米账号"),
          mi.value?.loggedIn
            ? h("div", { class: "kv" }, [
                h("div", null, [h("span", { class: "muted" }, "账号 "), mi.value.accountMasked || "已登录"]),
                h("button", { class: "danger-btn", onClick: logoutMi }, "退出登录"),
              ])
            : h("div", { class: "kv" }, [
                h("span", { class: "muted" }, "未登录小米账号"),
                h("a", { class: "secondary-btn", href: "/admin", target: "_blank" }, "去 /admin 登录"),
              ]),
        ]),

        config.value
          ? h("section", { class: "card" }, [
              h("div", { class: "card-title" }, "运行配置"),
              h("label", { class: "field" }, [
                "服务端名称",
                h("input", {
                  value: config.value.serverName,
                  onInput: (e) => (config.value.serverName = e.target.value),
                }),
              ]),
              h("label", { class: "field" }, [
                "默认音质",
                h("select", {
                  value: config.value.defaultQuality,
                  onChange: (e) => (config.value.defaultQuality = e.target.value),
                }, ["128k", "320k", "flac", "hires"].map((q) =>
                  h("option", { value: q, selected: config.value.defaultQuality === q }, q))),
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
              h("button", { class: "primary-btn", disabled: saving.value, onClick: saveConfig },
                saving.value ? "保存中…" : "保存配置"),
            ])
          : null,

        h("section", { class: "card" }, [
          h("div", { class: "card-title" }, "播放设备"),
          h("button", { class: "secondary-btn", disabled: refreshing.value, onClick: refreshDevices },
            refreshing.value ? "刷新中…" : "刷新设备列表"),
          h("p", { class: "hint" }, "更完整的设备管理、LX 插件、手工曲目请到 ",
            h("a", { href: "/admin", target: "_blank" }, "/admin"), " 页面。"),
        ]),

        h("section", { class: "card" }, [
          h("div", { class: "card-title" }, "修改密码"),
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
              onKeyup: (e) => e.key === "Enter" && doChangePassword(),
            }),
          ]),
          h("button", {
            class: "primary-btn",
            disabled: changingPw.value || !currentPassword.value || !newPassword.value,
            onClick: doChangePassword,
          }, changingPw.value ? "修改中…" : "修改密码"),
        ]),
      ]);
  },
};

function parseModels(value) {
  const seen = new Set();
  return (value || "")
    .split(/[\s,，、]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => {
      if (!s || !/^[A-Z0-9]+$/.test(s) || seen.has(s)) return false;
      seen.add(s);
      return true;
    });
}
