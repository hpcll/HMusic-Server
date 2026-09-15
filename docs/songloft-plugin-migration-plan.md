# HMusic-Server 迁移为 Songloft 插件：技术决策记录

> 状态：0.2.0 已补齐 P1/P2 桥接能力，真实宿主与 Web 播放通过；原生客户端播放待确认
>
> 更新：2026-09-15
>
> 适用对象：后续负责 Songloft 插件化工作的 Agent 和开发者

## 决策摘要

**产品前提：HMusic 客户端继续使用自有客户端，不迁移到 Songloft 客户端。** Songloft 适配是可选的后端/生态兼容层，不能取代 HMusic App、HMusic Web 或现有播放体验。

HMusic-Server 不直接作为 Node.js 服务原样打包进 Songloft。若决定适配，推荐采用两阶段路线：

1. **第一阶段做桥接插件**：HMusic-Server 继续独立运行，Songloft 插件调用它的搜索和解析接口，并把结果转换为 Songloft 音源协议。
2. **第二阶段做原生音源插件**：逐步把 QQ、酷我、网易云搜索、歌词和轻量内容能力移入 QuickJS 插件，逐步减少对 HMusic-Server 的依赖。

HMusic 自己的 Fastify、SQLite、播放队列、媒体代理、下载、mDNS、watchdog 和 Playwright 登录不属于第一阶段迁移范围。小米设备控制优先复用官方 Songloft MIoT 插件，HMusic 只作为外部搜索源接入。

## 是否值得适配 Songloft

**决策：可以适配，但优先级低于 HMusic 自有客户端和 Server 演进；只做低耦合的桥接插件，不把 HMusic 全面重写成 Songloft 专属后端。**

Songloft 已经具备相对成熟的宿主基础：官方仓库当前约有 1,694 个 Star，存在 v2.12.0 发布版本，提供 Go 服务端、Flutter 多端客户端、Web 界面、QuickJS 插件体系和官方 MIoT 插件。由于 HMusic 明确继续使用自己的客户端，Songloft 不能被计入 HMusic 的客户端分发、播放器和 UI 收益。它能提供的主要价值只剩下插件生态兼容、Songloft 用户入口和与官方 MIoT 插件的外部搜索联动。HMusic 的差异化则在于 QQ/酷我/网易云聚合、LX 兼容、匹配和解析，这些能力可以作为 Songloft 的音源插件提供。

适配的产品价值主要有三点：

1. 借助 Songloft 插件目录、社区和 MIoT 外部搜索入口，触达一部分 Songloft 用户；
2. 让 HMusic 的音源和解析能力可以被另一个成熟宿主调用；
3. 保留 HMusic-Server 和 HMusic 客户端作为主产品，Songloft 适配只承担增量入口。

适配也有边界：Songloft 的主定位是管理用户合法拥有的本地音乐，第三方网络音源由社区插件自行承担兼容和合规责任；它的 QuickJS 沙箱不适合承载 HMusic 全部 Node.js 服务能力；Star 数和发布频率只能说明项目有活跃度，不能等同于真实安装量、插件曝光量或长期 API 稳定性。由于 HMusic 不使用 Songloft 客户端，适配的新增用户和收入价值需要通过实际插件安装、活跃调用和 MIoT 使用数据验证，不能预先高估。

### 建议的架构承诺

HMusic 后续代码应分成三层：

```text
HMusic Core（搜索、匹配、解析、歌词、来源模型）
       ├─ HMusic REST Adapter（HMusic 客户端和 Server）
       └─ Songloft Plugin Adapter（可选的 Songloft 插件）
```

核心层不应依赖 Songloft 的数字歌曲 ID、QuickJS API 或 MIoT action。所有 Songloft 特有逻辑集中在 adapter 中，使用版本化的 `source_data` 和稳定 `dedupKey`。HMusic 客户端的 API、播放队列、设备控制和 UI 继续以 HMusic 自己的协议为准。这样即使 Songloft API、插件政策或用户规模变化，也可以继续维护 HMusic 原生 App。

### 适配决策门槛

在投入 Songloft 适配前，必须满足以下 POC 门槛：

