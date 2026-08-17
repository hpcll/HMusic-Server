import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { env } from "../../config/env.js";
import { AppError } from "../../shared/errors.js";
import { serverVersion } from "../../shared/version.js";

// 升级链路的「上半段」：检测 GitHub Release 新版 + 一键触发 install.sh --update。
// 下半段（下载部署包、保留 .env/data、停旧进程、重启）全部复用现有安装脚本，
// 这里只负责「知道有新版」和「替用户按下回车」。

export type UpdateDeployMode = "native" | "docker" | "unknown";

export type UpdateCheckResult = {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  notes: string | null;
  publishedAt: string | null;
  url: string | null;
  deployMode: UpdateDeployMode;
  canSelfUpdate: boolean;
  updating: boolean;
};

const releaseRepo = process.env.HMUSIC_UPDATE_REPO ?? "hpcll/HMusic-Server";
const releaseApiUrl =
  process.env.HMUSIC_UPDATE_API_URL ??
  `https://api.github.com/repos/${releaseRepo}/releases/latest`;

// GitHub 未登录限频 60 次/小时：结果缓存 5 分钟，App 反复点「检查」不打穿。
const checkCacheTtlMs = 5 * 60 * 1000;
let cachedCheck: { fetchedAt: number; release: LatestRelease } | undefined;

type LatestRelease = {
  version: string;
  notes: string | null;
  publishedAt: string | null;
  url: string | null;
};

type FetchLike = typeof fetch;
let fetchImpl: FetchLike = fetch;

type SpawnLike = (command: string, args: string[], cwd: string) => void;
let spawnImpl: SpawnLike = (command, args, cwd) => {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
};

const updateLockFile = () => path.join(env.dataDir, "update.lock");
const updateLogFile = () => path.join(env.dataDir, "update.log");

// 服务端启动时清一次升级锁：升级脚本会重启进程，能走到这里说明上一轮
// 升级流程已经结束（成功或失败都以新进程为准）。
export function clearUpdateLockOnBoot(): void {
  try {
    if (fs.existsSync(updateLockFile())) {
      fs.rmSync(updateLockFile());
      fs.appendFileSync(
        updateLogFile(),
        `[${new Date().toISOString()}] 服务端已重启，升级流程结束（当前版本 ${serverVersion}）\n`,
      );
    }
  } catch {
    // 清锁失败不影响启动。
  }
}

function isUpdating(): boolean {
  try {
    const raw = fs.readFileSync(updateLockFile(), "utf8");
    const lock = JSON.parse(raw) as { startedAt?: number };
    // 30 分钟视为僵尸锁（脚本异常中断且进程没重启），不再挡新触发。
    return (
      typeof lock.startedAt === "number" &&
      Date.now() - lock.startedAt < 30 * 60 * 1000
    );
  } catch {
    return false;
  }
}

function detectDeployMode(): UpdateDeployMode {
  if (process.env.HMUSIC_IN_DOCKER === "1" || fs.existsSync("/.dockerenv")) {
    return "docker";
  }
  try {
    const recorded = fs
      .readFileSync(path.join(env.dataDir, "deploy-mode"), "utf8")
      .trim();
    if (recorded === "docker") return "docker";
    if (recorded === "native") return "native";
  } catch {
    // 没记录过（老版本安装/手工部署）按安装脚本存在性判断。
  }
  return fs.existsSync(path.join(installRoot(), "install.sh"))
    ? "native"
    : "unknown";
}

// 安装根目录 = 运行目录：deploy 脚本与 systemd 单元都以安装目录为 cwd 启动。
function installRoot(): string {
  return process.cwd();
}

function canSelfUpdate(mode: UpdateDeployMode): boolean {
  if (mode === "docker") return updateToken().length > 0;
  return mode === "native" && fs.existsSync(path.join(installRoot(), "install.sh"));
}

// Docker 一键升级走 hmusic-updater 守护容器（watchtower HTTP API，host 网络）。
const updaterUrl = () =>
  process.env.HMUSIC_UPDATER_URL ?? "http://127.0.0.1:8666";
const updateToken = () => (process.env.HMUSIC_UPDATE_TOKEN ?? "").trim();

