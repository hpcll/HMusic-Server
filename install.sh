#!/usr/bin/env bash
# HMusic Server 一键安装。自动选择 Docker 或原生方式、自动生成密钥、自动启动。
#
# 用法：
#   bash install.sh              # 自动选择最合适的方式
#   bash install.sh --docker     # 强制走 Docker
#   bash install.sh --native     # 强制走原生 Node
#
# 重复执行安全：已有 .env 不会被覆盖（密钥不会变，登录态不失效）。
set -euo pipefail

cd "$(dirname "$0")"

MODE=auto
for arg in "$@"; do
  case "$arg" in
    --docker) MODE=docker ;;
    --native) MODE=native ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "未知参数：${arg}（可用：--docker / --native）" >&2; exit 1 ;;
  esac
done

say()  { printf '\033[36m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✅ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m⚠️  %s\033[0m\n' "$*"; }
die()  { printf '\033[31m❌ %s\033[0m\n' "$*" >&2; exit 1; }

# ---------- 1. 选择安装方式 ----------
OS="$(uname -s)"
has_docker=false
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  has_docker=true
fi

if [ "$MODE" = auto ]; then
  # macOS / Windows(WSL) 的 Docker Desktop 跑在 VM 里，host 网络失效、mDNS 出不去，
  # 音箱会连不上——这两个平台即使有 Docker 也默认走原生。
  case "$OS" in
    Linux)  $has_docker && MODE=docker || MODE=native ;;
    Darwin) MODE=native ;;
    *)      MODE=native ;;
  esac
fi

if [ "$MODE" = docker ] && ! $has_docker; then
  die "指定了 --docker，但没检测到可用的 Docker（装了吗？服务起了吗？当前用户有权限吗？）"
fi

say "安装方式：${MODE}（系统：${OS}）"
echo

# ---------- 2. 生成 .env（含随机密钥）----------
gen_secret() {
  # 优先 openssl，退回 /dev/urandom，都没有再用 node。
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif [ -r /dev/urandom ]; then
    LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom | head -c 64
  elif command -v node >/dev/null 2>&1; then
    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  else
    die "无法生成随机密钥（缺 openssl / /dev/urandom / node）"
  fi
}

if [ -f .env ]; then
  ok ".env 已存在，保留原有配置（不覆盖，登录态和密钥不变）"
  if grep -q '^HMUSIC_JWT_SECRET=change-me$' .env; then
    warn "检测到 JWT 密钥仍是默认值 change-me，正在替换为随机密钥…"
    SECRET="$(gen_secret)"
    # BSD sed(macOS) 与 GNU sed 的 -i 参数不兼容，用临时文件绕开。
    sed "s|^HMUSIC_JWT_SECRET=.*|HMUSIC_JWT_SECRET=$SECRET|" .env > .env.tmp && mv .env.tmp .env
    ok "已替换为随机密钥"
  fi
else
  [ -f .env.example ] || die "缺少 .env.example，仓库不完整"
  SECRET="$(gen_secret)"
  sed "s|^HMUSIC_JWT_SECRET=.*|HMUSIC_JWT_SECRET=$SECRET|" .env.example > .env
  ok "已生成 .env，JWT 密钥已自动随机化（无需手动编辑）"
fi

PORT="$(grep -E '^HMUSIC_PORT=' .env | tail -n1 | cut -d= -f2 | tr -d '[:space:]')"
PORT="${PORT:-6650}"

# ---------- 3. 端口占用检查 ----------
port_busy() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -lnt "sport = :$1" 2>/dev/null | grep -q LISTEN
  else
    return 1   # 检测不了就当没占用，交给启动时报错
  fi
}
if port_busy "$PORT"; then
  warn "端口 $PORT 已被占用。若不是 HMusic 自己在跑，请改 .env 里的 HMUSIC_PORT 后重跑本脚本。"
fi

# ---------- 4. 安装并启动 ----------
if [ "$MODE" = docker ]; then
  command -v docker >/dev/null || die "找不到 docker"
  docker compose version >/dev/null 2>&1 \
    || die "找不到 docker compose（v2）。老版 docker-compose 请升级 Docker。"

  say "拉取镜像并启动…"
  # 镜像若为 private 会在这里失败，给出可操作的提示而不是让用户看原始报错。
  if ! docker compose pull 2>&1 | tee /tmp/hmusic-pull.log; then
    if grep -qiE 'denied|unauthorized|not found' /tmp/hmusic-pull.log; then
      die "拉取镜像被拒绝：镜像仓库可能还是 private。
   维护者需到 GitHub Packages 把 hmusic-server 设为 Public，
   或先用原生方式安装：bash install.sh --native"
    fi
    die "拉取镜像失败，详见上方输出"
  fi
  docker compose up -d
  ok "容器已启动"
  echo
  say "常用命令："
  echo "   查看日志:  docker compose logs -f"
  echo "   停止:      docker compose down"
  echo "   升级:      docker compose pull && docker compose up -d"
else
  command -v node >/dev/null || die "未找到 Node.js。请先安装 Node.js 20 或更高版本：https://nodejs.org/"
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 20 ] || die "Node 版本过低（当前 $(node -v)），需要 20 或更高"

  if [ ! -f dist/main.js ]; then
    say "安装依赖并编译（首次较慢，请耐心等待）…"
    npm ci
    npm run build
  else
    ok "已有编译产物 dist/，跳过构建"
  fi

  # Linux 上有 systemd 就装成开机自启的服务；否则给前台启动命令。
  if [ "$OS" = Linux ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    if [ "$(id -u)" -eq 0 ]; then
      say "检测到 systemd，安装为开机自启服务…"
      bash scripts/install-systemd.sh
      exit 0
    else
      warn "检测到 systemd。想要开机自启请运行：sudo bash scripts/install-systemd.sh"
      echo
    fi
  fi

  ok "准备就绪"
  echo
  say "启动命令："
  echo "   npm start          # 前台运行，关掉终端即停止"
fi

# ---------- 5. 打印访问地址 ----------
lan_ip() {
  if [ "$OS" = Darwin ]; then
    ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true
  else
    # hostname -I 在部分发行版没有，退回 ip route 解析
    hostname -I 2>/dev/null | awk '{print $1}' \
      || ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}'
  fi
}
IP="$(lan_ip)"
echo
ok "完成！用浏览器打开："
if [ -n "${IP:-}" ]; then
  echo "   http://${IP}:${PORT}/app/       ← 手机/其它设备用这个"
fi
echo "   http://127.0.0.1:${PORT}/app/   ← 本机用这个"
echo
echo "首次打开会让你创建管理员账号，然后在「设置 → 小米账号」里扫码登录。"
