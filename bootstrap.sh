#!/usr/bin/env bash
# HMusic Server 单行安装入口：下载最新 Release 部署包，或在 Release 不可用时回退 Git。
set -euo pipefail

say()  { printf '\033[36m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

REPO_SLUG="${HMUSIC_REPO:-hpcll/HMusic-Server}"
REPO_URL="https://github.com/${REPO_SLUG}.git"
RELEASE_URL="${HMUSIC_RELEASE_URL:-https://github.com/${REPO_SLUG}/releases/latest/download/hmusic-deploy.tar.gz}"
CHECKSUM_URL="${HMUSIC_RELEASE_SHA256_URL:-${RELEASE_URL}.sha256}"
# 网络受限时可提供一个 GitHub 代理前缀；支持把完整 URL 放在 {url} 占位符中。
# 例如：HMUSIC_GITHUB_PROXY='https://mirror.example/{url}'
GITHUB_PROXY="${HMUSIC_GITHUB_PROXY:-}"
DEFAULT_HOME="${HOME:-}"
[ -n "$DEFAULT_HOME" ] || die "无法确定用户目录，请先设置 HOME，或用 HMUSIC_INSTALL_DIR 指定安装目录。"
DEFAULT_INSTALL_DIR="${DEFAULT_HOME}/HMusic-Server"
if [ "$(uname -s)" = Linux ] && [ "$(id -u)" -eq 0 ]; then
  DEFAULT_INSTALL_DIR=/opt/hmusic-server
fi
INSTALL_DIR="${HMUSIC_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"

case "$INSTALL_DIR" in
  ''|/) die "安装目录不能是空值或根目录 /" ;;
esac

download_file() {
  local url="$1" output="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --connect-timeout 15 "$url" -o "$output"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$output" "$url"
  else
    return 127
  fi
}

github_proxy_url() {
  local url="$1"
  case "$GITHUB_PROXY" in
    *'{url}'*) printf '%s\n' "${GITHUB_PROXY//\{url\}/$url}" ;;
    */) printf '%s%s\n' "$GITHUB_PROXY" "$url" ;;
    *) printf '%s/%s\n' "$GITHUB_PROXY" "$url" ;;
  esac
}

download_github_file() {
  local url="$1" output="$2" proxied_url
  if download_file "$url" "$output"; then
    return 0
  fi
  [ -n "$GITHUB_PROXY" ] || return 1
  case "$url" in
    https://github.com/*|https://raw.githubusercontent.com/*|https://codeload.github.com/*) ;;
    *) return 1 ;;
  esac
  proxied_url="$(github_proxy_url "$url")"
  warn "直连 GitHub 失败，尝试配置的下载代理…"
  download_file "$proxied_url" "$output"
}

run_installer() {
  cd "$INSTALL_DIR"
  bash install.sh "$@"
  echo
  ok "HMusic 已安装在：$INSTALL_DIR"
}

# 引导器自行升级 Git 安装，兼容尚不支持 --update 的旧版 install.sh。
if [ -d "$INSTALL_DIR/.git" ]; then
  command -v git >/dev/null 2>&1 || die "已有安装来自 Git，但当前找不到 git 命令。"
  say "检测到已有 Git 安装，正在安全升级…"
  cd "$INSTALL_DIR"
  [ -z "$(git -c core.fileMode=false status --porcelain)" ] \
    || die "程序目录存在本地修改，为避免覆盖已停止升级：$INSTALL_DIR"
  BRANCH="$(git symbolic-ref --quiet --short HEAD || true)"
  [ -n "$BRANCH" ] || die "程序目录处于 detached HEAD，请先切回 main 分支。"
  UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
  [ -n "$UPSTREAM" ] || die "分支 ${BRANCH} 没有关联远端分支，无法自动升级。"
  git -c core.fileMode=false pull --ff-only
  run_installer "$@"
  exit 0
fi

