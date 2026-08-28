# HMusic Server 部署指南

## 推荐：单行安装

Linux、macOS 或 Git Bash 中执行：

```bash
curl -fsSL https://raw.githubusercontent.com/hpcll/HMusic-Server/main/bootstrap.sh | bash
```

安装器下载带 SHA-256 校验的 GitHub Release 部署包，自动选择 Docker 或原生模式，生成随机 JWT 密钥，
启动服务并等待健康检查。默认安装目录是 `$HOME/HMusic-Server`；Linux root 用户使用 `/opt/hmusic-server`。

安装完成后打开输出的 `/app/` 地址，创建管理员账号并完成设备配置。App 中填写 Server 基础地址，
例如 `http://192.168.1.20:6650`，不要填写 `/app/` 路径。

指定目录或强制原生模式：

```bash
curl -fsSL https://raw.githubusercontent.com/hpcll/HMusic-Server/main/bootstrap.sh \
  | HMUSIC_INSTALL_DIR=/volume1/docker/HMusic bash
curl -fsSL https://raw.githubusercontent.com/hpcll/HMusic-Server/main/bootstrap.sh \
  | bash -s -- --native
```

如果所在网络无法直接访问 GitHub，可使用可信镜像提供的脚本和 GitHub URL 代理：

```bash
export HMUSIC_BOOTSTRAP_URL='https://你的镜像站/bootstrap.sh'
export HMUSIC_GITHUB_PROXY='https://你的镜像站/{url}'
curl -fsSL "$HMUSIC_BOOTSTRAP_URL" | bash
```

镜像站应同时提供部署包和 `.sha256` 校验文件。代理只在 GitHub 直连失败时使用，
请勿把账号凭据交给未知代理。

## 平台选择

- Linux NAS/服务器：有 Docker 时推荐 Docker host network，支持 `linux/amd64` 和 `linux/arm64`。
- macOS：Docker Desktop 的 host network 不提供完整 mDNS 能力，推荐 native。
- Windows：在 Git Bash 中使用 native；Docker Desktop 的局域网发现需要额外网络配置。
- 默认端口：`6650`。反向代理或公网访问必须配置有效 HTTPS 和 `HMUSIC_PUBLIC_BASE_URL`。

## 反向代理与公网访问

代理必须原样转发 `Authorization` 请求头：管理页和 App 都用 `Authorization: Bearer <token>` 认证，
这个头被删除或改写时，服务端只能判定「没有凭据」，页面表现就是刚登录又被退回登录页。
也不要在代理层给 `/api/v1` 再套 Basic auth、Authelia 之类的登录墙：它们会用自己的
`Authorization` 覆盖 HMusic 的令牌，或者直接用 401 拦掉接口请求。

Nginx 最小可用配置：

```nginx
location / {
    proxy_pass http://192.168.1.20:6650;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Nginx 默认就会透传 Authorization；不要显式 proxy_set_header Authorization，
    # 那样很容易把 Bearer 令牌覆盖成代理自己的凭据。
}
```

同时把 `HMUSIC_PUBLIC_BASE_URL` 设为公网地址（如 `https://music.example.com`），否则下发给
小爱音箱和客户端的音频地址仍是局域网 IP。公网暴露前请确认 HTTPS 证书有效、管理员密码足够强：
`/app/` 是完整管理界面，包含小米账号会话。

登录失败提示对照：

| 页面提示 | 含义 |
| --- | --- |
| 用户名或密码错误 | 凭据本身不对，与代理无关 |
| 服务端没收到本次请求的登录凭据… | 代理删除或改写了 `Authorization` 头 |
| 响应不是 HMusic 的错误格式… | 401 来自代理或网关，请求没到 HMusic |
| 登录已失效，请重新登录 | 服务端收到凭据但拒绝了（例如换过 `HMUSIC_JWT_SECRET`） |

自查（把地址换成自己的公网地址）：

```bash
curl -s https://music.example.com/api/v1/system/info
TOKEN=$(curl -s -X POST https://music.example.com/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"你的密码"}' \
  | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
curl -s -H "Authorization: Bearer $TOKEN" https://music.example.com/api/v1/auth/status
```

最后一条返回 `"authenticated":true` 说明代理转发正常；返回
`"authError":"FST_JWT_NO_AUTHORIZATION_IN_HEADER"` 就是代理把 `Authorization` 头弄丢了。

## 升级、停止和备份

重新执行同一条 bootstrap 命令，或在安装目录执行：

```bash
bash install.sh --update
bash scripts/stop.sh
```

升级不会覆盖 `.env` 和 `data/`。升级前停止服务并备份 `data/` 与 `.env`；恢复时先恢复文件，再运行
`bash install.sh`。不要把账号会话、数据库、音源插件或 `.env` 上传到公开 Issue。

也可以在管理页「设置 → 系统 → 关于与更新」或 App 里点一键升级：原生部署直接跑
`install.sh --update`，Docker 部署由 `hmusic-updater`（watchtower）拉新镜像并原地重建容器。
两种方式都不动 `data/` 和 `.env`。

一键升级提示「升级守护不在线」时，先确认守护容器在跑：

```bash
docker compose ps hmusic-updater
docker compose logs --tail=30 hmusic-updater
```

守护的 HTTP 接口固定在容器内 8080，compose 把它映射到宿主机回环 `127.0.0.1:8666`。少数
宿主机关掉了 Docker 的 userland-proxy，回环映射不生效，服务端就探不到守护；这种情况把服务端的
`HMUSIC_UPDATER_URL` 指向容器实际地址（例如 `http://172.17.0.1:8666`）即可，或者继续用
`bash install.sh --update` 在宿主机升级。

## 健康检查

```bash
curl http://127.0.0.1:6650/api/v1/system/info
```
