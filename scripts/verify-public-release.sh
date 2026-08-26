#!/usr/bin/env bash
# 以匿名用户身份验证公开分发入口；发布并设置可见性后执行。
set -euo pipefail

command -v node >/dev/null 2>&1 || {
  echo "需要 Node.js 20+ 执行公开发布验证" >&2
  exit 1
}

export HMUSIC_VERIFY_REPO="${HMUSIC_VERIFY_REPO:-hpcll/HMusic-Server}"
export HMUSIC_VERIFY_IMAGE="${HMUSIC_VERIFY_IMAGE:-hpcll/hmusic-server}"

node <<'NODE'
const repo = process.env.HMUSIC_VERIFY_REPO;
const image = process.env.HMUSIC_VERIFY_IMAGE.toLowerCase();
const headers = { "user-agent": "hmusic-public-release-verifier" };
const requestTimeout = () => AbortSignal.timeout(15_000);
const failures = [];

async function expectOk(name, url, inspect) {
  try {
    const response = await fetch(url, { headers, signal: requestTimeout() });
    if (!response.ok) {
      failures.push(`${name}: HTTP ${response.status}`);
      return;
    }
    if (inspect) await inspect(response);
    console.log(`通过：${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

await expectOk("GitHub 仓库可匿名访问", `https://github.com/${repo}`);
await expectOk(
  "单行安装脚本可匿名下载",
  `https://raw.githubusercontent.com/${repo}/main/bootstrap.sh`,
  async (response) => {
    const body = await response.text();
    if (!body.includes("HMusic Server") || !body.includes("HMUSIC_RELEASE_URL")) {
      throw new Error("内容不是预期的 bootstrap.sh");
    }
  },
);
await expectOk(
  "Latest Release 部署包可匿名下载",
  `https://github.com/${repo}/releases/latest/download/hmusic-deploy.tar.gz`,
  async (response) => {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 1024 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
      throw new Error("下载内容不是有效的 gzip 部署包");
    }
  },
);
await expectOk(
  "Latest Release SHA-256 可匿名下载",
  `https://github.com/${repo}/releases/latest/download/hmusic-deploy.tar.gz.sha256`,
  async (response) => {
    const body = await response.text();
    if (!/^[a-f0-9]{64}\s+hmusic-deploy\.tar\.gz\s*$/i.test(body)) {
      throw new Error("校验文件格式不正确");
    }
  },
);

try {
  const tokenResponse = await fetch(
    `https://ghcr.io/token?scope=repository:${image}:pull`,
    { headers, signal: requestTimeout() },
  );
  if (!tokenResponse.ok) {
    failures.push(`GHCR 匿名令牌: HTTP ${tokenResponse.status}`);
  } else {
    const tokenBody = await tokenResponse.json();
    const token = tokenBody.token || tokenBody.access_token;
    const manifestResponse = await fetch(
      `https://ghcr.io/v2/${image}/manifests/latest`,
      {
        headers: {
          ...headers,
          authorization: `Bearer ${token}`,
          accept: [
            "application/vnd.oci.image.index.v1+json",
            "application/vnd.docker.distribution.manifest.list.v2+json",
            "application/vnd.oci.image.manifest.v1+json",
          ].join(", "),
        },
        signal: requestTimeout(),
      },
    );
    if (!manifestResponse.ok) {
      failures.push(`GHCR latest manifest: HTTP ${manifestResponse.status}`);
    } else {
      const manifest = await manifestResponse.json();
      const platforms = new Set(
        (manifest.manifests || []).map(
          (item) => `${item.platform?.os || ""}/${item.platform?.architecture || ""}`,
        ),
      );
      if (!platforms.has("linux/amd64") || !platforms.has("linux/arm64")) {
        failures.push("GHCR latest manifest 缺少 linux/amd64 或 linux/arm64");
      } else {
        console.log("通过：GHCR latest 镜像可匿名拉取（amd64 + arm64）");
      }
    }
  }
} catch (error) {
  failures.push(`GHCR: ${error.message}`);
}

if (failures.length > 0) {
  console.error("\n公开发布尚未就绪：");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error("\n请确认仓库已设为 Public、已推送新 v* tag、Release 工作流成功，并把 GHCR 包设为 Public。\n");
  process.exit(1);
}

console.log("\n公开分发验收通过：小白用户可以匿名安装和拉取镜像。\n");
NODE
