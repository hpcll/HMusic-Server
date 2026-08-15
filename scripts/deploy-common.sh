#!/usr/bin/env bash
# 部署脚本共用函数。调用方需要先设置 OS，并在项目根目录执行。

say()  { printf '\033[36m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✅ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m⚠️  %s\033[0m\n' "$*"; }
die()  { printf '\033[31m❌ %s\033[0m\n' "$*" >&2; exit 1; }

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif [ -r /dev/urandom ] && command -v od >/dev/null 2>&1; then
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  elif command -v node >/dev/null 2>&1; then
    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  else
    die "无法生成随机密钥（缺少 openssl、/dev/urandom 和 node）"
  fi
}

ensure_env() {
  local secret
  if [ -f .env ]; then
    ok ".env 已存在，保留原有配置和登录态"
  else
    [ -f .env.example ] || die "缺少 .env.example，安装文件不完整"
    sed "s|^HMUSIC_JWT_SECRET=.*|HMUSIC_JWT_SECRET=$(gen_secret)|" .env.example > .env
    ok "已生成 .env，并自动创建安全密钥"
  fi

  secret="$(env_value HMUSIC_JWT_SECRET | tr -d '[:space:]')"
  if [ -z "$secret" ] || [ "$secret" = change-me ]; then
    warn "检测到密钥缺失或仍为默认值，正在自动修复…"
    if grep -q '^HMUSIC_JWT_SECRET=' .env; then
      sed "s|^HMUSIC_JWT_SECRET=.*|HMUSIC_JWT_SECRET=$(gen_secret)|" .env > .env.tmp
      mv .env.tmp .env
    else
      printf '\nHMUSIC_JWT_SECRET=%s\n' "$(gen_secret)" >> .env
    fi
    ok "安全密钥已就绪"
  elif [ "${#secret}" -lt 8 ]; then
    die "HMUSIC_JWT_SECRET 至少需要 8 个字符，请修改 .env 后重试。"
  fi
  chmod 600 .env 2>/dev/null || true
}

env_value() {
  awk -F= -v key="$1" '$1 == key {sub(/^[^=]*=/, ""); value=$0} END {print value}' .env 2>/dev/null | tr -d '\r'
}

set_env_value() {
  local key="$1" value="$2"
  awk -v key="$key" -v value="$value" '
    BEGIN { updated = 0 }
    $0 ~ "^" key "=" { print key "=" value; updated = 1; next }
    { print }
    END { if (!updated) print key "=" value }
  ' .env > .env.tmp
  mv .env.tmp .env
  chmod 600 .env 2>/dev/null || true
}

read_port() {
  local port
  port="$(env_value HMUSIC_PORT | tr -d '[:space:]')"
  port="${port:-6650}"
  case "$port" in
    *[!0-9]*) die "HMUSIC_PORT 必须是 1-65535 之间的数字（当前：$port）" ;;
  esac
  [ "$port" -ge 1 ] && [ "$port" -le 65535 ] \
    || die "HMUSIC_PORT 必须在 1-65535 之间（当前：$port）"
  printf '%s\n' "$port"
}

sync_loopback_public_base_port() {
  local port="$1" base host replacement
  base="$(env_value HMUSIC_PUBLIC_BASE_URL)"
  case "$base" in
    http://127.0.0.1:*|http://localhost:*)
      host="${base#http://}"
      host="${host%%:*}"
      replacement="http://${host}:${port}"
      set_env_value HMUSIC_PUBLIC_BASE_URL "$replacement"
      ;;
  esac
}

ensure_docker_data_identity() {
  local uid gid
  mkdir -p data
  uid="$(stat -c '%u' data 2>/dev/null || stat -f '%u' data 2>/dev/null || true)"
  gid="$(stat -c '%g' data 2>/dev/null || stat -f '%g' data 2>/dev/null || true)"
  case "$uid:$gid" in
    *[!0-9:]*|:*|*:) die "无法读取 data/ 的 UID/GID，请检查目录权限" ;;
  esac
  set_env_value HMUSIC_DOCKER_UID "$uid"
  set_env_value HMUSIC_DOCKER_GID "$gid"
  ok "Docker 数据目录权限已对齐（UID ${uid} / GID ${gid}）"
}

read_deploy_mode() {
  local mode=""
  [ -f data/deploy-mode ] && mode="$(tr -d '[:space:]' < data/deploy-mode 2>/dev/null || true)"
  case "$mode" in
    docker|native) printf '%s\n' "$mode" ;;
  esac
}

record_deploy_mode() {
  mkdir -p data
  printf '%s\n' "$1" > data/deploy-mode.tmp
  mv data/deploy-mode.tmp data/deploy-mode
}

explain_npm_install_failure() {
  case "${OS:-}" in
    Darwin)
      die "依赖安装失败。请先检查网络；若上方出现 node-gyp 或编译错误，执行 xcode-select --install 安装命令行工具后重试。"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      die "依赖安装失败。请使用 Node.js 20/22 LTS 的 x64 完整安装包；若上方出现 node-gyp，请安装 Visual Studio Build Tools 后重试。"
      ;;
    Linux)
      die "依赖安装失败。请先检查网络；若上方出现 node-gyp，可在 Debian/Ubuntu 执行 sudo apt install python3 make g++ 后重试。"
      ;;
    *)
      die "依赖安装失败，请根据上方 npm 输出修复后重试。"
      ;;
  esac
}