- 一个真实音源能够在 Songloft 中完成“搜索 → 入库 → 解析 → 播放”；
- Songloft 宿主至少完成一次真实搜索、入库和播放，且 URL、headers、过期重试行为可控；
- MIoT 外部搜索源能够返回 HMusic 的最佳匹配歌曲；
- 插件安装、升级、卸载和配置恢复流程可用；
- POC 代码不需要修改 HMusic 核心数据模型，也不暴露长期凭证；
- Songloft 插件超时和第三方音源失败时，HMusic 原有 Server/App 仍可独立工作；
- 适配不会要求 HMusic 用户安装或切换到 Songloft 客户端。

若上述门槛中“宿主播放”或“网络可达性”无法稳定通过，应停止扩大迁移范围，保留 Songloft 适配为实验性插件，不继续投入 LX、Spotify 和曲库迁移。

## 为什么不能直接打包整个 HMusic-Server

Songloft 插件运行在 Go 宿主提供的 QuickJS 沙箱中，插件形态是 `plugin.json + main.js/main.jsc + static/`，由宿主调用生命周期和 HTTP 路由。它不是 Node.js 进程，也不是可长期监听端口的完整后端。

当前 HMusic-Server 依赖或使用了以下不能原样带入插件的能力：

- Fastify 和 Node HTTP 服务生命周期；
- `better-sqlite3`、Drizzle 以及本地 SQLite 文件；
- Node `vm`（LX 运行时）；
- Playwright 启动独立 Chromium 窗口（Spotify 登录）；
- Node 文件系统、媒体流、下载和本地代理；
- mDNS、播放 watchdog 和常驻后台进程。

Songloft 插件可使用宿主提供的 `fetch`、定时器、有限的 `Buffer/crypto/zlib`、持久化 KV 和 songs/playlists API。插件应返回媒体 URL 和必要 headers，让 Songloft 宿主负责播放；不要在 JS 中搬运完整音频字节。

## 目标架构

```text
Songloft 宿主
  ├─ HMusic 插件页面（配置、搜索、结果、导入/播放）
  ├─ /api/search       ──> HMusic-Server /api/v1/search
  ├─ /api/music/url    ──> HMusic-Server /api/v1/tracks/resolve（按实际接口确认）
  └─ Songloft player   <── 宿主歌曲 ID

官方 MIoT 插件
  └─ 外部搜索源 ──> HMusic 插件 /api/search/topone
```

第一阶段的插件保存 HMusic 地址和认证配置，调用 HMusic 现有 REST API，将 HMusic 的歌曲模型转换为 Songloft 模型。搜索结果写入 Songloft 曲库后，交给宿主播放器；播放队列、播放状态和续播由 Songloft 管理。

## Songloft 音源协议映射

### 搜索

插件实现：

```http
POST /api/search
Content-Type: application/json

{"keyword":"...","page":1,"page_size":20}
```

响应中的每项至少包含：

```json
{
  "title": "...",
  "artist": "...",
  "album": "...",
  "duration": 180,
  "cover_url": "...",
  "source_data": {
    "schema_version": 1,
    "provider": "hmusic",
    "track": {
      "id": "tx:...",
      "source": "tx",
      "sourceTrackId": "...",
      "title": "...",
      "artist": "...",
      "durationMs": 180000
    }
  }
}
```

`source_data` 是插件私有的 opaque JSON。HMusic 的 `source`、`sourceTrackId`、必要的 `raw` 信息应放入其中，并加入 schema 版本，避免将来修改格式时破坏已有歌曲。

### 解析播放 URL

插件实现：

```http
POST /api/music/url
Content-Type: application/json

{
  "source_data": {},
  "fallback": {
    "enabled": true,
    "title": "...",
    "artist": "...",
    "duration": 180
  }
}
```

响应：

```json
{
  "url": "...",
  "headers": {},
  "source_data": {},
  "used_fallback": false
}
```

HMusic 使用字符串歌曲 ID 和毫秒时长，Songloft 曲库使用数字歌曲 ID 和秒数，必须在适配层显式转换。`dedupKey` 稳定地由来源和来源歌曲 ID 生成，例如 `hmusic:tx:<track-id>`（HMusic 平台码为 tx/kw/wy），同时保留必要的标题、歌手和时长回退信息。

