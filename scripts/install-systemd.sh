#!/usr/bin/env bash
# 安装 systemd 服务（Debian/Ubuntu/树莓派/Armbian 等）。
# 用法：sudo bash scripts/install-systemd.sh [安装目录]
# 不传目录则用当前项目所在路径。
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "❌ 需要 root 权限：sudo bash scripts/install-systemd.sh" >&2
  exit 1
fi

DEFAULT_APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$(cd "${1:-$DEFAULT_APP_DIR}" && pwd)"
UNIT=/etc/systemd/system/hmusic-server.service
. "$APP_DIR/scripts/deploy-common.sh"
cd "$APP_DIR"

# ---- 前置校验：缺任何一项都会让服务起不来，提前说清楚 ----
[ -f "$APP_DIR/dist/main.js" ] || {
  echo "❌ 找不到 $APP_DIR/dist/main.js —— 请先 npm run build 或解压部署包" >&2; exit 1; }
ensure_env
PORT="$(read_port)"
sync_loopback_public_base_port "$PORT"

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "❌ 未找到 node，请先安装 Node.js 20+" >&2; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || {
  echo "❌ Node 版本过低（当前 $(node -v)），需要 20+" >&2; exit 1; }
command -v runuser >/dev/null 2>&1 || {
  echo "❌ 系统缺少 runuser（通常由 util-linux 提供），无法安全校验服务用户权限" >&2; exit 1; }

# ---- 运行用户：优先使用项目目录所属用户，避免家目录权限导致服务读不到代码 ----
RUN_USER="$(stat -c '%U' "$APP_DIR" 2>/dev/null || true)"
if [ -z "$RUN_USER" ] || [ "$RUN_USER" = root ]; then
  RUN_USER=hmusic
  if ! id -u "$RUN_USER" >/dev/null 2>&1; then
    command -v useradd >/dev/null 2>&1 || {
      echo "❌ 系统缺少 useradd。请先手工创建无登录权限的 hmusic 系统用户后重试" >&2; exit 1; }
    echo "创建系统用户 ${RUN_USER}…"
    NOLOGIN_SHELL="$(command -v nologin || true)"
    [ -n "$NOLOGIN_SHELL" ] || NOLOGIN_SHELL=/usr/sbin/nologin
    useradd --system --no-create-home --shell "$NOLOGIN_SHELL" "$RUN_USER"
  fi
fi
id -u "$RUN_USER" >/dev/null 2>&1 || {
  echo "❌ 无法解析项目所属用户 ${RUN_USER}，请检查项目目录所有权" >&2; exit 1; }
RUN_GROUP="$(id -gn "$RUN_USER")"

if ! runuser -u "$RUN_USER" -- test -r "$APP_DIR/dist/main.js"; then
  echo "❌ 用户 $RUN_USER 无法读取项目目录 $APP_DIR。请把项目移动到 /opt/hmusic-server 后重试。" >&2
  exit 1
fi

# data/ 必须存在且归属运行用户，否则 SQLite 建库会因无写权限失败。
mkdir -p "$APP_DIR/data"
chown -R "$RUN_USER":"$RUN_GROUP" "$APP_DIR/data"
# .env 含 JWT 密钥，只给运行用户读。
chown "$RUN_USER":"$RUN_GROUP" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

echo "写入 $UNIT …"
# 用实际路径生成 unit，避免用户手工改路径时漏掉 ReadWritePaths 那处。
sed -e "s|^User=.*|User=$RUN_USER|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$APP_DIR|" \
    -e "s|^EnvironmentFile=.*|EnvironmentFile=-$APP_DIR/.env|" \
    -e "s|^ExecStart=.*|ExecStart=$NODE_BIN dist/main.js|" \
    -e "s|^ReadWritePaths=.*|ReadWritePaths=$APP_DIR/data|" \
    "$APP_DIR/scripts/hmusic-server.service" > "$UNIT"

systemctl daemon-reload
stop_managed_native
systemctl enable hmusic-server
systemctl restart hmusic-server

if systemctl is-active --quiet hmusic-server && wait_for_http "$PORT" 30; then
  echo
  echo "✅ 已启动并设为开机自启"
  echo "   访问:  http://<本机IP>:${PORT}/app/"
  echo "   状态:  systemctl status hmusic-server"
  echo "   日志:  journalctl -u hmusic-server -f"
else
  journalctl -u hmusic-server -n 50 --no-pager >&2 || true
  echo "❌ 服务未通过健康检查，日志命令：journalctl -u hmusic-server -n 50 --no-pager" >&2
  exit 1
fi
