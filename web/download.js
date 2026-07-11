import { ref, h } from "vue";
import { api } from "/app/api.js";
import { Icons } from "/app/icons.js";
import { Modal } from "/app/components/modal.js";
import { toast } from "/app/main.js";

// 下载共享模块：音质选择弹窗 + 「已下载」角标状态集。
// 模型：下载是曲目级缓存，与歌单正交——任何列表行都可发起下载/显示角标。

// ── 已下载状态（全站共享）：keys 供角标判断，list 供「已下载」视图播放 ──
export const downloadedKeys = ref(new Set());
export const downloadedList = ref([]); // status=done 的完整记录（含可播 track）

export function trackKeyOf(track) {
  return track ? `${track.source}:${track.sourceTrackId}` : "";
}

export function isDownloaded(track) {
  return downloadedKeys.value.has(trackKeyOf(track));
}

// 曲目行「已下载」角标（贴标题后）；未下载返回 null。
export function downloadedBadge(track) {
  return isDownloaded(track)
    ? h("span", { class: "dl-badge", title: "已下载到服务器" }, Icons.download())
    : null;
}

// 进列表页时调用刷新（尽力而为，失败不打扰）。
export async function refreshDownloadedKeys() {
  try {
    const result = await api("/downloads");
    const done = (result.downloads || []).filter((d) => d.status === "done");
    downloadedList.value = done;
    downloadedKeys.value = new Set(done.map((d) => d.trackKey));
  } catch {
    // 角标缺席不影响功能
  }
}

// ── 音质选择弹窗 ──
const QUALITIES = [
  { value: "128k", label: "128k", desc: "省空间" },
  { value: "320k", label: "320k", desc: "推荐" },
  { value: "flac", label: "FLAC", desc: "无损" },
  { value: "hires", label: "Hi-Res", desc: "高解析" },
];

const pickerTrack = ref(null); // 非空时展示弹窗
const picked = ref("320k");
const busy = ref(false);
let defaultQualityCache = "";

// 打开音质弹窗（默认选中运行配置的 defaultQuality，取一次缓存复用）。
export async function openDownloadPicker(track) {
  if (!defaultQualityCache) {
    try {
      const config = await api("/config");
      defaultQualityCache = config.defaultQuality || "320k";
    } catch {
      defaultQualityCache = "320k";
    }
  }
  picked.value = defaultQualityCache;
  pickerTrack.value = track;
}

async function confirmDownload() {
  if (busy.value || !pickerTrack.value) return;
  busy.value = true;
  const track = pickerTrack.value;
  try {
    const result = await api("/downloads", {
      method: "POST",
      body: { track, quality: picked.value },
    });
    const status = result.download?.status;
    toast(
      status === "done" ? `已在本地：${track.title}` : `开始下载：${track.title}`,
      "success",
    );
    pickerTrack.value = null;
    refreshDownloadedKeys();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    busy.value = false;
  }
}

// 各页在根节点末尾挂上 renderDownloadPicker()，弹窗才有处渲染。
export function renderDownloadPicker() {
  if (!pickerTrack.value) return null;
  const track = pickerTrack.value;
  return Modal(
    {
      title: "下载音质",
      onClose: () => (pickerTrack.value = null),
      footer: [
        h("button", {
          class: "secondary-btn",
          disabled: busy.value,
          onClick: () => (pickerTrack.value = null),
        }, "取消"),
        h("button", {
          class: "primary-btn",
          disabled: busy.value,
          onClick: confirmDownload,
        }, busy.value ? "提交中…" : "开始下载"),
      ],
    },
    [
      h("div", { class: "picker-song muted" },
        `${track.title} · ${track.artist || "未知"}`),
      h("div", { class: "quality-grid" },
        QUALITIES.map((q) =>
          h("button", {
            key: q.value,
            class: ["quality-item", { active: picked.value === q.value }],
            onClick: () => (picked.value = q.value),
          }, [
            h("div", { class: "quality-label" }, q.label),
            h("div", { class: "muted" }, q.desc),
          ]),
        ),
      ),
      h("p", { class: "hint" }, "所选音质源站没有时会自动降档，下载列表里可见实际档位。"),
    ],
  );
}
