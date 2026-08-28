# 更新日志

## Unreleased

- 修复 Docker 升级守护 `hmusic-updater` 无限重启：compose 曾给 watchtower 传了它不存在的
  `--http-api-port`，参数解析失败即退出，被 `restart: unless-stopped` 反复拉起。守护改用桥接网络
  加 `127.0.0.1:8666:8080` 端口映射对齐服务端调用地址，镜像固定到 `containrrr/watchtower:1.7.1`。
- 安装器在容器健康检查通过后确认升级守护真的在运行，未运行时打印状态和排查命令，不再静默通过。

## 0.2.0 - 2026-08-26

- 增加公开部署指南、贡献指南、安全报告入口和发布验收说明。
- 增加 Docker 与原生安装的统一升级、停止和健康检查流程。
- 安装器支持通过可信镜像代理下载 GitHub Release，升级时保留配置、账号和数据。
- 改进小爱音箱机型播放与 TTS 兼容，并公开注明对 SongLoft MIoT 插件与 xiaomusic 的参考及许可证。
- 旧版 HMusic App 继续可用，新版页面和接口作为推荐入口。
- 拒绝使用空值或默认值启动服务 JWT 密钥，并统一服务端版本信息。

版本发布时记录 API 变化、数据库迁移、部署方式和已知限制。Git tag 使用 `vX.Y.Z`，并与
`package.json` 版本保持一致。
