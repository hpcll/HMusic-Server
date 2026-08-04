import { h, Teleport, onMounted, onUnmounted, ref } from "vue";

// 通用模态框：半透明遮罩 + 居中卡片。点遮罩或按 Esc 关闭。
// 用法：v-if 控制挂载，传 title / onClose / 默认插槽（正文）。
// 用 Teleport 挂到 body，避免被局部 overflow/transform 裁切或压层级。
export const Modal = {
  props: {
    title: String,
    onClose: Function,
    footer: [Array, Object],
  },
  setup(props, { slots }) {
    const card = ref(null);

    function onKeydown(event) {
      if (event.key === "Escape") props.onClose?.();
    }

    onMounted(() => {
      window.addEventListener("keydown", onKeydown);
      // 自动聚焦收归 Modal：优先卡片内第一个输入控件，其次卡片本身。
      // 各调用点不再各自用 ref 抢焦点，杜绝与本兜底的时序竞争。
      const target = card.value?.querySelector("input, textarea, select") || card.value;
      target?.focus();
    });
    onUnmounted(() => window.removeEventListener("keydown", onKeydown));

    return () =>
      h(Teleport, { to: "body" }, [
        h(
          "div",
          {
            class: "modal-overlay",
            onClick: (event) => {
              if (event.target === event.currentTarget) props.onClose?.();
            },
          },
          [
            h("div", {
              ref: card,
              class: "modal-card",
              role: "dialog",
              "aria-modal": "true",
              tabindex: -1,
            }, [
              h("div", { class: "modal-head" }, [
                h("h3", { class: "modal-title" }, props.title),
                h(
                  "button",
                  { class: "modal-close", title: "关闭", onClick: () => props.onClose?.() },
                  "✕",
                ),
              ]),
              h("div", { class: "modal-body" }, slots.default?.()),
              props.footer ? h("div", { class: "modal-foot" }, props.footer) : null,
            ]),
          ],
        ),
      ]);
  },
};
