# HMusic Server 发布流程

本文档供维护者使用，不是终端用户安装说明。

## 发布前

1. 确认 `package.json` 与 `package-lock.json` 版本一致，并检查代码中没有旧版本硬编码。
2. 确认 `THIRD-PARTY-NOTICES.md` 已随源码、部署包和镜像分发。
3. 确认仓库包含已选定的项目许可证文件（例如 `LICENSE`）；未确定许可证前不要公开仓库。
4. 在干净环境完成：

   ```bash
   npm ci
   npm run audit:prod
   npm run typecheck
   npm run test:deploy
   npm test
   npm run lint
   npm run build
   bash scripts/pack.sh
   ```

5. 确认完整 `npm audit` 中的开发依赖问题已升级、缓解或明确记录接受风险；生产依赖必须通过 `npm run audit:prod`。
6. 确认 README 中的安装地址、镜像地址和配置说明与本次发布状态一致。
7. 如果承诺为无 VPN 用户提供一键安装，先部署项目自有镜像并用匿名环境验证脚本、部署包和 `.sha256`；否则 README 只能说明如何配置用户自己的可信代理。
8. 确认仓库准备公开，且没有提交 `.env`、`data/`、账号凭据或其它运行时数据。

## 发布

推荐推送与 `package.json` 版本一致的 `v*` tag。推送 tag 会构建并发布镜像、创建部署包
Release。也可以在 Actions 页面手动运行：`release_tag` 留空时只做源码校验；填写与
`package.json` 一致的 `vX.Y.Z` 时，会发布当前选定分支的镜像和 Release，使用前确认分支内容就是要发布的版本。

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

工作流成功后应同时具备：

- GHCR 的 `linux/amd64` 与 `linux/arm64` 镜像；
- Release 附件 `hmusic-deploy.tar.gz`；
- Release 附件 `hmusic-deploy.tar.gz.sha256`。

首次发布后，把 GHCR 包设为 Public。最后执行匿名验收：

```bash
npm run verify:release
```

验收通过后，再对外公布仓库、Release 和 Docker 镜像地址。
