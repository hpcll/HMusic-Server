# 贡献指南

HMusic Server 是自托管音乐库后端。提交代码前请阅读 README、公开部署指南和相关 API 测试，保持路由、
schema、部署脚本与文档同步。

## 本地开发

需要 Node.js 20 或更高版本：

```bash
npm ci
cp .env.example .env
npm run typecheck
npm run test:deploy
npm test
npm run lint
npm run build
```

不要提交 `.env`、`data/`、账号会话、部署包或日志。问题报告应使用脱敏配置和最小复现，不要上传小米
凭据、验证码、音频签名 URL 或私人曲库。

## Pull Request

每个 PR 聚焦一个行为变化，并说明 API、数据迁移、部署兼容性和验证结果。涉及公开契约时必须同步更新
README 或 `docs/DEPLOYMENT.md`。未经维护者确认，不要修改 Release、GHCR 可见性或生产部署。