// 数字段逐段比较（v 前缀无视），段数不齐补 0；非数字段按 0 处理
//（本项目版本号是纯 x.y.z，预发布后缀不参与排序）。
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (value: string) =>
    value
      .replace(/^v/i, "")
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function fetchLatestRelease(): Promise<LatestRelease> {
  if (cachedCheck && Date.now() - cachedCheck.fetchedAt < checkCacheTtlMs) {
    return cachedCheck.release;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(releaseApiUrl, {
      signal: controller.signal,
      headers: {
        accept: "application/vnd.github+json",
        // GitHub API 要求 UA，不带会 403。
        "user-agent": `hmusic-server/${serverVersion}`,
      },
    });
    if (!response.ok) {
      throw new AppError(
        "UPDATE_CHECK_FAILED",
        response.status === 404
          ? "还没有发布任何 Release（或仓库不可见）"
          : `GitHub 返回 ${response.status}`,
        502,
        { statusCode: response.status },
      );
    }
    const body = (await response.json()) as {
      tag_name?: string;
      name?: string;
      body?: string;
      published_at?: string;
      html_url?: string;
    };
    const version = (body.tag_name ?? body.name ?? "").trim();
    if (!version) {
      throw new AppError("UPDATE_CHECK_FAILED", "Release 缺少版本号", 502);
    }
    const release: LatestRelease = {
      version,
      notes: body.body?.trim() || null,
      publishedAt: body.published_at ?? null,
      url: body.html_url ?? null,
    };
    cachedCheck = { fetchedAt: Date.now(), release };
    return release;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "UPDATE_CHECK_FAILED",
      "无法连接 GitHub 检查更新（网络不通或超时）",
      502,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const mode = detectDeployMode();
  const release = await fetchLatestRelease();
  return {
    current: serverVersion,
    latest: release.version,
    hasUpdate: isNewerVersion(release.version, serverVersion),
    notes: release.notes,
    publishedAt: release.publishedAt,
    url: release.url,
    deployMode: mode,
    canSelfUpdate: canSelfUpdate(mode),
    updating: isUpdating(),
  };
}

export async function triggerSelfUpdate(): Promise<{ started: boolean }> {
  if (isUpdating()) {
    throw new AppError("UPDATE_IN_PROGRESS", "升级已在进行中，请稍候", 409);
  }
  const mode = detectDeployMode();
  if (mode === "docker") return triggerDockerUpdate();
  if (!canSelfUpdate(mode)) {
    throw new AppError(
      "UPDATE_NOT_SUPPORTED",
      "当前部署找不到 install.sh，无法自升级。请参考 README 手动更新。",
      409,
    );
  }

  const root = installRoot();
  writeUpdateLock();
  appendUpdateLog(
    `收到升级请求，当前版本 ${serverVersion}，开始执行 install.sh --update`,
  );
  // 脱离父进程执行：脚本会停掉当前服务端进程再重启，若不 detach 会跟着一起死。
  // sleep 2 让 HTTP 响应先落地；日志追加到 data/update.log 供事后排查。
  spawnImpl(
    "bash",
    [
      "-c",
      `sleep 2; exec bash install.sh --update >> ${JSON.stringify(
        updateLogFile(),
      )} 2>&1`,
    ],
    root,
  );
  return { started: true };
}

// Docker：让 hmusic-updater（watchtower）拉新镜像并原地重建本容器。
// 真正的 POST 不 await 到底——重建开始后本进程即消亡，等不到响应；
// 先做一次探活确保守护在线，再火后不理地触发。
async function triggerDockerUpdate(): Promise<{ started: boolean }> {
  const token = updateToken();
  if (!token) {
    throw new AppError(
      "UPDATE_DOCKER_MODE",
      "Docker 部署还没有配置升级守护（旧版安装）。请在宿主机进入安装目录执行一次 "
        + "bash install.sh --update，之后即可在这里一键升级。",
      409,
    );
  }
  const endpoint = `${updaterUrl()}/v1/update`;
  try {
    // 探活：不带令牌的请求只要有 HTTP 响应（通常 401）就说明守护在线；
    // 连接被拒/超时才算不在线。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      await fetchImpl(endpoint, { method: "HEAD", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    throw new AppError(
      "UPDATE_DOCKER_MODE",
      "升级守护（hmusic-updater 容器）不在线。请在宿主机进入安装目录执行："
        + "docker compose up -d，或 bash install.sh --update。",
      409,
    );
  }
  writeUpdateLock();
  appendUpdateLog(
    `收到升级请求，当前版本 ${serverVersion}，已通知升级守护拉取新镜像并重建容器`,
  );
  void fetchImpl(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  })
    .then((response) => {
      // 没有新镜像/触发失败时本进程还活着，记录并放开锁；
      // 有新镜像时容器被重建，这里根本执行不到（新进程启动会清锁）。
      if (!response.ok) {
        appendUpdateLog(`升级守护返回 ${response.status}，本次未升级`);
        clearUpdateLock();
      }
    })
    .catch((error: unknown) => {
      appendUpdateLog(
        `通知升级守护失败：${error instanceof Error ? error.message : String(error)}`,
      );
      clearUpdateLock();
    });
  return { started: true };
}

