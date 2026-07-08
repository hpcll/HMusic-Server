import { h, Teleport } from "vue";

// 通用模态框：半透明遮罩 + 居中卡片。点遮罩或按 Esc 关闭。
// 用法：v-if 控制挂载，传 title / onClose / 子节点（正文）。
// 用 Teleport 挂到 body，避免被局部 overflow/transform 裁切或压层级。
export function Modal(props, children) {
  const { title, onClose, footer } = props;
  return h(Teleport, { to: "body" }, [
    h(
      "div",
      {
        class: "modal-overlay",
        onClick: (e) => {
          if (e.target === e.currentTarget) onClose?.();
        },
      },
      [
        h("div", { class: "modal-card", role: "dialog", "aria-modal": "true" }, [
          h("div", { class: "modal-head" }, [
            h("h3", { class: "modal-title" }, title),
            h(
              "button",
              { class: "modal-close", title: "关闭", onClick: () => onClose?.() },
              "✕",
            ),
          ]),
          h("div", { class: "modal-body" }, children),
          footer ? h("div", { class: "modal-foot" }, footer) : null,
        ]),
      ],
    ),
  ]);
}
