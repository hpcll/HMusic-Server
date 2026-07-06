#!/usr/bin/env bash
# 打一键部署包：编译后端 + 收齐前端与依赖清单，产出 hmusic-deploy.tar.gz。
# 用法：在项目根执行  bash scripts/pack.sh
# 产物拷到服务器解压后，按 scripts/deploy-run.sh 启动即可。
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="hmusic-deploy.tar.gz"

echo "[1/3] 安装依赖并编译后端…"
npm ci
npm run build

echo "[2/3] 打包运行所需文件…"
# dist=后端产物, web=前端(含 vendored Vue), package*.json=服务器装依赖用
tar -czf "$OUT" dist web package.json package-lock.json .env.example README.md scripts

echo "[3/3] 完成：$OUT ($(du -h "$OUT" | cut -f1))"
echo
echo "下一步：把 $OUT 拷到服务器，解压后执行 bash scripts/deploy-run.sh"