function writeUpdateLock(): void {
  fs.mkdirSync(env.dataDir, { recursive: true });
  fs.writeFileSync(
    updateLockFile(),
    JSON.stringify({ startedAt: Date.now(), pid: process.pid }),
  );
}

function clearUpdateLock(): void {
  try {
    fs.rmSync(updateLockFile());
  } catch {
    // 已被清即无事。
  }
}

function appendUpdateLog(message: string): void {
  try {
    fs.appendFileSync(
      updateLogFile(),
      `[${new Date().toISOString()}] ${message}\n`,
    );
  } catch {
    // 日志写不进不影响主流程。
  }
}

export function readUpdateLog(): { updating: boolean; log: string } {
  let log = "";
  try {
    const raw = fs.readFileSync(updateLogFile(), "utf8");
    // 只回尾部 8KB，升级日志可能带完整 npm 输出。
    log = raw.length > 8192 ? raw.slice(-8192) : raw;
  } catch {
    log = "";
  }
  return { updating: isUpdating(), log };
}

// ===== App 远程配置中转 =====
// 手机直连 GitHub 在大陆常态不通，由服务端代拉 App 仓库的 app-config.json
// （强制升级/公告的全局开关）。30min 缓存 + 拉挂时回上次旧值：门控宁可
// 用旧配置也不因网络抖动放空。available=false 时 App 退回自身直连镜像。
const appConfigRepo = process.env.HMUSIC_APP_CONFIG_REPO ?? "hpcll/HMusic-App";
const appConfigMirrors: string[] = process.env.HMUSIC_APP_CONFIG_URL
  ? [process.env.HMUSIC_APP_CONFIG_URL]
  : [
      `https://raw.githubusercontent.com/${appConfigRepo}/main/app-config.json`,
      `https://fastly.jsdelivr.net/gh/${appConfigRepo}@main/app-config.json`,
    ];

const appConfigTtlMs = 30 * 60 * 1000;

type AppRemoteConfig = {
  minVersion?: string;
  notice?: string;
  downloadUrl?: string;
};

let cachedAppConfig:
  | { fetchedAt: number; config: AppRemoteConfig }
  | undefined;

export type AppConfigRelay = {
  available: boolean;
  config: AppRemoteConfig | null;
};

export async function relayAppConfig(): Promise<AppConfigRelay> {
  if (cachedAppConfig && Date.now() - cachedAppConfig.fetchedAt < appConfigTtlMs) {
    return { available: true, config: cachedAppConfig.config };
  }
  for (const url of appConfigMirrors) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetchImpl(url, {
          signal: controller.signal,
          headers: { "user-agent": `hmusic-server/${serverVersion}` },
        });
        if (!response.ok) continue;
        const body = (await response.json()) as AppRemoteConfig;
        if (typeof body !== "object" || body === null) continue;
        cachedAppConfig = { fetchedAt: Date.now(), config: body };
        return { available: true, config: body };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // 换下一个镜像。
    }
  }
  // 全部镜像失败：有旧值用旧值（过期缓存也比放空强），否则如实报不可用。
  if (cachedAppConfig) {
    return { available: true, config: cachedAppConfig.config };
  }
  return { available: false, config: null };
}

// ===== 测试注入 =====
export function _setFetchForTests(impl: FetchLike | undefined): void {
  fetchImpl = impl ?? fetch;
  cachedCheck = undefined;
}

export function _setSpawnForTests(impl: SpawnLike | undefined): void {
  spawnImpl =
    impl ??
    ((command, args, cwd) => {
      const child = spawn(command, args, { cwd, detached: true, stdio: "ignore" });
      child.unref();
    });
}

export function _resetUpdateStateForTests(): void {
  cachedCheck = undefined;
  cachedAppConfig = undefined;
  try {
    fs.rmSync(updateLockFile());
  } catch {
    // 不存在即干净。
  }
}