### 主动搜索和入库

不能假定 `/api/search` 会自动成为 Songloft 普通全局搜索 UI。插件页面应负责主动搜索，选择结果后调用 `songloft.songs.create`（或宿主对应的歌曲 API）入库，再把宿主返回的数字 ID交给 `SongloftPlugin.player`。

## HMusic 模块迁移边界

| 模块 | 第一阶段 | 长期判断 |
| --- | --- | --- |
| QQ/酷我/网易云聚合搜索 | 通过 Server 桥接 | 可移植到原生插件 |
| 匹配、音质回退、URL 可播性检查 | 通过 Server 桥接 | 可移植，但需压缩超时 |
| 歌词 | 暂不阻塞 POC | 可注册 Songloft lyrics provider |
| LX JS 运行时 | 暂不迁移 | 用 `songloft.jsenv` 重写并逐脚本实测；不能复制 Node `vm` |
| SQLite 曲库、歌单 | 保留在 Server | 映射到 Songloft songs/playlists |
| HMusic 播放队列和 watchdog | 不迁移 | 交给 Songloft 播放器和宿主 |
| 下载、代理、缓存 | 不迁移 | 按宿主媒体能力重新设计 |
| Spotify 搜索/匹配 | 保留 Server | 数据逻辑可移植 |
| Spotify Playwright 登录 | 不迁移 | 需要 Cookie、WebView 或其他认证方案，单独验证 |
| 小米账号和设备控制 | 不迁移 | 优先复用官方 MIoT 插件 |

## MIoT 接入策略

官方 MIoT 插件已经覆盖小米账号、设备、TTS、队列、自动续播、分组、定时和语音搜索等大量能力。HMusic 不应重复维护整套小米控制逻辑，而应注册为 MIoT 的外部搜索源：

```ts
songloft.comm.call("miot", "register-search-provider", {
  name: "HMusic",
  searchPath: "/api/search/topone"
})
```

HMusic 插件需要提供“标题 + 歌手 + 时长”最佳匹配接口，返回 Songloft 可入库和播放的歌曲信息。注册需要 `inter-plugin` 权限，且用户仍需在 MIoT 设置中启用该搜索源。

目前不能假设存在通用的 `comm.play` 设备控制 action。若要同步设备状态或直接控制设备，先验证官方 MIoT 当前版本的受保护 HTTP 路由或补充通用跨插件 API；不要把这项能力写进第一阶段承诺。

## 分阶段实施与验收

### P0：协议和环境确认

- 确认 Songloft 主机版本、插件 SDK 版本、`minHostVersion` 和打包方式。
- 确认 HMusic 与 Songloft 的部署关系：同机、局域网或反向代理。
- 确认插件请求 HMusic 所需的认证方式、CORS、HTTPS 和可达地址。
- 测量 HMusic 单源搜索、聚合搜索、解析 URL 的 P50/P95 延迟。
- 用一首真实歌曲确认 Songloft 宿主能访问 HMusic 返回的 URL 和 headers。

### P1：最小桥接 POC

只支持一个稳定音源，完成：

1. 插件保存 HMusic 地址和认证配置；
2. 页面搜索并展示结果；
3. 结果写入 Songloft 曲库；
4. Songloft 宿主播放该歌曲；
5. 解析失败时可重试并重新获取 URL；
6. 在 WebView 和至少一个真实客户端完成验证。

POC 通过标准：搜索、入库、播放三条链路连续跑通；不依赖 HMusic 前端；不把长期密钥暴露在静态页面或 `source_data` 中。

### P2：基础 MVP

- QQ/酷我/网易云搜索；
- 稳定的 `source_data` 和 `dedupKey`；
- 歌词 provider；
- 基础设置页、错误提示和健康检查；
- MIoT 外部搜索源；
- URL 过期后的重新解析和播放重试；
- `.jsplugin.zip` 打包、安装、升级和卸载验证。

### P3：可选能力

