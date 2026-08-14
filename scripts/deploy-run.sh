#!/usr/bin/env bash
# 在服务器上启动 HMusic Server（解压部署包后执行）。
# 用法：bash scripts/deploy-run.sh
# 首次运行会自动生成安全配置、安装依赖并在后台启动。
set -euo pipefail

cd "$(dirname "$0")/.."
OS="$(uname -s)"
. scripts/deploy-common.sh

command -v node >/dev/null || die "未找到 Node.js，请先安装 Node.js 20 或更高版本：https://nodejs.org/"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node 版本过低（当前 $(node -v)），需要 20 或更高"
command -v npm >/dev/null || die "未找到 npm，请重新安装完整的 Node.js 20+"
[ -f dist/main.js ] || die "缺少 dist/main.js，部署包不完整，请重新打包"

# 1. 生产依赖（只装运行时，不含 dev 工具链）
echo "[1/3] 安装生产依赖…"
npm ci --omit=dev --no-audit --no-fund || explain_npm_install_failure

# 2. 环境变量
ensure_env

# 3. 启动
echo "[2/3] 配置已就绪"

# 从 .env 读端口用于提示（读不到则回退默认 6650），避免脚本提示与实际端口脱节。
PORT="$(read_port)"
sync_loopback_public_base_port "$PORT"

echo "[3/3] 启动并检查服务…"
start_native_background "$PORT"
record_deploy_mode native
print_access_urls "$PORT"
echo "日志：data/server.log"
