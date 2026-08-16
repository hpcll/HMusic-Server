import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// env 是模块级单例（导入即读 process.env），必须先设好临时数据目录再动态
// 导入被测模块——与集成测试同一手法。
let dataDir: string;
let svc: typeof import("../../src/modules/system/update.service.js");
let expectedVersion: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "hmusic-update-test-"));
  process.env.HMUSIC_DATA_DIR = dataDir;
  process.env.HMUSIC_DATABASE_URL = path.join(dataDir, "hmusic.db");
  svc = await import("../../src/modules/system/update.service.js");
  expectedVersion = (
    JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { version: string }
  ).version;
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  svc._setFetchForTests(undefined);
  svc._setSpawnForTests(undefined);
  svc._resetUpdateStateForTests();
});

function fakeRelease(tag: string): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        tag_name: tag,
        body: "修复若干问题",
        published_at: "2026-08-16T00:00:00Z",
        html_url: `https://github.com/hpcll/HMusic-Server/releases/tag/${tag}`,
      }),
      { status: 200 },
    )) as typeof fetch;
}

describe("update service", () => {
  it("版本比较：v 前缀、段数不齐、相等都判对", () => {
    expect(svc.isNewerVersion("v0.2.0", "0.1.0")).toBe(true);
    expect(svc.isNewerVersion("0.1.1", "0.1.0")).toBe(true);
    expect(svc.isNewerVersion("1.0", "0.9.9")).toBe(true);
    expect(svc.isNewerVersion("0.1.0", "0.1.0")).toBe(false);
    expect(svc.isNewerVersion("0.1.0", "0.2.0")).toBe(false);
    expect(svc.isNewerVersion("0.1.0.1", "0.1.0")).toBe(true);
  });

  it("checkForUpdate：读取 Release、按当前版本判 hasUpdate、带部署形态", async () => {
    svc._setFetchForTests(fakeRelease("v99.0.0"));
    const result = await svc.checkForUpdate();
    expect(result.current).toBe(expectedVersion);
    expect(result.latest).toBe("v99.0.0");
    expect(result.hasUpdate).toBe(true);
    expect(result.notes).toContain("修复");
    expect(result.updating).toBe(false);
    expect(["native", "docker", "unknown"]).toContain(result.deployMode);
  });

  it("checkForUpdate：结果缓存，第二次不再打 GitHub", async () => {
    let calls = 0;
    svc._setFetchForTests((async () => {
      calls += 1;
      return new Response(JSON.stringify({ tag_name: "v0.1.0" }), {
        status: 200,
      });
    }) as typeof fetch);
    await svc.checkForUpdate();
    await svc.checkForUpdate();
    expect(calls).toBe(1);
  });

  it("checkForUpdate：GitHub 不可达转成 UPDATE_CHECK_FAILED", async () => {
    svc._setFetchForTests((async () => {
      throw new Error("network down");
    }) as typeof fetch);
    await expect(svc.checkForUpdate()).rejects.toMatchObject({
      code: "UPDATE_CHECK_FAILED",
    });
  });

  it("triggerSelfUpdate：native 下写锁并派生 install.sh --update，重复触发 409", async () => {
    const spawned: Array<{ command: string; args: string[]; cwd: string }> = [];
    svc._setSpawnForTests((command, args, cwd) => {
      spawned.push({ command, args, cwd });
    });

    // 测试进程 cwd 即仓库根，install.sh 存在 → 视同 native 安装。
    const result = await svc.triggerSelfUpdate();
    expect(result.started).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].command).toBe("bash");
    expect(spawned[0].args.join(" ")).toContain("install.sh --update");

    await expect(svc.triggerSelfUpdate()).rejects.toMatchObject({
      code: "UPDATE_IN_PROGRESS",
    });
    expect(svc.readUpdateLog().updating).toBe(true);
    expect(svc.readUpdateLog().log).toContain("收到升级请求");
  });

  it("triggerSelfUpdate：docker 无令牌时拒绝并提示补装升级守护", async () => {
    process.env.HMUSIC_IN_DOCKER = "1";
    delete process.env.HMUSIC_UPDATE_TOKEN;
    try {
      await expect(svc.triggerSelfUpdate()).rejects.toMatchObject({
        code: "UPDATE_DOCKER_MODE",
      });
    } finally {
      delete process.env.HMUSIC_IN_DOCKER;
    }
  });

  it("triggerSelfUpdate：docker 有令牌时探活升级守护并带 Bearer 触发", async () => {
    process.env.HMUSIC_IN_DOCKER = "1";
    process.env.HMUSIC_UPDATE_TOKEN = "test-update-token";
    const requests: Array<{ url: string; method?: string; auth?: string }> = [];
    svc._setFetchForTests(((url: string, init?: RequestInit) => {
      requests.push({
        url: String(url),
        method: init?.method,
        auth: (init?.headers as Record<string, string> | undefined)?.[
          "authorization"
        ],
      });
      return Promise.resolve(new Response(null, { status: 401 }));
    }) as unknown as typeof fetch);
    try {
      const result = await svc.triggerSelfUpdate();
      expect(result.started).toBe(true);
      // 等触发的火后不理 POST 落地（微任务）。
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(requests).toHaveLength(2);
      expect(requests[0].method).toBe("HEAD");
      expect(requests[1].method).toBe("POST");
      expect(requests[1].url).toContain("/v1/update");
      expect(requests[1].auth).toBe("Bearer test-update-token");
    } finally {
      delete process.env.HMUSIC_IN_DOCKER;
      delete process.env.HMUSIC_UPDATE_TOKEN;
    }
  });

  it("triggerSelfUpdate：docker 守护不在线转 UPDATE_DOCKER_MODE", async () => {
    process.env.HMUSIC_IN_DOCKER = "1";
    process.env.HMUSIC_UPDATE_TOKEN = "test-update-token";
    svc._setFetchForTests((async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch);
    try {
      await expect(svc.triggerSelfUpdate()).rejects.toMatchObject({
        code: "UPDATE_DOCKER_MODE",
      });
    } finally {
      delete process.env.HMUSIC_IN_DOCKER;
      delete process.env.HMUSIC_UPDATE_TOKEN;
    }
  });

  it("checkForUpdate：docker 配好令牌时 canSelfUpdate 为真", async () => {
    process.env.HMUSIC_IN_DOCKER = "1";
    process.env.HMUSIC_UPDATE_TOKEN = "test-update-token";
    svc._setFetchForTests(fakeRelease("v99.0.0"));
    try {
      const result = await svc.checkForUpdate();
      expect(result.deployMode).toBe("docker");
      expect(result.canSelfUpdate).toBe(true);
    } finally {
      delete process.env.HMUSIC_IN_DOCKER;
      delete process.env.HMUSIC_UPDATE_TOKEN;
    }
  });

  it("锁超过 30 分钟视为僵尸，不再阻塞新触发", async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "update.lock"),
      JSON.stringify({ startedAt: Date.now() - 31 * 60 * 1000 }),
    );
    const spawned: string[] = [];
    svc._setSpawnForTests((command) => {
      spawned.push(command);
    });
    const result = await svc.triggerSelfUpdate();
    expect(result.started).toBe(true);
    expect(spawned).toHaveLength(1);
  });
});