- LX `jsenv` 兼容层；
- 榜单、歌单导入；
- 本地缓存或宿主下载能力；
- Spotify 数据读取和替代登录流程；
- 在减少 Server 依赖后再评估原生曲库迁移。

## 必须提前验证的风险

1. **网络可达性**：Songloft 宿主、客户端和 HMusic 可能不在同一网络；`127.0.0.1` 对客户端不一定有效。
2. **URL 生命周期**：CDN 签名可能过期；需要确认排队后播放、暂停恢复、302、headers、Range 和重试行为。
3. **超时预算**：Songloft 音源调用预算比 HMusic 当前多源重试流程更紧，可能需要异步化或减少探测。
4. **认证泄露**：HMusic JWT、第三方音源密钥和用户 LX 脚本不得进入前端静态资源、日志、曲目 `source_data` 或插件仓库。
5. **去重和升级**：歌曲 ID、`source_data` schema、解析策略变更必须兼容已有 Songloft 歌曲。
6. **客户端差异**：原生 WebView、Songloft Web iframe、普通浏览器标签页的宿主桥能力不同。初期优先声明 WebView 支持矩阵。
7. **LX 兼容性**：`jsenv` 与 Node `vm` 不是同一个运行时，必须建立脚本级兼容测试，不能凭静态代码判断兼容。
8. **Spotify 登录**：Playwright 窗口无法原样放入 QuickJS 插件；Cookie 和 WebView 方案存在登录、过期和风控不确定性。
9. **第三方接口稳定性**：QQ、酷我、网易云以及用户提供的 LX 脚本可能限流、改接口或要求额外凭证，应有来源健康状态和失败降级。
10. **部署和资源**：桥接方案仍需要运行 HMusic-Server、持久化数据库和网络端口，不能宣传为“单个轻量插件完全替代 Server”。

## 关于“songfilt”依赖的决策

截至本记录更新时，未确认你所说的 `songfilt` 对应的准确项目地址；按这个拼写检索到的公开 GitHub 项目与 Songloft 音乐宿主/插件生态不匹配，也没有足够的活跃度和用户量证据。因此当前方案**不把 songfilt 作为迁移前置依赖，也不建议为了“看起来成熟”直接把 HMusic 核心绑定到它**。

如果你指的是另一个项目，请补充准确的仓库链接或产品名称。收到链接后，应按以下标准重新评估：

- 是否有稳定的公开 API/插件协议和版本策略；
- 最近一年提交、发布、Issue 响应和真实安装量；
- 是否能直接解决 HMusic 的音源解析、播放 URL、认证或客户端分发问题；
- 是否与 Songloft 的 QuickJS、宿主认证、媒体播放模型兼容；
- 许可证、第三方音源合规和迁移成本；
- 引入后是否形成单点依赖，导致 HMusic 自己的核心能力无法独立演进。

即使该项目确实成熟，也更适合作为**可替换的适配层或音源后端**，而不是让 HMusic 全面依赖它。HMusic 应先保持自己的 Songloft 音源协议边界，必要时再增加 `SongfiltProvider` 之类的独立 adapter。

## 给后续 Agent 的执行入口

开始编码前，先阅读：