port_busy() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -lnt "sport = :$1" 2>/dev/null | grep -q LISTEN
  elif command -v netstat >/dev/null 2>&1; then
    netstat -an 2>/dev/null | grep -E "[.:]$1[[:space:]].*LISTEN" >/dev/null
  else
    return 1
  fi
}

http_ok() {
  local port="$1"
  node -e "fetch('http://127.0.0.1:${port}/api/v1/system/info').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1
}

wait_for_http() {
  local port="$1" attempts="${2:-30}" i=1
  while [ "$i" -le "$attempts" ]; do
    http_ok "$port" && return 0
    sleep 2
    i=$((i + 1))
  done
  return 1
}

process_command_line() {
  local pid="$1" command_line=""
  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if [ -z "$command_line" ] && [ -r "/proc/$pid/cmdline" ]; then
    command_line="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  fi
  if [ -z "$command_line" ] && command -v powershell.exe >/dev/null 2>&1; then
    command_line="$(powershell.exe -NoProfile -Command \
      "(Get-CimInstance Win32_Process -Filter 'ProcessId=$pid').CommandLine" 2>/dev/null | tr -d '\r' || true)"
  fi
  printf '%s\n' "$command_line"
}

stop_managed_native() {
  local pid_file="data/hmusic.pid" pid command_line
  [ -f "$pid_file" ] || return 0
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  case "$pid" in
    ''|*[!0-9]*)
      rm -f "$pid_file"
      warn "发现无效 PID 文件，已清理。"
      return 0
      ;;
  esac
  if [ "$pid" -le 1 ]; then
    rm -f "$pid_file"
    warn "发现不安全的 PID 文件，已清理。"
    return 0
  fi
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    command_line="$(process_command_line "$pid")"
    case "$command_line" in
      *"node dist/main.js"*) ;;
      *)
        rm -f "$pid_file"
        die "PID 文件指向了其它程序，为安全起见没有停止它。请检查 data/hmusic.pid。"
        ;;
    esac
    say "正在停止已有 HMusic 服务…"
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      die "旧服务在 5 秒内未停止。请执行 bash scripts/stop.sh 后重试。"
    fi
    wait "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
}

start_native_background() {
  local port="$1" pid
  mkdir -p data
  stop_managed_native

  if port_busy "$port"; then
    if http_ok "$port"; then
      die "端口 ${port} 上已有 HMusic 服务，但它不由本脚本管理。若使用 systemd，请用 sudo bash install.sh --native 升级；否则先停止旧服务。"
    fi
    die "端口 ${port} 已被其它程序占用。请修改 .env 中的 HMUSIC_PORT 后重试。"
  fi

  say "正在后台启动 HMusic…"
  nohup node dist/main.js >> data/server.log 2>&1 &
  pid=$!
  disown "$pid" 2>/dev/null || true
  printf '%s\n' "$pid" > data/hmusic.pid

  if ! wait_for_http "$port" 30; then
    warn "服务未能正常启动，最后 30 行日志如下："
    tail -n 30 data/server.log 2>/dev/null || true
    die "启动失败。完整日志：data/server.log"
  fi
  ok "服务已在后台启动，并通过健康检查（PID ${pid}）"
}

lan_ip() {
  local detected=""
  if [ "${OS:-}" = Darwin ]; then
    detected="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
    [ -n "$detected" ] && printf '%s\n' "$detected"
    return 0
  fi

  if command -v ip >/dev/null 2>&1; then
    detected="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}' || true)"
  fi
  if [ -z "$detected" ] && command -v hostname >/dev/null 2>&1; then
    detected="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi
  if [ -z "$detected" ] && command -v ipconfig >/dev/null 2>&1; then
    detected="$(ipconfig 2>/dev/null | awk -F: '/IPv4 Address|IPv4 地址/{gsub(/^[ \t]+|[ \t\r]+$/, "", $2); print $2; exit}' || true)"
  fi
  [ -n "$detected" ] && printf '%s\n' "$detected"
  return 0
}

print_access_urls() {
  local port="$1" ip
  ip="$(lan_ip | head -n1)"
  echo
  ok "部署完成！用浏览器打开："
  if [ -n "${ip:-}" ]; then
    echo "   http://${ip}:${port}/app/       ← 手机或其它设备"
  fi
  echo "   http://127.0.0.1:${port}/app/   ← 本机"
  echo
  echo "首次打开会引导创建管理员账号，然后可在「设置 → 小米账号」扫码登录。"
}

update_checkout() {
  local branch upstream
  command -v git >/dev/null 2>&1 || die "自动升级需要 Git。请先安装 Git，或下载新版部署包覆盖程序文件。"
  [ -d .git ] || die "当前不是 Git 克隆目录，无法自动拉取。部署包用户请下载新版部署包，保留 .env 和 data/ 后覆盖程序文件。"
  [ -z "$(git -c core.fileMode=false status --porcelain)" ] \
    || die "检测到程序文件有本地修改，为避免覆盖已停止升级。请先保存或还原这些修改。"
  branch="$(git symbolic-ref --quiet --short HEAD || true)"
  [ -n "$branch" ] || die "当前 Git 处于 detached HEAD，无法自动升级。请切回 main 分支后重试。"
  upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
  [ -n "$upstream" ] \
    || die "当前分支 ${branch} 没有关联远端分支。请先执行 git branch --set-upstream-to=origin/${branch}，再重试。"

  say "正在从 ${upstream} 拉取最新版…"
  git -c core.fileMode=false pull --ff-only
  ok "代码已更新"
}
