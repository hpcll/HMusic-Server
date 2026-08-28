import { ref, computed, onMounted, onUnmounted, h } from "vue";
import { api } from "/app/api.js";
import { toast } from "/app/main.js";
import { openConfirm } from "/app/components/confirm.js";

// 关于与更新：服务端版本 + GitHub Release 检查 + 一键升级 + 升级日志。
// 后端三件套（GET/POST /system/update、GET /system/update/log）此前只有 App 在用，
// 只用网页管理的用户根本不知道有新版，这里把同一套能力补齐到 SPA。
//
// 升级过程中服务端会重启（Docker 下是容器被重建），所以不能靠一次响应判成败：
// 触发后轮询公开的 /system/info，版本号变了才算成功——与 App 端同一策略。
const POLL_MS = 3000;
const POLL_MAX_TICKS = 60; // 3 分钟：弱设备上 npm install 可能很慢

export const UpdateSection = {
  setup() {
    const version = ref("");
    const info = ref(null); // /system/update 的检查结果
    const checking = ref(false);
    const upgrading = ref(false);
    const log = ref("");
    const logOpen = ref(false);
    let timer = 0;
    let ticks = 0;

    const hasUpdate = computed(() => Boolean(info.value?.hasUpdate));

    async function loadVersion() {
      try {
        version.value = (await api("/system/info")).version || "";
      } catch {
        // 纯展示，失败留空；点检查更新时会报具体错误。
      }
    }

    // 进页先读一次日志：它同时带 updating 标记，能接上「上次没看完的升级」——
    // 用户中途切走页面再回来，进度不会凭空消失。
    async function loadLog(silent = true) {
      try {
        const result = await api("/system/update/log");
        log.value = result.log || "";
        if (result.updating && !upgrading.value) startPolling(version.value);
        return true;
      } catch (error) {
        if (!silent) toast(error.message, "error");
        return false;
      }
    }

    async function check() {
      if (checking.value) return;
      checking.value = true;
      try {
        info.value = await api("/system/update");
        version.value = info.value.current || version.value;
        if (info.value.updating && !upgrading.value) startPolling(version.value);
        else if (!info.value.hasUpdate) toast("已是最新版本", "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        checking.value = false;
      }
    }

    async function upgrade() {
      if (upgrading.value) return;
      const ok = await openConfirm({
        title: "升级服务端",
        message:
          "服务端会下载新版并自动重启，期间播放控制和本页面会短暂不可用。继续吗？",
        confirmText: "开始升级",
      });
      if (!ok) return;

      const before = info.value?.current || version.value;
      upgrading.value = true;
      try {
        await api("/system/update", { method: "POST" });
      } catch (error) {
        // 409 都是「能做但现在不行」（守护缺失/部署不支持/已在升级中），
        // 后端文案已经写明下一步该干什么，原样透出去。
        upgrading.value = false;
        toast(error.message, "error");
        return;
      }
      logOpen.value = true;
      startPolling(before);
    }

    function startPolling(before) {
      stopPolling();
      upgrading.value = true;
      ticks = 0;
      // 基线版本可能还没拿到（进页时两个请求并发，或 /system/info 失败）。
      // 基线为空就把第一次读到的版本当基线，否则「非空 != 空」会当场误报升级成功。
      let baseline = before || version.value;
      timer = setInterval(async () => {
        ticks += 1;
        try {
          const current = (await api("/system/info")).version || "";
          if (!baseline) {
            baseline = current;
          } else if (current && current !== baseline) {
            stopPolling();
            upgrading.value = false;
            version.value = current;
            info.value = null;
            loadLog();
            toast(`服务端已升级到 v${current}`, "success");
            return;
          }
        } catch {
          // 重启窗口内请求失败属正常，下一轮再探。
        }
        loadLog();
        if (ticks >= POLL_MAX_TICKS) {
          stopPolling();
          upgrading.value = false;
          toast(
            "升级还没结束（可能仍在进行）。稍后再检查版本，或查看下方升级日志",
            "error",
          );
        }
      }, POLL_MS);
    }

    function stopPolling() {
      clearInterval(timer);
      timer = 0;
    }

    onMounted(async () => {
      // 先版本再日志：日志里的 updating 会拿版本当轮询基线，反过来会误判。
      await loadVersion();
      await loadLog();
    });
    onUnmounted(stopPolling);

    return () => {
      const it = info.value;
      return h("div", { class: "section-body" }, [
        h("section", { class: "card" }, [
          h("div", { class: "card-title" }, "HMusic Server"),
          h("div", { class: "inline-form" }, [
            h("div", { class: "muted", style: "flex:1" }, [
              version.value ? `当前版本 v${version.value}` : "当前版本未知",
              it ? ` · ${DEPLOY_LABELS[it.deployMode] || it.deployMode}` : "",
            ]),
            h(
              "button",
              {
                class: "secondary-btn",
                disabled: checking.value || upgrading.value,
                onClick: check,
              },
              checking.value ? "检查中…" : "检查更新",
            ),
          ]),

          upgrading.value
            ? h("p", { class: "hint" }, "正在升级，服务端会短暂重启，请勿断电或关闭容器…")
            : null,

          !upgrading.value && hasUpdate.value
            ? h("div", { class: "update-found" }, [
                h("div", { class: "card-title" }, `发现新版本 ${tagLabel(it.latest)}`),
                it.publishedAt
                  ? h("div", { class: "hint" }, `发布于 ${formatDate(it.publishedAt)}`)
                  : null,
                it.notes ? h("pre", { class: "log-block" }, it.notes) : null,
                it.canSelfUpdate
                  ? h(
                      "button",
                      { class: "primary-btn", onClick: upgrade },
                      "立即升级",
                    )
                  : h("p", { class: "hint" }, cannotUpdateHint(it.deployMode)),
                it.url
                  ? h(
                      "a",
                      {
                        class: "muted",
                        href: it.url,
                        target: "_blank",
                        rel: "noreferrer",
                      },
                      "打开 Release 页面 ›",
                    )
                  : null,
              ])
            : null,

          !upgrading.value && it && !it.hasUpdate
            ? h("p", { class: "hint" }, "已是最新版本。")
            : null,
        ]),

        h("section", { class: "card" }, [
          h("div", { class: "inline-form" }, [
            h("div", { class: "card-title", style: "flex:1" }, "升级日志"),
            h(
              "button",
              {
                class: "secondary-btn",
                onClick: async () => {
                  logOpen.value = true;
                  await loadLog(false);
                },
              },
              logOpen.value ? "刷新" : "查看",
            ),
          ]),
          logOpen.value
            ? log.value
              ? h("pre", { class: "log-block" }, log.value)
              : h("p", { class: "hint" }, "还没有升级记录。")
            : h(
                "p",
                { class: "hint" },
                "记录一键升级的执行过程，服务端文件位置：data/update.log（只显示末尾 8KB）。",
              ),
        ]),
      ]);
    };
  },
};

const DEPLOY_LABELS = {
  docker: "Docker 部署",
  native: "原生部署",
  unknown: "部署方式未知",
};

// canSelfUpdate 为假的两种成因分开说：Docker 是守护没配好（可补救），
// 其它是找不到 install.sh（只能手动更新）。
function cannotUpdateHint(mode) {
  return mode === "docker"
    ? "这台服务端还没有升级守护（旧版 Docker 部署）：在宿主机进入安装目录执行一次 bash install.sh --update，之后就能在这里一键升级。"
    : "当前部署方式不支持一键升级，请在宿主机执行 bash install.sh --update，或参考 README 手动更新。";
}

// latest 直接来自 Release 的 tag_name，实测带 v 前缀（如 "v0.2.1"），
// 而 current 是 package.json 版本（"0.2.1"）。两边都补成 vX.Y.Z 再显示，
// 免得出现「发现新版本 vv0.2.1」。
function tagLabel(version) {
  const text = String(version || "");
  return text.startsWith("v") ? text : `v${text}`;
}

function formatDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