- 本文件；
- [HMusic 后端实现](backend-implementation.md)；
- [HMusic 功能全景](FEATURES.md)；
- [src/app.ts](/Users/pchu/AICODE/HMusic-Server/src/app.ts)；
- [src/modules/search/native-search.service.ts](/Users/pchu/AICODE/HMusic-Server/src/modules/search/native-search.service.ts)；
- [src/modules/search/search.service.ts](/Users/pchu/AICODE/HMusic-Server/src/modules/search/search.service.ts)；
- [src/modules/sources/lx-plugin.runtime.ts](/Users/pchu/AICODE/HMusic-Server/src/modules/sources/lx-plugin.runtime.ts)；
- [src/shared/contracts.ts](/Users/pchu/AICODE/HMusic-Server/src/shared/contracts.ts)；
- Songloft 的 [JS 插件开发指南](https://github.com/songloft-org/songloft/blob/main/docs/js-plugin-development-guide.md) 和官方插件 SDK。

第一份实现应只做 P0/P1，不要同时重写 LX、Spotify、SQLite、下载或小米控制。每次扩展都应保留独立的协议适配层，并用真实 Songloft 宿主完成搜索、入库、解析和播放验收。

## 当前仓库状态

桥接插件 0.2.0 已实现来源筛选、严格刷新与失败换源、媒体 headers、歌词 provider、MIoT 最佳匹配与注册、页面播放重试。Songloft 2.12.0 的真实宿主、官方 Web 客户端与插件生命周期验收已经通过；macOS 原生客户端已登录，播放链路待最终确认。当前接口、使用方式和兼容边界以 [插件 README](../songloft-plugin/README.md) 为准。

HMusic Server 仅为解析接口增加可选的 `refresh`、`strict`、`timeoutMs` 和媒体 headers 支持，旧客户端未请求这些选项时沿用原行为。Songloft 的歌曲 ID、`source_data`、MIoT 协议继续集中在插件适配层。工作区已有的 charts/Spotify/UI 改动与本次插件工作分开维护。

## 补齐与真实宿主验收（2026-09-14 至 15 日）

| 项目 | 当前证据 |
| --- | --- |
| 宿主与版本 | 官方 Songloft 2.12.0，本地隔离运行；`minHostVersion` 已校正为 2.12.0 |
| 搜索、入库、播放 | 真实 QQ“晴天 / 周杰伦”通过；官方 Flutter Web 的插件 iframe 发起播放，媒体 206、播放状态为真且进度增长 |
| 过期与 headers | 受控媒体夹具要求 Referer，并能主动使旧链接失效；真实宿主取得新 URL 和媒体字节；Server 集成测试覆盖 302、Range、403 和超时 |
| 生命周期 | 旧版升级保留配置、重复入库去重、禁用再启用、保留数据卸载重装，宿主验收合计 9 项通过 |
| 页面重试 | 浏览器路由注入 503，真实播放器失败后点“重试播放”取得 206 并恢复进度；不重复入库。正常重播允许复用客户端缓存 |
| 歌词 | 完整 track 接口、译文转换和宿主 provider 已实现；宿主返回真实“晴天”时间轴歌词，夹具与离线契约验证通过 |
| MIoT | 官方 2026.9.11 接受注册，实际休眠后的唤醒注册通过；列表包含 HMusic，真实最佳匹配返回 QQ 曲目身份；未验收物理音箱发声 |
| 原生客户端 | macOS 2.12.0 已登录；原生 WebView 的搜索、入库和播放结果待操作确认 |
| 自动检查 | Server 151 项测试，插件 51 项回归和 7 项离线冒烟通过；两端类型检查、插件构建和 manifest 校验通过 |

本轮纠正了两项宿主假设：2.12.0 的 fetch 响应上限是 **64 MiB**，并不识别 `X-Fetch-Control: bypass`，相关头和不需要的 `net` 权限已移除；`onDeinit` 也会在空闲休眠时触发，不能在此撤销歌词和 MIoT 搜索源登记，否则后续请求无法唤醒插件。手动 MIoT 注册先通过宿主 HTTP 路由加载目标插件，再检查 `{success, data: {ok}}` 确认。

脱敏结果见 [验收证据](../songloft-plugin/test/evidence/2026-09-14/report.json)。自然 URL 过期后的长时间暂停恢复、跨主机/移动客户端和真实音箱仍需对应环境验证。P3 保持为可选后续能力，未借本轮扩展为 LX、Spotify 或曲库重写。

## P0/P1 执行记录（2026-09-12）

> 以下为历史执行快照，其中的“未验收”、1.3.0 和 bypass 假设已由上方 2026-09-14 的结果更新，不应作为当前状态读取。

按本方案完成 P0 协议确认与 P1 最小桥接 POC 实现，产物在 `songloft-plugin/`（独立目录，与既有未提交改动零重叠）。

### P0 确认结果

- **Songloft 音源协议**：官方 SDK 2.15.0 固化了 2026 新架构约定，与本文档 §Songloft 音源协议映射一致——插件实现 `POST /api/search`（`{keyword,page,page_size}` → `{results:[{title,artist,album,duration,cover_url,source_data}]}`）与 `POST /api/music/url`（`{source_data,fallback}` → `{url,headers?,source_data?,used_fallback?}`）；SDK 直接提供 `createSearchHandler` / `createMusicUrlHandler`。宿主歌曲表存 `(plugin_entry_path, source_data)` 而非 url，客户端播放统一走 `/api/v1/songs/{id}/play`，宿主每次向插件取新鲜直链。**注意：URL 过期重试"天然成立"的结论已收回，降级为待验证**——HMusic 解析接口遇到自带 `url` 的曲目会直接返回原链接（`src/modules/search/search.service.ts:133`），再次调用解析未必得到新链接；排队后过期、暂停恢复、失败重试都仍需真实宿主验收。
- **入库**：`songloft.songs.create` 支持 `sourceData`（JSON 字符串）与 `dedupKey`，且自动关联创建插件；本插件 dedupKey 取 `hmusic:<source>:<sourceTrackId>`（对应文档建议的 `hmusic:qq:<track-id>`，HMusic 平台码为 tx/kw/wy）。
- **HMusic API 实测**（本机 6650 端口）：聚合搜索 P50≈380ms / P95≈580ms；`POST /api/v1/tracks/resolve` 全程约 2.0s（含档位可播性探测）；返回的 QQ CDN 直链 Range 探测 206 可播。均为 JWT 鉴权（`Authorization: Bearer`）。
- **工具链**：npm 上 `@songloft/plugin-sdk` / `plugin-builder` / `client-sdk` 均 2.15.0；builder 产出 `.jsplugin.zip` + entryHash/zipHash + main.jsc。
- **待实测项**：本机无 Songloft 实例，宿主真实“入库→播放”未验证；`minHostVersion` 暂按脚手架模板填 `1.3.0`；`X-Fetch-Control: bypass`（搜索响应可能超 SourceFetcher 单请求 10KB 默认值，插件已声明 `net` 权限并发送该头）需在真实宿主确认。

### P1 实现与验证

- 位置：`songloft-plugin/`（TS 源码 `src/main.ts`、页面 `static/`、冒烟测试 `test/smoke.mjs`、构建产物 `dist/hmusic-bridge.jsplugin.zip`，已含 entryHash/zipHash）。
- 能力：连接配置（存 `songloft.storage`，不回传明文）、连通状态检查、聚合搜索（结果带 schema 版本化 `source_data`）、解析与换源共享 26s 总预算（宿主单请求钳制 30s）、fallback 自搜换源（移植 HMusic `isSameSong` 判定 + 时长±5s 择优）、入库（`songs.create` + dedupKey，token 不入 source_data）、页面勾选后经宿主 `player.setQueue` 播放。
- 验证：`npm run smoke` 在 Node vm 中加载构建产物、模拟宿主全局、对真实 HMusic-Server 跑通 22 项断言，全部通过（含 fallback 换源、非法输入 404/400、token 不泄露检查）。

### 下一步（P1 宿主验收 → P2）

1. 在真实 Songloft 实例安装 `dist/hmusic-bridge.jsplugin.zip`，完成“搜索→入库→播放”三链路 + WebView 与至少一个真实客户端验证（P1 通过标准）；据此修正 `minHostVersion` 并确认 `X-Fetch-Control: bypass` 行为。
2. 通过后进入 P2：QQ/酷我/网易云显式来源筛选、`songloft.lyrics` 歌词 provider（**用 `POST /api/v1/tracks/lyrics` 传完整 track**；`GET /api/v1/tracks/:id/lyrics` 只从播放状态和队列找歌，仅入库未播放的歌会返回空歌词，见 `src/modules/lyrics/lyrics.service.ts:77`）、`/api/search/topone` + MIoT `register-search-provider`、设置页错误提示完善、安装/升级/卸载验证。

### 第二轮评审修订（2026-09-12，针对宿主源码比对后的三项）

1. **解析超时预算不成立 → 已修**。宿主 `jsruntime` 将单请求 `X-Fetch-Timeout-Ms` 钳制在 100–30000ms（`runtime.go:2042`），此前解析写的 40s 无效。现改为：单次 `music/url` 总预算 26s（宿主约 30s 调用上限留 4s 余量），原曲解析、自搜、候选串行解析共享同一预算，剩余 <4s 即止损返回 404，由宿主下次重试。慢源场景（每个候选都吃满超时）此前会串行 21 次解析直至被宿主整体掐断，现最多消耗一次预算。Phase C 冒烟断言覆盖：预算耗尽 → 404、总耗时 <30s、尝试序列 `原曲→slow-a→slow-b→止损`。
2. **"URL 过期重试天然消解"缺乏依据 → 已收回为待验证**（见上文 P0 记录修订）。HMusic `resolveTrack` 遇到自带 `url` 的曲目直接返回原链接，再次调用解析未必拿到新链接；排队后过期、暂停恢复、失败重试均待真实宿主验收。
3. **P2 歌词接口选错 → 已更正**。`GET /api/v1/tracks/:id/lyrics` 只从播放状态与队列找歌（`lyrics.service.ts:77`），仅入库未播放的歌返回空歌词；P2 歌词 provider 应使用 `POST /api/v1/tracks/lyrics` 传完整 track。

另：`npm run validate` 对源码 `plugin.json` 报空哈希属预期（entryHash/zipHash 由 builder 构建时写入），对构建产物校验通过。本轮重新验证：TypeScript、构建、32 项冒烟断言（live 25 + mock 候选遍历 4 + mock 预算 3）全部通过。

### 第三轮评审修订（2026-09-12，第二轮复核后的四项）

1. **跨 origin 泄漏旧 JWT → 已修**。`POST /api/config` 未传 token 时仅在新旧地址**同 origin** 时沿用已存凭证；跨 origin 一律清空、要求重填（换回旧地址同样需要重填，因为中间已切走）。冒烟断言覆盖：A+Token → B 留空（不沿用）→ 回 A 留空（仍不沿用）→ 重填恢复 → 同 origin 仅尾斜杠差异留空（沿用）。
2. **清除 Token 后被写回 → 已修**。"清除 Token"成功后同步清空输入框 `value`，不再只是重置 placeholder；否则"清除 → 测试连通"会把输入框里残留的旧 Token 重新写回。
3. **宿主桥不可用时播放按钮仍启用 → 已修**。新增 `hostAvailable` 状态（来自 `host.isAvailable()` 实测），`canPlay()` 必须同时满足宿主可用 + `player.setQueue` 存在（宿主公共脚本在桥不可用时也会注入该函数）；"仅入库"按钮同样以宿主可用为门槛。
4. **JSON null 请求体触发未捕获异常 → 已修**。新增 `parseJsonObject`：`JSON.parse('null')` / 数组 / 非法 JSON 一律返回 null，配置、入库、解析三个路由统一返回 400，不再让 TypeError 落入宿主错误处理。

测试脚手架修正：Node vm 沙箱默认缺 QuickJS 宿主具备的 `URL` / `TextDecoder` / `Response` 全局，此前 `isSameOrigin` 内 `new URL` 抛 ReferenceError 被 catch 吞掉、恒判为跨 origin——已显式注入。本轮验证：TypeScript、构建、**39 项冒烟断言**（live 32 + mock 候选遍历 4 + mock 预算 3）全部通过；前端两项修复（清除联动、按钮门控）属浏览器行为，经源码逐处核对，未纳入 vm 断言。

### 第四轮评审修订（2026-09-12，第三轮复核后的四项）

1. **页面残留 Token 绕过跨 origin 防护 → 已修**。后端防住了“未传 token”路径，但页面在保存/测试成功后不清空输入框，用户换地址点“测试连通”会显式提交旧 Token 给新服务器（显式提交不受跨 origin 规则约束）。现改为：保存成功与测试连通成功后均清空 `token` 输入值并刷新掩码 placeholder（经 `GET /api/config` 回读）。
2. **宿主握手失败/缺 player 能力时按钮放行 → 已修**。`hostAvailable` 只在 `getInfo()` 成功回调内置位，失败回调回退 false；`canPlay()` 三重门槛：握手成功 + `capabilities` 含 `player` + `player.setQueue` 存在。握手结果晚于首次搜索完成时，通过 `updateImportButtons()` 补刷按钮状态；“仅入库”按钮继续以握手成功为门槛。
3. **同源判断在宿主与 Node 行为不一致 → 已修**。宿主 URL polyfill 不省略默认端口，`URL.origin` 直接比较会让 `http://host:80` 与 `http://host` 在宿主判异源（清空 JWT，过严但安全）、在 Node 测试判同源。改为 `canonicalOrigin` 手动规范化：主机名小写 + 省略 `http:80` / `https:443`，两端行为一致。冒烟断言覆盖：显式 `:80` 与省略端口同源沿用、主机名大小写不敏感、协议不同清空、端口 `:8080` 清空。
4. **搜索路由缺 JSON null 防护 → 已修**。弃用 SDK `createSearchHandler`（其 `JSON.parse` 后直接 `body.keyword`，null 会抛 TypeError），改用与其他路由一致的 `parseJsonObject` 校验，null/数组/非法 JSON 统一 400。

当轮记录为全部通过；2026-09-14 复核断言数量应为 **45 项**（live 38 + mock 候选遍历 4 + mock 预算 3），此前写成 46 项属计数错误。预算用例约 26s 结束。前端两项修复（保存后清空输入、握手/能力门控）当轮仅经源码核对与 `node --check`，未纳入 vm 断言；后续复核发现失败/请求未返回与 IPv6 路径仍有缺口，见下方修复记录。

### 第五轮修复（2026-09-14，剩余凭据问题与回归验证）

1. **IPv6 同源误判 → 已修**。不再依赖宿主 URL polyfill 的 `hostname`/`port`（其 `split(':')` 会截断 IPv6）。独立解析完整主机与端口，IPv6 展开为八组后比较，兼容压缩写法、大小写、内嵌 IPv4 和默认端口。更换 IPv6 地址或端口会清空旧 JWT。用户信息、zone ID、查询、片段、非法端口等不支持的地址返回 400；旧存储中的非法地址也禁止出站。
2. **失败与请求未返回时残留 Token → 已修**。地址变化时立即清空输入凭据与旧掩码；保存、测试、清除共用串行入口，提交时即清空 Token。请求期间按钮禁用、输入仍可修改；配置修订号使迟到的保存、状态和初始配置响应无法覆盖新输入。新地址只有重新填写的 Token 才会被显式提交。
3. **测试缺口 → 已补**。新增 `test/regression.mjs`：真实插件 handler + 真实页面脚本 + 隔离网络/最小 DOM，覆盖 Node URL 与宿主 polyfill、IPv6、默认端口、非法地址、12 种非法 JSON 请求、失败与并发交互、清除联动、宿主握手与播放能力门控。旧代码先复现 15 个失败场景，修复后 40 项回归用例通过。宿主 URL 夹具保留上游实现，避免 Node 的标准 URL 掩盖宿主差异。
4. **验证入口与计数 → 已修**。`npm test` 运行回归测试与离线 Phase B/C；`npm run smoke -- --offline` 可单独跑原有换源/预算断言；在线冒烟仍需显式提供服务地址和 JWT。冒烟数量由脚本运行时统计；`npm run validate` 改为检查 `dist/_build` 的构建 manifest，不再因源码哈希留空误报。

本轮结果：`npm run typecheck`、页面 `node --check`、`npm test`（40 项回归 + 7 项离线冒烟）、`npm run build` 与 `npm run validate` 全部通过。重建 `dist/hmusic-bridge.jsplugin.zip`（含 `main.jsc`），另行复核 entryHash/zipHash、ZIP CRC、包内文件与构建目录逐字节一致、HTML 引用的脚本与当前页面源码一致。

本轮离线验证使用虚构 Token 和模拟上游，不计为真实 HMusic 在线冒烟或 Songloft 宿主验收。P1 剩余验收仍为真实宿主的“搜索→入库→播放”、WebView 与客户端行为、URL/headers/过期重试、`minHostVersion` 和 bypass 支持；歌词、MIoT 与生命周期验收仍按 P2 门槛推进，P3 未开展。
