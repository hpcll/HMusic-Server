# HMusic Bridge — Songloft 音源桥接插件（0.2.0）

按 [Songloft 插件迁移方案](../docs/songloft-plugin-migration-plan.md) 实现的可选桥接层。
HMusic-Server 继续独立运行，HMusic 自有客户端继续使用原有 API；本插件提供 Songloft 搜索、入库、播放、歌词和 MIoT 外部搜索适配。

**兼容要求：Songloft 2.12.0 或更新版本，以及包含本仓库严格解析补丁的 HMusic-Server。** 实测宿主、Web 和 macOS 客户端版本为 2.12.0；SDK/builder 固定为 2.15.0。尚未验证更高宿主版本。旧 HMusic Server 缺少 `verified` 响应时，插件会拒绝把未验证的 URL 当作解析成功。

## 链路

```text
Songloft 宿主
  ├─ POST /api/search      → HMusic GET  /api/v1/search?q=&page=&limit=&source=
  ├─ POST /api/music/url   → HMusic POST /api/v1/tracks/resolve { track, refresh, strict, timeoutMs }
  │                          (失败 + fallback hint → 插件自搜换源,used_fallback=true)
  ├─ POST /api/import      → songloft.songs.create(dedupKey=hmusic:<source>:<id>)
  ├─ POST /api/lyrics      → HMusic POST /api/v1/tracks/lyrics { track }
  ├─ GET  /lyric-search    → 宿主歌词 provider：同曲匹配后取歌词
  ├─ POST /api/search/topone → MIoT 外部搜索候选（不在此接口入库）
  └─ static/index.html     → 配置 / 来源筛选 / 入库与播放 / 重试 / MIoT 注册
```

- `source_data`: `{ schema_version: 1, provider: 'hmusic', track: <HMusicTrack> }`，宿主原样存 song 表并在 music/url 时回传。
- HMusic 地址与 JWT 存 `songloft.storage`，仅服务端 fetch 时使用，不进 source_data / 静态资源 / 日志。
- 同源地址留空沿用已存 Token；更换地址时输入凭据立即清空，跨源保存不继承旧 Token。支持域名、IPv4、带方括号的 IPv6 和反代路径；地址不接受用户信息、zone ID、查询或片段。
- 播放走 `/api/v1/songs/{id}/play`。桥接请求 `refresh: true, strict: true`，重新解析来源歌曲并以 Range 请求检查媒体 HTTP 状态；失败进入同曲换源，共享 26 秒预算。媒体 headers 随解析结果返回宿主，不写入歌曲身份。
- 页面“重试播放”重新提交已入库歌曲队列，无需重复入库；播放器可复用已有媒体缓存。已验证真实播放器遇到受控 503 后，重试重新取得 206 音频并恢复进度。手工/本地直链没有可查询的来源 ID，失效后仍需更换原地址。
- 原文与翻译歌词通过完整 track 查询，不要求歌曲先进入 HMusic 播放队列。
- MIoT 注册使用宿主的 `{success, data}` 确认；手动注册会先唤醒休眠的 MIoT。插件空闲卸载时保留歌词/搜索源登记，禁用或卸载后的有效性由宿主和 MIoT 校验。

## 使用

1. **构建**：在本目录运行 `npm ci`、`npm run build`，得到 `dist/hmusic-bridge.jsplugin.zip`。
2. **安装**：Songloft 客户端插件管理页上传该 zip（或放服务器 `data/jsplugins/`，或 `npm run dev` 连接实例热更新）。
3. **配置**：打开插件页，填 HMusic 地址（如 `http://<局域网IP>:6650`）与 JWT（登录 `/api/v1/auth/login` 获取 accessToken；HMusic 未开匿名时必填），点"测试连通"应显示"已认证"。
4. **播放**：选择全部来源、QQ、酷我、网易云或手工曲目，搜索后勾选结果并点“入库并播放”。“仅入库”不改变播放队列；媒体失败后可点“重试播放”。
5. **MIoT（可选）**：安装并启用官方“智能音箱”插件，在 HMusic 页面点“注册 / 重试注册”，再到 MIoT 设置里启用 HMusic 外部搜索源。注册不会自动更改音箱或搜索优先级。

服务器地址须能被 Songloft 宿主访问。这里的 HMusic 地址与 Songloft 登录地址是两个独立服务；容器或异机部署时不要照抄 `127.0.0.1`。

`npm run validate` 检查 `dist/_build` 中的构建 manifest，请先运行 `npm run build`。源码 `plugin.json` 的 entryHash/zipHash 保持为空，由 builder 构建时写入。

