#!/usr/bin/env bash
# 在服务器上启动 HMusic Server（解压部署包后执行）。
# 用法：bash scripts/deploy-run.sh
# 首次运行会从 .env.example 生成 .env，请按提示修改后重跑。
set -euo pipefail

cd "$(dirname "$0")/.."

# 1. 生产依赖（只装运行时，不含 dev 工具链）
if [ ! -d node_modules ]; then
  echo "[1/3] 安装生产依赖…"
  npm ci --omit=dev
else
  echo "[1/3] node_modules 已存在，跳过安装"
fi

# 2. 环境变量
if [ ! -f .env ]; then
  cp .env.example .env
  echo
  echo "!! 已生成 .env，请先修改这两项再重新运行本脚本："
  echo "   HMUSIC_JWT_SECRET     改成一段随机长字符串"
  echo "   HMUSIC_PUBLIC_BASE_URL 改成 http://<本机局域网IP>:8090"
  echo "     （手机和小爱音箱都要能访问到这个地址）"
  exit 1
fi

# 3. 启动
echo "[2/3] 校验 .env…"
grep -q "change-me" .env && {
  echo "!! HMUSIC_JWT_SECRET 还是默认值 change-me，请修改后重试"; exit 1;
}

echo "[3/3] 启动服务…"
echo "  管理页:  http://<IP>:8090/admin"
echo "  新前端:  http://<IP>:8090/app/"
exec node dist/main.js
