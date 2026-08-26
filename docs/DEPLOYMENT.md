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

## 升级、停止和备份

重新执行同一条 bootstrap 命令，或在安装目录执行：

```bash
bash install.sh --update
bash scripts/stop.sh
```

升级不会覆盖 `.env` 和 `data/`。升级前停止服务并备份 `data/` 与 `.env`；恢复时先恢复文件，再运行
`bash install.sh`。不要把账号会话、数据库、音源插件或 `.env` 上传到公开 Issue。

## 健康检查

```bash
curl http://127.0.0.1:6650/api/v1/system/info
```
