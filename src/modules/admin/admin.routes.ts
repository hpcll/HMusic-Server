import type { FastifyInstance } from "fastify";

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(renderAdminHtml());
  });

  app.get("/admin/", async (_request, reply) => {
    return reply.redirect("/admin");
  });
}

function renderAdminHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>HMusic Server 管理</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f8f8;
        --panel: #ffffff;
        --text: #1f2a2a;
        --muted: #667575;
        --line: #d9e1e1;
        --brand: #12a594;
        --brand-dark: #0b7f72;
        --danger: #b42318;
        --warn-bg: #fff7e6;
        --warn-text: #7a4b00;
        --ok-bg: #e8f7f4;
        --ok-text: #075e54;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font-family:
          -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.5;
      }

      header {
        border-bottom: 1px solid var(--line);
        background: var(--panel);
      }

      .shell {
        width: min(1120px, calc(100% - 32px));
        margin: 0 auto;
      }

      .topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        min-height: 72px;
        gap: 16px;
      }

      h1 {
        margin: 0;
        font-size: 24px;
        font-weight: 700;
      }

      main {
        padding: 24px 0 40px;
      }

      .grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(320px, 420px);
        gap: 20px;
        align-items: start;
      }

      .section {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 20px;
        margin-bottom: 20px;
      }

      .section h2 {
        margin: 0 0 12px;
        font-size: 18px;
      }

      .subtle {
        color: var(--muted);
        font-size: 14px;
      }

      label {
        display: grid;
        gap: 6px;
        margin: 12px 0;
        font-size: 14px;
        color: var(--muted);
      }

      .hint {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.4;
      }

      input,
      select,
      textarea {
        width: 100%;
        min-height: 44px;
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 10px 12px;
        color: var(--text);
        font: inherit;
        background: #fff;
      }

      textarea {
        min-height: 180px;
        resize: vertical;
        font-family:
          ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 13px;
      }

      input:focus,
      select:focus,
      textarea:focus {
        outline: 2px solid rgba(18, 165, 148, 0.22);
        border-color: var(--brand);
      }

      .split {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 16px;
      }

      button,
      .button-link {
        min-height: 42px;
        border: 1px solid var(--brand);
        border-radius: 6px;
        padding: 9px 14px;
        background: var(--brand);
        color: #fff;
        font: inherit;
        font-weight: 650;
        cursor: pointer;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      button.secondary,
      .button-link.secondary {
        background: #fff;
        color: var(--brand-dark);
      }

      button.danger {
        border-color: var(--danger);
        background: #fff;
        color: var(--danger);
      }

      button:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }

      .status {
        display: grid;
        gap: 8px;
        margin-top: 12px;
      }

      .pill {
        display: inline-flex;
        width: fit-content;
        border-radius: 999px;
        padding: 5px 10px;
        background: var(--ok-bg);
        color: var(--ok-text);
        font-size: 13px;
        font-weight: 650;
      }

      .pill.warn {
        background: var(--warn-bg);
        color: var(--warn-text);
      }

      .message {
        border-radius: 6px;
        padding: 10px 12px;
        margin: 12px 0;
        background: var(--ok-bg);
        color: var(--ok-text);
        font-size: 14px;
      }

      .message.error {
        background: #fff1f0;
        color: var(--danger);
      }

      .message.warn {
        background: var(--warn-bg);
        color: var(--warn-text);
      }

      details.inline-panel {
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 12px;
        margin-top: 14px;
      }

      details.inline-panel summary {
        cursor: pointer;
        color: var(--brand-dark);
        font-weight: 650;
      }

      .device-list {
        display: grid;
        gap: 10px;
        margin-top: 12px;
      }

      .item-list {
        display: grid;
        gap: 10px;
        margin-top: 12px;
      }

      .device,
      .list-item {
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 12px;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
        align-items: center;
      }

      .device strong,
      .list-item strong {
        display: block;
        font-size: 15px;
      }

      .list-item.full {
        grid-template-columns: 1fr;
      }

      .mini {
        min-height: 34px;
        padding: 6px 10px;
        font-size: 13px;
      }

      .inline-check {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .inline-check input {
        width: auto;
        min-height: auto;
      }

      .hidden {
        display: none !important;
      }

      @media (max-width: 860px) {
        .grid {
          grid-template-columns: 1fr;
        }

        .split {
          grid-template-columns: 1fr;
        }

        .topbar {
          align-items: flex-start;
          flex-direction: column;
          justify-content: center;
          padding: 14px 0;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="shell topbar">
        <div>
          <h1>HMusic Server 管理</h1>
          <div class="subtle" id="serverInfo">正在连接服务端...</div>
        </div>
        <button id="logoutButton" class="secondary hidden" type="button">退出登录</button>
      </div>
    </header>

    <main class="shell">
      <div id="globalMessage" class="message hidden"></div>

      <section id="authSection" class="section">
        <h2 id="authTitle">管理员登录</h2>
        <p class="subtle" id="authHint">首次使用需要创建管理员账号，之后使用该账号管理服务端。</p>
        <label>
          管理员账号
          <input id="adminUser" autocomplete="username" value="admin" />
        </label>
        <label>
          管理员密码
          <input id="adminPass" autocomplete="current-password" type="password" />
        </label>
        <div class="actions">
          <button id="authButton" type="button">登录</button>
        </div>
      </section>

      <div id="dashboard" class="grid hidden">
        <div>
          <section class="section">
            <h2>小米账号</h2>
            <p class="subtle">账号密码只提交给当前 HMusic Server。服务端保存小米登录凭据，App 不需要保存小米密码。</p>
            <label>
              小米账号
              <input id="miAccount" autocomplete="username" />
            </label>
            <label>
              小米密码
              <input id="miPassword" autocomplete="current-password" type="password" />
            </label>
            <label>
              图形验证码
              <input id="miCaptcha" autocomplete="one-time-code" placeholder="仅在服务端提示图形验证码时填写" />
            </label>
            <div class="actions">
              <button id="miLoginButton" type="button">登录小米账号</button>
              <button id="miWebLoginButton" class="secondary" type="button">短信验证码登录</button>
              <button id="miStatusButton" class="secondary" type="button">刷新状态</button>
            </div>
            <div id="miVerification" class="message warn hidden"></div>
            <div id="miWebVerification" class="message warn hidden"></div>
            <details class="inline-panel">
              <summary>导入已有小米会话</summary>
              <p class="subtle">当短信验证被限制时，可从已登录 Cookie 或 STS 回调导入。</p>
              <label>
                账号标识
                <input id="miImportAccount" placeholder="用于后台展示，可填手机号或邮箱" />
              </label>
              <label>
                STS URL
                <input id="miImportStsUrl" placeholder="https://api2.mina.mi.com/sts?..." />
              </label>
              <div class="split">
                <label>
                  serviceToken
                  <input id="miImportServiceToken" />
                </label>
                <label>
                  userId
                  <input id="miImportUserId" />
                </label>
              </div>
              <label>
                ssecurity
                <input id="miImportSsecurity" />
              </label>
              <div class="actions">
                <button id="miImportButton" class="secondary" type="button">导入会话</button>
              </div>
            </details>
            <div class="status" id="miStatus"></div>
          </section>

          <section class="section">
            <h2>播放设备</h2>
            <p class="subtle">登录小米账号后刷新设备，选择默认播放设备。</p>
            <div class="actions">
              <button id="refreshDevicesButton" type="button">刷新小米设备</button>
              <button id="listDevicesButton" class="secondary" type="button">重新读取列表</button>
            </div>
            <div id="devices" class="device-list"></div>
          </section>

          <section class="section">
            <h2>运行配置</h2>
            <div class="split">
              <label>
                服务端名称
                <input id="configServerName" />
              </label>
              <label>
                默认音质
                <select id="configDefaultQuality">
                  <option value="128k">128k</option>
                  <option value="320k">320k</option>
                  <option value="flac">FLAC</option>
                  <option value="hires">Hi-Res</option>
                </select>
              </label>
            </div>
            <div class="split">
              <label>
                搜索策略
                <select id="configSearchStrategy">
                  <option value="qqFirst">QQ 优先</option>
                  <option value="kuwoFirst">酷我优先</option>
                  <option value="neteaseFirst">网易云优先</option>
                </select>
              </label>
              <label>
                解析策略
                <select id="configResolveStrategy">
                  <option value="originalFirst">原始结果优先</option>
                  <option value="qqFirst">QQ 优先</option>
                  <option value="kuwoFirst">酷我优先</option>
                  <option value="neteaseFirst">网易云优先</option>
                </select>
              </label>
            </div>
            <label>
              自定义直连播放型号
              <input id="configExtraPlayMusicModels" placeholder="型号用逗号分隔，如 L20A, X20C" />
              <small class="hint">仅当某型号小爱直连播放没声音时才填。内置常见型号已适配，无需重复填写。</small>
            </label>
            <div class="actions">
              <button id="saveConfigButton" type="button">保存配置</button>
              <button id="reloadConfigButton" class="secondary" type="button">重新读取</button>
            </div>
          </section>

          <section class="section">
            <h2>手工曲目</h2>
            <div class="split">
              <label>
                歌名
                <input id="manualTitle" />
              </label>
              <label>
                歌手
                <input id="manualArtist" />
              </label>
            </div>
            <label>
              音频 URL
              <input id="manualUrl" placeholder="https://example.com/song.mp3" />
            </label>
            <div class="actions">
              <button id="addManualTrackButton" type="button">加入手工曲目</button>
            </div>
            <div id="manualTracks" class="item-list"></div>
          </section>

          <section class="section">
            <h2>LX 插件</h2>
            <div class="split">
              <label>
                插件 ID
                <input id="pluginId" placeholder="my-lx-source" />
              </label>
              <label>
                插件名称
                <input id="pluginName" />
              </label>
            </div>
            <div class="split">
              <label>
                默认音质
                <select id="pluginDefaultQuality">
                  <option value="128k">128k</option>
                  <option value="320k">320k</option>
                  <option value="flac">FLAC</option>
                  <option value="hires">Hi-Res</option>
                </select>
              </label>
              <label class="inline-check">
                <input id="pluginEnabled" type="checkbox" checked />
                启用插件
              </label>
            </div>
            <label>
              插件代码
              <textarea id="pluginCode" spellcheck="false"></textarea>
            </label>
            <div class="actions">
              <button id="savePluginButton" type="button">保存插件</button>
              <button id="clearPluginFormButton" class="secondary" type="button">清空表单</button>
            </div>
            <div id="plugins" class="item-list"></div>
          </section>

          <section class="section">
            <h2>搜索与播放测试</h2>
            <div class="split">
              <label>
                关键词
                <input id="searchQuery" />
              </label>
              <label>
                音源
                <select id="searchSource">
                  <option value="">全部音源</option>
                </select>
              </label>
            </div>
            <div class="actions">
              <button id="searchButton" type="button">搜索</button>
              <button id="refreshSourcesButton" class="secondary" type="button">刷新音源</button>
            </div>
            <div id="searchResults" class="item-list"></div>
          </section>
        </div>

        <aside>
          <section class="section">
            <h2>服务端状态</h2>
            <div class="status" id="runtimeStatus"></div>
          </section>

          <section class="section">
            <h2>链路诊断</h2>
            <p class="subtle">先用内置测试音频验证 HMusic Server 到小米音箱的播放链路。</p>
            <div class="actions">
              <button id="testToneButton" type="button">播放测试音频</button>
              <button id="playbackStateButton" class="secondary" type="button">刷新播放状态</button>
            </div>
            <div class="status" id="playbackStatus"></div>
          </section>
        </aside>
      </div>
    </main>

    <script>
      const state = {
        initialized: false,
        token: localStorage.getItem("hmusic_admin_token") || "",
        user: null,
        systemInfo: null,
        verificationTimer: null,
        miWebVerificationTimer: null,
        miWebVerificationChecking: false,
        config: null,
        sources: [],
        plugins: [],
        searchTracks: [],
        playbackState: null,
      };

      const el = (id) => document.getElementById(id);

      function setBusy(isBusy) {
        document.querySelectorAll("button").forEach((button) => {
          button.disabled = isBusy;
        });
      }

      function showMessage(text, type) {
        const target = el("globalMessage");
        target.textContent = text;
        target.className = "message" + (type ? " " + type : "");
        target.classList.remove("hidden");
      }

      function clearMessage() {
        el("globalMessage").classList.add("hidden");
      }

      async function api(path, options = {}) {
        const headers = {
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(state.token ? { Authorization: "Bearer " + state.token } : {}),
          ...(options.headers || {}),
        };
        const response = await fetch("/api/v1" + path, { ...options, headers });
        const text = await response.text();
        const data = text ? JSON.parse(text) : {};
        if (!response.ok) {
          const error = new Error(data.error?.message || "请求失败");
          error.status = response.status;
          error.payload = data;
          throw error;
        }
        return data;
      }

      function renderAuth() {
        const authenticated = Boolean(state.token && state.user);
        el("authSection").classList.toggle("hidden", authenticated);
        el("dashboard").classList.toggle("hidden", !authenticated);
        el("logoutButton").classList.toggle("hidden", !authenticated);

        el("authTitle").textContent = state.initialized ? "管理员登录" : "创建管理员账号";
        el("authButton").textContent = state.initialized ? "登录" : "创建并登录";
        el("authHint").textContent = state.initialized
          ? "输入管理员账号密码后进入服务端管理。"
          : "首次使用需要创建管理员账号。密码至少 8 位。";
      }

      function renderRuntime() {
        const info = state.systemInfo;
        el("serverInfo").textContent = info
          ? info.name + " " + info.version + " · " + location.origin
          : location.origin;
        el("runtimeStatus").innerHTML = [
          "<span class=\\"pill\\">API " + (info?.apiVersion || "v1") + "</span>",
          "<div>管理员：" + (state.user?.username || "未登录") + "</div>",
          "<div>小米账号：" + (info?.capabilities?.miAccount ? "支持" : "未启用") + "</div>",
          "<div>播放控制：" + (info?.capabilities?.playback ? "支持" : "未启用") + "</div>",
        ].join("");
      }

      function renderPlaybackState(playback) {
        state.playbackState = playback;
        if (!playback) {
          el("playbackStatus").innerHTML = '<span class="pill warn">未读取</span>';
          return;
        }
        const track = playback.track;
        const rows = [
          '<span class="pill ' + (playback.state === "playing" ? "" : "warn") + '">' + escapeHtml(playback.state || "unknown") + "</span>",
          "<div>设备：" + escapeHtml(playback.deviceName || playback.deviceId || "未选择") + "</div>",
          "<div>曲目：" + escapeHtml(track ? [track.title, track.artist].filter(Boolean).join(" - ") : "无") + "</div>",
          "<div>进度：" + Math.round((playback.positionMs || 0) / 1000) + "s / " + Math.round((playback.durationMs || 0) / 1000) + "s</div>",
        ];
        el("playbackStatus").innerHTML = rows.join("");
      }

      function showMiVerificationStatus(text, type) {
        const target = document.getElementById("miVerificationStatus");
        if (!target) return;
        target.textContent = text;
        target.className = "message" + (type ? " " + type : "");
        target.classList.remove("hidden");
      }

      function renderMiStatus(status) {
        const rows = [];
        if (!status) {
          el("miStatus").innerHTML = '<span class="pill warn">未读取</span>';
          return;
        }
        rows.push('<span class="pill ' + (status.loggedIn ? "" : "warn") + '">' + (status.loggedIn ? "已登录" : "未登录") + "</span>");
        if (status.accountMasked) rows.push("<div>账号：" + status.accountMasked + "</div>");
        if (status.deviceId) rows.push("<div>登录设备标识：" + status.deviceId + "</div>");
        if (status.deviceCount !== undefined) rows.push("<div>设备数量：" + status.deviceCount + "</div>");
        el("miStatus").innerHTML = rows.join("");
      }

      function renderDevices(devices) {
        const container = el("devices");
        if (!devices || devices.length === 0) {
          container.innerHTML = '<div class="message warn">暂无设备。请先登录小米账号并刷新设备。</div>';
          return;
        }
        container.innerHTML = devices
          .map((device) => {
            const meta = [device.type, device.ip, device.isOnline ? "在线" : "离线"]
              .filter(Boolean)
              .join(" · ");
            return '<div class="device"><div><strong>' +
              escapeHtml(device.name || device.id) +
              '</strong><div class="subtle">' +
              escapeHtml(meta || device.id) +
              '</div>' +
              (device.isDefault ? '<span class="pill">默认设备</span>' : "") +
              '</div><button class="secondary" type="button" data-device-id="' +
              escapeHtml(device.id) +
              '">设为默认</button></div>';
          })
          .join("");
        container.querySelectorAll("[data-device-id]").forEach((button) => {
          button.addEventListener("click", () => selectDevice(button.dataset.deviceId));
        });
      }

      function renderConfig(config) {
        state.config = config;
        el("configServerName").value = config.serverName || "";
        el("configDefaultQuality").value = config.defaultQuality || "320k";
        el("configSearchStrategy").value = config.searchStrategy || "qqFirst";
        el("configResolveStrategy").value = config.resolveStrategy || "originalFirst";
        el("configExtraPlayMusicModels").value = (config.extraPlayMusicModels || []).join(", ");
        renderManualTracks(config.manualTracks || []);
      }

      function parseExtraPlayMusicModels(value) {
        const seen = new Set();
        return (value || "")
          .split(/[\\s,，、]+/)
          .map((item) => item.trim().toUpperCase())
          .filter((item) => {
            if (!item || !/^[A-Z0-9]+$/.test(item) || seen.has(item)) return false;
            seen.add(item);
            return true;
          });
      }

      function renderManualTracks(tracks) {
        const container = el("manualTracks");
        if (!tracks.length) {
          container.innerHTML = '<div class="message warn">暂无手工曲目。</div>';
          return;
        }
        container.innerHTML = tracks
          .map((track, index) =>
            '<div class="list-item"><div><strong>' +
            escapeHtml(track.title) +
            '</strong><div class="subtle">' +
            escapeHtml([track.artist, track.url].filter(Boolean).join(" · ")) +
            '</div></div><button class="danger mini" type="button" data-manual-index="' +
            index +
            '">删除</button></div>',
          )
          .join("");
        container.querySelectorAll("[data-manual-index]").forEach((button) => {
          button.addEventListener("click", () => removeManualTrack(Number(button.dataset.manualIndex)));
        });
      }

      function renderSources(sources) {
        state.sources = sources || [];
        const options = ['<option value="">全部音源</option>']
          .concat(
            state.sources.map((source) =>
              '<option value="' +
              escapeHtml(source.id) +
              '">' +
              escapeHtml(source.name || source.id) +
              (source.enabled ? "" : "（停用）") +
              "</option>",
            ),
          )
          .join("");
        el("searchSource").innerHTML = options;
      }

      function renderPlugins(plugins) {
        state.plugins = plugins || [];
        const container = el("plugins");
        if (!state.plugins.length) {
          container.innerHTML = '<div class="message warn">暂无 LX 插件。</div>';
          return;
        }
        container.innerHTML = state.plugins
          .map((plugin) =>
            '<div class="list-item"><div><strong>' +
            escapeHtml(plugin.name || plugin.id) +
            '</strong><div class="subtle">' +
            escapeHtml(plugin.id + " · " + (plugin.enabled ? "启用" : "停用") + " · " + (plugin.defaultQuality || "320k")) +
            '</div></div><div class="actions"><button class="secondary mini" type="button" data-plugin-edit="' +
            escapeHtml(plugin.id) +
            '">编辑</button><button class="secondary mini" type="button" data-plugin-test="' +
            escapeHtml(plugin.id) +
            '">测试</button><button class="danger mini" type="button" data-plugin-delete="' +
            escapeHtml(plugin.id) +
            '">删除</button></div></div>',
          )
          .join("");
        container.querySelectorAll("[data-plugin-edit]").forEach((button) => {
          button.addEventListener("click", () => editPlugin(button.dataset.pluginEdit));
        });
        container.querySelectorAll("[data-plugin-test]").forEach((button) => {
          button.addEventListener("click", () => testPlugin(button.dataset.pluginTest));
        });
        container.querySelectorAll("[data-plugin-delete]").forEach((button) => {
          button.addEventListener("click", () => deletePlugin(button.dataset.pluginDelete));
        });
      }

      function renderSearchResults(result) {
        state.searchTracks = result?.tracks || [];
        const container = el("searchResults");
        if (!state.searchTracks.length) {
          container.innerHTML = '<div class="message warn">没有搜索结果。</div>';
          return;
        }
        container.innerHTML = state.searchTracks
          .map((track, index) =>
            '<div class="list-item"><div><strong>' +
            escapeHtml(track.title) +
            '</strong><div class="subtle">' +
            escapeHtml([track.artist, track.album, track.source].filter(Boolean).join(" · ")) +
            '</div></div><div class="actions"><button class="mini" type="button" data-play-index="' +
            index +
            '">播放</button></div></div>',
          )
          .join("");
        container.querySelectorAll("[data-play-index]").forEach((button) => {
          button.addEventListener("click", () => playSearchResult(Number(button.dataset.playIndex)));
        });
      }

      function escapeHtml(value) {
        return String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#039;");
      }

      async function refreshAuthStatus() {
        const auth = await api("/auth/status");
        state.initialized = Boolean(auth.initialized);
        state.user = auth.authenticated ? auth.user : null;
        if (!auth.authenticated) {
          state.token = "";
          localStorage.removeItem("hmusic_admin_token");
        }
        renderAuth();
        renderRuntime();
      }

      async function refreshMiStatus() {
        const status = await api("/mi/status");
        renderMiStatus(status);
      }

      async function listDevices() {
        const result = await api("/devices");
        renderDevices(result.devices || []);
      }

      async function loadAdminData() {
        await Promise.all([loadConfig(), loadSources(), loadPlugins(), loadPlaybackState()]);
      }

      async function loadPlaybackState() {
        const playback = await api("/playback/state");
        renderPlaybackState(playback);
      }

      async function loadConfig() {
        const config = await api("/config");
        renderConfig(config);
      }

      async function saveConfig() {
        await run(async () => {
          const next = await api("/config", {
            method: "PATCH",
            body: JSON.stringify({
              serverName: el("configServerName").value.trim() || "HMusic Server",
              defaultQuality: el("configDefaultQuality").value,
              searchStrategy: el("configSearchStrategy").value,
              resolveStrategy: el("configResolveStrategy").value,
              extraPlayMusicModels: parseExtraPlayMusicModels(el("configExtraPlayMusicModels").value),
              manualTracks: state.config?.manualTracks || [],
            }),
          });
          renderConfig(next);
          showMessage("运行配置已保存");
        });
      }

      async function addManualTrack() {
        await run(async () => {
          const title = el("manualTitle").value.trim();
          const artist = el("manualArtist").value.trim();
          const url = el("manualUrl").value.trim();
          if (!title || !url) {
            showMessage("手工曲目需要歌名和音频 URL", "error");
            return;
          }
          const manualTracks = [
            ...(state.config?.manualTracks || []),
            {
              id: "manual-" + Date.now(),
              title,
              ...(artist ? { artist } : {}),
              url,
            },
          ];
          const next = await api("/config", {
            method: "PATCH",
            body: JSON.stringify({ manualTracks }),
          });
          renderConfig(next);
          el("manualTitle").value = "";
          el("manualArtist").value = "";
          el("manualUrl").value = "";
          showMessage("手工曲目已加入");
        });
      }

      async function removeManualTrack(index) {
        await run(async () => {
          const manualTracks = [...(state.config?.manualTracks || [])];
          manualTracks.splice(index, 1);
          const next = await api("/config", {
            method: "PATCH",
            body: JSON.stringify({ manualTracks }),
          });
          renderConfig(next);
          showMessage("手工曲目已删除");
        });
      }

      async function loadSources() {
        const result = await api("/sources");
        renderSources(result.sources || []);
      }

      async function loadPlugins() {
        const result = await api("/sources/lx-plugins");
        renderPlugins(result.plugins || []);
        await loadSources();
      }

      async function savePlugin() {
        await run(async () => {
          const id = el("pluginId").value.trim();
          const name = el("pluginName").value.trim();
          const code = el("pluginCode").value;
          if (!id || !name || !code.trim()) {
            showMessage("插件 ID、名称和代码都不能为空", "error");
            return;
          }
          await api("/sources/lx-plugins", {
            method: "POST",
            body: JSON.stringify({
              id,
              name,
              code,
              enabled: el("pluginEnabled").checked,
              defaultQuality: el("pluginDefaultQuality").value,
            }),
          });
          await loadPlugins();
          showMessage("LX 插件已保存");
        });
      }

      async function editPlugin(pluginId) {
        await run(async () => {
          const plugin = state.plugins.find((item) => item.id === pluginId);
          const result = await api("/sources/lx-plugins/" + encodeURIComponent(pluginId));
          el("pluginId").value = pluginId;
          el("pluginName").value = plugin?.name || pluginId;
          el("pluginDefaultQuality").value = plugin?.defaultQuality || "320k";
          el("pluginEnabled").checked = plugin?.enabled !== false;
          el("pluginCode").value = result.code || "";
          showMessage("插件已载入表单");
        });
      }

      async function testPlugin(pluginId) {
        await run(async () => {
          const result = await api("/sources/" + encodeURIComponent(pluginId) + "/test", {
            method: "POST",
          });
          showMessage(result.message || "插件加载测试通过");
        });
      }

      async function deletePlugin(pluginId) {
        await run(async () => {
          await api("/sources/lx-plugins/" + encodeURIComponent(pluginId), {
            method: "DELETE",
          });
          await loadPlugins();
          showMessage("LX 插件已删除");
        });
      }

      function clearPluginForm() {
        el("pluginId").value = "";
        el("pluginName").value = "";
        el("pluginCode").value = "";
        el("pluginDefaultQuality").value = "320k";
        el("pluginEnabled").checked = true;
      }

      async function searchMusic() {
        await run(async () => {
          const query = el("searchQuery").value.trim();
          const source = el("searchSource").value;
          if (!query) {
            showMessage("请输入搜索关键词", "error");
            return;
          }
          const params = new URLSearchParams({ q: query, limit: "20" });
          if (source) params.set("source", source);
          const result = await api("/search?" + params.toString());
          renderSearchResults(result);
          showMessage("搜索完成，共 " + result.total + " 条");
        });
      }

      async function playSearchResult(index) {
        await run(async () => {
          const track = state.searchTracks[index];
          if (!track) {
            showMessage("播放目标不存在", "error");
            return;
          }
          await api("/playback/play", {
            method: "POST",
            body: JSON.stringify({
              track,
              quality: state.config?.defaultQuality || "320k",
            }),
          });
          showMessage("已下发播放：" + track.title);
        });
      }

      async function playTestTone() {
        await run(async () => {
          const playback = await api("/playback/test-tone", {
            method: "POST",
          });
          renderPlaybackState(playback);
          showMessage("已下发测试音频");
        });
      }

      async function refreshDevices() {
        await api("/devices/refresh", { method: "POST" });
        await listDevices();
        showMessage("设备列表已刷新");
      }

      async function selectDevice(deviceId) {
        await run(async () => {
          await api("/devices/" + encodeURIComponent(deviceId) + "/select", {
            method: "POST",
          });
          await listDevices();
          showMessage("默认设备已更新");
        });
      }

      async function loginOrSetup() {
        await run(async () => {
          const username = el("adminUser").value.trim();
          const password = el("adminPass").value;
          const path = state.initialized ? "/auth/login" : "/auth/setup";
          const result = await api(path, {
            method: "POST",
            body: JSON.stringify({ username, password }),
          });
          state.token = result.accessToken;
          state.user = result.user;
          localStorage.setItem("hmusic_admin_token", state.token);
          await refreshAuthStatus();
          await Promise.all([refreshMiStatus(), listDevices(), loadAdminData()]);
          showMessage(state.initialized ? "已登录" : "管理员账号已创建");
        });
      }

      function buildMiPayload() {
        const payload = {
          account: el("miAccount").value.trim(),
          password: el("miPassword").value,
        };
        const captchaCode = el("miCaptcha").value.trim();
        if (captchaCode) payload.captchaCode = captchaCode;
        return payload;
      }

      function buildMiImportPayload() {
        const account =
          el("miImportAccount").value.trim() ||
          el("miAccount").value.trim() ||
          "imported";
        const webCredentials = {};
        const stsUrl = el("miImportStsUrl").value.trim();
        const serviceToken = el("miImportServiceToken").value.trim();
        const userId = el("miImportUserId").value.trim();
        const ssecurity = el("miImportSsecurity").value.trim();

        if (stsUrl) webCredentials.stsUrl = stsUrl;
        if (serviceToken) webCredentials.serviceToken = serviceToken;
        if (userId) webCredentials.userId = userId;
        if (ssecurity) webCredentials.ssecurity = ssecurity;

        if (!webCredentials.stsUrl && !(webCredentials.serviceToken && webCredentials.userId)) {
          throw new Error("请填写 STS URL，或 serviceToken + userId");
        }

        return { account, webCredentials };
      }

      async function startMiVerification(payload) {
        return api("/mi/verification/start", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }

      async function startMiWebVerification(payload) {
        return api("/mi/web-verification/start", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }

      async function finishMiLogin(status) {
        if (state.verificationTimer) {
          clearInterval(state.verificationTimer);
          state.verificationTimer = null;
        }
        stopMiWebVerificationPolling();
        el("miVerification").classList.add("hidden");
        el("miWebVerification").classList.add("hidden");
        renderMiStatus(status);
        await listDevices();
        showMessage("小米账号已登录");
      }

      async function confirmMiVerification(verificationId) {
        await run(async () => {
          const code = document.getElementById("miSmsCode")?.value.trim();
          if (!code) {
            showMiVerificationStatus("请输入短信验证码", "error");
            return;
          }
          try {
            const status = await api("/mi/verification/" + encodeURIComponent(verificationId) + "/confirm", {
              method: "POST",
              body: JSON.stringify({ code }),
            });
            await finishMiLogin(status);
          } catch (error) {
            if (requiresWebVerificationFallback(error)) {
              showMiVerificationStatus(
                "短信验证已通过，但小米没有返回可用登录地址，正在改用网页登录验证。",
                "warn",
              );
              await startMiWebLoginFlow();
              return;
            }
            showMiVerificationStatus(error.message || "验证码验证失败", "error");
            throw error;
          }
        });
      }

      async function resendMiVerification(verificationId) {
        await run(async () => {
          const result = await api("/mi/verification/" + encodeURIComponent(verificationId) + "/resend", {
            method: "POST",
          });
          showSmsVerificationPrompt(result);
          if (result.smsStatus === "limited") {
            showMiVerificationStatus("小米限制今日短信发送次数，请输入最近收到的验证码", "warn");
          } else if (result.smsStatus === "recent") {
            showMiVerificationStatus("小米提示验证码刚发送过，请输入最近收到的验证码", "warn");
          } else {
            showMiVerificationStatus("验证码已重新发送", "");
          }
        });
      }

      function showSmsVerificationPrompt(result) {
        el("miWebVerification").classList.add("hidden");
        const box = el("miVerification");
        const maskedPhone = result.maskedPhone || "绑定手机号";
        const expiresAt = result.expiresAt
          ? new Date(result.expiresAt).toLocaleTimeString()
          : "";
        const sentText =
          result.smsStatus === "limited"
            ? "小米限制今日短信发送次数，请输入最近收到的短信验证码。"
            : result.smsStatus === "recent"
              ? "小米提示验证码刚发送过，请输入最近收到的短信验证码。"
              : "验证码已发送到 " + escapeHtml(maskedPhone) + "。";
        box.innerHTML =
          "小米需要短信验证，" +
          sentText +
          (expiresAt ? '<div class="subtle">验证会话有效期至 ' + escapeHtml(expiresAt) + "。</div>" : "") +
          '<div id="miVerificationStatus" class="message hidden"></div>' +
          '<label>短信验证码<input id="miSmsCode" autocomplete="one-time-code" inputmode="numeric" /></label>' +
          '<div class="actions"><button id="confirmSmsButton" type="button">确认验证</button><button id="resendSmsButton" class="secondary" type="button">重新发送</button><button id="restartMiLoginButton" class="secondary" type="button">重新登录</button></div>';
        box.classList.remove("hidden");
        renderMiStatus({ loggedIn: false });

        box.querySelector("#confirmSmsButton")?.addEventListener("click", () => {
          confirmMiVerification(result.verificationId);
        });

        box.querySelector("#resendSmsButton")?.addEventListener("click", () => {
          resendMiVerification(result.verificationId);
        });

        box.querySelector("#restartMiLoginButton")?.addEventListener("click", () => {
          loginMi();
        });

        if (state.verificationTimer) {
          clearInterval(state.verificationTimer);
          state.verificationTimer = null;
        }
      }

      function showWebVerificationPrompt(result) {
        el("miVerification").classList.add("hidden");
        const box = el("miWebVerification");
        const expiresAt = result.expiresAt
          ? new Date(result.expiresAt).toLocaleTimeString()
          : "";
        const verificationPageUrl = miWebVerificationPageUrl(result.verificationId);
        box.innerHTML =
          "小米需要网页登录验证。请在新窗口完成验证，服务端会自动接收登录结果。" +
          (expiresAt ? '<div class="subtle">验证会话有效期至 ' + escapeHtml(expiresAt) + "。</div>" : "") +
          '<div class="actions"><a id="openMiWebVerificationLink" class="button-link" target="_blank" rel="noopener" href="' +
          escapeHtml(verificationPageUrl) +
          '">打开小米验证页面</a><button id="retryMiWebVerificationButton" class="secondary" type="button">检查登录状态</button><button id="restartMiWebLoginButton" class="secondary" type="button">重新开始</button></div>';
        box.classList.remove("hidden");
        renderMiStatus({ loggedIn: false });
        startMiWebVerificationPolling(result.verificationId);

        box.querySelector("#retryMiWebVerificationButton")?.addEventListener("click", () => {
          retryMiWebVerification(result.verificationId);
        });

        box.querySelector("#restartMiWebLoginButton")?.addEventListener("click", () => {
          loginMiWithWebVerification();
        });
      }

      async function loginMi() {
        await run(async () => {
          stopMiWebVerificationPolling();
          el("miVerification").classList.add("hidden");
          el("miWebVerification").classList.add("hidden");
          const payload = buildMiPayload();
          const result = await startMiVerification(payload);
          if (result.loggedIn) {
            await finishMiLogin(result);
            return;
          }
          showSmsVerificationPrompt(result);
        });
      }

      async function loginMiWithWebVerification() {
        await run(async () => {
          await startMiWebLoginFlow();
        });
      }

      async function startMiWebLoginFlow() {
        stopMiWebVerificationPolling();
        let verificationWindow = null;
        try {
          verificationWindow = window.open("about:blank", "_blank");
          if (verificationWindow) verificationWindow.opener = null;
        } catch {
          verificationWindow = null;
        }

        el("miVerification").classList.add("hidden");
        el("miWebVerification").classList.add("hidden");
        let result;
        try {
          const payload = buildMiPayload();
          result = await startMiWebVerification(payload);
        } catch (error) {
          if (verificationWindow && !verificationWindow.closed) {
            verificationWindow.close();
          }
          throw error;
        }

        if (result.loggedIn) {
          if (verificationWindow && !verificationWindow.closed) {
            verificationWindow.close();
          }
          await finishMiLogin(result);
          return;
        }
        showWebVerificationPrompt(result);
        if (verificationWindow && !verificationWindow.closed) {
          verificationWindow.location.href = miWebVerificationPageUrl(result.verificationId);
        }
        showMessage("请在新窗口完成小米验证；后台会自动刷新登录状态");
      }

      function requiresWebVerificationFallback(error) {
        const code = error?.payload?.error?.code;
        return code === "MI_IDENTITY_STS_INVALID" || code === "MI_IDENTITY_STS_MISSING";
      }

      function miWebVerificationPageUrl(verificationId) {
        return "/mi-web-verification/" + encodeURIComponent(verificationId);
      }

      function stopMiWebVerificationPolling() {
        if (state.miWebVerificationTimer) {
          clearInterval(state.miWebVerificationTimer);
          state.miWebVerificationTimer = null;
        }
        state.miWebVerificationChecking = false;
      }

      function startMiWebVerificationPolling(verificationId) {
        stopMiWebVerificationPolling();
        state.miWebVerificationTimer = setInterval(async () => {
          if (!state.token || state.miWebVerificationChecking) return;
          state.miWebVerificationChecking = true;
          try {
            const status = await api("/mi/status");
            if (status.loggedIn) await finishMiLogin(status);
          } catch {
            // Polling is best-effort; the manual check button reports errors.
          } finally {
            state.miWebVerificationChecking = false;
          }
        }, 2000);
      }

      async function retryMiWebVerification(verificationId) {
        await run(async () => {
          const status = await api("/mi/status");
          if (status.loggedIn) {
            await finishMiLogin(status);
            return;
          }
          const result = await api("/mi/web-verification/" + encodeURIComponent(verificationId) + "/complete", {
            method: "POST",
          });
          if (result.loggedIn) {
            await finishMiLogin(result);
            return;
          }
          showWebVerificationPrompt(result);
          showMessage("还没有检测到网页登录完成，请确认新窗口验证已完成", "warn");
        });
      }

      async function importMiSession() {
        await run(async () => {
          const payload = buildMiImportPayload();
          const status = await api("/mi/session/import", {
            method: "POST",
            body: JSON.stringify(payload),
          });
          await finishMiLogin(status);
        });
      }

      async function run(task) {
        clearMessage();
        setBusy(true);
        try {
          await task();
        } catch (error) {
          showMessage(error.message || "操作失败", "error");
        } finally {
          setBusy(false);
        }
      }

      el("authButton").addEventListener("click", loginOrSetup);
      el("logoutButton").addEventListener("click", () => {
        stopMiWebVerificationPolling();
        state.token = "";
        state.user = null;
        localStorage.removeItem("hmusic_admin_token");
        renderAuth();
        renderRuntime();
      });
      el("miLoginButton").addEventListener("click", loginMiWithWebVerification);
      el("miWebLoginButton").addEventListener("click", loginMi);
      el("miImportButton").addEventListener("click", importMiSession);
      el("miStatusButton").addEventListener("click", () => run(refreshMiStatus));
      el("refreshDevicesButton").addEventListener("click", () => run(refreshDevices));
      el("listDevicesButton").addEventListener("click", () => run(listDevices));
      el("saveConfigButton").addEventListener("click", saveConfig);
      el("reloadConfigButton").addEventListener("click", () => run(loadConfig));
      el("addManualTrackButton").addEventListener("click", addManualTrack);
      el("savePluginButton").addEventListener("click", savePlugin);
      el("clearPluginFormButton").addEventListener("click", clearPluginForm);
      el("searchButton").addEventListener("click", searchMusic);
      el("refreshSourcesButton").addEventListener("click", () => run(loadSources));
      el("testToneButton").addEventListener("click", playTestTone);
      el("playbackStateButton").addEventListener("click", () => run(loadPlaybackState));
      window.addEventListener("message", (event) => {
        if (event.origin !== window.location.origin) return;
        if (event.data?.type !== "hmusic-mi-web-verification-complete") return;
        run(async () => {
          const status = await api("/mi/status");
          if (status.loggedIn) {
            await finishMiLogin(status);
            return;
          }
          showMessage("验证窗口已关闭，但服务端还没有登录成功，请点检查登录状态", "warn");
        });
      });

      (async function init() {
        await run(async () => {
          state.systemInfo = await api("/system/info");
          await refreshAuthStatus();
          if (state.token && state.user) {
            await Promise.all([refreshMiStatus(), listDevices(), loadAdminData()]);
          }
        });
      })();
    </script>
  </body>
</html>`;
}
