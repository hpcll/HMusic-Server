import { ref, computed, h } from "vue";
import { api, setToken } from "/app/api.js";
import { store, refreshAuth, refreshPlayback, go, toast } from "/app/main.js";

// 登录 / 首次创建管理员二合一。后端 /auth/status 的 initialized 决定走哪条。
export const LoginView = {
  setup() {
    const username = ref("");
    const password = ref("");
    const busy = ref(false);
    const isSetup = computed(() => !store.initialized);

    async function submit() {
      if (busy.value) return;
      if (username.value.trim().length < 3) {
        toast("用户名至少 3 个字符", "error");
        return;
      }
      if (password.value.length < 8) {
        toast("密码至少 8 个字符", "error");
        return;
      }
      busy.value = true;
      try {
        const path = isSetup.value ? "/auth/setup" : "/auth/login";
        const result = await api(path, {
          method: "POST",
          body: { username: username.value.trim(), password: password.value },
        });
        setToken(result.accessToken);
        await refreshAuth();
        await refreshPlayback();
        toast(isSetup.value ? "管理员已创建" : "登录成功", "success");
        go("player");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        busy.value = false;
      }
    }

    return () =>
      h("div", { class: "login-page" }, [
        h("div", { class: "login-card" }, [
          h("div", { class: "login-brand" }, [
            h("img", { class: "login-logo", src: "/app/assets/logo-wordmark.png", alt: "HMusic" }),
          ]),
          h(
            "p",
            { class: "login-sub" },
            isSetup.value ? "首次使用，请创建管理员账号" : "登录你的 HMusic 服务",
          ),
          h("label", { class: "field" }, [
            "用户名",
            h("input", {
              value: username.value,
              autocomplete: "username",
              onInput: (e) => (username.value = e.target.value),
              onKeyup: (e) => e.key === "Enter" && submit(),
            }),
          ]),
          h("label", { class: "field" }, [
            "密码",
            h("input", {
              type: "password",
              value: password.value,
              autocomplete: isSetup.value ? "new-password" : "current-password",
              onInput: (e) => (password.value = e.target.value),
              onKeyup: (e) => e.key === "Enter" && submit(),
            }),
          ]),
          h(
            "button",
            { class: "primary-btn", disabled: busy.value, onClick: submit },
            busy.value ? "处理中…" : isSetup.value ? "创建并登录" : "登录",
          ),
        ]),
      ]);
  },
};
