#!/usr/bin/env bash
# 安装 systemd 服务（Debian/Ubuntu/树莓派/Armbian 等）。
# 用法：sudo bash scripts/install-systemd.sh [安装目录]
# 不传目录则用当前项目所在路径。
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "❌ 需要 root 权限：sudo bash scripts/install-systemd.sh" >&2
  exit 1
fi

APP_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
UNIT=/etc/systemd/system/hmusic-server.service

# ---- 前置校验：缺任何一项都会让服务起不来，提前说清楚 ----
[ -f "$APP_DIR/dist/main.js" ] || {
  echo "❌ 找不到 $APP_DIR/dist/main.js —— 请先 npm run build 或解压部署包" >&2; exit 1; }
[ -f "$APP_DIR/.env" ] || {
  echo "❌ 找不到 $APP_DIR/.env —— 请先 cp .env.example .env 并修改 HMUSIC_JWT_SECRET" >&2; exit 1; }
grep -q "change-me" "$APP_DIR/.env" && {
  echo "❌ .env 里 HMUSIC_JWT_SECRET 还是默认值 change-me，请改成随机长字符串" >&2; exit 1; }

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "❌ 未找到 node，请先安装 Node.js 20+" >&2; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || {
  echo "❌ Node 版本过低（当前 $(node -v)），需要 20+" >&2; exit 1; }

# ---- 运行用户：优先复用已存在的 hmusic，否则建一个无登录权限的系统用户 ----
RUN_USER=hmusic
if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  echo "创建系统用户 $RUN_USER…"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$RUN_USER"
fi

# data/ 必须存在且归属运行用户，否则 SQLite 建库会因无写权限失败。
mkdir -p "$APP_DIR/data"
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR/data"
# .env 含 JWT 密钥，只给运行用户读。
chown "$RUN_USER":"$RUN_USER" "$APP_DIR/.env"
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
systemctl enable --now hmusic-server

sleep 2
if systemctl is-active --quiet hmusic-server; then
  PORT="$(grep -E '^HMUSIC_PORT=' "$APP_DIR/.env" | tail -n1 | cut -d= -f2 | tr -d '[:space:]')"
  PORT="${PORT:-6650}"
  echo
  echo "✅ 已启动并设为开机自启"
  echo "   访问:  http://<本机IP>:${PORT}/app/"
  echo "   状态:  systemctl status hmusic-server"
  echo "   日志:  journalctl -u hmusic-server -f"
else
  echo "❌ 启动失败，查看日志：journalctl -u hmusic-server -n 50 --no-pager" >&2
  exit 1
fi
