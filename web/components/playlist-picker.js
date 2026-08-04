import { ref, h } from "vue";
import { api } from "/app/api.js";
import { Icons } from "/app/icons.js";
import { Modal } from "/app/components/modal.js";
import { toast } from "/app/main.js";

const pickerTrack = ref(null); // 非空时展示歌单选择器
const playlists = ref([]);
const playlistsLoading = ref(false);
const newName = ref("");
const pickBusy = ref(false);

export async function openPlaylistPicker(track) {
  pickerTrack.value = track;
  newName.value = "";
  playlistsLoading.value = true;
  try {
    const result = await api("/playlists");
    playlists.value = result.playlists || [];
  } catch (error) {
    toast(error.message, "error");
    playlists.value = [];
  } finally {
    playlistsLoading.value = false;
  }
}

function closePicker() {
  pickerTrack.value = null;
}

async function addToPlaylist(playlistId) {
  if (pickBusy.value) return;
  pickBusy.value = true;
  try {
    await api(`/playlists/${playlistId}/tracks`, {
      method: "POST",
      body: { track: pickerTrack.value },
    });
    toast(`已加入歌单：${pickerTrack.value.title}`, "success");
    closePicker();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    pickBusy.value = false;
  }
}

// 新建歌单并把当前歌曲加进去（快速通道）。
async function createAndAdd() {
  const name = newName.value.trim();
  if (!name || pickBusy.value) return;
  pickBusy.value = true;
  try {
    const created = await api("/playlists", {
      method: "POST",
      body: { name },
    });
    const id = created.playlist?.id;
    await api(`/playlists/${id}/tracks`, {
      method: "POST",
      body: { track: pickerTrack.value },
    });
    toast(`已创建「${name}」并加入歌曲`, "success");
    closePicker();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    pickBusy.value = false;
  }
}

export function renderPlaylistPicker() {
  if (!pickerTrack.value) return null;
  return h(Modal, {
    title: "加入歌单",
    onClose: closePicker,
  }, () => [
    h("div", { class: "picker-song muted" },
      `${pickerTrack.value.title} · ${pickerTrack.value.artist || "未知"}`),
    h("div", { class: "picker-create" }, [
      h("input", {
        class: "modal-input",
        placeholder: "新建歌单…",
        value: newName.value,
        onInput: (event) => (newName.value = event.target.value),
        onKeyup: (event) => event.key === "Enter" && createAndAdd(),
      }),
      h("button", {
        class: "primary-btn",
        disabled: pickBusy.value || !newName.value.trim(),
        onClick: createAndAdd,
      }, [Icons.plus(), "新建"]),
    ]),
    playlistsLoading.value
      ? h("div", { class: "muted center" }, "加载中…")
      : playlists.value.length === 0
        ? h("div", { class: "muted center" }, "还没有歌单，上面新建一个吧")
        : h("ul", { class: "picker-list" },
            playlists.value.map((playlist) =>
              h("li", {
                key: playlist.id,
                class: "picker-item",
                onClick: () => addToPlaylist(playlist.id),
              }, [
                h("span", { class: "pl-icon" }, Icons.playlists()),
                h("span", { class: "picker-name" }, playlist.name),
                h("span", { class: "muted" }, `${playlist.trackCount} 首`),
              ]),
            ),
          ),
  ]);
}
