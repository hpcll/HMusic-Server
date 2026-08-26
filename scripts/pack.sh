#!/usr/bin/env bash
# 打一键部署包：编译后端 + 收齐前端与依赖清单，产出 hmusic-deploy.tar.gz。
# 用法：在项目根执行  bash scripts/pack.sh
# 产物拷到服务器解压后，执行 bash install.sh 即可自动选择 Docker/原生方式。
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="${HMUSIC_DEPLOY_OUT:-hmusic-deploy.tar.gz}"
CHECKSUM_OUT="${OUT}.sha256"

echo "[1/3] 安装依赖并编译后端…"
npm ci --no-audit --no-fund
npm run build

echo "[2/3] 打包运行所需文件…"
# 校验前端运行时库齐全（缺任何一个都会让 SPA 在浏览器里崩，例如缺 qrcode.js
# 会导致扫码登录点“生成二维码”时 window.qrcode 未定义、二维码永远出不来）。
REQUIRED_VENDOR=(
  "web/vendor/vue.esm-browser.prod.js"
  "web/vendor/qrcode.js"
)
for f in "${REQUIRED_VENDOR[@]}"; do
  if [[ ! -s "$f" ]]; then
    echo "❌ 缺少前端运行时库：$f —— 打包中止，请先补齐 web/vendor/ 再打包。" >&2
    exit 1
  fi
done
# 同一部署包同时支持 Docker 与原生安装；不包含 .env/data，覆盖升级不会碰用户状态。
tar --exclude='.DS_Store' --exclude='*/.DS_Store' -czf "$OUT" \
  dist web package.json package-lock.json .env.example LICENSE README.md docs/DEPLOYMENT.md THIRD-PARTY-NOTICES.md scripts \
  bootstrap.sh install.sh docker-compose.yml

echo "[2.5/3] 校验产物内已包含前端运行时库…"
ARCHIVE_LIST="$(mktemp)"
trap 'rm -f "$ARCHIVE_LIST"' EXIT
tar tzf "$OUT" > "$ARCHIVE_LIST"
for f in "${REQUIRED_VENDOR[@]}"; do
  if ! grep -Fx "$f" "$ARCHIVE_LIST" >/dev/null; then
    echo "❌ 产物 $OUT 内缺少 $f —— 打包失败。" >&2
    rm -f "$OUT"
    exit 1
  fi
done
for f in bootstrap.sh install.sh docker-compose.yml LICENSE README.md docs/DEPLOYMENT.md THIRD-PARTY-NOTICES.md scripts/deploy-common.sh scripts/stop.sh; do
  if ! grep -Fx "$f" "$ARCHIVE_LIST" >/dev/null; then
    echo "❌ 产物 $OUT 内缺少 $f —— 打包失败。" >&2
    rm -f "$OUT"
    exit 1
  fi
done
if grep -E '(^|/)\.DS_Store$' "$ARCHIVE_LIST" >/dev/null; then
  echo "❌ 产物 $OUT 含有 .DS_Store，打包失败。" >&2
  rm -f "$OUT" "$CHECKSUM_OUT"
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  PACKAGE_SHA256="$(sha256sum "$OUT" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  PACKAGE_SHA256="$(shasum -a 256 "$OUT" | awk '{print $1}')"
else
  echo "❌ 缺少 sha256sum/shasum，无法生成部署包校验文件。" >&2
  exit 1
fi
printf '%s  %s\n' "$PACKAGE_SHA256" "$(basename "$OUT")" > "$CHECKSUM_OUT"

echo "[3/3] 完成：$OUT ($(du -h "$OUT" | cut -f1))"
echo "       校验：$CHECKSUM_OUT"
echo
echo "下一步：把 $OUT 拷到服务器，解压后执行 bash install.sh"
