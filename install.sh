#!/usr/bin/env bash
# HMusic Server 一键安装。自动选择 Docker 或原生方式、自动生成密钥、自动启动。
#
# 用法：
#   bash install.sh              # 自动选择最合适的方式
#   bash install.sh --docker     # 强制走 Docker
#   bash install.sh --native     # 强制走原生 Node
#   bash install.sh --update     # 拉取最新版并升级（保留配置和数据）
#
# 重复执行安全：已有 .env 不会被覆盖（密钥不会变，登录态不失效）。
set -euo pipefail

cd "$(dirname "$0")"
OS="$(uname -s)"
. scripts/deploy-common.sh

MODE=auto
UPDATE=false
NEXT_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --docker) MODE=docker; NEXT_ARGS+=("$arg") ;;
    --native) MODE=native; NEXT_ARGS+=("$arg") ;;
    --update) UPDATE=true ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "未知参数：${arg}（可用：--docker / --native / --update）" >&2; exit 1 ;;
  esac
done

if $UPDATE && [ "${HMUSIC_UPDATE_DONE:-0}" != 1 ]; then
  if [ ! -d .git ] && [ -f bootstrap.sh ]; then
    ok "检测到 Release 部署包安装，切换到最新版部署包升级"
    export HMUSIC_INSTALL_DIR="$PWD"
    if [ "${#NEXT_ARGS[@]}" -gt 0 ]; then
      exec bash bootstrap.sh "${NEXT_ARGS[@]}"
    fi
    exec bash bootstrap.sh
  fi
  update_checkout
  ok "继续执行最新版安装器"
  export HMUSIC_UPDATE_DONE=1
  if [ "${#NEXT_ARGS[@]}" -gt 0 ]; then
    exec bash "$0" "${NEXT_ARGS[@]}"
  fi
  exec bash "$0"
fi

# ---------- 1. 选择安装方式 ----------
has_docker=false
docker_present=false
if command -v docker >/dev/null 2>&1; then
  docker_present=true
  docker info >/dev/null 2>&1 && has_docker=true
fi

systemd_native=false
if [ "$OS" = Linux ] && command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet hmusic-server 2>/dev/null \
    || systemctl is-enabled --quiet hmusic-server 2>/dev/null; then
    systemd_native=true
  fi
fi

PREVIOUS_MODE="$(read_deploy_mode)"
if [ -z "$PREVIOUS_MODE" ]; then
  if [ -f data/hmusic.pid ]; then
    PREVIOUS_MODE=native
  elif $systemd_native; then
    PREVIOUS_MODE=native
  elif $has_docker && docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx hmusic-server; then
    PREVIOUS_MODE=docker
  fi
fi

if [ "$MODE" = auto ]; then
  if [ -n "$PREVIOUS_MODE" ]; then
    MODE="$PREVIOUS_MODE"
    ok "沿用上次部署方式：${MODE}"
  else
  # macOS / Windows(WSL) 的 Docker Desktop 跑在 VM 里，host 网络失效、mDNS 出不去，
  # 音箱会连不上——这两个平台即使有 Docker 也默认走原生。
    case "$OS" in
      Linux)  $has_docker && MODE=docker || MODE=native ;;
      Darwin) MODE=native ;;
      *)      MODE=native ;;
    esac
  fi
fi

if [ "$MODE" = docker ] && ! $has_docker; then
  if [ "$PREVIOUS_MODE" = docker ]; then
    die "上次使用 Docker 部署，但当前无法连接 Docker 服务。请先启动 Docker 或修复当前用户权限后重试。"
  fi
  die "指定了 --docker，但没检测到可用的 Docker（装了吗？服务起了吗？当前用户有权限吗？）"
fi

if [ "$PREVIOUS_MODE" = docker ] && [ "$MODE" = native ] && ! $has_docker; then
  die "上次使用 Docker 部署。切换到原生方式前需要先恢复 Docker 访问，以便安全停止旧容器。"
fi
if [ "$MODE" = native ] && $docker_present && ! $has_docker && [ "$OS" = Linux ]; then
  warn "检测到 Docker 命令，但当前无法连接 Docker 服务（服务未启动或用户无权限），将改用原生 Node 方式。"
fi
if [ "$PREVIOUS_MODE" = native ] && [ "$MODE" = docker ] \
  && $systemd_native && [ "$(id -u)" -ne 0 ]; then
  die "上次使用 systemd 原生部署。切换 Docker 前请用 sudo bash install.sh --docker，让安装器安全停止旧服务。"
fi

say "安装方式：${MODE}（系统：${OS}）"
echo

# ---------- 2. 生成 .env（含随机密钥）----------
ensure_env

