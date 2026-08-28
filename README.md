# HMusic Server

HMusic App 的自建后端，负责服务端登录、运行配置、小米账号设备、音源插件、搜索解析和小爱音箱播放控制。

## 配套客户端

HMusic-Server 与 [HMusic-App](https://github.com/hpcll/HMusic-App) 配套使用。移动端负责本机后台播放、搜索、
歌词、歌单和队列操作；桌面端还可用于管理内容和遥控小爱音箱。客户端安装包和跨平台使用说明见
[HMusic-App Releases](https://github.com/hpcll/HMusic-App/releases) 与 [App README](https://github.com/hpcll/HMusic-App#readme)。

Server 自带的 `/app/` 是管理和诊断页面，不是必须嵌入客户端的 WebView。首次部署时用它创建管理员、登录小米账号、
刷新设备并播放测试音；日常听歌可以直接使用 HMusic App。

## 快速开始

公开安装、平台选择、升级和备份见 [部署指南](docs/DEPLOYMENT.md)。

装到 NAS、服务器或长期开机的电脑上，推荐直接执行一行：

```bash
curl -fsSL https://raw.githubusercontent.com/hpcll/HMusic-Server/main/bootstrap.sh | bash
```

Linux/macOS 可直接在终端执行；Windows 请先安装 Git for Windows，并在 **Git Bash** 中执行。

引导脚本会把最新 Release 部署包安装到 `$HOME/HMusic-Server`（Linux root 用户默认
`/opt/hmusic-server`），自动选择 Docker 或原生方式，
生成随机密钥、启动服务并等待健康检查通过。以后升级只需重新执行同一行；`.env`、账号和
`data/` 数据不会被部署包覆盖。安装后也可在程序目录执行统一升级命令
`bash install.sh --update`；统一停止命令是 `bash scripts/stop.sh`，会自动识别 Docker、
systemd 或后台原生进程。指定安装目录或强制原生方式：

```bash
curl -fsSL https://raw.githubusercontent.com/hpcll/HMusic-Server/main/bootstrap.sh \
  | HMUSIC_INSTALL_DIR=/volume1/docker/HMusic bash
curl -fsSL https://raw.githubusercontent.com/hpcll/HMusic-Server/main/bootstrap.sh \
  | bash -s -- --native
```

系统没有 `curl` 但有 `wget` 时，可以执行：

```bash
wget -qO- https://raw.githubusercontent.com/hpcll/HMusic-Server/main/bootstrap.sh | bash
```

如果所在网络无法直接访问 GitHub，可以把 `HMUSIC_BOOTSTRAP_URL` 指向可访问的镜像脚本，
并把 `HMUSIC_GITHUB_PROXY` 设置为该镜像的 GitHub URL 前缀。代理地址支持 `{url}` 占位符：

```bash
export HMUSIC_BOOTSTRAP_URL='https://你的镜像站/bootstrap.sh'
export HMUSIC_GITHUB_PROXY='https://你的镜像站/{url}'
curl -fsSL "$HMUSIC_BOOTSTRAP_URL" | bash
```

镜像站应同时提供部署包和 `.sha256` 校验文件；请使用可信的镜像服务，避免把账号凭据交给未知代理。

想先查看代码再安装，可以使用 Git：

```bash
git clone https://github.com/hpcll/HMusic-Server.git
cd HMusic-Server
bash install.sh
```

`install.sh` 会自动选择 Docker 或原生方式、生成随机 JWT 密钥、安装最新版、启动服务并等待健康检查通过。
浏览器打开提示的地址即可创建管理员账号，然后在「设置 → 小米账号」扫码登录小米。
Git 安装以后升级执行 `bash install.sh --update`；已有配置、账号和数据不会被覆盖。安装器会记住
首次选择的 Docker/原生方式，升级时自动沿用；只有显式传 `--docker` 或 `--native` 才切换方式。

部署成功后，将手机、平板或电脑与 Server 放在同一局域网，打开 HMusic App。App 会自动发现并验证这台 Server，
点选发现结果即可连接；发现不到时再使用 App 的“手动输入地址”，填写安装器输出的基础地址和端口 `6650`。

细节和平台差异见 [Docker 部署](#docker-部署各种-nas--服务器)。

`/app/` 是一个基于 Vue 3 的单页应用（免构建，运行时已随仓库 vendored 到
`web/vendor/`，局域网离线可用）。首次访问引导创建管理员账号，之后包含
正在播放 / 搜索 / 队列 / 歌单 / 设置中心五页。设置中心已覆盖全部服务端配置：
小米账号（**推荐米家 APP 扫码登录**，也支持账号密码+短信、网页验证、导入会话）、播放设备、
LX 音源插件（选文件上传）、手工曲目、运行配置、链路诊断（测试音频 + TTS）、
修改密码。

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

HMusic App 与服务端共享当前 API 契约。服务端保留旧兼容入口以便旧客户端平滑升级，但新版本优先使用当前页面和接口；
升级 Server 后请同时查看 [HMusic-App Releases](https://github.com/hpcll/HMusic-App/releases) 的兼容说明。

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

由于可用于测试的小爱音箱型号有限，HMusic 的部分兼容逻辑参考了
[xiaomusic](https://github.com/hanxi/xiaomusic) 与
[SongLoft MIoT 插件](https://github.com/songloft-org/songloft-plugin-miot) 的公开实现，
并结合 HMusic 自身架构进行了重新实现。不同型号的实际表现可能存在差异，欢迎反馈测试结果；
具体致谢与许可证见 [第三方声明](THIRD-PARTY-NOTICES.md)。

服务端内置了需要走 `player_play_music` 接口的小爱型号白名单（`X08*`、`LX0*`、`L05B/L05C`、`L06A`、`L15A/L16A/L17A`、`OH2/OH2P` 等）。如果某个型号直连播放“能连上但没声音”，通常是它需要 `player_play_music` 却没在内置表里——在管理页“运行配置 → 自定义直连播放型号”里填入型号代码（逗号分隔）即可补充，无需改代码。

`POST /api/v1/playback/speak`（body: `{ "text": "...", "deviceId": "..." }`）可让小爱音箱语音播报一段文字。机型在内置 TTS 表内（`LX06`、`L05B/L05C`、`X08E`、`OH2/OH2P` 等）时走 miio 域 `miotspec/action`（需登录时留下的 passToken 静默换 `sid=xiaomiio` 会话）；表外机型回退 MiNA ubus `mibrain/text_to_speech` → `player_play_tts`。运行配置里的 `announceTracks` 开关（默认关）可让音箱开播前先播报「即将播放 XX」。

## 手动安装（高级）

```bash
npm ci
cp .env.example .env
npm run build
npm start
```

手动部署需要 Node.js 20+。请修改 `.env` 里的 `HMUSIC_JWT_SECRET`，不能使用空值或 `change-me`。
默认 `HMUSIC_DATA_DIR=./data` 已是项目目录中的持久化位置；只有想把数据放到其它磁盘时才需要改它。
App 访问地址填写 `http://<server-ip>:6650` 或反向代理后的 HTTPS 地址；
`HMUSIC_PUBLIC_BASE_URL` 仅在反向代理或公网域名场景需要填写，局域网 IPv4 会自动探测。

### Linux 裸机：开机自启（systemd）

`deploy-run.sh` 会后台运行，重启机器后需要再次执行。Linux 要开机自动启动，可装成 systemd 服务：

```bash
sudo bash scripts/install-systemd.sh          # 不传参则用当前项目路径
sudo systemctl status hmusic-server            # 确认 active (running)
journalctl -u hmusic-server -f                 # 跟踪日志
```

脚本会先校验 `dist/main.js` 与 Node ≥ 20，自动生成或修复 `.env` 的随机密钥；无法满足时
直接报错退出，而不是装一个起不来的服务。随后
优先使用项目目录所属用户运行；若项目归 root，则创建无登录权限的系统用户 `hmusic`。
脚本会先验证运行用户能读取项目，再把 `data/` 与 `.env` 归属给它（`.env` 含密钥，
chmod 600），随后生成实际路径的 systemd 单元并 enable + start。若家目录权限不允许
systemd 读取项目，脚本会提示将项目移动到 `/opt/hmusic-server`，不会安装一个必然失败的服务。

重启机器自动拉起，进程崩溃自动重启。卸载：

```bash
sudo systemctl disable --now hmusic-server
sudo rm /etc/systemd/system/hmusic-server.service && sudo systemctl daemon-reload
```

## Docker 部署（各种 NAS / 服务器）

正式版本会提供双架构（amd64 + arm64）镜像：

```text
ghcr.io/hpcll/hmusic-server:latest
```

推荐直接执行 `bash install.sh`，安装器会自动拉取与启动对应版本。

### ⚠️ 先看这里：平台选择

本服务依赖 **mDNS 局域网广播**（App 秒级发现）和 **真实网卡 IPv4 探测**（给小爱音箱下发可访问的音频地址）。这两点决定了部署方式：

| 平台 | 推荐方式 | 原因 |
|------|---------|------|
| **Linux NAS**（群晖 / 威联通 / unRAID / 飞牛 / Debian…） | ✅ Docker + `network_mode: host` | host 网络下 mDNS 与局域网 IP 全自动，开箱即用 |
| **macOS**（Docker Desktop） | ✅ `bash install.sh` 原生安装 | Docker 跑在 VM 里，host 模式失效、mDNS 出不去 |
| **Windows Git Bash** | ✅ `bash install.sh` 原生安装 | Docker Desktop/WSL2 的 VM 隔离会挡住 mDNS |

macOS / Windows 请安装 Node.js 20+ 和 Git，然后在 Git Bash 中执行快速开始的三条命令。
脚本会在后台启动服务；日志位于 `data/server.log`。升级执行 `bash install.sh --update`，停止执行 `bash scripts/stop.sh`。

### Linux NAS：docker compose（推荐）

```bash
bash install.sh
```

脚本会自动判断该用 Docker 还是原生方式、生成 `.env` 并随机化 JWT 密钥、拉镜像启动，
自动对齐宿主机 `data/` 与容器进程的 UID/GID，并在健康检查通过后才打印手机能直接打开的
局域网地址。重复执行安全 —— 已有的 `.env` 不会被覆盖，密钥不变、登录态不失效。

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
bash install.sh --update
```

升级器只接受快进更新；若检测到程序文件被手工修改，会停止并提示处理，不会覆盖本地修改。

### 关键说明

- **`network_mode: host` 不可改桥接**：桥接网络会让 mDNS 多播出不去、容器只能拿到内网 `172.x` 地址，小爱音箱将连不上。这是本服务的硬约束。
- **端口**：host 模式下服务直接监听宿主机 6650，不做 `-p` 端口映射。要换端口设 `.env` 里的 `HMUSIC_PORT`（宿主机上该端口需空闲）。
- **`HMUSIC_PUBLIC_BASE_URL`**：局域网 IPv4 会自动探测，通常留默认。仅反向代理 / 公网域名场景才显式填写。
- **数据备份**：直接备份宿主机 `./data` 目录即可。
- **数据权限**：推荐始终使用 `bash install.sh`，脚本会自动处理 NAS 上常见的 UID/GID 不一致问题，无需 `chmod 777`。
- **升级守护**：`hmusic-updater`（watchtower）只把升级接口绑在宿主机回环 `127.0.0.1:8666`，供服务端触发 App 里的一键升级，不对局域网开放。它反复重启说明配置过旧，执行 `bash install.sh --update` 重建即可；守护缺席只影响一键升级，不影响听歌。

## 许可证

HMusic Server 本身采用 [Apache License 2.0](LICENSE)。小爱音箱兼容层涉及的上游参考实现及其许可证，
请查看 [第三方声明](THIRD-PARTY-NOTICES.md)。
