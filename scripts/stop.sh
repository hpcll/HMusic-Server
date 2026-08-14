#!/usr/bin/env bash
# 停止由 install.sh / deploy-run.sh 管理的原生服务。
set -euo pipefail

cd "$(dirname "$0")/.."
OS="$(uname -s)"
. scripts/deploy-common.sh

MODE="$(read_deploy_mode)"
if [ "$MODE" = docker ]; then
  command -v docker >/dev/null 2>&1 || die "当前记录为 Docker 部署，但找不到 docker 命令。"
  docker compose version >/dev/null 2>&1 || die "找不到 docker compose（v2）。"
  docker compose down
  ok "HMusic Docker 容器已停止。"
  exit 0
fi

if [ "$OS" = Linux ] && command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet hmusic-server 2>/dev/null; then
    if [ "$(id -u)" -ne 0 ]; then
      die "HMusic 由 systemd 管理，请执行：sudo systemctl stop hmusic-server"
    fi
    systemctl stop hmusic-server
    ok "HMusic systemd 服务已停止；开机自启保持启用。"
    exit 0
  fi
  if systemctl is-enabled --quiet hmusic-server 2>/dev/null; then
    echo "HMusic systemd 服务当前已停止；开机自启仍保持启用。"
    exit 0
  fi
fi

if [ ! -f data/hmusic.pid ]; then
  echo "HMusic 当前没有由安装器记录的运行进程。"
  exit 0
fi

stop_managed_native
ok "HMusic 已停止。"
