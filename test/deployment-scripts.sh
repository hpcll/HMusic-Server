#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_DIR="$(mktemp -d)"
GIT_TEST_DIR="$(mktemp -d)"
BOOTSTRAP_TEST_DIR="$(mktemp -d)"
PORT=16650
SERVER_PID=""

file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

cleanup() {
  if [ -f "$TEST_DIR/data/hmusic.pid" ]; then
    SERVER_PID="$(cat "$TEST_DIR/data/hmusic.pid" 2>/dev/null || true)"
  fi
  if [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TEST_DIR"
  rm -rf "$GIT_TEST_DIR"
  rm -rf "$BOOTSTRAP_TEST_DIR"
}
trap cleanup EXIT

cp "$ROOT/scripts/deploy-common.sh" "$TEST_DIR/deploy-common.sh"
cat > "$TEST_DIR/.env.example" <<EOF
HMUSIC_JWT_SECRET=change-me
HMUSIC_PORT=$PORT
EOF
cat > "$TEST_DIR/server.mjs" <<EOF
import http from "node:http";
http.createServer((req, res) => {
  res.writeHead(req.url === "/api/v1/system/info" ? 200 : 404);
  res.end("ok");
}).listen($PORT, "127.0.0.1");
EOF

cd "$TEST_DIR"
OS="$(uname -s)"
. ./deploy-common.sh

ensure_env
grep -Eq '^HMUSIC_JWT_SECRET=[a-f0-9]{64}$' .env
[ "$(read_port)" = "$PORT" ]
sync_loopback_public_base_port "$PORT"
[ "$(env_value HMUSIC_PUBLIC_BASE_URL)" = "" ]
ORIGINAL_SECRET="$(env_value HMUSIC_JWT_SECRET)"
ensure_env
[ "$(env_value HMUSIC_JWT_SECRET)" = "$ORIGINAL_SECRET" ]

grep -v '^HMUSIC_JWT_SECRET=' .env > .env.without-secret
mv .env.without-secret .env
ensure_env
grep -Eq '^HMUSIC_JWT_SECRET=[a-f0-9]{64}$' .env

printf 'HMUSIC_PUBLIC_BASE_URL=http://127.0.0.1:6650\n' >> .env
sync_loopback_public_base_port "$PORT"
[ "$(env_value HMUSIC_PUBLIC_BASE_URL)" = "http://127.0.0.1:$PORT" ]
if stat -f '%Lp' .env >/dev/null 2>&1; then
  [ "$(stat -f '%Lp' .env)" = 600 ]
else
  [ "$(stat -c '%a' .env)" = 600 ]
fi
sed 's|^HMUSIC_PUBLIC_BASE_URL=.*|HMUSIC_PUBLIC_BASE_URL=https://music.example.com|' .env > .env.custom-url
mv .env.custom-url .env
sync_loopback_public_base_port "$PORT"
[ "$(env_value HMUSIC_PUBLIC_BASE_URL)" = "https://music.example.com" ]

sed 's|^HMUSIC_PORT=.*|HMUSIC_PORT=70000|' .env > .env.invalid-port
mv .env.invalid-port .env
if (read_port >/dev/null 2>&1); then
  echo "out-of-range port should be rejected" >&2
  exit 1
fi
sed 's|^HMUSIC_PORT=.*|HMUSIC_PORT='"$PORT"'|' .env > .env.valid-port
mv .env.valid-port .env

ensure_docker_data_identity >/dev/null
EXPECTED_UID="$(stat -c '%u' data 2>/dev/null || stat -f '%u' data)"
EXPECTED_GID="$(stat -c '%g' data 2>/dev/null || stat -f '%g' data)"
[ "$(env_value HMUSIC_DOCKER_UID)" = "$EXPECTED_UID" ]
[ "$(env_value HMUSIC_DOCKER_GID)" = "$EXPECTED_GID" ]
[ "$(env_value HMUSIC_JWT_SECRET)" != change-me ]
record_deploy_mode docker
[ "$(read_deploy_mode)" = docker ]
printf 'invalid\n' > data/deploy-mode
[ -z "$(read_deploy_mode)" ]
record_deploy_mode native
[ "$(read_deploy_mode)" = native ]
rm -f data/deploy-mode

git init --bare "$GIT_TEST_DIR/remote.git" >/dev/null
git init -b main "$GIT_TEST_DIR/seed" >/dev/null
git -C "$GIT_TEST_DIR/seed" config user.email deployment-test@example.com
git -C "$GIT_TEST_DIR/seed" config user.name deployment-test
printf 'v1\n' > "$GIT_TEST_DIR/seed/version.txt"
cat > "$GIT_TEST_DIR/seed/install.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" > install-args.txt
cp version.txt installed-version.txt
EOF
printf '.env\ndata/\ninstall-args.txt\ninstalled-version.txt\n' > "$GIT_TEST_DIR/seed/.gitignore"
git -C "$GIT_TEST_DIR/seed" add version.txt install.sh .gitignore
git -C "$GIT_TEST_DIR/seed" commit -m v1 >/dev/null
git -C "$GIT_TEST_DIR/seed" remote add origin "$GIT_TEST_DIR/remote.git"
git -C "$GIT_TEST_DIR/seed" push -u origin main >/dev/null
git clone --branch main "$GIT_TEST_DIR/remote.git" "$GIT_TEST_DIR/clone" >/dev/null 2>&1
chmod +x "$GIT_TEST_DIR/clone/install.sh"
printf 'v2\n' > "$GIT_TEST_DIR/seed/version.txt"
git -C "$GIT_TEST_DIR/seed" commit -am v2 >/dev/null
git -C "$GIT_TEST_DIR/seed" push >/dev/null

cd "$GIT_TEST_DIR/clone"
printf 'HMUSIC_JWT_SECRET=keep-me-secret\n' > .env
mkdir -p data
printf 'keep-me-data\n' > data/state.txt
HMUSIC_INSTALL_DIR="$GIT_TEST_DIR/clone" bash "$ROOT/bootstrap.sh" --native >/dev/null
[ "$(cat installed-version.txt)" = v2 ]
[ "$(cat install-args.txt)" = --native ]
[ "$(cat .env)" = 'HMUSIC_JWT_SECRET=keep-me-secret' ]
[ "$(cat data/state.txt)" = 'keep-me-data' ]

printf 'v3\n' > "$GIT_TEST_DIR/seed/version.txt"
git -C "$GIT_TEST_DIR/seed" commit -am v3 >/dev/null
git -C "$GIT_TEST_DIR/seed" push >/dev/null
update_checkout >/dev/null
[ "$(cat version.txt)" = v3 ]
[ "$(cat .env)" = 'HMUSIC_JWT_SECRET=keep-me-secret' ]
[ "$(cat data/state.txt)" = 'keep-me-data' ]
git branch --unset-upstream
if (update_checkout >/dev/null 2>&1); then
  echo "checkout without upstream should not update" >&2
  exit 1
fi
git branch --set-upstream-to=origin/main >/dev/null
EMPTY_ARGS=()
if [ "${#EMPTY_ARGS[@]}" -gt 0 ]; then
  echo "empty argument list reported a non-zero size" >&2
  exit 1
fi
printf 'local change\n' >> version.txt
if (update_checkout >/dev/null 2>&1); then
  echo "dirty checkout should not update" >&2
  exit 1
fi
cd "$TEST_DIR"

mkdir -p "$BOOTSTRAP_TEST_DIR/release-v1/scripts" "$BOOTSTRAP_TEST_DIR/install/data"
cp "$ROOT/scripts/deploy-common.sh" "$BOOTSTRAP_TEST_DIR/release-v1/scripts/deploy-common.sh"
cat > "$BOOTSTRAP_TEST_DIR/release-v1/install.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" > install-args.txt
printf 'v1\n' > installed-version.txt
EOF
cat > "$BOOTSTRAP_TEST_DIR/release-v1/bootstrap.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
tar -czf "$BOOTSTRAP_TEST_DIR/release-v1.tar.gz" -C "$BOOTSTRAP_TEST_DIR/release-v1" .
printf '%s  hmusic-deploy.tar.gz\n' "$(file_sha256 "$BOOTSTRAP_TEST_DIR/release-v1.tar.gz")" \
  > "$BOOTSTRAP_TEST_DIR/release-v1.tar.gz.sha256"
printf 'HMUSIC_JWT_SECRET=keep-bootstrap-secret\n' > "$BOOTSTRAP_TEST_DIR/install/.env"
printf 'keep-bootstrap-data\n' > "$BOOTSTRAP_TEST_DIR/install/data/state.txt"

HMUSIC_INSTALL_DIR="$BOOTSTRAP_TEST_DIR/install" \
HMUSIC_RELEASE_URL="file://$BOOTSTRAP_TEST_DIR/release-v1.tar.gz" \
  bash "$ROOT/bootstrap.sh" --native >/dev/null
[ "$(cat "$BOOTSTRAP_TEST_DIR/install/installed-version.txt")" = v1 ]
[ "$(cat "$BOOTSTRAP_TEST_DIR/install/install-args.txt")" = --native ]
[ "$(cat "$BOOTSTRAP_TEST_DIR/install/.env")" = 'HMUSIC_JWT_SECRET=keep-bootstrap-secret' ]
[ "$(cat "$BOOTSTRAP_TEST_DIR/install/data/state.txt")" = 'keep-bootstrap-data' ]
[ -f "$BOOTSTRAP_TEST_DIR/install/.hmusic-install" ]

mkdir -p "$BOOTSTRAP_TEST_DIR/install/dist" "$BOOTSTRAP_TEST_DIR/install/web" "$BOOTSTRAP_TEST_DIR/install/scripts"
printf 'stale\n' > "$BOOTSTRAP_TEST_DIR/install/dist/removed.js"
printf 'stale\n' > "$BOOTSTRAP_TEST_DIR/install/web/removed.js"
printf 'stale\n' > "$BOOTSTRAP_TEST_DIR/install/scripts/removed.sh"

cp -R "$BOOTSTRAP_TEST_DIR/release-v1" "$BOOTSTRAP_TEST_DIR/release-v2"
sed 's/v1/v2/' "$BOOTSTRAP_TEST_DIR/release-v2/install.sh" > "$BOOTSTRAP_TEST_DIR/release-v2/install.sh.tmp"
mv "$BOOTSTRAP_TEST_DIR/release-v2/install.sh.tmp" "$BOOTSTRAP_TEST_DIR/release-v2/install.sh"
tar -czf "$BOOTSTRAP_TEST_DIR/release-v2.tar.gz" -C "$BOOTSTRAP_TEST_DIR/release-v2" .
printf '%s  hmusic-deploy.tar.gz\n' "$(file_sha256 "$BOOTSTRAP_TEST_DIR/release-v2.tar.gz")" \
  > "$BOOTSTRAP_TEST_DIR/release-v2.tar.gz.sha256"
HMUSIC_INSTALL_DIR="$BOOTSTRAP_TEST_DIR/install" \
HMUSIC_RELEASE_URL="file://$BOOTSTRAP_TEST_DIR/release-v2.tar.gz" \
  bash "$ROOT/bootstrap.sh" --native >/dev/null
[ "$(cat "$BOOTSTRAP_TEST_DIR/install/installed-version.txt")" = v2 ]
[ "$(cat "$BOOTSTRAP_TEST_DIR/install/.env")" = 'HMUSIC_JWT_SECRET=keep-bootstrap-secret' ]
[ "$(cat "$BOOTSTRAP_TEST_DIR/install/data/state.txt")" = 'keep-bootstrap-data' ]
[ ! -e "$BOOTSTRAP_TEST_DIR/install/dist/removed.js" ]
[ ! -e "$BOOTSTRAP_TEST_DIR/install/web/removed.js" ]
[ ! -e "$BOOTSTRAP_TEST_DIR/install/scripts/removed.sh" ]

printf '%064d  hmusic-deploy.tar.gz\n' 0 > "$BOOTSTRAP_TEST_DIR/release-v2.tar.gz.sha256"
if HMUSIC_INSTALL_DIR="$BOOTSTRAP_TEST_DIR/install" \
  HMUSIC_RELEASE_URL="file://$BOOTSTRAP_TEST_DIR/release-v2.tar.gz" \
  bash "$ROOT/bootstrap.sh" --native >/dev/null 2>&1; then
  echo "bootstrap should reject a mismatched checksum" >&2
  exit 1
fi
[ "$(cat "$BOOTSTRAP_TEST_DIR/install/.env")" = 'HMUSIC_JWT_SECRET=keep-bootstrap-secret' ]

mkdir -p "$BOOTSTRAP_TEST_DIR/unsafe"
printf 'HMUSIC_JWT_SECRET=overwritten\n' > "$BOOTSTRAP_TEST_DIR/unsafe/.env"
cp "$BOOTSTRAP_TEST_DIR/release-v1/install.sh" "$BOOTSTRAP_TEST_DIR/unsafe/install.sh"
mkdir -p "$BOOTSTRAP_TEST_DIR/unsafe/scripts"
cp "$ROOT/scripts/deploy-common.sh" "$BOOTSTRAP_TEST_DIR/unsafe/scripts/deploy-common.sh"
tar -czf "$BOOTSTRAP_TEST_DIR/unsafe.tar.gz" -C "$BOOTSTRAP_TEST_DIR/unsafe" .
if HMUSIC_INSTALL_DIR="$BOOTSTRAP_TEST_DIR/install" \
  HMUSIC_RELEASE_URL="file://$BOOTSTRAP_TEST_DIR/unsafe.tar.gz" \
  bash "$ROOT/bootstrap.sh" --native >/dev/null 2>&1; then
  echo "bootstrap should reject archives containing .env" >&2
  exit 1
fi
[ "$(cat "$BOOTSTRAP_TEST_DIR/install/.env")" = 'HMUSIC_JWT_SECRET=keep-bootstrap-secret' ]

mkdir -p "$BOOTSTRAP_TEST_DIR/unmanaged"
printf 'unrelated\n' > "$BOOTSTRAP_TEST_DIR/unmanaged/notes.txt"
printf 'HMUSIC_JWT_SECRET=looks-managed-but-is-not\n' > "$BOOTSTRAP_TEST_DIR/unmanaged/.env"
if HMUSIC_INSTALL_DIR="$BOOTSTRAP_TEST_DIR/unmanaged" \
  HMUSIC_RELEASE_URL="file://$BOOTSTRAP_TEST_DIR/release-v1.tar.gz" \
  bash "$ROOT/bootstrap.sh" --native >/dev/null 2>&1; then
  echo "bootstrap should reject a non-managed non-empty directory" >&2
  exit 1
fi
[ "$(cat "$BOOTSTRAP_TEST_DIR/unmanaged/notes.txt")" = unrelated ]

mkdir -p "$BOOTSTRAP_TEST_DIR/symlink/scripts"
cp "$BOOTSTRAP_TEST_DIR/release-v1/install.sh" "$BOOTSTRAP_TEST_DIR/symlink/install.sh"
cp "$ROOT/scripts/deploy-common.sh" "$BOOTSTRAP_TEST_DIR/symlink/scripts/deploy-common.sh"
ln -s install.sh "$BOOTSTRAP_TEST_DIR/symlink/linked-installer"
tar -czf "$BOOTSTRAP_TEST_DIR/symlink.tar.gz" -C "$BOOTSTRAP_TEST_DIR/symlink" .
if HMUSIC_INSTALL_DIR="$BOOTSTRAP_TEST_DIR/install" \
  HMUSIC_RELEASE_URL="file://$BOOTSTRAP_TEST_DIR/symlink.tar.gz" \
  bash "$ROOT/bootstrap.sh" --native >/dev/null 2>&1; then
  echo "bootstrap should reject archives containing symlinks" >&2
  exit 1
fi

mkdir -p dist data
cp server.mjs dist/main.js
printf '%s\n' 'not-a-pid' > data/hmusic.pid
stop_managed_native
[ ! -f data/hmusic.pid ]
start_native_background "$PORT"
http_ok "$PORT"
FIRST_PID="$(cat data/hmusic.pid)"

start_native_background "$PORT"
SECOND_PID="$(cat data/hmusic.pid)"
[ "$FIRST_PID" != "$SECOND_PID" ]
http_ok "$PORT"

sed 's|^HMUSIC_JWT_SECRET=.*|HMUSIC_JWT_SECRET=short|' .env > .env.short-secret
mv .env.short-secret .env
if (ensure_env >/dev/null 2>&1); then
  echo "short JWT secret should be rejected" >&2
  exit 1
fi

printf 'deployment scripts: ok\n'