PORT="$(read_port)"
sync_loopback_public_base_port "$PORT"

# ---------- 3. 安装并启动 ----------
if [ "$MODE" = docker ]; then
  command -v docker >/dev/null || die "找不到 docker"
  docker compose version >/dev/null 2>&1 \
    || die "找不到 docker compose（v2）。老版 docker-compose 请升级 Docker。"
  ensure_docker_data_identity

  say "拉取镜像并启动…"
  # 镜像若为 private 会在这里失败，给出可操作的提示而不是让用户看原始报错。
  PULL_LOG="${TMPDIR:-/tmp}/hmusic-pull.$$.log"
  trap 'rm -f "$PULL_LOG"' EXIT
  if ! docker compose pull 2>&1 | tee "$PULL_LOG"; then
    if grep -qiE 'denied|unauthorized|not found' "$PULL_LOG"; then
      die "拉取镜像被拒绝：镜像仓库可能还是 private。
   维护者需到 GitHub Packages 把 hmusic-server 设为 Public，
   或先用原生方式安装：bash install.sh --native"
    fi
    die "拉取镜像失败，详见上方输出"
  fi
  rm -f "$PULL_LOG"
  trap - EXIT
  if [ "$PREVIOUS_MODE" = native ]; then
    say "正在停止旧的原生服务…"
    if $systemd_native; then
      systemctl disable --now hmusic-server
    fi
    stop_managed_native
  fi
  docker compose up -d
  say "等待容器通过健康检查…"
  CONTAINER_ID="$(docker compose ps -q hmusic-server)"
  [ -n "$CONTAINER_ID" ] || die "容器没有成功创建，请运行 docker compose logs 查看原因"
  HEALTH=starting
  ATTEMPT=1
  while [ "$ATTEMPT" -le 60 ]; do
    HEALTH="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER_ID" 2>/dev/null || true)"
    [ "$HEALTH" = healthy ] && break
    [ "$HEALTH" = exited ] && break
    sleep 2
    ATTEMPT=$((ATTEMPT + 1))
  done
  if [ "$HEALTH" != healthy ]; then
    docker compose logs --tail=50 hmusic-server || true
    die "容器未通过健康检查（状态：${HEALTH:-未知}）"
  fi
  record_deploy_mode docker
  ok "容器已启动并通过健康检查"
  echo
  say "常用命令："
  echo "   查看日志:  docker compose logs -f"
  echo "   停止:      docker compose down"
  echo "   升级:      bash install.sh --update"
else
  if ! command -v node >/dev/null 2>&1; then
    if $has_docker; then
      die "上次使用原生 Node 部署，但当前找不到 Node.js。请重新安装 Node.js 20+，或执行 bash install.sh --docker 切换到 Docker。"
    fi
    if [ "$OS" = Linux ]; then
      die "未找到可用的 Docker，也未安装 Node.js。NAS 推荐先在应用中心安装 Docker / Container Manager；若要原生安装，请先安装 Node.js 20+：https://nodejs.org/"
    fi
    die "未找到 Node.js。请先安装 Node.js 20 或更高版本：https://nodejs.org/"
  fi
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 20 ] || die "Node 版本过低（当前 $(node -v)），需要 20 或更高"

  command -v npm >/dev/null || die "未找到 npm，请重新安装完整的 Node.js 20+"
  if [ -f tsconfig.json ] && [ -d src ]; then
    say "安装依赖并编译最新版（首次较慢，请耐心等待）…"
    npm ci --no-audit --no-fund || explain_npm_install_failure
    npm run build
  elif [ -f dist/main.js ]; then
    say "检测到预编译部署包，正在安装生产依赖…"
    npm ci --omit=dev --no-audit --no-fund || explain_npm_install_failure
  else
    die "既没有源码也没有 dist/main.js，安装文件不完整，请重新下载。"
  fi

  if [ "$PREVIOUS_MODE" = docker ]; then
    say "正在停止旧的 Docker 容器…"
    docker compose down
  fi

  # Linux root 环境装成 systemd 服务；其它环境由安装器在后台管理。
  if [ "$OS" = Linux ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    if [ "$(id -u)" -eq 0 ]; then
      say "检测到 systemd，安装为开机自启服务…"
      bash scripts/install-systemd.sh
      record_deploy_mode native
      print_access_urls "$PORT"
      exit 0
    else
      warn "检测到 systemd。想要开机自启请运行：sudo bash scripts/install-systemd.sh"
      echo
    fi
  fi

  start_native_background "$PORT"
  record_deploy_mode native
  echo "   日志: data/server.log"
  echo "   停止: bash scripts/stop.sh"
fi

# ---------- 4. 打印访问地址 ----------
print_access_urls "$PORT"
