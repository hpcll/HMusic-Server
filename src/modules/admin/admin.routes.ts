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
        --bg: #f4f6f5;
        --panel: #ffffff;
        --text: #172124;
        --muted: #667477;
        --line: #e2e8e6;
        --brand: #0f9f91;
        --brand-dark: #08776d;
        --brand-soft: #e8f6f3;
        --ink: #192426;
        --danger: #b42318;
        --warn-bg: #fff7e6;
        --warn-text: #7a4b00;
        --ok-bg: #e8f7f4;
        --ok-text: #075e54;
        --radius: 14px;
        --radius-sm: 10px;
        --shadow: 0 1px 2px rgba(23, 33, 36, 0.04), 0 4px 14px rgba(23, 33, 36, 0.05);
        --shadow-pop: 0 12px 40px rgba(23, 33, 36, 0.14);
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
        -webkit-font-smoothing: antialiased;
      }

      button,
      input,
      select,
      textarea {
        transition:
          border-color 0.15s ease,
          background-color 0.15s ease,
          box-shadow 0.15s ease,
          color 0.15s ease,
          opacity 0.15s ease;
      }

      button {
        transition:
          border-color 0.15s ease,
          background-color 0.15s ease,
          color 0.15s ease,
          box-shadow 0.15s ease,
          transform 0.08s ease,
          opacity 0.15s ease;
      }

      header {
        border-bottom: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.85);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        position: sticky;
        top: 0;
        z-index: 10;
      }

      .shell {
        width: min(1120px, calc(100% - 32px));
        margin: 0 auto;
      }

      .topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        min-height: 64px;
        gap: 16px;
      }

      .brand {
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
      }

      .brand-logo {
        width: 34px;
        height: 34px;
        flex-shrink: 0;
        border-radius: 8px;
        background: var(--brand-soft);
        padding: 4px;
      }

      h1 {
        margin: 0;
        font-size: 20px;
        font-weight: 700;
        letter-spacing: -0.01em;
      }

      main {
        padding: 24px 0 48px;
      }

      .grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(300px, 360px);
        gap: 20px;
        align-items: start;
      }

      .section {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        padding: 22px 22px 20px;
        margin-bottom: 18px;
        box-shadow: var(--shadow);
      }

      .section h2 {
        margin: 0;
        font-size: 15px;
        font-weight: 700;
        letter-spacing: -0.01em;
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .section h2 .sec-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        border-radius: 8px;
        background: var(--brand-soft);
        color: var(--brand-dark);
        flex-shrink: 0;
      }

      .section h2 .sec-icon svg {
        width: 16px;
        height: 16px;
        fill: none;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 1.8;
      }

      .sec-sub {
        margin: 8px 0 4px;
        padding-left: 40px;
        font-size: 12.5px;
        color: var(--muted);
      }

      .subtle {
        color: var(--muted);
        font-size: 13px;
      }

      label {
        display: grid;
        gap: 6px;
        margin: 12px 0;
        font-size: 13px;
        font-weight: 600;
        color: var(--text);
      }

      .hint {
        color: var(--muted);
        font-size: 12px;
        font-weight: 400;
        line-height: 1.4;
      }

      input,
      select,
      textarea {
        width: 100%;
        min-height: 42px;
        border: 1px solid var(--line);
        border-radius: var(--radius-sm);
        padding: 9px 12px;
        color: var(--text);
        font: inherit;
        font-weight: 400;
        background: #fbfbfa;
      }

      input:hover,
      select:hover,
      textarea:hover {
        border-color: #b9c6c3;
      }

      input::placeholder {
        color: #9aa7a5;
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
        outline: none;
        border-color: var(--brand);
        background: #fff;
        box-shadow: 0 0 0 3px rgba(15, 159, 145, 0.14);
      }

      .split {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0 14px;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 14px;
      }

      button,
      .button-link {
        min-height: 40px;
        border: 1px solid var(--brand);
        border-radius: var(--radius-sm);
        padding: 8px 14px;
        background: var(--brand);
        color: #fff;
        font: inherit;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 1px 2px rgba(8, 119, 109, 0.18);
      }

      button:hover:not(:disabled),
      .button-link:hover {
        background: var(--brand-dark);
        border-color: var(--brand-dark);
      }

      button:active:not(:disabled) {
        transform: translateY(1px);
      }

      button.secondary,
      .button-link.secondary {
        background: #fff;
        color: var(--brand-dark);
        border-color: #cfdad8;
        box-shadow: none;
      }

      button.secondary:hover:not(:disabled),
      .button-link.secondary:hover {
        background: var(--brand-soft);
        border-color: var(--brand);
        color: var(--brand-dark);
      }

      button.danger {
        border-color: #eec5c2;
        background: #fff;
        color: var(--danger);
        box-shadow: none;
      }

      button.danger:hover:not(:disabled) {
        background: #fff1f0;
        border-color: var(--danger);
      }

      button:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }

      .status {
        display: grid;
        gap: 8px;
        margin-top: 12px;
        font-size: 13px;
      }

      .status-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 7px 0;
        border-bottom: 1px dashed var(--line);
      }

      .status-row:last-child {
        border-bottom: none;
      }

      .status-row .k {
        color: var(--muted);
        font-size: 12.5px;
      }

      .status-row .v {
        color: var(--text);
        font-size: 13px;
        font-weight: 600;
        text-align: right;
      }

      .pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        width: fit-content;
        border-radius: 999px;
        padding: 4px 10px;
        background: var(--ok-bg);
        color: var(--ok-text);
        font-size: 12px;
        font-weight: 650;
      }

      .pill::before {
        content: "";
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: currentColor;
      }

      .pill.warn {
        background: var(--warn-bg);
        color: var(--warn-text);
      }

      .progress {
        height: 6px;
        border-radius: 999px;
        background: #edf1f0;
        margin-top: 10px;
        overflow: hidden;
      }

      .progress-bar {
        height: 100%;
        border-radius: 999px;
        background: linear-gradient(90deg, var(--brand), #21b0a5);
        transition: width 0.3s ease;
      }

      .overview {
        margin-bottom: 20px;
        overflow: hidden;
        border-radius: var(--radius);
        background: linear-gradient(158deg, #20312f 0%, #142120 58%, #0d1615 100%);
        color: #f4f8f7;
        box-shadow: var(--shadow);
      }

      .overview-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }

      .overview-item {
        min-width: 0;
        min-height: 132px;
        padding: 20px;
        border: 0;
        border-right: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 0;
        background: transparent;
        color: inherit;
        text-align: left;
        box-shadow: none;
        cursor: default;
        display: block;
      }

      .overview-item:last-child {
        border-right: 0;
      }

      button.overview-item {
        width: 100%;
        font-weight: inherit;
        cursor: pointer;
      }

      button.overview-item:hover:not(:disabled),
      button.overview-item:focus-visible {
        border-color: rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.07);
        color: inherit;
        outline: none;
      }

      button.overview-item:focus-visible {
        box-shadow: inset 0 0 0 2px #72d4ca;
      }

      .overview-label {
        display: block;
        margin-bottom: 10px;
        color: #8fa09d;
        font-size: 12px;
        font-weight: 700;
      }

      .overview-value {
        display: block;
        overflow: hidden;
        color: #f4f8f7;
        font-size: 18px;
        font-weight: 700;
        line-height: 1.35;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .overview-value.warn {
        color: #f7c66b;
      }

      .overview-meta {
        display: block;
        margin-top: 7px;
        color: #afbcba;
        font-size: 12px;
        font-weight: 500;
      }

      .overview-progress {
        /* span 默认是 inline，不加 display:block 则 height 失效，
           内部 i 的 height:100% 会退到按单元格高度算，涨成一坨色块。 */
        display: block;
        height: 3px;
        margin-top: 12px;
        overflow: hidden;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.14);
      }

      .overview-progress i {
        display: block;
        height: 100%;
        border-radius: inherit;
        background: #58cabd;
        transition: width 0.3s ease;
      }

      /* 卡片高度差异很大（603px 的 LX 插件 vs 174px 的链路诊断），
         静态左右分列必然一边先见底。改用 multi-column 让浏览器按实际
         高度自动填充，加新卡片也不需要重新规划归属。 */
      .dashboard-grid {
        display: block;
        columns: 2;
        column-gap: 20px;
      }

      .dashboard-grid .section {
        scroll-margin-top: 84px;
        /* 卡片不允许被拆到两列 */
        break-inside: avoid;
      }

      .stat-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
        margin-top: 10px;
      }

      .stat-card {
        border: 1px solid var(--line);
        border-radius: var(--radius-sm);
        padding: 10px 12px;
        background: #fdfdfc;
      }

      .stat-card .n {
        display: block;
        font-size: 20px;
        font-weight: 700;
        letter-spacing: -0.02em;
        color: var(--text);
      }

      .stat-card .l {
        display: block;
        margin-top: 2px;
        font-size: 11.5px;
        color: var(--muted);
      }

      .stat-dist {
        margin-top: 10px;
        display: grid;
        gap: 6px;
      }

      .dist-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        align-items: center;
        font-size: 12px;
      }

      .dist-row .bar {
        grid-column: 1 / -1;
        height: 4px;
        border-radius: 999px;
        background: #edf1f0;
        overflow: hidden;
      }

      .dist-row .bar i {
        display: block;
        height: 100%;
        border-radius: 999px;
        background: var(--brand);
      }

      .message {
        border-radius: var(--radius-sm);
        padding: 10px 12px;
        margin: 12px 0;
        background: var(--ok-bg);
        color: var(--ok-text);
        font-size: 13px;
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
        border-radius: var(--radius-sm);
        padding: 10px 12px;
        margin-top: 14px;
        background: #fbfbfa;
      }

      details.inline-panel summary {
        cursor: pointer;
        color: var(--brand-dark);
        font-size: 13px;
        font-weight: 650;
      }

      .device-list {
        display: grid;
        gap: 8px;
        margin-top: 12px;
      }

      .item-list {
        display: grid;
        gap: 8px;
        margin-top: 12px;
      }

      .device,
      .list-item {
        border: 1px solid var(--line);
        border-radius: var(--radius-sm);
        padding: 10px 12px;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
        align-items: center;
        background: #fdfdfc;
        transition: border-color 0.15s ease, background-color 0.15s ease;
      }

      .device:hover,
      .list-item:hover {
        border-color: #c4d2cf;
        background: #fff;
      }

      .device strong,
      .list-item strong {
        display: block;
        font-size: 14px;
      }

      .list-item.full {
        grid-template-columns: 1fr;
      }

      .list-item .actions,
      .device .actions {
        margin-top: 0;
      }

      .mini {
        min-height: 32px;
        padding: 5px 10px;
        font-size: 12px;
      }

      .inline-check {
        display: flex;
        align-items: center;
        gap: 8px;
        align-self: end;
        min-height: 42px;
      }

      .inline-check input {
        width: auto;
        min-height: auto;
      }

      .hidden {
        display: none !important;
      }

      body.auth-mode {
        background:
          radial-gradient(1100px 500px at 82% -12%, rgba(15, 159, 145, 0.14), transparent 62%),
          radial-gradient(800px 420px at -10% 110%, rgba(15, 159, 145, 0.09), transparent 60%),
          var(--bg);
      }

      body.auth-mode > header {
        display: none;
      }

      body.auth-mode main.shell {
        display: grid;
        width: 100%;
        max-width: none;
        min-height: 100vh;
        min-height: 100svh;
        padding: 32px;
        place-items: center;
      }

      body.auth-mode #globalMessage {
        display: none;
      }

      .auth-layout {
        display: grid;
        grid-template-columns: minmax(280px, 0.88fr) minmax(390px, 1.12fr);
        width: min(920px, 100%);
        min-height: 560px;
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: 20px;
        background: var(--panel);
        box-shadow: var(--shadow-pop);
      }

      .auth-context {
        display: flex;
        flex-direction: column;
        min-width: 0;
        padding: 44px;
        background: linear-gradient(158deg, #20312f 0%, #142120 58%, #0d1615 100%);
        color: #f4f8f7;
      }

      .auth-logo {
        display: block;
        width: min(210px, 100%);
        height: auto;
      }

      .auth-context-copy {
        margin: auto 0;
        padding: 52px 0;
      }

      .auth-kicker {
        margin: 0 0 12px;
        color: #72d4ca;
        font-size: 12px;
        font-weight: 750;
        letter-spacing: 0;
        text-transform: uppercase;
      }

      .auth-context h1 {
        max-width: 320px;
        font-size: 32px;
        line-height: 1.2;
      }

      .auth-context-note {
        max-width: 290px;
        margin: 14px 0 0;
        color: #afbcba;
        font-size: 14px;
      }

      .auth-service {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 0 10px;
        align-items: center;
        padding-top: 18px;
        border-top: 1px solid rgba(255, 255, 255, 0.13);
      }

      .auth-service-dot {
        grid-row: 1 / span 2;
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: #58cabd;
        box-shadow: 0 0 0 4px rgba(88, 202, 189, 0.14);
      }

      .auth-service-name,
      .auth-service-origin {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .auth-service-name {
        color: #f4f8f7;
        font-size: 13px;
        font-weight: 700;
      }

      .auth-service-origin {
        color: #8fa09d;
        font-size: 12px;
      }

      .auth-panel {
        display: flex;
        align-items: center;
        min-width: 0;
        padding: 48px 52px;
      }

      .auth-panel-inner {
        width: 100%;
      }

      .auth-panel-kicker {
        margin: 0 0 10px;
        color: var(--brand-dark);
        font-size: 12px;
        font-weight: 750;
      }

      .auth-panel h2 {
        margin: 0;
        font-size: 24px;
        letter-spacing: -0.01em;
        line-height: 1.25;
      }

      .auth-hint {
        min-height: 42px;
        margin: 10px 0 24px;
        color: var(--muted);
        font-size: 13px;
      }

      .auth-form {
        display: grid;
        gap: 16px;
      }

      .auth-field {
        gap: 8px;
        margin: 0;
        color: var(--text);
        font-size: 13px;
        font-weight: 600;
      }

      .auth-field input {
        min-height: 46px;
        padding: 11px 13px;
      }

      .password-field {
        display: block;
        position: relative;
      }

      .password-field input {
        padding-right: 48px;
      }

      .password-toggle {
        position: absolute;
        top: 50%;
        right: 5px;
        width: 36px;
        min-height: 36px;
        padding: 0;
        transform: translateY(-50%);
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: var(--muted);
        box-shadow: none;
      }

      .password-toggle:hover {
        background: #eef3f2;
        color: var(--text);
      }

      .password-toggle svg {
        width: 18px;
        height: 18px;
        fill: none;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 2;
      }

      .auth-submit {
        width: 100%;
        min-height: 46px;
        margin-top: 4px;
      }

      .auth-spinner {
        display: none;
        width: 16px;
        height: 16px;
        margin-right: 9px;
        border: 2px solid rgba(255, 255, 255, 0.42);
        border-top-color: #fff;
        border-radius: 50%;
        animation: auth-spin 0.75s linear infinite;
      }

      body.is-busy.auth-mode .auth-spinner {
        display: inline-block;
      }

      .auth-message {
        margin: 18px 0 0;
      }

      .auth-footnote {
        margin: 24px 0 0;
        color: #899597;
        font-size: 12px;
        text-align: center;
      }

      @keyframes auth-spin {
        to {
          transform: rotate(360deg);
        }
      }

      @media (max-width: 860px) {
        .grid {
          grid-template-columns: 1fr;
        }

        /* dashboard-grid 是 multi-column，grid-template-columns 对它无效，
           必须显式收成单列，否则窄屏会被挤成两条窄柱。 */
        .dashboard-grid {
          columns: 1;
        }

        .split {
          grid-template-columns: 1fr;
        }

        .device,
        .list-item {
          grid-template-columns: 1fr;
        }

        .device .actions,
        .list-item .actions {
          justify-content: flex-start;
        }

        .topbar {
          align-items: flex-start;
          flex-direction: column;
          justify-content: center;
          padding: 14px 0;
        }
      }

      @media (max-width: 720px) {
        .overview-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .overview-item:nth-child(2) {
          border-right: 0;
        }

        .overview-item:nth-child(-n + 2) {
          border-bottom: 1px solid rgba(255, 255, 255, 0.12);
        }

        body.auth-mode main.shell {
          padding: 16px;
          place-items: start center;
        }

        .auth-layout {
          grid-template-columns: 1fr;
          min-height: 0;
        }

        .auth-context {
          padding: 28px;
        }

        .auth-logo {
          width: 160px;
        }

        .auth-context-copy {
          padding: 34px 0;
        }

        .auth-context h1 {
          font-size: 26px;
        }

        .auth-panel {
          padding: 34px 28px 30px;
        }
      }

      @media (max-width: 420px) {
        .overview-grid {
          grid-template-columns: 1fr;
        }

        .overview-item,
        .overview-item:nth-child(2) {
          min-height: 112px;
          border-right: 0;
          border-bottom: 1px solid rgba(255, 255, 255, 0.12);
        }

        .overview-item:last-child {
          border-bottom: 0;
        }

        body.auth-mode main.shell {
          padding: 0;
        }

        .auth-layout {
          min-height: 100vh;
          min-height: 100svh;
          border: 0;
          border-radius: 0;
          box-shadow: none;
        }

        .auth-context-copy {
          display: none;
        }

        .auth-service {
          margin-top: 28px;
        }

        .auth-panel {
          align-items: flex-start;
          padding: 32px 24px 28px;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .auth-spinner {
          animation: none;
        }
      }
    </style>
  </head>
  <body class="auth-mode">
    <header>
      <div class="shell topbar">
        <div class="brand">
          <img class="brand-logo" src="/app/assets/hmusic-logo.svg" alt="HMusic" />
          <div>
            <h1>HMusic Server 管理</h1>
            <div class="subtle" id="serverInfo">正在连接服务端...</div>
          </div>
        </div>
        <button id="logoutButton" class="secondary hidden" type="button">退出登录</button>
      </div>
    </header>

    <main class="shell">
      <div id="globalMessage" class="message hidden"></div>

      <section id="authSection" class="auth-layout" aria-labelledby="authTitle">
        <div class="auth-context">
          <img class="auth-logo" src="/app/assets/hmusic-logo.svg" alt="HMusic" />
          <div class="auth-context-copy">
            <p class="auth-kicker">Server console</p>
            <h1>HMusic Server</h1>
            <p class="auth-context-note">管理当前服务节点与播放链路。</p>
          </div>
          <div class="auth-service">
            <span class="auth-service-dot" aria-hidden="true"></span>
            <span class="auth-service-name" id="authServerInfo">正在连接服务端</span>
            <span class="auth-service-origin" id="authServerOrigin"></span>
          </div>
        </div>

        <div class="auth-panel">
          <div class="auth-panel-inner">
            <p class="auth-panel-kicker">管理员入口</p>
            <h2 id="authTitle">管理员登录</h2>
            <p class="auth-hint" id="authHint">输入管理员账号密码后继续。</p>
            <form id="authForm" class="auth-form">
              <label class="auth-field" for="adminUser">
                管理员账号
                <input
                  id="adminUser"
                  autocomplete="username"
                  minlength="3"
                  required
                  value="admin"
                />
              </label>
              <label class="auth-field" for="adminPass">
                管理员密码
                <span class="password-field">
                  <input
                    id="adminPass"
                    autocomplete="current-password"
                    minlength="8"
                    required
                    type="password"
                  />
                  <button
                    id="passwordToggle"
                    class="password-toggle"
                    type="button"
                    title="显示密码"
                    aria-label="显示密码"
                    aria-pressed="false"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M2.1 12a10.8 10.8 0 0 1 19.8 0 10.8 10.8 0 0 1-19.8 0Z"></path>
                      <circle cx="12" cy="12" r="3"></circle>
                    </svg>
                  </button>
                </span>
              </label>
              <button id="authButton" class="auth-submit" type="submit">
                <span class="auth-spinner" aria-hidden="true"></span>
                <span id="authButtonLabel">登录</span>
              </button>
            </form>
            <div id="authMessage" class="message auth-message hidden" role="status" aria-live="polite"></div>
            <p class="auth-footnote">HMusic Server 管理控制台</p>
          </div>
        </div>
      </section>

      <div id="dashboard" class="hidden">
        <section class="overview" aria-label="状态总览">
          <div class="overview-grid">
            <div class="overview-item" id="overviewPlayback"></div>
            <button class="overview-item" type="button" data-scroll-target="devicesSection" id="overviewDevices"></button>
            <button class="overview-item" type="button" data-scroll-target="miAccountSection" id="overviewMi"></button>
            <button class="overview-item" type="button" data-scroll-target="statsSection" id="overviewStats"></button>
          </div>
        </section>

        <div class="grid dashboard-grid">
          <section class="section" id="devicesSection">
            <h2><span class="sec-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/></svg></span>播放设备</h2>
            <p class="sec-sub">登录小米账号后刷新设备，选择默认播放设备。</p>
            <div class="actions">
              <button id="refreshDevicesButton" type="button">刷新小米设备</button>
              <button id="listDevicesButton" class="secondary" type="button">重新读取列表</button>
            </div>
            <div id="devices" class="device-list"></div>
          </section>

          <section class="section" id="configSection">
            <h2><span class="sec-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span>运行配置</h2>
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

          <section class="section" id="pluginsSection">
            <h2><span class="sec-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 17l6-6-6-6M12 19h8"/></svg></span>LX 插件</h2>
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

          <section class="section" id="manualTracksSection">
            <h2><span class="sec-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></span>手工曲目</h2>
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

          <section class="section" id="miAccountSection">
            <h2><span class="sec-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h10M4 17h7"/></svg></span>小米账号</h2>
            <div class="status" id="miStatus"></div>
            <div class="actions hidden" id="miLoggedInActions">
              <button id="miReloginButton" class="secondary" type="button">重新登录</button>
            </div>
            <div id="miLoginForm">
              <p class="sec-sub">账号密码只提交给当前 HMusic Server。服务端保存小米登录凭据，App 不需要保存小米密码。</p>
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
                <button id="miStatusButton" class="secondary" type="button">刷新状态</button>
              </div>
              <div id="miWebVerification" class="message warn hidden"></div>
              <details class="inline-panel" id="miSmsDetails">
                <summary>短信验证码登录</summary>
                <p class="subtle">使用小米账号密码发起短信验证登录。</p>
                <div class="actions">
                  <button id="miWebLoginButton" class="secondary" type="button">发送短信验证码</button>
                </div>
                <div id="miVerification" class="message warn hidden"></div>
              </details>
              <details class="inline-panel">
                <summary>手动导入会话</summary>
                <p class="subtle">导入已有小米会话；当短信验证被限制时，可使用已登录 Cookie 或 STS 回调。</p>
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
            </div>
          </section>

          <section class="section" id="statsSection">
            <h2><span class="sec-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/></svg></span>听歌统计</h2>
            <p class="sec-sub">来自播放历史的聚合数据，近 30 天。</p>
            <div class="status" id="listeningStats"></div>
          </section>

          <section class="section" id="searchSection">
            <h2><span class="sec-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg></span>搜索与播放测试</h2>
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

          <section class="section" id="diagnosticsSection">
            <h2><span class="sec-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg></span>链路诊断</h2>
            <p class="sec-sub">先用内置测试音频验证 HMusic Server 到小米音箱的播放链路。</p>
            <div class="actions">
              <button id="testToneButton" type="button">播放测试音频</button>
            </div>
          </section>

          <section class="section" id="runtimeSection">
            <h2><span class="sec-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></span>服务端状态</h2>
            <div class="status" id="runtimeStatus"></div>
          </section>

        </div>
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
        devices: null,
        miStatus: null,
        listeningStats: undefined,
        miReloginExpanded: false,
        playbackPollTimer: null,
        deviceStatsPollTimer: null,
        dashboardPolling: {
          playback: false,
          deviceStats: false,
        },
      };

      const el = (id) => document.getElementById(id);

      function setBusy(isBusy) {
        document.body.classList.toggle("is-busy", isBusy);
        document.querySelectorAll("button").forEach((button) => {
          button.disabled = isBusy;
        });
        el("authButtonLabel").textContent = isBusy
          ? state.initialized
            ? "正在登录..."
            : "正在创建..."
          : state.initialized
            ? "登录"
            : "创建并登录";
      }

      function showMessage(text, type) {
        const target = state.user ? el("globalMessage") : el("authMessage");
        target.textContent = text;
        target.className = "message" + (type ? " " + type : "");
        if (target.id === "authMessage") target.classList.add("auth-message");
        target.classList.remove("hidden");
      }

      function clearMessage() {
        el("globalMessage").classList.add("hidden");
        el("authMessage").classList.add("hidden");
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
        document.body.classList.toggle("auth-mode", !authenticated);
        el("authSection").classList.toggle("hidden", authenticated);
        el("dashboard").classList.toggle("hidden", !authenticated);
        el("logoutButton").classList.toggle("hidden", !authenticated);

        if (authenticated) {
          renderOverview();
          startDashboardPolling();
        } else {
          stopDashboardPolling();
        }

        el("authTitle").textContent = state.initialized ? "管理员登录" : "创建管理员账号";
        el("authButtonLabel").textContent = state.initialized ? "登录" : "创建并登录";
        el("authHint").textContent = state.initialized
          ? "输入管理员账号密码后继续。"
          : "首次使用需要创建管理员账号，密码至少 8 位。";
        el("adminPass").autocomplete = state.initialized ? "current-password" : "new-password";
        document.title = authenticated
          ? "HMusic Server 管理"
          : (state.initialized ? "登录" : "初始化") + " · HMusic Server";
      }

      function renderRuntime() {
        const info = state.systemInfo;
        el("serverInfo").textContent = info
          ? info.name + " " + info.version + " · " + location.origin
          : location.origin;
        el("authServerInfo").textContent = info
          ? info.name + " " + info.version
          : "HMusic Server";
        el("authServerOrigin").textContent = location.origin;
        el("runtimeStatus").innerHTML = [
          '<div class="status-row"><span class="k">API 版本</span><span class="pill">' + escapeHtml(info?.apiVersion || "v1") + "</span></div>",
          '<div class="status-row"><span class="k">管理员</span><span class="v">' + escapeHtml(state.user?.username || "未登录") + "</span></div>",
          '<div class="status-row"><span class="k">小米账号</span><span class="v">' + (info?.capabilities?.miAccount ? "支持" : "未启用") + "</span></div>",
          '<div class="status-row"><span class="k">播放控制</span><span class="v">' + (info?.capabilities?.playback ? "支持" : "未启用") + "</span></div>",
        ].join("");
      }

      function renderPlaybackState(playback) {
        state.playbackState = playback;
        renderOverview();
      }

      function formatDuration(milliseconds) {
        const seconds = Math.max(0, Math.round((milliseconds || 0) / 1000));
        const minutes = Math.floor(seconds / 60);
        return String(minutes).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
      }

      function renderOverview() {
        const playback = state.playbackState;
        // 暂停也要显示曲目（只是标注已暂停），否则与旧版行为相比是退化。
        const track = playback?.track || null;
        const positionMs = playback?.positionMs || 0;
        const durationMs = playback?.durationMs || 0;
        const progress = durationMs > 0
          ? Math.min(100, Math.round((positionMs / durationMs) * 100))
          : 0;
        el("overviewPlayback").innerHTML = track
          ? '<span class="overview-label">正在播放</span>' +
            '<span class="overview-value">' +
            escapeHtml([track.title, track.artist].filter(Boolean).join(" - ")) +
            '</span><span class="overview-meta">' +
            (playback?.state === "playing" ? "" : "已暂停 · ") +
            formatDuration(positionMs) + " / " + formatDuration(durationMs) +
            '</span><span class="overview-progress"><i style="width:' + progress + '%"></i></span>'
          : '<span class="overview-label">正在播放</span><span class="overview-value">空闲</span>' +
            '<span class="overview-meta">当前没有播放任务</span>';

        const devices = state.devices;
        const onlineCount = devices?.filter((device) => device.isOnline).length || 0;
        el("overviewDevices").innerHTML =
          '<span class="overview-label">播放设备</span><span class="overview-value">' +
          (devices ? devices.length + " 台 · 在线 " + onlineCount : "读取中...") +
          '</span><span class="overview-meta">查看和选择默认设备</span>';

        const miStatus = state.miStatus;
        const miText = !miStatus
          ? "读取中..."
          : miStatus.loggedIn
            ? "已登录"
            : miStatus.sessionExpired
              ? "已失效"
              : "未登录";
        const miMeta = miStatus?.accountMasked || (miStatus?.sessionExpired ? "请重新登录" : "配置小米账号");
        el("overviewMi").innerHTML =
          '<span class="overview-label">小米会话</span><span class="overview-value' +
          (miStatus?.sessionExpired ? " warn" : "") + '">' + escapeHtml(miText) +
          '</span><span class="overview-meta">' + escapeHtml(miMeta) + "</span>";

        const stats = state.listeningStats;
        const win = stats?.last30d || stats?.overview || {};
        const statsText = stats === undefined
          ? "读取中..."
          : stats
            ? "近 30 天 " + (win.totalPlays ?? 0) + " 次"
            : "暂不可用";
        el("overviewStats").innerHTML =
          '<span class="overview-label">听歌统计</span><span class="overview-value">' +
          escapeHtml(statsText) +
          '</span><span class="overview-meta">查看播放历史聚合</span>';
      }

      function showMiVerificationStatus(text, type) {
        const target = document.getElementById("miVerificationStatus");
        if (!target) return;
        target.textContent = text;
        target.className = "message" + (type ? " " + type : "");
        target.classList.remove("hidden");
      }

      function renderMiStatus(status) {
        state.miStatus = status;
        if (!status) {
          el("miStatus").innerHTML = '<span class="pill warn">未读取</span>';
          renderOverview();
          return;
        }
        const statusText = status.loggedIn
          ? "已登录"
          : status.sessionExpired
            ? "已失效"
            : "未登录";
        const rows = [
          '<div class="status-row"><span class="k">登录状态</span><span class="pill ' + (status.loggedIn ? "" : "warn") + '">' + statusText + "</span></div>",
        ];
        if (status.accountMasked) rows.push('<div class="status-row"><span class="k">账号</span><span class="v">' + escapeHtml(status.accountMasked) + "</span></div>");
        if (status.deviceId) rows.push('<div class="status-row"><span class="k">登录设备标识</span><span class="v">' + escapeHtml(status.deviceId) + "</span></div>");
        if (status.deviceCount !== undefined) rows.push('<div class="status-row"><span class="k">设备数量</span><span class="v">' + escapeHtml(status.deviceCount) + "</span></div>");
        if (status.updatedAt) rows.push('<div class="status-row"><span class="k">状态更新时间</span><span class="v">' + escapeHtml(new Date(status.updatedAt).toLocaleString()) + "</span></div>");
        el("miStatus").innerHTML = rows.join("");
        el("miLoginForm").classList.toggle("hidden", status.loggedIn && !state.miReloginExpanded);
        el("miLoggedInActions").classList.toggle("hidden", !status.loggedIn);
        renderOverview();
      }

      function renderDevices(devices) {
        state.devices = devices || [];
        const container = el("devices");
        if (!devices || devices.length === 0) {
          container.innerHTML = '<div class="message warn">暂无设备。请先登录小米账号并刷新设备。</div>';
          renderOverview();
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
        renderOverview();
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
        await Promise.all([loadConfig(), loadSources(), loadPlugins(), loadPlaybackState(), loadListeningStats()]);
      }

      async function loadPlaybackState() {
        const playback = await api("/playback/state");
        renderPlaybackState(playback);
      }

      async function loadListeningStats() {
        try {
          const result = await api("/stats");
          renderListeningStats(result.stats);
        } catch {
          state.listeningStats = null;
          el("listeningStats").innerHTML = '<div class="message warn">统计暂不可用</div>';
          renderOverview();
        }
      }

      function stopDashboardPolling() {
        if (state.playbackPollTimer) clearInterval(state.playbackPollTimer);
        if (state.deviceStatsPollTimer) clearInterval(state.deviceStatsPollTimer);
        state.playbackPollTimer = null;
        state.deviceStatsPollTimer = null;
        state.dashboardPolling.playback = false;
        state.dashboardPolling.deviceStats = false;
      }

      async function pollDashboard(key, task) {
        if (
          document.hidden ||
          !state.token ||
          !state.user ||
          el("dashboard").classList.contains("hidden") ||
          state.dashboardPolling[key]
        ) {
          return;
        }
        state.dashboardPolling[key] = true;
        try {
          await task();
        } catch {
          // 自动轮询静默失败，各区块的手动操作仍会展示具体错误。
        } finally {
          state.dashboardPolling[key] = false;
        }
      }

      function startDashboardPolling() {
        if (state.playbackPollTimer && state.deviceStatsPollTimer) return;
        stopDashboardPolling();
        state.playbackPollTimer = setInterval(() => {
          void pollDashboard("playback", loadPlaybackState);
        }, 8000);
        state.deviceStatsPollTimer = setInterval(() => {
          void pollDashboard("deviceStats", () => Promise.all([listDevices(), loadListeningStats()]));
        }, 60000);
      }

      function resetDashboardState() {
        state.playbackState = null;
        state.devices = null;
        state.miStatus = null;
        state.listeningStats = undefined;
        state.miReloginExpanded = false;
      }

      function renderListeningStats(stats) {
        state.listeningStats = stats || null;
        const container = el("listeningStats");
        if (!stats) {
          container.innerHTML = '<div class="message warn">暂无统计数据</div>';
          renderOverview();
          return;
        }
        const win = stats.last30d || stats.overview || {};
        const cards = [
          { n: win.totalPlays ?? 0, l: "累计播放" },
          { n: win.uniqueTracks ?? 0, l: "不同曲目" },
          { n: win.uniqueArtists ?? 0, l: "艺术家" },
          { n: win.activeDays ?? 0, l: "活跃天数" },
        ];
        const dist = (stats.sourceDist || []).slice(0, 4);
        const distHtml = dist.length
          ? '<div class="stat-dist">' +
            dist
              .map(
                (item) =>
                  '<div class="dist-row"><span class="k">' +
                  escapeHtml(item.label || item.source) +
                  '</span><span class="v">' +
                  item.count +
                  ' 次</span><div class="bar"><i style="width:' +
                  Math.min(100, item.percent || 0) +
                  '%"></i></div></div>',
              )
              .join("") +
            "</div>"
          : "";
        container.innerHTML =
          '<div class="stat-grid">' +
          cards
            .map(
              (c) =>
                '<div class="stat-card"><span class="n">' +
                escapeHtml(c.n) +
                '</span><span class="l">' +
                escapeHtml(c.l) +
                "</span></div>",
            )
            .join("") +
          "</div>" +
          distHtml;
        renderOverview();
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
        const track = state.config?.manualTracks?.[index];
        if (!track || !confirm('确认删除手工曲目“' + (track.title || "未命名曲目") + '”？')) return;
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
        const plugin = state.plugins.find((item) => item.id === pluginId);
        const pluginName = plugin?.name || pluginId;
        if (!confirm('确认删除 LX 插件“' + pluginName + '”？')) return;
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
          const wasInitialized = state.initialized;
          const username = el("adminUser").value.trim();
          const password = el("adminPass").value;
          const path = wasInitialized ? "/auth/login" : "/auth/setup";
          const result = await api(path, {
            method: "POST",
            body: JSON.stringify({ username, password }),
          });
          state.token = result.accessToken;
          state.user = result.user;
          localStorage.setItem("hmusic_admin_token", state.token);
          await refreshAuthStatus();
          await Promise.all([refreshMiStatus(), listDevices(), loadAdminData()]);
          el("adminPass").value = "";
          showMessage(wasInitialized ? "已登录" : "管理员账号已创建");
        });
      }

      function togglePasswordVisibility() {
        const input = el("adminPass");
        const button = el("passwordToggle");
        const showPassword = input.type === "password";
        input.type = showPassword ? "text" : "password";
        button.title = showPassword ? "隐藏密码" : "显示密码";
        button.setAttribute("aria-label", button.title);
        button.setAttribute("aria-pressed", String(showPassword));
        input.focus();
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
        state.miReloginExpanded = false;
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
        el("miSmsDetails").open = true;
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

      el("authForm").addEventListener("submit", (event) => {
        event.preventDefault();
        loginOrSetup();
      });
      el("passwordToggle").addEventListener("click", togglePasswordVisibility);
      el("logoutButton").addEventListener("click", () => {
        stopMiWebVerificationPolling();
        stopDashboardPolling();
        state.token = "";
        state.user = null;
        resetDashboardState();
        localStorage.removeItem("hmusic_admin_token");
        el("adminPass").value = "";
        el("adminPass").type = "password";
        el("passwordToggle").title = "显示密码";
        el("passwordToggle").setAttribute("aria-label", "显示密码");
        el("passwordToggle").setAttribute("aria-pressed", "false");
        renderAuth();
        renderRuntime();
      });
      el("miReloginButton").addEventListener("click", () => {
        state.miReloginExpanded = true;
        renderMiStatus(state.miStatus);
        el("miAccount").focus();
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
      document.querySelectorAll("[data-scroll-target]").forEach((button) => {
        button.addEventListener("click", () => {
          el(button.dataset.scrollTarget)?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      });
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
