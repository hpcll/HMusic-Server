import { h, ref } from "vue";
import { Modal } from "/app/components/modal.js";

const current = ref(null);
let resolveCurrent = null;

function settle(value) {
  const resolve = resolveCurrent;
  resolveCurrent = null;
  current.value = null;
  resolve?.(value);
}

export function openConfirm({
  title,
  message,
  confirmText = "确认",
  danger = false,
}) {
  // 新确认覆盖旧确认时先取消旧 Promise，避免调用方永久等待。
  if (resolveCurrent) settle(false);
  return new Promise((resolve) => {
    resolveCurrent = resolve;
    current.value = { title, message, confirmText, danger };
  });
}

export function renderConfirm() {
  if (!current.value) return null;
  const options = current.value;
  return h(Modal, {
    title: options.title,
    onClose: () => settle(false),
    footer: [
      h("button", { class: "secondary-btn", onClick: () => settle(false) }, "取消"),
      h("button", {
        class: options.danger ? "danger-btn" : "primary-btn",
        onClick: () => settle(true),
      }, options.confirmText),
    ],
  }, () => [
    h("p", { class: "muted", style: { margin: "0" } }, options.message),
  ]);
}
