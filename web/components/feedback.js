import { h } from "vue";
import { Icons } from "/app/icons.js";

// 共享反馈态只负责布局，页面仍保留各自的数据加载与业务语义。
export function EmptyState({ icon = Icons.note, title, hint, action } = {}) {
  return h("div", { class: "state-block" }, [
    h("div", { class: "state-icon" }, icon()),
    h("div", { class: "state-title" }, title),
    hint ? h("div", { class: "state-hint" }, hint) : null,
    action ? h("div", { class: "state-action" }, action) : null,
  ]);
}

export function LoadingState({ label = "加载中…" } = {}) {
  return h("div", { class: "state-block" }, [
    h("div", { class: "spinner", role: "status", "aria-label": label }),
    h("div", { class: "state-hint" }, label),
  ]);
}

export function ErrorState({ message, onRetry } = {}) {
  return EmptyState({
    icon: Icons.close,
    title: message || "加载失败",
    action: h("button", { class: "secondary-btn", onClick: onRetry }, "重试"),
  });
}