if [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" ] \
  && [ ! -f "$INSTALL_DIR/install.sh" ]; then
  for EXISTING_PATH in "$INSTALL_DIR"/* "$INSTALL_DIR"/.[!.]* "$INSTALL_DIR"/..?*; do
    [ -e "$EXISTING_PATH" ] || continue
    case "${EXISTING_PATH##*/}" in
      .env|data) ;;
      *) die "安装目录已包含其它文件：$INSTALL_DIR。请用 HMUSIC_INSTALL_DIR 指定一个空目录。" ;;
    esac
  done
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hmusic-bootstrap.XXXXXX")"
ARCHIVE="$WORK_DIR/hmusic-deploy.tar.gz"
CHECKSUM="$WORK_DIR/hmusic-deploy.tar.gz.sha256"
PACKAGE_DIR="$WORK_DIR/package"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT INT TERM

say "正在下载 HMusic 最新部署包…"
if ! download_github_file "$RELEASE_URL" "$ARCHIVE"; then
  warn "最新 Release 部署包暂时不可用。"
  if command -v git >/dev/null 2>&1 && { [ ! -d "$INSTALL_DIR" ] || [ -z "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" ]; }; then
    say "改用 Git 获取最新版…"
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
    run_installer "$@"
    exit 0
  fi
  die "下载失败。请检查网络和 Release 是否已发布；已有安装不会被改动。"
fi

if download_github_file "$CHECKSUM_URL" "$CHECKSUM"; then
  EXPECTED_SHA256="$(awk 'NR == 1 {print $1}' "$CHECKSUM")"
  case "$EXPECTED_SHA256" in
    ''|*[!a-fA-F0-9]*)
      die "Release 校验文件格式无效，已停止安装。"
      ;;
  esac
  [ "${#EXPECTED_SHA256}" -eq 64 ] || die "Release 校验值长度无效，已停止安装。"
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL_SHA256="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
  else
    ACTUAL_SHA256=""
    warn "系统缺少 sha256sum/shasum，跳过部署包完整性校验。"
  fi
  if [ -n "$ACTUAL_SHA256" ]; then
    [ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ] || die "部署包 SHA-256 校验失败，已停止安装。"
    ok "部署包完整性校验通过"
  fi
else
  warn "未找到 Release SHA-256 校验文件，继续使用 HTTPS 下载结果。"
fi

command -v tar >/dev/null 2>&1 || die "系统缺少 tar，无法解压部署包。"
if ! tar -tzf "$ARCHIVE" | awk '
  {
    entry = $0
    sub(/^\.\//, "", entry)
    if (entry ~ /^\// || entry ~ /(^|\/)\.\.(\/|$)/ || entry == ".env" || entry ~ /^data(\/|$)/) bad = 1
  }
  END { exit bad }
'; then
  die "部署包包含不安全路径或用户数据目录，已停止安装。"
fi
if ! tar -tvzf "$ARCHIVE" | awk 'substr($1, 1, 1) != "-" && substr($1, 1, 1) != "d" { bad = 1 } END { exit bad }'; then
  die "部署包包含符号链接或其它特殊文件，已停止安装。"
fi

mkdir -p "$PACKAGE_DIR" "$INSTALL_DIR"
tar -xzf "$ARCHIVE" -C "$PACKAGE_DIR"
[ -f "$PACKAGE_DIR/install.sh" ] || die "部署包缺少 install.sh，请等待维护者重新发布。"
[ -f "$PACKAGE_DIR/scripts/deploy-common.sh" ] || die "部署包缺少共用部署脚本，请等待维护者重新发布。"

# 官方部署包不包含 .env 和 data/。升级时清掉旧程序目录，避免已删除文件继续残留。
if [ -f "$INSTALL_DIR/.hmusic-install" ]; then
  rm -rf "$INSTALL_DIR/dist" "$INSTALL_DIR/web" "$INSTALL_DIR/scripts"
fi
cp -R "$PACKAGE_DIR"/. "$INSTALL_DIR"/
printf 'managed-by-hmusic-bootstrap\n' > "$INSTALL_DIR/.hmusic-install"
chmod +x "$INSTALL_DIR/install.sh" "$INSTALL_DIR/bootstrap.sh" "$INSTALL_DIR/scripts/"*.sh 2>/dev/null || true
run_installer "$@"
