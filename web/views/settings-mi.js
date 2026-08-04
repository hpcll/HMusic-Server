import { ref, onMounted, onUnmounted, h } from "vue";
import { api } from "/app/api.js";
import { toast } from "/app/main.js";

// 小米账号子页：状态卡 + 三通道（扫码 / 账号密码+短信 / 导入会话）。
// 扫码为主推通道：后端长轮询小米，前端本地渲染二维码并每 2s 查状态。
export const MiAccountSection = {
  setup() {
    const mi = ref(null);
    const tab = ref("qr");

    // 已登录时是否展开「更换账号」面板（Server 单账号模型：再登录是替换不是新增）。
    // loadStatus 每次成功都会收拢，登录/退出后自动回到状态卡视图。
    const changing = ref(false);

    // ── 扫码通道状态 ──
    const qr = ref(null); // {qrId, loginUrl, expiresAt}
    const qrSvg = ref("");
    const qrStatus = ref("idle"); // idle|loading|pending|success|failed|expired
    const qrMessage = ref("");
    const qrRemain = ref("");
    let qrPollTimer = 0;
    let qrTickTimer = 0;

    // ── 密码通道状态 ──
    const account = ref("");
    const password = ref("");
    const captcha = ref("");
    const challenge = ref(null); // {verificationId, maskedPhone, smsStatus, expiresAt}
    const smsCode = ref("");
    const busy = ref(false);

    // ── 导入通道状态 ──
    const importUrl = ref("");
    const importToken = ref("");
    const importUserId = ref("");

    async function loadStatus() {
      try {
        mi.value = await api("/mi/status");
        // 每次确认状态都收起「更换账号」：三通道登录成功/退出后回到默认视图。
        changing.value = false;
      } catch (error) {
        toast(error.message, "error");
      }
    }

    // 翻转「更换账号」面板。开合都复位三通道：重开从干净扫码页开始，
    // 收起同时停掉遗留的扫码轮询（否则折叠后仍可能被扫码顶号）。
    function toggleChanging() {
      changing.value = !changing.value;
      stopQrTimers();
      qr.value = null;
      qrSvg.value = "";
      qrStatus.value = "idle";
      qrMessage.value = "";
      qrRemain.value = "";
      tab.value = "qr";
      challenge.value = null;
    }

    // ===== 扫码 =====
    function stopQrTimers() {
      clearInterval(qrPollTimer);
      clearInterval(qrTickTimer);
    }

    async function startQr() {
      stopQrTimers();
      qrStatus.value = "loading";
      qrMessage.value = "";
      // 二维码库来自 index.html 的 <script src="vendor/qrcode.js">。若部署时漏带该文件，
      // window.qrcode 会是 undefined —— 提前拦截并给出可操作的提示，而非抛含糊错误。
      if (typeof window.qrcode !== "function") {
        qrStatus.value = "failed";
        qrMessage.value = "二维码组件未加载（缺 vendor/qrcode.js），请更新部署包或改用「账号密码」通道";
        return;
      }
      try {
        qr.value = await api("/mi/qr/start", { method: "POST" });
        const maker = window.qrcode(0, "M");
        maker.addData(qr.value.loginUrl);
        maker.make();
        qrSvg.value = maker.createSvgTag({ cellSize: 5, margin: 0, scalable: true });
        qrStatus.value = "pending";
        qrPollTimer = setInterval(pollQr, 2000);
        qrTickTimer = setInterval(tickCountdown, 1000);
        tickCountdown();
      } catch (error) {
        qrStatus.value = "failed";
        qrMessage.value = error.message;
      }
    }

    async function pollQr() {
      if (!qr.value) return;
      try {
        const result = await api(`/mi/qr/${qr.value.qrId}/status`);
        if (result.status === "success") {
          stopQrTimers();
          qrStatus.value = "success";
          await loadStatus();
          toast("小米账号已登录", "success");
        } else if (result.status === "failed" || result.status === "expired") {
          stopQrTimers();
          qrStatus.value = result.status;
          qrMessage.value = result.message || "";
        }
      } catch {
        // 单次轮询失败忽略，下一轮继续
      }
    }

    function tickCountdown() {
      if (!qr.value) return;
      const left = Math.max(0, Math.floor((qr.value.expiresAt - Date.now()) / 1000));
      const m = String(Math.floor(left / 60)).padStart(2, "0");
      const s = String(left % 60).padStart(2, "0");
      qrRemain.value = `${m}:${s}`;
    }

    // ===== 密码 + 短信 =====
    async function loginPassword() {
      if (!account.value.trim() || !password.value) {
        toast("请填写小米账号和密码", "error");
        return;
      }
      busy.value = true;
      try {
        const result = await api("/mi/verification/start", {
          method: "POST",
          body: {
            account: account.value.trim(),
            password: password.value,
            ...(captcha.value.trim() ? { captchaCode: captcha.value.trim() } : {}),
          },
        });
        if (result.loggedIn) {
          challenge.value = null;
          await loadStatus();
          toast(`登录成功，发现 ${result.deviceCount ?? 0} 台设备`, "success");
        } else {
          challenge.value = result;
          toast(smsHint(result.smsStatus), result.smsStatus === "limited" ? "error" : "info");
        }
      } catch (error) {
        toast(error.message, "error");
      } finally {
        busy.value = false;
      }
    }

    function smsHint(status) {
      if (status === "recent") return "短信最近已发过，直接填收到的验证码";
      if (status === "limited") return "短信被限频，建议改用扫码登录";
      return "验证码已发送";
    }

    async function confirmSms() {
      if (!smsCode.value.trim()) return;
      busy.value = true;
      try {
        const result = await api(
          `/mi/verification/${challenge.value.verificationId}/confirm`,
          { method: "POST", body: { code: smsCode.value.trim() } },
        );
        challenge.value = null;
        smsCode.value = "";
        await loadStatus();
        toast(`登录成功，发现 ${result.deviceCount ?? 0} 台设备`, "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        busy.value = false;
      }
    }

    async function resendSms() {
      try {
        const result = await api(
          `/mi/verification/${challenge.value.verificationId}/resend`,
          { method: "POST" },
        );
        toast(smsHint(result.smsStatus), "info");
      } catch (error) {
        toast(error.message, "error");
      }
    }

    // ===== 导入 =====
    async function importSession() {
      const url = importUrl.value.trim();
      const token = importToken.value.trim();
      const userId = importUserId.value.trim();
      if (!url && !(token && userId)) {
        toast("请填写 STS 地址，或 serviceToken + userId", "error");
        return;
      }
      busy.value = true;
      try {
        const webCredentials = url ? { stsUrl: url } : { serviceToken: token, userId };
        const result = await api("/mi/session/import", {
          method: "POST",
          body: { account: "imported", webCredentials },
        });
        await loadStatus();
        toast(`导入成功，发现 ${result.deviceCount ?? 0} 台设备`, "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        busy.value = false;
      }
    }

    async function logoutMi() {
      try {
        await api("/mi/logout", { method: "POST" });
        await loadStatus();
        toast("已退出小米账号", "success");
      } catch (error) {
        toast(error.message, "error");
      }
    }

    onMounted(loadStatus);
    onUnmounted(stopQrTimers);

    const TABS = [
      { key: "qr", label: "扫码登录" },
      { key: "password", label: "账号密码" },
      { key: "import", label: "导入会话" },
    ];

    return () => {
      // 未登录恒展开三通道；已登录默认只留状态卡，「更换账号」按需展开。
      const showPanel = !mi.value?.loggedIn || changing.value;
      return h("div", { class: "section-body" }, [
        // 状态卡：更换是低危动作用 ghost 灰阶；退出是破坏动作保持 danger。
        h("section", { class: "card" }, [
          mi.value?.loggedIn
            ? h("div", { class: "kv" }, [
                h("div", null, [
                  h("span", { class: "dot dot-playing" }),
                  `已登录 ${mi.value.accountMasked || ""}`,
                ]),
                h("div", { class: "kv-actions" }, [
                  h("button", { class: "ghost-btn", onClick: toggleChanging },
                    changing.value ? "取消更换" : "更换账号"),
                  h("button", { class: "danger-btn", onClick: logoutMi }, "退出登录"),
                ]),
              ])
            : mi.value?.sessionExpired
              ? h("div", null, [
                  h("span", { class: "dot dot-error" }),
                  `登录已失效${mi.value.accountMasked ? `（${mi.value.accountMasked}）` : ""}，请重新登录`,
                ])
              : h("div", null, [h("span", { class: "dot dot-idle" }), "未登录小米账号"]),
        ]),

        // 单账号模型：新登录会顶掉当前账号，展开时先把替换语义说清。
        showPanel && mi.value?.loggedIn
          ? h("p", { class: "hint" }, "登录新账号后将替换当前账号。")
          : null,

        // 通道 Tabs
        showPanel
          ? h("div", { class: "tabs" },
              TABS.map((t) =>
                h("button", {
                  key: t.key,
                  class: ["tab", { active: tab.value === t.key }],
                  onClick: () => (tab.value = t.key),
                }, t.label),
              ),
            )
          : null,

        showPanel && tab.value === "qr" ? renderQrTab() : null,
        showPanel && tab.value === "password" ? renderPasswordTab() : null,
        showPanel && tab.value === "import" ? renderImportTab() : null,
      ]);
    };

    function renderQrTab() {
      return h("section", { class: "card qr-card" }, [
        qrStatus.value === "idle"
          ? h("div", { class: "qr-idle" }, [
              h("p", { class: "muted" }, "用手机「米家」APP 扫码即可登录，无需短信验证码。"),
              h("button", { class: "primary-btn", onClick: startQr }, "生成二维码"),
            ])
          : null,
        qrStatus.value === "loading" ? h("div", { class: "muted center" }, "正在生成二维码…") : null,
        qrStatus.value === "pending"
          ? h("div", { class: "qr-live" }, [
              h("div", { class: "qr-box", innerHTML: qrSvg.value }),
              h("div", { class: "qr-tip" }, [
                h("span", { class: "dot dot-paused" }),
                "等待扫码 · 打开「米家」APP 扫一扫",
              ]),
              h("div", { class: "muted" }, [
                `${qrRemain.value} 后过期 `,
                h("button", { class: "ghost-btn", onClick: startQr }, "重新生成"),
              ]),
            ])
          : null,
        qrStatus.value === "success"
          ? h("div", { class: "qr-done" }, [
              h("div", { class: "qr-ok" }, "登录成功"),
              h("p", { class: "muted" }, "设备已自动刷新，可去「播放设备」选默认音箱。"),
            ])
          : null,
        qrStatus.value === "expired" || qrStatus.value === "failed"
          ? h("div", { class: "qr-idle" }, [
              h("p", { class: "muted" },
                qrStatus.value === "expired" ? "二维码已过期" : `失败：${qrMessage.value}`),
              h("button", { class: "primary-btn", onClick: startQr }, "重新生成"),
              qrStatus.value === "failed"
                ? h("p", { class: "hint" }, "多次失败可改用「账号密码」通道。")
                : null,
            ])
          : null,
      ]);
    }

    function renderPasswordTab() {
      return h("div", { class: "section-body" }, [
        h("section", { class: "card" }, [
          h("label", { class: "field" }, [
            "小米账号（手机号 / 邮箱）",
            h("input", {
              value: account.value,
              autocomplete: "username",
              onInput: (e) => (account.value = e.target.value),
            }),
          ]),
          h("label", { class: "field" }, [
            "密码",
            h("input", {
              type: "password",
              value: password.value,
              autocomplete: "current-password",
              onInput: (e) => (password.value = e.target.value),
            }),
          ]),
          h("label", { class: "field" }, [
            "图形验证码（仅提示需要时填写）",
            h("input", {
              value: captcha.value,
              onInput: (e) => (captcha.value = e.target.value),
            }),
          ]),
          h("button", {
            class: "primary-btn",
            disabled: busy.value,
            onClick: loginPassword,
          }, busy.value ? "登录中…" : "登录小米账号"),
        ]),

        challenge.value
          ? h("section", { class: "card sms-card" }, [
              h("div", { class: "card-title" },
                `验证码已发至 ${challenge.value.maskedPhone || "绑定手机"}`),
              h("div", { class: "inline-form" }, [
                h("input", {
                  placeholder: "短信验证码",
                  value: smsCode.value,
                  onInput: (e) => (smsCode.value = e.target.value),
                  onKeyup: (e) => e.key === "Enter" && confirmSms(),
                }),
                h("button", {
                  class: "primary-btn",
                  disabled: busy.value,
                  onClick: confirmSms,
                }, "确认验证"),
              ]),
              h("div", { class: "sms-actions" }, [
                h("button", { class: "ghost-btn", onClick: resendSms }, "重新发送"),
                h("button", {
                  class: "ghost-btn",
                  onClick: () => (challenge.value = null),
                }, "重新登录"),
              ]),
            ])
          : null,
      ]);
    }

    function renderImportTab() {
      return h("section", { class: "card" }, [
        h("p", { class: "hint" },
          "兜底通道：粘贴验证完成后的 STS 地址，或直接填 serviceToken + userId。"),
        h("label", { class: "field" }, [
          "STS 地址",
          h("input", {
            placeholder: "https://api2.mina.mi.com/sts?…",
            value: importUrl.value,
            onInput: (e) => (importUrl.value = e.target.value),
          }),
        ]),
        h("div", { class: "muted center" }, "— 或 —"),
        h("label", { class: "field" }, [
          "serviceToken",
          h("input", {
            value: importToken.value,
            onInput: (e) => (importToken.value = e.target.value),
          }),
        ]),
        h("label", { class: "field" }, [
          "userId",
          h("input", {
            value: importUserId.value,
            onInput: (e) => (importUserId.value = e.target.value),
          }),
        ]),
        h("button", {
          class: "primary-btn",
          disabled: busy.value,
          onClick: importSession,
        }, busy.value ? "导入中…" : "导入会话"),
      ]);
    }
  },
};