## 本地验证

完全离线，不需要 JWT 或运行中的服务：

```bash
npm run typecheck
npm test
npm run build
npm run validate
```

`npm test` 运行 51 项配置、页面和 MVP 回归用例，再运行 7 项候选遍历与超时预算断言（2026-09-14 快照，数量以输出为准）。网络使用模拟响应和虚构 Token；覆盖 IPv6 跨源保护、失败/并发交互、非法 JSON、宿主播放门控、严格解析、来源筛选、歌词，以及 MIoT 休眠唤醒和注册确认。预算用例约 26 秒。

需要真实 HMusic-Server 的在线冒烟：

```bash
npm run smoke -- http://127.0.0.1:6650 <JWT>
```

在 Node vm 中加载构建产物 + 模拟宿主 `songloft` 全局，对真实 HMusic-Server 验证配置、状态、搜索、source_data 契约、解析可播性、fallback 换源、入库 dedupKey 和非法输入；断言数量自动汇总。仅跑离线换源与预算用例可用 `npm run smoke -- --offline`。

离线用例与下面的真实宿主验收分别记录；不能用离线通过替代客户端播放证据。

## 真实宿主验收（2026-09-14 至 15 日）

- 隔离 Songloft 2.12.0 宿主的 9 项验收通过：0.1.0 → 0.2.0 升级保留配置、搜索和入库去重、带 headers 的媒体访问、旧 URL 失效后的刷新、歌词、禁用再启用，以及保留数据卸载重装。
- 真实 QQ 音源“晴天 / 周杰伦”搜索、解析、入库通过；官方 Flutter Web 客户端的插件 iframe 内点“入库并播放”后，媒体接口返回 206，播放器 `is_playing=true`，进度增长。
- 官方 MIoT 2026.9.11 接受 HMusic 注册并列出搜索源；最佳匹配返回真实 QQ 曲目身份，不携带临时播放 URL。
- MIoT 在实际空闲休眠后，手动注册成功唤醒并完成登记；宿主歌曲歌词接口返回“晴天”的带时间轴歌词。受控旧链接失效前后，宿主播放入口均返回 206 音频。
- macOS 原生客户端已登录，原生 WebView 的播放结果仍待操作确认。
- Server 类型检查及 23 个测试文件、151 项测试通过；插件类型检查、构建与 manifest 校验通过。

脱敏结果与截图见 [验收证据](test/evidence/2026-09-14/report.json)。真实音箱发声、手机端、跨主机部署及第三方 URL 的长时间暂停恢复未验收。

验收脚本：`test/acceptance-server.mjs` 启动使用全新目录的 HMusic 与本地媒体夹具；`test/host-acceptance.mjs`、`test/web-acceptance.mjs` 使用单独准备的宿主和认证文件。固定使用本机 58192–58194 端口，生命周期脚本会安装、禁用、卸载插件，**仅可用于隔离实例**。这些目录中的认证文件、真实 LX 脚本和原始日志不要提交。

## P0 实测记录（2026-09-12，本机 HMusic-Server）

| 项目 | 结果 |
| --- | --- |
| 聚合搜索 P50/P95（3 次） | ~380ms / ~580ms（tx+kw+wy 并行） |
| 解析（含可播性探测） | ~2.0s；插件侧单次 music/url 总预算 26s（宿主单请求钳制 ≤30s） |
| CDN 直链实测 | Range 1 字节 → 206 可播 |
| Songloft SDK/builder | 2.15.0（npm），builder 产出 zip+entryHash+zipHash |
| 宿主音源架构 | 2026 新架构：songs 表存 (plugin_entry_path, source_data)，客户端播放走 `/api/v1/songs/{id}/play` |

## 兼容边界

- 已将 `minHostVersion` 从未经验证的 1.3.0 改为实际验收版本 2.12.0。
- 2.12.0 的 fetch 响应上限为 64 MiB，单请求最长 30 秒；它不识别 `X-Fetch-Control: bypass`，本插件已移除此头及不需要的 `net` 权限。
- HMusic accessToken 过期后需在插件页更新；未实现自动刷新或长期凭据签发。
- 死链检测保证严格模式不放行 HTTP 失败或探测异常；HTTP 成功不能证明任意媒体格式都能解码。自然过期、客户端缓存及长时间暂停后的恢复仍受宿主和音源行为影响。
- P3 的原生 LX 运行时、榜单/歌单导入、缓存下载、Spotify 登录与曲库迁移是可选后续能力，本版本未实现。
