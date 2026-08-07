# HMusic Server

HMusic App 的自建后端，负责服务端登录、运行配置、小米账号设备、音源插件、搜索解析和小爱音箱播放控制。

## 快速开始

装到 NAS 或服务器上，一条命令：

```bash
git clone https://github.com/hpcll/HMusic-Server.git
cd HMusic-Server
bash install.sh
```

自动完成：选择 Docker 或原生方式、生成随机 JWT 密钥、启动服务、打印访问地址。
浏览器打开提示的地址即可创建管理员账号，然后在「设置 → 小米账号」扫码登录小米。

细节和平台差异见 [Docker 部署](#docker-部署各种-nas--服务器)。

## Development

```bash
npm install
cp .env.example .env
npm run dev
```

Health check:

```bash
curl http://127.0.0.1:6650/api/v1/system/info
```

Web 前端：

```text
http://127.0.0.1:6650/app/
```

`/app/` 是一个基于 Vue 3 的单页应用（免构建，运行时已随仓库 vendored 到
`web/vendor/`，局域网离线可用）。首次访问引导创建管理员账号，之后包含
正在播放 / 搜索 / 队列 / 歌单 / 设置中心五页。设置中心已覆盖全部服务端配置：
小米账号（**推荐米家 APP 扫码登录**，也支持账号密码+短信、网页验证、导入会话）、播放设备、
LX 音源插件（选文件上传）、手工曲目、运行配置、链路诊断（测试音频 + TTS）、
修改密码。

完整功能清单见 [docs/FEATURES.md](docs/FEATURES.md)，界面设计说明见
[docs/ui-redesign.md](docs/ui-redesign.md)。

首次使用可以在管理页创建管理员账号、登录小米账号、刷新小米设备并选择默认播放设备。管理页还支持运行配置、手工曲目、LX 插件管理、链路诊断、搜索和播放测试。

局域网播放通常无需配置 `HMUSIC_PUBLIC_BASE_URL`：它是回环地址或换网后失效的 IPv4 时，
服务端会在生成音频地址时实时替换为本机当前局域网 IPv4，换了网络也不用改配置重启。
只有走反向代理或公网域名时才需要显式填写，例如：

```env
HMUSIC_PUBLIC_BASE_URL=https://music.example.com
```

服务端会把解析出的音乐地址转换成带签名的 `/api/v1/proxy/audio/...` 代理地址再下发给小爱音箱，避免部分音乐 CDN 被音箱直连时拦截。

推荐的本地验证顺序：

1. 打开 `/app/` 创建管理员账号。
2. 在 `/app/` 设置 → 小米账号里登录。**推荐扫码登录**（米家 APP 扫码，无短信无跳页）；也可用账号密码+短信验证（验证通过后 passToken 优先换凭据，不依赖手工粘贴 STS 地址）；极端情况用“导入会话”兜底。
3. 刷新设备并选择默认播放设备。
4. 在“链路诊断”区域播放内置测试音频，先确认服务端到小爱音箱的链路能出声。
5. 在“LX 插件”区域上传音源插件，或在“手工曲目”区域添加一个可访问的音频 URL。
6. 在“搜索与播放测试”区域搜索并播放，确认真实歌曲能出声。

如果小米短信验证被限频，管理页的小米账号区域可以通过“网页登录验证”导入验证完成地址，也可以在“导入已有小米会话”里导入 STS URL 或 `serviceToken + userId` 会话。

现有 Flutter App 仍有部分旧风格调用。服务端提供过渡兼容入口，包括 `/getversion`、`/getsetting`、`/api/js-plugins`、`/api/device/pushList`、`/getplayerstatus` 等；App 发来的客户端搜索结果会被转换成 HMusic 队列并复用服务端播放链路。

新接口推荐直接提交客户端搜索结果：

```json
{
  "clientTrack": {
    "id": "0039MnYb0qxYhV",
    "source": "qq",
    "title": "Song Title",
    "artist": "Artist",
    "album": "Album",
    "duration": 180,
    "pic": "https://example.com/cover.jpg"
  }
}
```

`POST /api/v1/tracks/resolve`、`POST /api/v1/playback/play`、`POST /api/v1/playlists/:id/tracks` 都支持这种输入。服务端会把 `qq/kuwo/netease` 等来源规范化成 `tx/kw/wy`，并清理客户端临时 `url/playUrl`，最终用 `source + id` 交给 LX 插件解析。

可用 `POST /api/v1/playback/test-tone` 播放内置 3 秒测试音频。它不依赖 LX 插件，适合先排查小米登录、默认设备、`HMUSIC_PUBLIC_BASE_URL` 和音频代理链路。测试音与正常播放隔离：不写播放状态、不进队列（返回 `{ deviceId, deviceName }`）；部分机型（如 L05B）设备端会循环单曲列表，服务端在 3.5 秒后补发 pause+stop 掐停，不会一直响。

### 小爱音箱型号适配

服务端内置了需要走 `player_play_music` 接口的小爱型号白名单（`X08*`、`LX0*`、`L05B/L05C`、`L06A`、`L15A/L16A/L17A`、`OH2/OH2P` 等）。如果某个型号直连播放“能连上但没声音”，通常是它需要 `player_play_music` 却没在内置表里——在管理页“运行配置 → 自定义直连播放型号”里填入型号代码（逗号分隔）即可补充，无需改代码。

`POST /api/v1/playback/speak`（body: `{ "text": "...", "deviceId": "..." }`）可让小爱音箱语音播报一段文字。机型在内置 TTS 表内（`LX06`、`L05B/L05C`、`X08E`、`OH2/OH2P` 等）时走 miio 域 `miotspec/action`（需登录时留下的 passToken 静默换 `sid=xiaomiio` 会话）；表外机型回退 MiNA ubus `mibrain/text_to_speech` → `player_play_tts`。运行配置里的 `announceTracks` 开关（默认关）可让音箱开播前先播报「即将播放 XX」。

## Documentation

- [后端实现文档](docs/backend-implementation.md)

## Production

```bash
npm ci
cp .env.example .env
npm run build
npm start
```

部署时必须修改 `.env` 里的 `HMUSIC_JWT_SECRET`，并把 `HMUSIC_DATA_DIR` 指向持久化目录。App 访问地址填写 `http://<server-ip>:6650` 或反向代理后的 HTTPS 地址；`HMUSIC_PUBLIC_BASE_URL` 仅在反向代理或公网域名场景需要填写，局域网 IPv4 会自动探测。

### 一键部署到另一台服务器

如果开发机和运行服务器是两台机器，用打包脚本把产物送过去，无需在服务器上装开发工具链：

```bash
# 开发机：编译 + 打包，产出 hmusic-deploy.tar.gz
bash scripts/pack.sh

# 拷到服务器（scp/rsync/共享盘任选），解压后：
tar -xzf hmusic-deploy.tar.gz
bash scripts/deploy-run.sh   # 首次会生成 .env 并提示改 JWT_SECRET 与 PUBLIC_BASE_URL，改完重跑
```

启动后访问 `http://<server-ip>:6650/app/`。

### Linux 裸机：开机自启（systemd）

`deploy-run.sh` 是前台运行，关掉终端服务就停。要长期跑，装成 systemd 服务：

```bash
sudo bash scripts/install-systemd.sh          # 不传参则用当前项目路径
sudo systemctl status hmusic-server            # 确认 active (running)
journalctl -u hmusic-server -f                 # 跟踪日志
```

脚本会先校验 `dist/main.js` 存在、`.env` 存在且 `HMUSIC_JWT_SECRET` 已改掉
默认值、Node ≥ 20，任一不满足直接报错退出而不是装一个起不来的服务。随后
创建无登录权限的系统用户 `hmusic`、把 `data/` 与 `.env` 归属给它（`.env`
含密钥，chmod 600），再把 `scripts/hmusic-server.service` 里的路径占位替换成
实际值后安装到 `/etc/systemd/system/` 并 enable + start。

重启机器自动拉起，进程崩溃自动重启。卸载：

```bash
sudo systemctl disable --now hmusic-server
sudo rm /etc/systemd/system/hmusic-server.service && sudo systemctl daemon-reload
```

## Docker 部署（各种 NAS / 服务器）

镜像已发布到 GHCR，双架构 amd64 + arm64（v0.1.0 起）：

```text
ghcr.io/hpcll/hmusic-server:latest
```

拉取报 `denied` / `unauthorized` 说明包还是 private，见文末
「发布镜像（维护者）」里的可见性设置步骤。

### ⚠️ 先看这里：平台选择

本服务依赖 **mDNS 局域网广播**（App 秒级发现）和 **真实网卡 IPv4 探测**（给小爱音箱下发可访问的音频地址）。这两点决定了部署方式：

| 平台 | 推荐方式 | 原因 |
|------|---------|------|
| **Linux NAS**（群晖 / 威联通 / unRAID / 飞牛 / Debian…） | ✅ Docker + `network_mode: host` | host 网络下 mDNS 与局域网 IP 全自动，开箱即用 |
| **macOS**（Docker Desktop） | ❌ 别用 Docker，改用原生 | Docker 跑在 VM 里，host 模式失效、mDNS 出不去 |
| **Windows**（Docker Desktop / WSL2） | ❌ 别用 Docker，改用原生 | 同样 VM 隔离，mDNS 到不了物理局域网 |

macOS / Windows 请用上面的「一键部署到另一台服务器」或直接 `npm ci && npm run build && npm start` 原生运行。

### Linux NAS：docker compose（推荐）

```bash
bash install.sh
```

脚本会自动判断该用 Docker 还是原生方式、生成 `.env` 并随机化 JWT 密钥、拉镜像启动，
最后打印出手机能直接打开的局域网地址。重复执行安全 —— 已有的 `.env` 不会被覆盖，
密钥不变、登录态不失效。

想自己一步步来也可以：

```bash
# 1. 准备环境变量（必须改 HMUSIC_JWT_SECRET）
cp .env.example .env
# 编辑 .env，把 HMUSIC_JWT_SECRET 改成一段随机长字符串

# 2. 拉起（compose 已内置 network_mode: host、数据卷、健康检查、自动重启）
docker compose up -d

# 3. 查看日志确认启动
docker compose logs -f
```

访问 `http://<NAS局域网IP>:6650/app/`。数据（SQLite 库、下载的音乐 `music/`、LX 插件 `plugins/lx/`）全部持久化在宿主机 `./data`。

升级到新版本：

```bash
docker compose pull && docker compose up -d
```

### 关键说明

- **`network_mode: host` 不可改桥接**：桥接网络会让 mDNS 多播出不去、容器只能拿到内网 `172.x` 地址，小爱音箱将连不上。这是本服务的硬约束。
- **端口**：host 模式下服务直接监听宿主机 6650，不做 `-p` 端口映射。要换端口设 `.env` 里的 `HMUSIC_PORT`（宿主机上该端口需空闲）。
- **`HMUSIC_PUBLIC_BASE_URL`**：局域网 IPv4 会自动探测，通常留默认。仅反向代理 / 公网域名场景才显式填写。
- **数据备份**：直接备份宿主机 `./data` 目录即可。

### 发布镜像（维护者）

推一个 `v*` tag 即触发 GitHub Actions 自动构建双架构镜像并推送到 GHCR：

```bash
git tag v0.1.0
git push origin v0.1.0
```

会自动打上四个标签：`0.1.0`、`0.1`、`v0.1.0`、`latest`。工作流见
`.github/workflows/docker-publish.yml`。

⚠️ **首次发布后必须手动把包设为 Public**：GHCR 新建的包默认 private，
此时用户 `docker compose pull` 会因无权限失败（匿名拉取返回 401）。
去 `https://github.com/users/hpcll/packages/container/hmusic-server/settings`
→ Danger Zone → Change visibility → Public。这一步只需做一次，
后续版本继承该可见性。

## Verification

```bash
npm run typecheck
npm test
npm run lint
npm run build
```
